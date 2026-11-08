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
use qap_client::proto::ops::command::{CheckReply, CommandReply, CommandText};
use qap_client::proto::ops::connection::HelloReply;
use qap_client::proto::ops::develop::CompileReply;
use qap_client::proto::types::{Diagnostic, JobId, MemberName, ObjectName, Where};
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

// action.run

fn job() -> JobId {
    JobId {
        name: "QAPCNN".into(),
        user: "QUSER".into(),
        number: "123456".into(),
    }
}

fn member(library: &str, file: &str, name: &str) -> MemberName {
    MemberName {
        file: ObjectName {
            library: library.into(),
            name: file.into(),
        },
        member: name.into(),
    }
}

const RNF7030_HELP: &str =
    "The name is not declared in the program. Declare it, or correct the spelling.";

fn rnf7030(at: Where, line: u32) -> Diagnostic {
    Diagnostic {
        r#where: at,
        line,
        column: 9,
        end_line: 0,
        end_column: 17,
        severity: 30,
        id: "RNF7030".into(),
        text: "ASSETQTY is not defined.".into(),
        help: RNF7030_HELP.into(),
    }
}

fn rns9310() -> ServerMessage {
    message(
        "RNS9310",
        50,
        "Program ASSETS42 was not created in library CWELLMAN.",
        "The listing shows why: diagnostics above GENLVL, OPTION(*NOGEN), or a problem binding or storing the program.",
    )
}

const COMPILE: &str = "CRTBNDRPG PGM(CWELLMAN/ASSETS42) SRCFILE(HLINV/QTMPSRC) SRCMBR(ASSETS42) DBGVIEW(*SOURCE) OPTION(*EVENTF)";

#[test]
fn compile_goes_to_develop_compile_and_an_error_keeps_its_body() {
    let h = Host::new();
    h.plan(
        Op::Compile,
        Plan::Now((
            Status::Error,
            Some(rns9310()),
            body(&CompileReply {
                job: job(),
                messages: vec![rns9310()],
                diagnostics: vec![
                    rnf7030(
                        Where::Member {
                            member: member("HLINV", "QTMPSRC", "ASSETS42"),
                        },
                        42,
                    ),
                    rnf7030(
                        Where::Member {
                            member: member("HLINV", "QRPGLESRC", "ASSETCPY"),
                        },
                        7,
                    ),
                    Diagnostic {
                        severity: 0,
                        id: "RNF7031".into(),
                        text: "The name or indicator is not referenced.".into(),
                        ..rnf7030(
                            Where::Path {
                                path: "/home/CWELLMAN/inc.rpgleinc".into(),
                            },
                            3,
                        )
                    },
                    Diagnostic {
                        line: 0,
                        column: 0,
                        end_column: 0,
                        ..rnf7030(Where::None, 0)
                    },
                ],
            }),
        )),
    );
    let out = h
        .call(
            "action.run",
            json!({"name":"QSHQ400","command":COMPILE,"kind":"compile"}),
        )
        .unwrap();
    assert_eq!(h.asked(), vec![format!("Compile {COMPILE}")]);
    let escape = json!({
        "id":"RNS9310","severity":50,
        "text":"Program ASSETS42 was not created in library CWELLMAN.",
        "secondLevel":rns9310().help
    });
    assert_eq!(out["status"], json!("Error"));
    assert_eq!(out["escape"], escape);
    assert_eq!(
        out["job"],
        json!({"number":"123456","user":"QUSER","name":"QAPCNN"})
    );
    assert_eq!(out["messages"], json!([escape]));
    let d = out["diagnostics"].as_array().unwrap();
    assert_eq!(d.len(), 4);
    assert_eq!(
        d[0],
        json!({
            "at":{"kind":"member","library":"HLINV","file":"QTMPSRC","member":"ASSETS42"},
            "line":42,"column":9,"endLine":0,"endColumn":17,"severity":30,
            "id":"RNF7030","text":"ASSETQTY is not defined.","help":RNF7030_HELP
        })
    );
    assert_eq!(
        d[1]["at"],
        json!({"kind":"member","library":"HLINV","file":"QRPGLESRC","member":"ASSETCPY"})
    );
    assert_eq!(
        d[2]["at"],
        json!({"kind":"path","path":"/home/CWELLMAN/inc.rpgleinc"})
    );
    assert_eq!(d[3]["at"], json!({"kind":"none"}));
    assert_eq!(d[3]["line"], json!(0));
}

