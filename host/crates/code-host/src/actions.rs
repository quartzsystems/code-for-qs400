// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `action.*`: commands the extension's actions run in the connection job,
//! thin over `qap-client`'s `Command` (version 2) and `Develop`'s
//! `Compile` (version 8), through [`Sessions::command`].
//!
//! - `action.check` is `CheckCommand`: the command's syntax checked,
//!   nothing run. It waits in the connection job's lane like every
//!   `Command` request, so it is answered on a thread of its own and the
//!   session is held only to send it; the wait is `qap-client`'s reply
//!   timeout.
//! - `action.run` runs a command in the connection job: `kind: "compile"`
//!   is `Develop::compile` (version 8), whose reply carries the compiler's
//!   diagnostics; `kind: "command"` is `RunCommand` (version 2). The
//!   extension picks the kind from the command's name; the host takes it as
//!   given. Both wait in the lane with no reply timeout, so the method is
//!   deferred: the session is held only to send, a thread waits for the
//!   reply, and `action.cancel` meanwhile asks the server to stop it
//!   (`Pending::cancel`). A run cancelled while it waited in the lane comes
//!   back `Cancelled` with no job and no messages; one cancelled once it
//!   started comes back `Cancelled` with its body.
//! - The outcome is `qap-client`'s `CompileOutcome` or `CommandOutcome` as
//!   it came: `Ok`, `Error` (the escape message, the body still filled),
//!   `NotFound`, `NotAuthorized` or `Cancelled` are a result, never an
//!   error; any other status is the server's refusal (`-32010`).
//! - Commands go as typed; the server checks and folds them. Nothing here
//!   parses a command, and the host log names the run, never its command.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use host_rpc::{Context, Registry, Responder, RpcError};
use qap_client::proto::ServerMessage;
use qap_client::proto::types::{Diagnostic, JobId, Where};
use qap_client::{CheckOutcome, CommandOutcome, CompileOutcome, Error, Pending};
use serde::{Deserialize, Serialize};

use crate::session::{JobDto, QAP_COMMAND, QAP_DEVELOP, Sessions, rpc_error};
use crate::{LogLevel, log};

/// How often a waiting run looks for a cancel.
const CANCEL_EVERY: Duration = Duration::from_millis(50);

/// A message as the extension shows it: the server's own, with its
/// second-level text when it has one. Substitution data is not passed on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub severity: u8,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub second_level: Option<String>,
}

impl From<ServerMessage> for MessageDto {
    fn from(m: ServerMessage) -> MessageDto {
        MessageDto {
            id: m.id,
            severity: m.severity,
            text: m.text,
            second_level: (!m.help.trim().is_empty()).then_some(m.help),
        }
    }
}

/// Params of `action.check`.
#[derive(Debug, Deserialize)]
pub struct CheckParams {
    pub name: String,
    pub command: String,
}

/// Result of `action.check`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckDto {
    /// `Ok`, `Error` or `NotFound`.
    pub status: String,
    /// Whether the command is valid.
    pub valid: bool,
    /// The check's messages; none when the command is valid.
    pub messages: Vec<MessageDto>,
}

impl From<CheckOutcome> for CheckDto {
    fn from(o: CheckOutcome) -> CheckDto {
        CheckDto {
            status: format!("{:?}", o.status),
            valid: o.valid(),
            messages: o.messages.into_iter().map(MessageDto::from).collect(),
        }
    }
}

/// The command, trimmed; `-32602` when it is empty.
pub(crate) fn command_param(command: &str) -> Result<&str, RpcError> {
    let c = command.trim();
    if c.is_empty() {
        return Err(RpcError::invalid_params("command is empty"));
    }
    Ok(c)
}

/// `action.check`, to its end.
pub fn check(s: &Sessions, p: &CheckParams) -> Result<CheckDto, RpcError> {
    let command = command_param(&p.command)?;
    let (pending, timeout): (Pending, _) = s.command(&p.name, QAP_COMMAND, |c| {
        Ok((c.send_check(command)?, c.reply_timeout()))
    })?;
    pending
        .wait(timeout)
        .and_then(CheckOutcome::from_reply)
        .map(CheckDto::from)
        .map_err(|e: Error| rpc_error(&e))
}

