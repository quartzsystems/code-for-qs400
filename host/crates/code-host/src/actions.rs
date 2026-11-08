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
//! - Commands go as typed; the server checks and folds them. Nothing here
//!   parses a command.

use std::sync::Arc;

use host_rpc::{Context, Registry, Responder, RpcError};
use qap_client::proto::ServerMessage;
use qap_client::{CheckOutcome, Error, Pending};
use serde::{Deserialize, Serialize};

use crate::session::{QAP_COMMAND, Sessions, rpc_error};

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
    let s = Arc::clone(sessions);
    r.register_deferred(
        "action.check",
        move |p: CheckParams, _: &Context, responder: Responder| {
            let s = Arc::clone(&s);
            on_thread("action check".into(), responder, move || check(&s, &p));
        },
    );
}
