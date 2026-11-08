// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! What the adapter needs from its QAP connection.
//!
//! `qap-client`'s `Debugger` is a trait over `Requests`, whose methods are
//! generic, so it cannot be called through a trait object. [`DebugBackend`]
//! is the same operations as an object-safe trait (each method the
//! `Debugger` call of the same name), plus the connection job's name, the
//! `CALL` the session debugs, and the sign-off. `code-host`'s `debug`
//! module implements it for `qap-client`'s `Client`; tests implement it
//! with canned replies.

use std::sync::mpsc::Receiver;
use std::time::Duration;

use qap_client::proto::ops::debug::{
    BreakpointSet, DebugModule, DebugTarget, Frame, LineBreakpoint, ResumeHow, Variable,
};
use qap_client::proto::types::{JobId, ObjectName};
use qap_client::{CommandOutcome, DebugEvent, Error};
use serde::Deserialize;

/// The `Debug` service's operations on one connection, and what the
/// session needs around them.
pub trait DebugBackend: Send {
    /// `JobInfo`: the connection's own job, the one `Own` debugs. `None`
    /// when the server has no `JobInfo`.
    fn job(&mut self) -> Result<Option<JobId>, Error>;
    /// `Start`, and the receiver its events arrive on.
    fn start(&mut self, target: DebugTarget) -> Result<Receiver<DebugEvent>, Error>;
    /// `End`.
    fn end(&mut self) -> Result<(), Error>;
    /// `AddProgram`: its modules and their views.
    fn add_program(&mut self, program: &ObjectName, ty: &str) -> Result<Vec<DebugModule>, Error>;
    /// `SetBreakpoints`: where each landed, in order.
    fn set_breakpoints(
        &mut self,
        program: &ObjectName,
        module: &str,
        lines: &[LineBreakpoint],
    ) -> Result<Vec<BreakpointSet>, Error>;
    /// `Resume`.
    fn resume(&mut self, how: ResumeHow) -> Result<(), Error>;
    /// `Stack`: the newest frame first.
    fn stack(&mut self) -> Result<Vec<Frame>, Error>;
    /// `Variables`.
    fn variables(&mut self, frame: u32, parent: Option<&str>) -> Result<Vec<Variable>, Error>;
    /// `Eval`.
    fn eval(&mut self, frame: u32, expression: &str) -> Result<String, Error>;
    /// `SetServiceEntry`.
    fn set_service_entry(&mut self, program: &ObjectName, user: &str) -> Result<(), Error>;
    /// `RemoveServiceEntry`.
    fn remove_service_entry(&mut self, program: &ObjectName) -> Result<(), Error>;
    /// `RunCommand`, sent and not waited for: the `CALL` an `Own` session
    /// debugs. Its reply comes when the command ends.
    fn run_command(&mut self, command: &str) -> Result<Box<dyn RunningCommand>, Error>;
    /// Signs off and closes the connection; errors are of no use here.
    fn sign_off(&mut self);
}

/// A `RunCommand` sent: waited for in steps, so a cancel can come between.
pub trait RunningCommand: Send {
    /// The outcome if it comes within `timeout`, else `None`.
    fn wait_for(&self, timeout: Duration) -> Option<Result<CommandOutcome, Error>>;
    /// Asks the server to stop the command (`Cancel`).
    fn cancel(&self);
}

/// The sign-on the extension passes in `launch` and `attach`, under
/// `qs400`. Not `Debug`: it holds the password.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    pub user: String,
    pub password: String,
    /// PEM file of certificates to trust beyond the platform's store.
    #[serde(default)]
    pub ca_file: Option<String>,
}

/// Opens a connection, signs on and checks the version: what `serve`
/// calls with the `launch` or `attach` credentials.
pub type Connect = Box<dyn Fn(&Credentials) -> Result<Box<dyn DebugBackend>, Failure> + Send>;

/// Why a request failed, as the DAP error response carries it: the
/// server's message ID and text, as sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    /// `ID: text` for a server message, else the adapter's own words.
    pub message: String,
    /// The server's message ID (`CPF9C15`), when it sent one.
    pub message_id: Option<String>,
    /// Whether VS Code should show it.
    pub show_user: bool,
}

/// What every `Debug` operation answers on a server that agreed a version
/// below 9.
pub const QAP_UNAVAILABLE: &str = "QAP version 9 not available on this server";

impl Failure {
    /// The adapter's own message, shown.
    pub fn new(message: impl Into<String>) -> Failure {
        Failure {
            message: message.into(),
            message_id: None,
            show_user: true,
        }
    }

    /// The same, not shown (a hover, a watch).
    #[must_use]
    pub fn quiet(mut self) -> Failure {
        self.show_user = false;
        self
    }
}

impl From<&Error> for Failure {
    fn from(e: &Error) -> Failure {
        match e {
            Error::Unsupported { .. } => Failure::new(QAP_UNAVAILABLE),
            _ => Failure {
                message: e.to_string(),
                message_id: e
                    .server_message()
                    .map(|m| m.id.trim().to_owned())
                    .filter(|id| !id.is_empty()),
                show_user: true,
            },
        }
    }
}

impl From<Error> for Failure {
    fn from(e: Error) -> Failure {
        Failure::from(&e)
    }
}

/// `LIB/NAME` (or `NAME`, `*LIBL`) as an object name, upper-cased.
pub fn object_name(s: &str) -> Result<ObjectName, Failure> {
    let s = s.trim().to_ascii_uppercase();
    let (library, name) = match s.split_once('/') {
        Some((l, n)) => (l.trim().to_owned(), n.trim().to_owned()),
        None => ("*LIBL".to_owned(), s.clone()),
    };
    if name.is_empty() || library.is_empty() || name.contains('/') {
        return Err(Failure::new(format!("not a program name: {s:?}")));
    }
    Ok(ObjectName { library, name })
}

/// `LIB/NAME`.
pub fn object_text(o: &ObjectName) -> String {
    format!("{}/{}", o.library.trim(), o.name.trim())
}

/// `nnnnnn/USER/NAME` as a job.
pub fn job_id(s: &str) -> Result<JobId, Failure> {
    let parts: Vec<&str> = s.trim().split('/').map(str::trim).collect();
    match parts.as_slice() {
        [number, user, name]
            if number.len() == 6
                && number.bytes().all(|b| b.is_ascii_digit())
                && !user.is_empty()
                && !name.is_empty() =>
        {
            Ok(JobId {
                number: (*number).to_owned(),
                user: user.to_ascii_uppercase(),
                name: name.to_ascii_uppercase(),
            })
        }
        _ => Err(Failure::new(format!(
            "not a qualified job name (nnnnnn/USER/NAME): {s:?}"
        ))),
    }
}

/// `nnnnnn/USER/NAME`.
pub fn job_text(j: &JobId) -> String {
    format!("{}/{}/{}", j.number.trim(), j.user.trim(), j.name.trim())
}