/// Which QAP call runs a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// `Develop::compile`: the outcome carries diagnostics.
    Compile,
    /// `RunCommand`.
    Command,
}

/// Params of `action.run`.
#[derive(Debug, Deserialize)]
pub struct RunParams {
    /// The connection.
    pub name: String,
    pub command: String,
    pub kind: Kind,
    /// The ID `action.cancel` names; the host makes one when absent.
    #[serde(default)]
    pub run: Option<String>,
}

/// Params of `action.cancel`. `name` is taken and not checked: run IDs
/// are the host's, not per connection.
#[derive(Debug, Deserialize)]
pub struct CancelParams {
    #[serde(default)]
    pub name: Option<String>,
    pub run: String,
}

/// Where a diagnostic points, as JSON names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WhereDto {
    /// A line of a source member: the compiled one or a `/COPY` member.
    Member {
        library: String,
        file: String,
        member: String,
    },
    /// A line of a stream file.
    Path { path: String },
    /// Nowhere in the source.
    None,
}

impl From<Where> for WhereDto {
    fn from(w: Where) -> WhereDto {
        match w {
            Where::Member { member } => WhereDto::Member {
                library: member.file.library,
                file: member.file.name,
                member: member.member,
            },
            Where::Path { path } => WhereDto::Path { path },
            Where::None => WhereDto::None,
        }
    }
}

/// One compiler message, as the spec's `Diagnostic` has it: lines and
/// columns from 1, 0 unknown (`end_line` 0 is `line`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticDto {
    pub at: WhereDto,
    pub line: u32,
    pub column: u16,
    pub end_line: u32,
    pub end_column: u16,
    pub severity: u8,
    pub id: String,
    pub text: String,
    /// The second-level text.
    pub help: String,
}

impl From<Diagnostic> for DiagnosticDto {
    fn from(d: Diagnostic) -> DiagnosticDto {
        DiagnosticDto {
            at: d.r#where.into(),
            line: d.line,
            column: d.column,
            end_line: d.end_line,
            end_column: d.end_column,
            severity: d.severity,
            id: d.id,
            text: d.text,
            help: d.help,
        }
    }
}

fn job_dto(j: JobId) -> JobDto {
    JobDto {
        number: j.number,
        user: j.user,
        name: j.name,
    }
}

/// Result of `action.run`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutcomeDto {
    /// `Ok`, `Error`, `NotFound`, `NotAuthorized` or `Cancelled`.
    pub status: String,
    /// The escape message that ended it, when one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escape: Option<MessageDto>,
    /// The job it ran in; none when it was cancelled in the lane.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<JobDto>,
    /// Every message it sent its caller, oldest first.
    pub messages: Vec<MessageDto>,
    /// The compiler's; always empty for `kind: "command"`.
    pub diagnostics: Vec<DiagnosticDto>,
}

impl From<CompileOutcome> for OutcomeDto {
    fn from(o: CompileOutcome) -> OutcomeDto {
        OutcomeDto {
            status: format!("{:?}", o.status),
            escape: o.escape.map(MessageDto::from),
            job: o.job.map(job_dto),
            messages: o.messages.into_iter().map(MessageDto::from).collect(),
            diagnostics: o.diagnostics.into_iter().map(DiagnosticDto::from).collect(),
        }
    }
}

impl From<CommandOutcome> for OutcomeDto {
    fn from(o: CommandOutcome) -> OutcomeDto {
        OutcomeDto {
            status: format!("{:?}", o.status),
            escape: o.escape.map(MessageDto::from),
            job: o.job.map(job_dto),
            messages: o.messages.into_iter().map(MessageDto::from).collect(),
            diagnostics: Vec::new(),
        }
    }
}

/// The runs waiting for their reply, by ID, each with its cancel flag.
#[derive(Default)]
pub struct Runs {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    made: AtomicU64,
}

