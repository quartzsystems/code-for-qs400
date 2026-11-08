// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! A canned `DebugBackend` and a DAP client over in-memory pipes. The
//! canned refusals use the IDs `docs/QAP.md` at `7f82a43f` names for the
//! `Debug` service (`CPF9C15`, `TCP1A72`, `CPD9CCB`, `CPF9C59`, `CPF7E12`,
//! `TCP1A73`, `TCP1A75`).

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::io::{self, BufReader, Cursor, Read, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use dap::{Credentials, DebugBackend, Failure, Options, RunningCommand};
use qap_client::proto::ops::debug::{
    BreakpointSet, DebugModule, DebugTarget, Frame, LineBreakpoint, ResumeHow, Variable, View,
};
use qap_client::proto::types::{JobId, ObjectName};
use qap_client::{CommandOutcome, DebugEvent, Error, ServerMessage, Status};
use serde_json::{Value, json};

pub const WAIT: Duration = Duration::from_secs(5);

pub fn refusal(status: Status, id: &str, text: &str) -> Error {
    Error::Status {
        status,
        message: Some(ServerMessage {
            id: id.into(),
            severity: 40,
            data: Vec::new(),
            text: text.into(),
            help: String::new(),
        }),
    }
}

pub fn msg(id: &str, text: &str) -> ServerMessage {
    ServerMessage {
        id: id.into(),
        severity: 0,
        data: Vec::new(),
        text: text.into(),
        help: String::new(),
    }
}

pub fn job(number: &str, user: &str, name: &str) -> JobId {
    JobId {
        number: number.into(),
        user: user.into(),
        name: name.into(),
    }
}

pub fn program(lib: &str, name: &str) -> ObjectName {
    ObjectName {
        library: lib.into(),
        name: name.into(),
    }
}

pub fn module(name: &str, views: &[View]) -> DebugModule {
    DebugModule {
        name: name.into(),
        views: views.to_vec(),
    }
}

pub fn frame(
    lib: &str,
    pgm: &str,
    module: &str,
    proc: &str,
    stmt: u32,
    line: u32,
    view: View,
) -> Frame {
    Frame {
        program: program(lib, pgm),
        module: module.into(),
        procedure: proc.into(),
        stmt,
        line,
        view,
    }
}

pub fn var(name: &str, ty: &str, value: &str, expandable: bool) -> Variable {
    Variable {
        name: name.into(),
        r#type: ty.into(),
        value: value.into(),
        expandable,
    }
}

/// The canned server: what each operation answers, and every call made.
#[derive(Default)]
pub struct Script {
    pub calls: Vec<String>,
    pub events: Option<Sender<DebugEvent>>,
    pub start: Option<Error>,
    pub job: Option<JobId>,
    /// `AddProgram` by `LIB/NAME TYPE`; absent is `NotFound` (`CPF9801`).
    pub programs: HashMap<String, Result<Vec<DebugModule>, Error>>,
    /// `SetBreakpoints`: where each line lands (`line` → `line`), or a refusal.
    pub moves: HashMap<u32, u32>,
    pub breakpoints_error: Option<Error>,
    pub stack: Vec<Frame>,
    /// When set, `Stack` waits for a message on it first.
    pub stack_gate: Option<Receiver<()>>,
    /// `Variables` by parent (`""` the frame's own).
    pub variables: HashMap<String, Vec<Variable>>,
    /// `Eval` by expression; absent is `CPF7E12`.
    pub evals: HashMap<String, String>,
    /// The `CALL`'s outcome, sent when the test says.
    pub call: Option<Receiver<Result<CommandOutcome, Error>>>,
    pub cancelled: bool,
    /// Keeps a `CALL` with no outcome planned waiting.
    pub call_keep: Vec<Sender<Result<CommandOutcome, Error>>>,
    pub resume_error: Option<Error>,
}

#[derive(Clone, Default)]
pub struct Mock(pub Arc<Mutex<Script>>);

impl Mock {
    pub fn script(&self) -> MutexGuard<'_, Script> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn calls(&self) -> Vec<String> {
        self.script().calls.clone()
    }

    fn note(&self, call: String) {
        self.script().calls.push(call);
    }

    /// Sends a `Debug` event as the connection's thread would.
    pub fn event(&self, ev: DebugEvent) {
        let tx = self.script().events.clone().expect("no session started");
        tx.send(ev).expect("receiver gone");
    }

    /// The connection closed: the receiver disconnects.
    pub fn close_events(&self) {
        self.script().events = None;
    }

    /// `ASSETS` with one source module, the connection job `123456/QUSER/QAPCNN`.
    pub fn assets() -> Mock {
        let m = Mock::default();
        {
            let mut s = m.script();
            s.job = Some(job("123456", "QUSER", "QAPCNN"));
            s.programs.insert(
                "HLINV/ASSETS *PGM".into(),
                Ok(vec![module("ASSETS", &[View::Statement, View::Source])]),
            );
        }
        m
    }
}

