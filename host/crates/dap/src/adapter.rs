// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The adapter: DAP requests to `Debug` operations, `Debug` events to DAP
//! events.
//!
//! Three threads: the reader takes frames off the input and queues the
//! requests; the worker (the caller of [`serve`]) answers them one at a
//! time; the event thread drains the session's receiver and forwards
//! `Stopped` and `DebugEnded` in the order they came, whatever the worker
//! is waiting on. A `CALL` under `Own` is waited for on a thread of its
//! own, since its reply comes only when the program ends.

use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use qap_client::proto::ops::debug::{DebugModule, DebugTarget, Frame, StopReason, Stopped};
use qap_client::proto::types::{JobId, ObjectName};
use qap_client::{CommandOutcome, DebugEvent, Error, Status};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::backend::{Connect, Credentials, DebugBackend, Failure, object_name, object_text};
use crate::protocol::{Capabilities, Incoming, Out, Source, StackFrame, Thread};

/// How often a waiting `CALL` looks for a cancel.
const CANCEL_EVERY: Duration = Duration::from_millis(50);

/// How long a disconnect waits for a cancelled `CALL`'s reply.
const CALL_GRACE: Duration = Duration::from_secs(2);

/// The scheme of the synthetic document a frame without a source view
/// stands on: `qs400dbg:/LIB/PROGRAM/MODULE`, one line per statement.
pub const SYNTHETIC_SCHEME: &str = "qs400dbg";

/// What `serve` may be told.
#[derive(Debug, Clone)]
pub struct Options {
    /// How long the extension has to answer `qs400/debugSource`.
    pub ask_timeout: Duration,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            ask_timeout: Duration::from_secs(5),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Serves one debug session: reads requests from `input` until
/// `disconnect` or the end of the stream, writes to `output`, and opens
/// the session's connection with `connect`.
pub fn serve<R: BufRead + Send + 'static>(
    input: R,
    output: Box<dyn Write + Send>,
    connect: Connect,
    options: Options,
) -> io::Result<()> {
    let out = Arc::new(Out::new(output));
    let session = Arc::new(Session::new(Arc::clone(&out), options));
    let (tx, rx) = mpsc::channel::<Incoming>();
    {
        let session = Arc::clone(&session);
        thread::spawn(move || read_loop(input, &tx, &session));
    }
    let mut adapter = Adapter { session, connect };
    for req in rx {
        if adapter.handle(&req) == Flow::Exit {
            break;
        }
    }
    adapter.session.close(true);
    Ok(())
}