impl Runs {
    fn running(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn begin(&self, asked: Option<&str>) -> Result<(String, Arc<AtomicBool>), RpcError> {
        let id = match asked {
            Some("") => return Err(RpcError::invalid_params("run is empty")),
            Some(r) => r.to_owned(),
            None => format!("r{}", self.made.fetch_add(1, Ordering::SeqCst) + 1),
        };
        let mut running = self.running();
        if running.contains_key(&id) {
            return Err(RpcError::invalid_params(format!("run {id} is running")));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        running.insert(id.clone(), Arc::clone(&cancel));
        Ok((id, cancel))
    }

    fn end(&self, id: &str) {
        self.running().remove(id);
    }

    /// Asks a run to stop; false when none has that ID.
    pub fn cancel(&self, id: &str) -> bool {
        match self.running().get(id) {
            Some(c) => {
                c.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }
}

/// The reply to `pending`, however long it takes; cancelled once when
/// `cancel` is set, its final reply still waited for.
fn wait(pending: &Pending, cancel: &AtomicBool) -> Result<qap_client::Reply, Error> {
    let mut cancelled = false;
    loop {
        if !cancelled && cancel.load(Ordering::SeqCst) {
            pending.cancel();
            cancelled = true;
        }
        if let Some(reply) = pending.wait_for(CANCEL_EVERY) {
            return reply;
        }
    }
}

/// `action.run`, to its end.
pub fn run(s: &Sessions, p: &RunParams, cancel: &AtomicBool) -> Result<OutcomeDto, RpcError> {
    let command = command_param(&p.command)?;
    let pending = match p.kind {
        Kind::Compile => s.command(&p.name, QAP_DEVELOP, |c| c.compile(command))?,
        Kind::Command => s.command(&p.name, QAP_COMMAND, |c| c.run_command(command))?,
    };
    let reply = wait(&pending, cancel).map_err(|e| rpc_error(&e))?;
    let out = match p.kind {
        Kind::Compile => CompileOutcome::from_reply(reply).map(OutcomeDto::from),
        Kind::Command => CommandOutcome::from_reply(reply).map(OutcomeDto::from),
    };
    out.map_err(|e| rpc_error(&e))
}

/// Answers `responder` with `run()` on a thread named `name`.
pub(crate) fn on_thread<R: Serialize + 'static>(
    name: String,
    responder: Responder,
    run: impl FnOnce() -> Result<R, RpcError> + Send + 'static,
) {
    // When the thread cannot start, the closure and the responder with it
    // are dropped, which answers the request.
    let _ = std::thread::Builder::new()
        .name(name)
        .spawn(move || responder.send(run()));
}

/// Registers `action.*`.
pub fn register(r: &mut Registry, sessions: &Arc<Sessions>) {
    let runs = Arc::new(Runs::default());
    let s = Arc::clone(sessions);
    let t = Arc::clone(&runs);
    r.register_deferred(
        "action.run",
        move |p: RunParams, ctx: &Context, responder: Responder| {
            let (id, cancel) = match t.begin(p.run.as_deref()) {
                Ok(r) => r,
                Err(e) => return responder.send::<OutcomeDto>(Err(e)),
            };
            let s = Arc::clone(&s);
            let t = Arc::clone(&t);
            let outbound = ctx.outbound().clone();
            on_thread(format!("action run {id}"), responder, move || {
                let kind = format!("{:?}", p.kind).to_lowercase();
                log(
                    &outbound,
                    LogLevel::Info,
                    format!("{}: run {id}: {kind}", p.name),
                );
                let out = run(&s, &p, &cancel);
                t.end(&id);
                let ended = match &out {
                    Ok(o) => o.status.clone(),
                    Err(e) => e.message.clone(),
                };
                log(
                    &outbound,
                    LogLevel::Info,
                    format!("{}: run {id}: {ended}", p.name),
                );
                out
            });
        },
    );
    let t = Arc::clone(&runs);
    r.register("action.cancel", move |p: CancelParams, _: &Context| {
        t.cancel(&p.run);
        Ok::<_, RpcError>(())
    });
    let s = Arc::clone(sessions);
    r.register_deferred(
        "action.check",
        move |p: CheckParams, _: &Context, responder: Responder| {
            let s = Arc::clone(&s);
            on_thread("action check".into(), responder, move || check(&s, &p));
        },
    );
}