struct Running {
    rx: Receiver<Result<CommandOutcome, Error>>,
    mock: Mock,
}

impl RunningCommand for Running {
    fn wait_for(&self, timeout: Duration) -> Option<Result<CommandOutcome, Error>> {
        self.rx.recv_timeout(timeout).ok()
    }
    fn cancel(&self) {
        self.mock.note("Cancel".into());
        self.mock.script().cancelled = true;
    }
}

impl DebugBackend for Mock {
    fn job(&mut self) -> Result<Option<JobId>, Error> {
        Ok(self.script().job.clone())
    }
    fn start(&mut self, target: DebugTarget) -> Result<Receiver<DebugEvent>, Error> {
        self.note(match &target {
            DebugTarget::Own => "Start Own".into(),
            DebugTarget::Job { job } => {
                format!("Start Job {}/{}/{}", job.number, job.user, job.name)
            }
        });
        let mut s = self.script();
        if let Some(e) = s.start.take() {
            return Err(e);
        }
        let (tx, rx) = mpsc::channel();
        s.events = Some(tx);
        Ok(rx)
    }
    fn end(&mut self) -> Result<(), Error> {
        self.note("End".into());
        Ok(())
    }
    fn add_program(&mut self, p: &ObjectName, ty: &str) -> Result<Vec<DebugModule>, Error> {
        let key = format!("{}/{} {ty}", p.library, p.name);
        self.note(format!("AddProgram {key}"));
        match self.script().programs.get(&key) {
            Some(Ok(m)) => Ok(m.clone()),
            Some(Err(Error::Status { status, message })) => Err(Error::Status {
                status: *status,
                message: message.clone(),
            }),
            _ => Err(refusal(
                Status::NotFound,
                "CPF9801",
                &format!("Object {} in library {} not found.", p.name, p.library),
            )),
        }
    }
    fn set_breakpoints(
        &mut self,
        p: &ObjectName,
        module: &str,
        lines: &[LineBreakpoint],
    ) -> Result<Vec<BreakpointSet>, Error> {
        let asked: Vec<String> = lines
            .iter()
            .map(|l| match &l.condition {
                Some(c) => format!("{} if {c}", l.line),
                None => l.line.to_string(),
            })
            .collect();
        self.note(format!(
            "SetBreakpoints {}/{} {module} [{}]",
            p.library,
            p.name,
            asked.join(", ")
        ));
        let mut s = self.script();
        if let Some(e) = s.breakpoints_error.take() {
            return Err(e);
        }
        Ok(lines
            .iter()
            .map(|l| {
                let line = s.moves.get(&l.line).copied().unwrap_or(l.line);
                BreakpointSet { line, stmt: line }
            })
            .collect())
    }
    fn resume(&mut self, how: ResumeHow) -> Result<(), Error> {
        self.note(format!("Resume {how:?}"));
        match self.script().resume_error.take() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
    fn stack(&mut self) -> Result<Vec<Frame>, Error> {
        self.note("Stack".into());
        let gate = self.script().stack_gate.take();
        if let Some(g) = gate {
            let _ = g.recv_timeout(WAIT);
        }
        Ok(self.script().stack.clone())
    }
    fn variables(&mut self, frame: u32, parent: Option<&str>) -> Result<Vec<Variable>, Error> {
        self.note(format!("Variables {frame} {}", parent.unwrap_or("-")));
        Ok(self
            .script()
            .variables
            .get(parent.unwrap_or(""))
            .cloned()
            .unwrap_or_default())
    }
    fn eval(&mut self, frame: u32, expression: &str) -> Result<String, Error> {
        self.note(format!("Eval {frame} {expression}"));
        let found = self.script().evals.get(expression).cloned();
        found.ok_or_else(|| {
            refusal(
                Status::Error,
                "CPF7E12",
                &format!("{expression} is not a variable of the stopped entry"),
            )
        })
    }
    fn set_service_entry(&mut self, p: &ObjectName, user: &str) -> Result<(), Error> {
        self.note(format!("SetServiceEntry {}/{} {user}", p.library, p.name));
        Ok(())
    }
    fn remove_service_entry(&mut self, p: &ObjectName) -> Result<(), Error> {
        self.note(format!("RemoveServiceEntry {}/{}", p.library, p.name));
        Ok(())
    }
    fn run_command(&mut self, command: &str) -> Result<Box<dyn RunningCommand>, Error> {
        self.note(format!("RunCommand {command}"));
        let mut s = self.script();
        let rx = s.call.take().unwrap_or_else(|| {
            let (tx, rx) = mpsc::channel();
            s.call_keep.push(tx);
            rx
        });
        drop(s);
        Ok(Box::new(Running {
            rx,
            mock: self.clone(),
        }))
    }
    fn sign_off(&mut self) {
        self.note("SignOff".into());
    }
}

/// Bytes in, read as the adapter's stdin.
struct PipeIn {
    rx: Receiver<Vec<u8>>,
    buf: Cursor<Vec<u8>>,
}

impl Read for PipeIn {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        loop {
            let n = self.buf.read(out)?;
            if n > 0 {
                return Ok(n);
            }
            match self.rx.recv() {
                Ok(b) => self.buf = Cursor::new(b),
                Err(_) => return Ok(0),
            }
        }
    }
}