/// Reads frames and queues what is not an answer to the adapter itself.
fn read_loop<R: BufRead>(mut input: R, tx: &mpsc::Sender<Incoming>, _session: &Session) {
    loop {
        let body = match host_rpc::framing::read_frame(&mut input) {
            Ok(Some(b)) => b,
            Ok(None) => return,
            Err(e) => {
                eprintln!("[error] dap: {e}");
                return;
            }
        };
        let msg: Incoming = match serde_json::from_slice(&body) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[error] dap: a message that does not read: {e}");
                continue;
            }
        };
        if msg.kind != "request" {
            continue;
        }
        if tx.send(msg).is_err() {
            return;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flow {
    Continue,
    Exit,
}

/// What the session debugs.
#[derive(Debug, Clone, Default)]
enum Mode {
    #[default]
    None,
    /// `Own`: the `CALL` that runs at `configurationDone`.
    Call { command: String },
}

/// A program under debug, as `AddProgram` answered.
#[derive(Debug, Clone)]
#[allow(dead_code)] // read by setBreakpoints
struct Program {
    name: ObjectName,
    modules: Vec<DebugModule>,
}

#[derive(Default)]
struct State {
    mode: Mode,
    programs: Vec<Program>,
    /// The debugged jobs; thread ID `n` is entry `n - 1`.
    threads: Vec<Option<JobId>>,
    /// The thread stopped, while one is.
    stopped: Option<i64>,
    /// The stack of the stop, as the last `stackTrace` read it.
    frames: Vec<Frame>,
    /// `disconnect` or `terminate` has begun: the receiver's close is ours.
    closing: bool,
    /// `terminated` has been sent.
    ended: bool,
    /// The running `CALL`'s cancel flag.
    call: Option<Arc<AtomicBool>>,
    /// Told when the `CALL`'s thread is done.
    call_done: Option<Receiver<()>>,
}

impl State {
    fn thread_for(&mut self, job: &JobId) -> i64 {
        let at = self.threads.iter().position(|t| match t {
            Some(j) => same_job(j, job),
            // The connection job before `JobInfo` named it.
            None => false,
        });
        let at = at.unwrap_or_else(|| {
            self.threads.push(Some(job.clone()));
            self.threads.len() - 1
        });
        i64::try_from(at).unwrap_or(i64::MAX - 1) + 1
    }
}

fn same_job(a: &JobId, b: &JobId) -> bool {
    a.number.trim() == b.number.trim()
        && a.user.trim().eq_ignore_ascii_case(b.user.trim())
        && a.name.trim().eq_ignore_ascii_case(b.name.trim())
}

fn thread_name(job: Option<&JobId>) -> String {
    match job {
        Some(j) => crate::backend::job_text(j),
        None => "connection job".to_owned(),
    }
}

/// What the worker and the event and `CALL` threads share.
struct Session {
    out: Arc<Out>,
    #[allow(dead_code)]
    options: Options,
    backend: Mutex<Option<Box<dyn DebugBackend>>>,
    state: Mutex<State>,
}

impl Session {
    fn new(out: Arc<Out>, options: Options) -> Session {
        Session {
            out,
            options,
            backend: Mutex::new(None),
            state: Mutex::new(State::default()),
        }
    }

    fn with_backend<T>(
        &self,
        f: impl FnOnce(&mut dyn DebugBackend) -> Result<T, Error>,
    ) -> Result<T, Failure> {
        let mut g = lock(&self.backend);
        let b = g
            .as_mut()
            .ok_or_else(|| Failure::new("no debug session: launch or attach first"))?;
        f(b.as_mut()).map_err(Failure::from)
    }

    /// `terminated`, once.
    fn terminated(&self) {
        {
            let mut st = lock(&self.state);
            if st.ended {
                return;
            }
            st.ended = true;
        }
        self.out.event("terminated", json!({}));
    }

    /// Drains `rx` on a thread of its own.
    fn forward(self: &Arc<Self>, rx: Receiver<DebugEvent>) {
        let s = Arc::clone(self);
        thread::spawn(move || {
            for ev in rx {
                s.on_event(ev);
            }
            let quiet = {
                let st = lock(&s.state);
                st.closing || st.ended
            };
            if !quiet {
                s.out
                    .console("The debug session ended: its connection closed.");
                s.terminated();
            }
        });
    }

    fn on_event(&self, ev: DebugEvent) {
        match ev {
            DebugEvent::Stopped(st) => self.on_stopped(&st),
            DebugEvent::DebugEnded(d) => {
                if let Some(m) = d.message {
                    self.out.console(&message_line(&m.id, &m.text));
                }
                self.terminated();
            }
        }
    }

    fn on_stopped(&self, s: &Stopped) {
        let thread = {
            let mut st = lock(&self.state);
            let thread = st.thread_for(&s.job);
            st.stopped = Some(thread);
            st.frames.clear();
            thread
        };
        let (reason, text) = match &s.reason {
            StopReason::Breakpoint => ("breakpoint", None),
            StopReason::Step => ("step", None),
            StopReason::ServiceEntry => ("entry", None),
            StopReason::Exception { message } => {
                ("exception", Some(message_line(&message.id, &message.text)))
            }
            StopReason::ProgramEnd => {
                self.out.console(&format!(
                    "ProgramEnd: {} ended",
                    object_text(&s.frame.program)
                ));
                self.terminated();
                return;
            }
        };
        let mut body = json!({
            "reason": reason,
            "threadId": thread,
            "allThreadsStopped": true,
        });
        if let Some(t) = text {
            body["description"] = json!(t);
            body["text"] = json!(t);
            self.out.console(&t);
        }
        self.out.event("stopped", body);
    }

    /// The `CALL` ended: its messages and status in the Debug Console,
    /// then the end of the session.
    fn call_ended(&self, command: &str, outcome: Result<CommandOutcome, Error>) {
        match outcome {
            Ok(o) => {
                let escape = o.escape.as_ref();
                for m in &o.messages {
                    if escape.is_some_and(|e| e.id == m.id && e.text == m.text) {
                        continue;
                    }
                    self.out.console(&message_line(&m.id, &m.text));
                }
                if let Some(e) = escape {
                    self.out.console(&message_line(&e.id, &e.text));
                }
                self.out
                    .console(&format!("{command} ended: {}", status_word(o.status)));
            }
            Err(e) => self.out.console(&format!("{command}: {e}")),
        }
        if !lock(&self.state).closing {
            self.terminated();
        }
    }

    /// Ends the session: the `CALL` cancelled when `terminate`, `End`,
    /// sign-off. Nothing is reported; nothing more will be.
    fn close(&self, terminate: bool) {
        let (flag, done) = {
            let mut st = lock(&self.state);
            st.closing = true;
            (st.call.take(), st.call_done.take())
        };
        let Some(mut b) = lock(&self.backend).take() else {
            return;
        };
        if terminate && let Some(f) = &flag {
            f.store(true, Ordering::Release);
        }
        let _ = b.end();
        if let Some(done) = done {
            let _ = done.recv_timeout(CALL_GRACE);
        }
        b.sign_off();
    }
}

/// `ID: text`, or the text alone.
fn message_line(id: &str, text: &str) -> String {
    if id.trim().is_empty() {
        text.trim().to_owned()
    } else {
        format!("{}: {}", id.trim(), text.trim())
    }
}

fn status_word(s: Status) -> String {
    format!("{s:?}")
}

/// `launch`'s arguments, as the extension's provider completes them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchArgs {
    /// `call` (the default) or `serviceEntry`.
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    program: Option<String>,
    /// More programs to put under debug, for breakpoints in called ones.
    #[serde(default)]
    programs: Vec<String>,
    /// The `CALL`, its parameters quoted by the extension.
    #[serde(default)]
    command: Option<String>,
    /// The extension offers a recompile for `CPF9C15`, so the adapter
    /// does not show it too.
    #[serde(default)]
    recompile_offer: bool,
    qs400: Credentials,
}

