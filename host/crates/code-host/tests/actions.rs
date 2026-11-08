// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `action.*` and `job.log` at the method-registry level, against canned
//! replies. The fake implements `qap-client`'s own [`Requests`], so the
//! host's calls go through `qap-client`'s real `Develop::compile`,
//! `Jobs::job_log`, `CompileOutcome`, `CommandOutcome` and `CheckOutcome`;
//! every request travels over a real `qap_client::Connection` on an
//! in-memory transport, answered by a canned server that can hold a
//! request in the lane until it is cancelled. Messages carry the IDs and
//! texts QS/400's commands and compilers send, passed through with their
//! second-level text.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use code_host::registry_with;
use code_host::session::{
    Backend, CommandBackend, DevelopBackend, Endpoint, Factory, IfsBackend, JobDto, Sessions,
    SystemDto, codes,
};
use host_rpc::{Context, Outbound, Registry, RpcError};
use qap_client::proto::ops::command::{CheckReply, CommandText};
use qap_client::proto::ops::connection::HelloReply;
use qap_client::proto::{Envelope, Kind, Op, Service};
use qap_client::{
    Connection, Error, Pending, Requests, Secret, ServerMessage, Status, Target, Wake, Wire,
};
use qsa_net::{Security, Transport};
use serde_json::{Value, json};

// The canned server.

/// A reply: status, message and encoded body.
type Answer = (Status, Option<ServerMessage>, Vec<u8>);

/// How the server answers the next request of an op.
#[allow(dead_code)] // `Hold`: the run tests cancel in the lane
enum Plan {
    /// At once.
    Now(Answer),
    /// Not until the request is cancelled; then this.
    Hold(Answer),
}

#[derive(Default)]
struct Script {
    /// The version agreed; `None` is 9.
    qap: Option<u16>,
    /// What to answer, per op, in order.
    plans: Vec<(Op, Plan)>,
    /// Each request, in order, as a line.
    asked: Vec<String>,
}

type Shared = Arc<Mutex<Script>>;

fn message(id: &str, severity: u8, text: &str, help: &str) -> ServerMessage {
    ServerMessage {
        id: id.into(),
        severity,
        data: Vec::new(),
        text: text.into(),
        help: help.into(),
    }
}

/// A body as the server encodes it.
fn body<B: Wire>(b: &B) -> Vec<u8> {
    let probe = Envelope::request(1, Op::RunCommand, &());
    Envelope::reply(&probe, Status::Ok, None, Vec::new())
        .with_body(b)
        .body
}

impl Script {
    fn plan(&mut self, op: Op, plan: Plan) {
        self.plans.push((op, plan));
    }

    fn next(&mut self, op: Op) -> Option<Plan> {
        let i = self.plans.iter().position(|(o, _)| *o == op)?;
        Some(self.plans.remove(i).1)
    }
}

/// The client's end of an in-memory connection: frames written are
/// answered by the script, the replies read back in order.
struct Canned {
    script: Shared,
    incoming: Vec<u8>,
    outgoing: VecDeque<u8>,
    /// Requests held, by request ID, with the answer a cancel gets.
    held: Vec<(Envelope, Answer)>,
    closed: bool,
}

impl Canned {
    fn send(&mut self, to: &Envelope, (status, msg, body): Answer) {
        for r in Envelope::replies(to, status, msg, body).expect("replies that frame") {
            let b = r.to_frame().expect("a frame");
            self.outgoing
                .extend((b.len() as u32).to_le_bytes().iter().chain(b.iter()));
        }
    }

    fn answer(&mut self, env: Envelope) {
        if env.kind == Kind::Cancel {
            if let Some(i) = self
                .held
                .iter()
                .position(|(e, _)| e.request_id == env.request_id)
            {
                let (held, answer) = self.held.remove(i);
                self.script.lock().unwrap().asked.push("Cancel".into());
                self.send(&held, answer);
            }
            return;
        }
        let Some(op) = env.operation() else { return };
        if op == Op::Hello {
            let version = self.script.lock().unwrap().qap.unwrap_or(9);
            let hello = HelloReply {
                version,
                system_name: "QSHQ400".into(),
                release: "V1R0M0".into(),
                services: Service::of_version(version),
                capabilities: Vec::new(),
                signon_methods: Vec::new(),
                server_time: 0,
                time_zone: "UTC".into(),
                system_ccsid: 37,
            };
            let b = body(&hello);
            self.send(&env, (Status::Ok, None, b));
            return;
        }
        let plan = {
            let mut s = self.script.lock().unwrap();
            let line = match op {
                Op::RunCommand | Op::CheckCommand | Op::Compile => format!(
                    "{op:?} {}",
                    env.body_as::<CommandText>().expect("a command").command
                ),
                _ => format!("{op:?}"),
            };
            s.asked.push(line);
            s.next(op)
        };
        match plan {
            Some(Plan::Now(a)) => self.send(&env, a),
            Some(Plan::Hold(a)) => self.held.push((env, a)),
            None => self.send(&env, (Status::InvalidRequest, None, Vec::new())),
        }
    }
}