#[test]
fn compile_ok_answers_the_completion_message_and_no_diagnostics() {
    let h = Host::new();
    let done = message(
        "RNS9304",
        0,
        "Program ASSETS42 created in library CWELLMAN. Highest severity: 00.",
        "The program was created. The highest severity of the compile messages is shown.",
    );
    h.plan(
        Op::Compile,
        Plan::Now((
            Status::Ok,
            None,
            body(&CompileReply {
                job: job(),
                messages: vec![done],
                diagnostics: vec![],
            }),
        )),
    );
    let out = h
        .call(
            "action.run",
            json!({"name":"QSHQ400","command":COMPILE,"kind":"compile"}),
        )
        .unwrap();
    assert_eq!(out["status"], json!("Ok"));
    assert!(out.get("escape").is_none());
    assert_eq!(out["messages"][0]["id"], json!("RNS9304"));
    assert_eq!(out["diagnostics"], json!([]));
}

#[test]
fn command_goes_to_run_command_and_never_has_diagnostics() {
    let h = Host::new();
    h.plan(
        Op::RunCommand,
        Plan::Now((
            Status::Ok,
            None,
            body(&CommandReply {
                job: job(),
                messages: vec![message("CPC2206", 0, "Ownership of object changed.", "")],
            }),
        )),
    );
    let out = h
        .call(
            "action.run",
            json!({"name":"QSHQ400","command":"CALL PGM(HLINV/ASSETS)","kind":"command"}),
        )
        .unwrap();
    assert_eq!(h.asked(), vec!["RunCommand CALL PGM(HLINV/ASSETS)"]);
    assert_eq!(
        out,
        json!({
            "status":"Ok",
            "job":{"number":"123456","user":"QUSER","name":"QAPCNN"},
            "messages":[{"id":"CPC2206","severity":0,"text":"Ownership of object changed."}],
            "diagnostics":[]
        })
    );
}

#[test]
fn an_escape_is_the_real_message_with_the_body_filled() {
    let h = Host::new();
    let cpf9812 = message(
        "CPF9812",
        40,
        "No file QNOSRC in library HLINV.",
        "Check the name and the library, or the library list.",
    );
    h.plan(
        Op::Compile,
        Plan::Now((
            Status::NotFound,
            Some(cpf9812.clone()),
            body(&CompileReply {
                job: job(),
                messages: vec![cpf9812],
                diagnostics: vec![],
            }),
        )),
    );
    let out = h
        .call(
            "action.run",
            json!({"name":"QSHQ400","command":"CRTBNDRPG PGM(CWELLMAN/ASSETS42) SRCFILE(HLINV/QNOSRC)","kind":"compile"}),
        )
        .unwrap();
    assert_eq!(out["status"], json!("NotFound"));
    assert_eq!(out["escape"]["id"], json!("CPF9812"));
    assert_eq!(
        out["escape"]["text"],
        json!("No file QNOSRC in library HLINV.")
    );
    assert_eq!(
        out["escape"]["secondLevel"],
        json!("Check the name and the library, or the library list.")
    );
    assert_eq!(out["messages"][0]["id"], json!("CPF9812"));
}

/// Calls `action.run` on a thread of its own; the answer when it ends.
fn run_in_background(h: &Host, params: Value) -> std::thread::JoinHandle<Result<Value, RpcError>> {
    let registry = Arc::clone(&h.registry);
    let outbound = h.outbound.clone();
    std::thread::spawn(move || registry.dispatch("action.run", params, &Context::new(outbound)))
}