/// The `Debug` refusal of a program compiled `DBGVIEW(*NONE)`.
pub const NO_DEBUG_DATA: &str = "CPF9C15";

struct Adapter {
    session: Arc<Session>,
    connect: Connect,
}

impl Adapter {
    fn out(&self) -> &Out {
        &self.session.out
    }

    fn handle(&mut self, req: &Incoming) -> Flow {
        let result = match req.command.as_str() {
            "initialize" => Ok(serde_json::to_value(Capabilities {
                supports_configuration_done_request: true,
                supports_conditional_breakpoints: true,
                supports_evaluate_for_hovers: true,
                supports_set_variable: false,
                supports_terminate_request: true,
                supports_function_breakpoints: false,
                supports_step_back: false,
                supports_restart_request: false,
            })
            .unwrap_or(Value::Null)),
            "launch" => self.launch(req),
            "configurationDone" => self.configuration_done(),
            "threads" => Ok(self.threads()),
            "stackTrace" => self.stack_trace(&req.arguments),
            "disconnect" => {
                let terminate = req
                    .arguments
                    .get("terminateDebuggee")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                self.session.close(terminate);
                self.out().ok(req, Value::Null);
                return Flow::Exit;
            }
            other => Err(Failure::new(format!(
                "{other} is not something the QS/400 debugger does"
            ))),
        };
        match result {
            Ok(body) => {
                self.out().ok(req, body);
                if req.command == "launch" {
                    self.out().event("initialized", Value::Null);
                }
            }
            Err(f) => self.out().fail(req, &f),
        }
        Flow::Continue
    }

    /// Opens the session's connection.
    fn open(&self, c: &Credentials) -> Result<(), Failure> {
        let b = (self.connect)(c)?;
        *lock(&self.session.backend) = Some(b);
        Ok(())
    }

    fn launch(&mut self, req: &Incoming) -> Result<Value, Failure> {
        let args: LaunchArgs = serde_json::from_value(req.arguments.clone())
            .map_err(|e| Failure::new(format!("launch: {e}")))?;
        match args.mode.as_deref().unwrap_or("call") {
            "call" => {}
            other => return Err(Failure::new(format!("launch: no mode {other:?}"))),
        }
        let program = object_name(
            args.program
                .as_deref()
                .ok_or_else(|| Failure::new("launch: no program"))?,
        )?;
        let command = args
            .command
            .clone()
            .filter(|c| !c.trim().is_empty())
            .unwrap_or_else(|| format!("CALL PGM({})", object_text(&program)));
        self.open(&args.qs400)?;
        let started = self.start(DebugTarget::Own, &program, &args).map(|()| {
            lock(&self.session.state).mode = Mode::Call { command };
        });
        if started.is_err() {
            self.session.close(false);
        }
        started.map(|()| Value::Null)
    }

    /// `Start`, the event thread, the session's thread, the programs.
    fn start(
        &mut self,
        target: DebugTarget,
        program: &ObjectName,
        args: &LaunchArgs,
    ) -> Result<(), Failure> {
        let events = self.session.with_backend(|b| b.start(target.clone()))?;
        self.session.forward(events);
        let job = match &target {
            DebugTarget::Own => self.session.with_backend(|b| b.job())?,
            DebugTarget::Job { job } => Some(job.clone()),
        };
        lock(&self.session.state).threads.push(job);
        self.add_programs(program, &args.programs, args.recompile_offer)
    }