impl Read for Canned {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.closed {
            return Ok(0);
        }
        if self.outgoing.is_empty() {
            std::thread::sleep(Duration::from_millis(1));
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let n = buf.len().min(self.outgoing.len());
        for (b, v) in buf.iter_mut().zip(self.outgoing.drain(..n)) {
            *b = v;
        }
        Ok(n)
    }
}

impl Write for Canned {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.incoming.extend_from_slice(buf);
        while self.incoming.len() >= 4 {
            let n = u32::from_le_bytes(self.incoming[..4].try_into().unwrap()) as usize;
            if self.incoming.len() < 4 + n {
                break;
            }
            let env = Envelope::from_frame(&self.incoming[4..4 + n]).expect("a frame that decodes");
            self.incoming.drain(..4 + n);
            self.answer(env);
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Transport for Canned {
    fn set_read_timeout(&mut self, _: Option<Duration>) -> io::Result<()> {
        Ok(())
    }
    fn poll_reads(&mut self, _: Duration) -> io::Result<()> {
        Ok(())
    }
    fn shutdown(&mut self) {
        self.closed = true;
    }
    fn security(&self) -> Security {
        Security::Plain
    }
    fn peer(&self) -> Option<SocketAddr> {
        None
    }
}

// The fake backend: qap-client's `Requests` over the canned connection.

struct Fake {
    script: Shared,
    conn: Option<Connection>,
}

impl Fake {
    fn version(&self) -> u16 {
        self.script.lock().unwrap().qap.unwrap_or(9)
    }

    fn conn(&mut self) -> Result<&Connection, Error> {
        if self.conn.is_none() {
            let canned = Canned {
                script: Arc::clone(&self.script),
                incoming: Vec::new(),
                outgoing: VecDeque::new(),
                held: Vec::new(),
                closed: false,
            };
            let target =
                Target::new("qshq400.example", 2320, qsa_net::Trust::default()).with_max_version(9);
            self.conn = Some(Connection::over(Box::new(canned), &target)?);
        }
        Ok(self.conn.as_ref().expect("opened above"))
    }
}

impl Requests for Fake {
    fn call_op<B: Wire, R: Wire>(&mut self, op: Op, body: &B) -> Result<R, Error> {
        self.conn()?.call(op, body)
    }
    fn request_op<B: Wire>(&mut self, op: Op, body: &B) -> Result<Pending, Error> {
        self.conn()?.request(op, body)
    }
    fn request_here_op<B: Wire>(&mut self, op: Op, body: &B) -> Result<Pending, Error> {
        self.conn()?.request(op, body)
    }
    fn reply_timeout(&self) -> Duration {
        Duration::from_secs(5)
    }
}

impl Backend for Fake {
    fn sign_on(&mut self, user: &str, _: &Secret) -> Result<String, Error> {
        Ok(user.to_owned())
    }
    fn change_password(&mut self, user: &str, _: &Secret, _: &Secret) -> Result<String, Error> {
        Ok(user.to_owned())
    }
    fn system(&mut self) -> Result<SystemDto, Error> {
        Ok(SystemDto {
            name: "QSHQ400".into(),
            product: "QS00SS1".into(),
            version: "V1R0M0".into(),
            serial: None,
            model: None,
            qap: self.version(),
        })
    }
    fn job(&mut self) -> Result<Option<JobDto>, Error> {
        Ok(Some(JobDto {
            number: "123456".into(),
            user: "QUSER".into(),
            name: "QAPCNN".into(),
        }))
    }
    fn sign_off(&mut self) -> Result<(), Error> {
        Ok(())
    }
    fn reconnect(&mut self) -> Result<bool, Error> {
        Ok(true)
    }
    fn live(&self) -> bool {
        true
    }
    fn develop(&mut self) -> &mut dyn DevelopBackend {
        self
    }
    fn ifs(&mut self) -> &mut dyn IfsBackend {
        unreachable!("these tests send no Ifs request")
    }
    fn command(&mut self) -> &mut dyn CommandBackend {
        self
    }
}

// The host.

struct Host {
    script: Shared,
    registry: Arc<Registry>,
    outbound: Outbound,
}

impl Host {
    /// A host with `QSHQ400` signed on at `qap` (`None`: 9).
    fn at(qap: Option<u16>) -> Host {
        let script: Shared = Arc::default();
        script.lock().unwrap().qap = qap;
        let s = Arc::clone(&script);
        let factory: Factory = Arc::new(move |_: &Endpoint, _: Wake| {
            Ok(Box::new(Fake {
                script: Arc::clone(&s),
                conn: None,
            }) as Box<dyn Backend>)
        });
        let outbound = Outbound::new(io::sink());
        let sessions = Sessions::new(factory, outbound.clone());
        let h = Host {
            script,
            registry: Arc::new(registry_with(&sessions)),
            outbound,
        };
        h.call(
            "session.connect",
            json!({"name":"QSHQ400","host":"qshq400.example","user":"cwellman","password":"secret"}),
        )
        .unwrap();
        h
    }

    fn new() -> Host {
        Host::at(None)
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.registry
            .dispatch(method, params, &Context::new(self.outbound.clone()))
    }

    fn script(&self) -> MutexGuard<'_, Script> {
        self.script.lock().unwrap()
    }

    fn plan(&self, op: Op, plan: Plan) {
        self.script().plan(op, plan);
    }

    fn asked(&self) -> Vec<String> {
        std::mem::take(&mut self.script().asked)
    }
}

// action.check

const CPD0030: (&str, &str) = (
    "Command CRTBNDRPGX in library *LIBL not found.",
    "Cause . . . . . :   The command CRTBNDRPGX was not found in the libraries of the library list.",
);

#[test]
fn check_valid_command_has_no_messages() {
    let h = Host::new();
    h.plan(
        Op::CheckCommand,
        Plan::Now((Status::Ok, None, body(&CheckReply { messages: vec![] }))),
    );
    let out = h
        .call(
            "action.check",
            json!({"name":"QSHQ400","command":"CRTBNDRPG PGM(QTEMP/SAMPLE) SRCFILE(QTEMP/QRPGLESRC)"}),
        )
        .unwrap();
    assert_eq!(out, json!({"status":"Ok","valid":true,"messages":[]}));
    assert_eq!(
        h.asked(),
        vec!["CheckCommand CRTBNDRPG PGM(QTEMP/SAMPLE) SRCFILE(QTEMP/QRPGLESRC)"]
    );
}

#[test]
fn check_bad_command_answers_the_server_messages_unchanged() {
    let h = Host::new();
    let m = message("CPD0030", 30, CPD0030.0, CPD0030.1);
    h.plan(
        Op::CheckCommand,
        Plan::Now((
            Status::NotFound,
            None,
            body(&CheckReply { messages: vec![m] }),
        )),
    );
    let out = h
        .call(
            "action.check",
            json!({"name":"QSHQ400","command":"CRTBNDRPGX PGM(QTEMP/SAMPLE)"}),
        )
        .unwrap();
    assert_eq!(
        out,
        json!({"status":"NotFound","valid":false,"messages":[
            {"id":"CPD0030","severity":30,"text":CPD0030.0,"secondLevel":CPD0030.1}
        ]})
    );
}

#[test]
fn check_empty_command_sends_nothing() {
    let h = Host::new();
    let e = h
        .call("action.check", json!({"name":"QSHQ400","command":"   "}))
        .unwrap_err();
    assert_eq!(e.code, host_rpc::codes::INVALID_PARAMS);
    assert!(h.asked().is_empty());
}

#[test]
fn check_on_a_session_that_is_not_signed_on() {
    let h = Host::new();
    let e = h
        .call("action.check", json!({"name":"OTHER","command":"DSPLIBL"}))
        .unwrap_err();
    assert_eq!(e.code, codes::NOT_CONNECTED);
}

#[test]
fn check_refused_status_is_a_server_error() {
    let h = Host::new();
    h.plan(
        Op::CheckCommand,
        Plan::Now((
            Status::NotAuthorized,
            Some(message(
                "CPF9802",
                40,
                "Not authorized to object CRTBNDRPG.",
                "Cause . . . . . :   You do not have the authority required.",
            )),
            Vec::new(),
        )),
    );
    let e = h
        .call(
            "action.check",
            json!({"name":"QSHQ400","command":"CRTBNDRPG"}),
        )
        .unwrap_err();
    assert_eq!(e.code, codes::SERVER);
    assert_eq!(e.data.unwrap()["messageId"], json!("CPF9802"));
}
