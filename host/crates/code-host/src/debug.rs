// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The debug adapter's connection: `qap-client`'s [`Client`] as a
//! [`dap::DebugBackend`], each method the `Debugger` call of the same
//! name, and [`connector`], which signs on with the `launch` or `attach`
//! credentials and refuses a server below version 9 before anything of
//! the session is sent.

use std::sync::mpsc::Receiver;
use std::time::Duration;

use dap::backend::QAP_UNAVAILABLE;
use dap::{Connect, Credentials, DebugBackend, Failure, RunningCommand};
use qap_client::proto::Op;
use qap_client::proto::ops::command::CommandText;
use qap_client::proto::ops::debug::{
    BreakpointSet, DebugModule, DebugTarget, Frame, LineBreakpoint, ResumeHow, Variable,
};
use qap_client::proto::types::{JobId, ObjectName};
use qap_client::{
    Client, CommandOutcome, DebugEvent, Debugger, Error, Pending, Requests, Secret, Target,
};

use qap_client::proto::ops::develop::SetLibraryList;

use crate::session::{DevelopBackend, QAP_ASKED, TlsParams, trust_for};

/// The version `Debug` needs.
pub const QAP_DEBUG: u16 = 9;

/// The adapter's own signed-on client.
pub struct QapDebug {
    client: Client,
}

impl DebugBackend for QapDebug {
    fn job(&mut self) -> Result<Option<JobId>, Error> {
        match self.client.job_info() {
            Ok(j) => Ok(Some(j.job)),
            Err(Error::Unsupported { .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }
    fn set_library_list(&mut self, current: Option<&str>, user: &[String]) -> Result<(), Error> {
        let request = SetLibraryList {
            current: current.map(|c| c.trim().to_ascii_uppercase()),
            user: user.iter().map(|l| l.trim().to_ascii_uppercase()).collect(),
        };
        DevelopBackend::set_library_list(&mut self.client, &request).map(|_| ())
    }
    fn start(&mut self, target: DebugTarget) -> Result<Receiver<DebugEvent>, Error> {
        Debugger::start(&mut self.client, target).map(|s| s.events)
    }
    fn end(&mut self) -> Result<(), Error> {
        Debugger::end(&mut self.client)
    }
    fn add_program(&mut self, program: &ObjectName, ty: &str) -> Result<Vec<DebugModule>, Error> {
        Debugger::add_program(&mut self.client, program, ty)
    }
    fn set_breakpoints(
        &mut self,
        program: &ObjectName,
        module: &str,
        lines: &[LineBreakpoint],
    ) -> Result<Vec<BreakpointSet>, Error> {
        Debugger::set_breakpoints(&mut self.client, program, module, lines)
    }
    fn resume(&mut self, how: ResumeHow) -> Result<(), Error> {
        Debugger::resume(&mut self.client, how)
    }
    fn stack(&mut self) -> Result<Vec<Frame>, Error> {
        Debugger::stack(&mut self.client)
    }
    fn variables(&mut self, frame: u32, parent: Option<&str>) -> Result<Vec<Variable>, Error> {
        Debugger::variables(&mut self.client, frame, parent)
    }
    fn eval(&mut self, frame: u32, expression: &str) -> Result<String, Error> {
        Debugger::eval(&mut self.client, frame, expression)
    }
    fn set_service_entry(&mut self, program: &ObjectName, user: &str) -> Result<(), Error> {
        Debugger::set_service_entry(&mut self.client, program, user)
    }
    fn remove_service_entry(&mut self, program: &ObjectName) -> Result<(), Error> {
        Debugger::remove_service_entry(&mut self.client, program)
    }
    fn run_command(&mut self, command: &str) -> Result<Box<dyn RunningCommand>, Error> {
        // What `Client::run_command` sends, waited for here in steps.
        let p = self.client.request_op(
            Op::RunCommand,
            &CommandText {
                command: command.to_owned(),
            },
        )?;
        Ok(Box::new(Running(p)))
    }
    fn sign_off(&mut self) {
        let _ = self.client.sign_off();
    }
}

struct Running(Pending);

impl RunningCommand for Running {
    fn wait_for(&self, timeout: Duration) -> Option<Result<CommandOutcome, Error>> {
        self.0
            .wait_for(timeout)
            .map(|r| r.and_then(CommandOutcome::from_reply))
    }
    fn cancel(&self) {
        self.0.cancel();
    }
}

/// Signs on as `launch` or `attach` says, at version 9 or not at all.
pub fn connector() -> Connect {
    Box::new(|c: &Credentials| {
        let trust = trust_for(&TlsParams {
            verify: None,
            ca_file: c.ca_file.clone(),
            certificates: c.certificates.clone(),
        })
        .map_err(|e| Failure::new(e.message))?;
        let port = c.port.unwrap_or(qap_client::proto::DEFAULT_PORT);
        let target = Target::new(c.host.clone(), port, trust).with_max_version(QAP_ASKED);
        let mut client = Client::new(target);
        client
            .sign_on(c.user.trim(), &Secret::new(c.password.clone()))
            .map_err(|e| Failure::from(&e))?;
        if client.version().unwrap_or_default() < QAP_DEBUG {
            let _ = client.sign_off();
            return Err(Failure::new(QAP_UNAVAILABLE));
        }
        Ok(Box::new(QapDebug { client }) as Box<dyn DebugBackend>)
    })
}