    /// `AddProgram` of the program, which must have debug data, then of
    /// each of `more` (`*PGM`, else `*SRVPGM`), whose refusals are only
    /// reported.
    fn add_programs(
        &mut self,
        program: &ObjectName,
        more: &[String],
        recompile_offer: bool,
    ) -> Result<(), Failure> {
        let modules = self
            .session
            .with_backend(|b| b.add_program(program, "*PGM"))
            .map_err(|mut f| {
                if recompile_offer && f.message_id.as_deref() == Some(NO_DEBUG_DATA) {
                    f.show_user = false;
                }
                f
            })?;
        lock(&self.session.state).programs.push(Program {
            name: program.clone(),
            modules,
        });
        for p in more {
            let name = match object_name(p) {
                Ok(n) => n,
                Err(f) => {
                    self.out().console(&f.message);
                    continue;
                }
            };
            let added = self
                .session
                .with_backend(|b| match b.add_program(&name, "*PGM") {
                    Err(e) if e.status() == Some(Status::NotFound) => {
                        b.add_program(&name, "*SRVPGM")
                    }
                    r => r,
                });
            match added {
                Ok(modules) => lock(&self.session.state)
                    .programs
                    .push(Program { name, modules }),
                Err(f) => self.out().console(&format!(
                    "{} not under debug: {}",
                    object_text(&name),
                    f.message
                )),
            }
        }
        Ok(())
    }

    /// The session is configured: a `CALL` runs now.
    fn configuration_done(&mut self) -> Result<Value, Failure> {
        let mode = lock(&self.session.state).mode.clone();
        if let Mode::Call { command } = mode {
            let running = self.session.with_backend(|b| b.run_command(&command))?;
            let flag = Arc::new(AtomicBool::new(false));
            let (done_tx, done_rx) = mpsc::channel();
            {
                let mut st = lock(&self.session.state);
                st.call = Some(Arc::clone(&flag));
                st.call_done = Some(done_rx);
            }
            let session = Arc::clone(&self.session);
            thread::spawn(move || {
                let mut cancelled = false;
                let outcome = loop {
                    if !cancelled && flag.load(Ordering::Acquire) {
                        running.cancel();
                        cancelled = true;
                    }
                    if let Some(r) = running.wait_for(CANCEL_EVERY) {
                        break r;
                    }
                };
                session.call_ended(&command, outcome);
                let _ = done_tx.send(());
            });
        }
        Ok(Value::Null)
    }

    fn threads(&self) -> Value {
        let st = lock(&self.session.state);
        let threads: Vec<Thread> = st
            .threads
            .iter()
            .enumerate()
            .map(|(i, j)| Thread {
                id: i64::try_from(i).unwrap_or(i64::MAX - 1) + 1,
                name: thread_name(j.as_ref()),
            })
            .collect();
        json!({ "threads": threads })
    }

    fn stack_trace(&mut self, args: &Value) -> Result<Value, Failure> {
        let frames = self.session.with_backend(|b| b.stack())?;
        lock(&self.session.state).frames.clone_from(&frames);
        let start = args
            .get("startFrame")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(0);
        let levels = args
            .get("levels")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .filter(|&n| n > 0)
            .unwrap_or(usize::MAX);
        let shown: Vec<StackFrame> = frames
            .iter()
            .enumerate()
            .skip(start)
            .take(levels)
            .map(|(i, f)| self.frame(i, f))
            .collect();
        Ok(json!({ "stackFrames": shown, "totalFrames": frames.len() }))
    }

    /// A DAP frame: `PROGRAM › MODULE › PROCEDURE · stmt n`, on its source.
    fn frame(&self, index: usize, f: &Frame) -> StackFrame {
        let name = [f.program.name.trim(), f.module.trim(), f.procedure.trim()]
            .iter()
            .filter(|s| !s.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" › ");
        let (source, line) = self.place(f);
        StackFrame {
            id: i64::try_from(index).unwrap_or(i64::MAX - 1) + 1,
            name: format!("{name} · stmt {}", f.stmt),
            presentation_hint: source.is_none().then(|| "subtle".to_owned()),
            source,
            line,
            column: if line > 0 { 1 } else { 0 },
        }
    }

    /// Where a frame stands: on the synthetic document at its statement.
    fn place(&self, f: &Frame) -> (Option<Source>, u32) {
        if f.stmt == 0 {
            return (None, 0);
        }
        (Some(synthetic(&f.program, &f.module)), f.stmt)
    }
}

/// The synthetic, read-only document of a module's statements.
pub fn synthetic(program: &ObjectName, module: &str) -> Source {
    Source {
        name: format!("{} (statements)", module.trim()),
        path: format!(
            "{SYNTHETIC_SCHEME}:/{}/{}/{}",
            program.library.trim(),
            program.name.trim(),
            module.trim()
        ),
        origin: Some("statement numbers".to_owned()),
        presentation_hint: Some("deemphasize".to_owned()),
    }
}