/// The adapter's stdout, one message per frame.
struct PipeOut {
    tx: Sender<Value>,
    buf: Vec<u8>,
}

impl Write for PipeOut {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        let mut r = io::BufReader::new(Cursor::new(std::mem::take(&mut self.buf)));
        while let Some(body) = host_rpc::framing::read_frame(&mut r)? {
            let _ = self
                .tx
                .send(serde_json::from_slice(&body).map_err(io::Error::other)?);
        }
        Ok(())
    }
}

/// A DAP client of an adapter served on a thread, with `mock` behind it.
pub struct Client {
    tx: Option<Sender<Vec<u8>>>,
    rx: Receiver<Value>,
    seq: i64,
    /// Messages read but not yet asked for, in order.
    pub seen: VecDeque<Value>,
    /// Every message read, in order.
    pub log: Vec<Value>,
    pub done: Option<thread::JoinHandle<()>>,
    /// What the credentials passed to `connect` were.
    pub signed_on: Arc<Mutex<Vec<String>>>,
}

/// What `connect` answers instead of the mock.
pub type Refuse = Option<Failure>;

impl Client {
    pub fn new(mock: &Mock) -> Client {
        Client::with(mock, None)
    }

    pub fn with(mock: &Mock, refuse: Refuse) -> Client {
        let (in_tx, in_rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel();
        let signed_on = Arc::new(Mutex::new(Vec::new()));
        let seen_on = Arc::clone(&signed_on);
        let m = mock.clone();
        let connect: dap::Connect = Box::new(move |c: &Credentials| {
            seen_on
                .lock()
                .unwrap()
                .push(format!("{}:{}@{}", c.user, c.password, c.host));
            if let Some(f) = &refuse {
                return Err(f.clone());
            }
            Ok(Box::new(m.clone()) as Box<dyn DebugBackend>)
        });
        let done = thread::spawn(move || {
            let input = BufReader::new(PipeIn {
                rx: in_rx,
                buf: Cursor::new(Vec::new()),
            });
            let output = Box::new(PipeOut {
                tx: out_tx,
                buf: Vec::new(),
            });
            dap::serve(
                input,
                output,
                connect,
                Options {
                    ask_timeout: Duration::from_millis(300),
                },
            )
            .unwrap();
        });
        Client {
            tx: Some(in_tx),
            rx: out_rx,
            seq: 0,
            seen: VecDeque::new(),
            log: Vec::new(),
            done: Some(done),
            signed_on,
        }
    }

    fn write(&mut self, msg: &Value) {
        let body = serde_json::to_vec(msg).unwrap();
        let mut frame = Vec::new();
        host_rpc::framing::write_frame(&mut frame, &body).unwrap();
        self.tx.as_ref().unwrap().send(frame).unwrap();
    }

    /// Sends a request; its `seq`.
    pub fn send(&mut self, command: &str, arguments: Value) -> i64 {
        self.seq += 1;
        let seq = self.seq;
        self.write(
            &json!({ "seq": seq, "type": "request", "command": command, "arguments": arguments }),
        );
        seq
    }

    fn next(&mut self, deadline: Instant) -> Option<Value> {
        let left = deadline.saturating_duration_since(Instant::now());
        let m = self.rx.recv_timeout(left).ok()?;
        self.log.push(m.clone());
        Some(m)
    }

    /// The first message read (or still to come) that `pick` takes.
    pub fn find(&mut self, what: &str, pick: impl Fn(&Value) -> bool) -> Value {
        if let Some(i) = self.seen.iter().position(&pick) {
            return self.seen.remove(i).unwrap();
        }
        let deadline = Instant::now() + WAIT;
        loop {
            let Some(m) = self.next(deadline) else {
                panic!("no {what} within {WAIT:?}; read {:#?}", self.log);
            };
            if pick(&m) {
                return m;
            }
            self.seen.push_back(m);
        }
    }

    pub fn response(&mut self, seq: i64) -> Value {
        self.find(&format!("response to {seq}"), |m| {
            m["type"] == "response" && m["request_seq"] == seq
        })
    }

    /// Sends a request and waits for its response.
    pub fn request(&mut self, command: &str, arguments: Value) -> Value {
        let seq = self.send(command, arguments);
        self.response(seq)
    }

    /// A request that must succeed; its body.
    pub fn ok(&mut self, command: &str, arguments: Value) -> Value {
        let r = self.request(command, arguments);
        assert_eq!(r["success"], true, "{command} failed: {r:#}");
        r["body"].clone()
    }

    pub fn event(&mut self, name: &str) -> Value {
        self.find(&format!("event {name}"), |m| {
            m["type"] == "event" && m["event"] == name
        })
    }

    /// Whether an event came within `wait`, without taking it.
    pub fn has_event(&mut self, name: &str, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        loop {
            if self
                .seen
                .iter()
                .any(|m| m["type"] == "event" && m["event"] == name)
            {
                return true;
            }
            match self.next(deadline) {
                Some(m) => self.seen.push_back(m),
                None => return false,
            }
        }
    }

    /// Debug Console lines read so far (after waiting `wait` for more).
    pub fn console(&mut self, wait: Duration) -> Vec<String> {
        let deadline = Instant::now() + wait;
        while let Some(m) = self.next(deadline) {
            self.seen.push_back(m);
        }
        self.log
            .iter()
            .filter(|m| m["event"] == "output")
            .map(|m| {
                m["body"]["output"]
                    .as_str()
                    .unwrap_or("")
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }

    /// The end of the input: the adapter's loop ends.
    pub fn close(&mut self) {
        self.tx = None;
        if let Some(d) = self.done.take() {
            d.join().unwrap();
        }
    }
}

pub fn credentials() -> Value {
    json!({ "host": "qshq400", "user": "CWELLMAN", "password": "secret" })
}

/// `initialize`, then `launch` of `Call` on `HLINV/ASSETS` with `extra`
/// merged into the arguments; the launch response.
pub fn launch_call(c: &mut Client, extra: Value) -> Value {
    c.ok("initialize", json!({ "adapterID": "qs400" }));
    let mut args = json!({
        "program": "HLINV/ASSETS",
        "command": "CALL PGM(HLINV/ASSETS)",
        "qs400": credentials(),
    });
    if let (Some(a), Some(e)) = (args.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            a.insert(k.clone(), v.clone());
        }
    }
    c.request("launch", args)
}