/// Waits until the server has been asked `line`.
fn until_asked(h: &Host, line: &str) {
    for _ in 0..1000 {
        if h.script().asked.iter().any(|a| a == line) {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("never asked {line}");
}

#[test]
fn cancelled_in_the_lane_has_no_body() {
    let h = Host::new();
    h.plan(
        Op::Compile,
        Plan::Hold((Status::Cancelled, None, Vec::new())),
    );
    let waiting = run_in_background(
        &h,
        json!({"name":"QSHQ400","command":COMPILE,"kind":"compile","run":"r-test"}),
    );
    until_asked(&h, &format!("Compile {COMPILE}"));
    // The host goes on answering while the run waits.
    assert_eq!(
        h.call("action.cancel", json!({"name":"QSHQ400","run":"r-test"}))
            .unwrap(),
        Value::Null
    );
    let out = waiting.join().unwrap().unwrap();
    assert_eq!(
        out,
        json!({"status":"Cancelled","messages":[],"diagnostics":[]})
    );
    assert_eq!(
        h.asked(),
        vec![format!("Compile {COMPILE}"), "Cancel".to_owned()]
    );
}

#[test]
fn cancelled_once_started_keeps_its_body() {
    let h = Host::new();
    let ended = message(
        "CPF0001",
        30,
        "Error found on CALL command.",
        "The command was ended.",
    );
    h.plan(
        Op::RunCommand,
        Plan::Hold((
            Status::Cancelled,
            Some(ended.clone()),
            body(&CommandReply {
                job: job(),
                messages: vec![ended],
            }),
        )),
    );
    let waiting = run_in_background(
        &h,
        json!({"name":"QSHQ400","command":"CALL PGM(HLINV/LOOP)","kind":"command","run":"r-loop"}),
    );
    until_asked(&h, "RunCommand CALL PGM(HLINV/LOOP)");
    h.call("action.cancel", json!({"run":"r-loop"})).unwrap();
    let out = waiting.join().unwrap().unwrap();
    assert_eq!(out["status"], json!("Cancelled"));
    assert_eq!(out["escape"]["id"], json!("CPF0001"));
    assert_eq!(out["job"]["number"], json!("123456"));
    assert_eq!(out["messages"][0]["id"], json!("CPF0001"));
}

#[test]
fn a_status_that_is_not_an_outcome_is_the_server_refusal() {
    let h = Host::new();
    h.plan(
        Op::Compile,
        Plan::Now((
            Status::Busy,
            Some(message("CPF1234", 40, "Too many requests.", "")),
            Vec::new(),
        )),
    );
    let e = h
        .call(
            "action.run",
            json!({"name":"QSHQ400","command":COMPILE,"kind":"compile"}),
        )
        .unwrap_err();
    assert_eq!(e.code, codes::SERVER);
    assert_eq!(e.data.unwrap()["status"], json!("Busy"));
}

#[test]
fn compile_below_version_8_is_refused_before_anything_is_sent() {
    let h = Host::at(Some(7));
    let e = h
        .call(
            "action.run",
            json!({"name":"QSHQ400","command":COMPILE,"kind":"compile"}),
        )
        .unwrap_err();
    assert_eq!(e.code, codes::QAP_UNAVAILABLE);
    assert_eq!(e.data.unwrap(), json!({"version":7}));
    assert!(h.asked().is_empty());
}

#[test]
fn run_params_are_checked() {
    let h = Host::new();
    for bad in [
        json!({"name":"QSHQ400","command":"","kind":"command"}),
        json!({"name":"QSHQ400","command":"CALL X","kind":"submit"}),
        json!({"name":"QSHQ400","command":"CALL X","kind":"command","run":""}),
    ] {
        let e = h.call("action.run", bad.clone()).unwrap_err();
        assert_eq!(e.code, host_rpc::codes::INVALID_PARAMS, "{bad}");
    }
    assert!(h.asked().is_empty());
    // A cancel of a run that is not running answers null.
    assert_eq!(
        h.call("action.cancel", json!({"run":"r404"})).unwrap(),
        Value::Null
    );
}

#[test]
fn a_run_id_already_running_is_refused() {
    let h = Host::new();
    h.plan(
        Op::Compile,
        Plan::Hold((Status::Cancelled, None, Vec::new())),
    );
    let first = run_in_background(
        &h,
        json!({"name":"QSHQ400","command":COMPILE,"kind":"compile","run":"same"}),
    );
    until_asked(&h, &format!("Compile {COMPILE}"));
    let e = h
        .call(
            "action.run",
            json!({"name":"QSHQ400","command":"CALL X","kind":"command","run":"same"}),
        )
        .unwrap_err();
    assert_eq!(e.code, host_rpc::codes::INVALID_PARAMS);
    h.call("action.cancel", json!({"run":"same"})).unwrap();
    assert_eq!(first.join().unwrap().unwrap()["status"], json!("Cancelled"));
}
