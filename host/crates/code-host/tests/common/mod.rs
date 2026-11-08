// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The fake of `tests/work.rs`: a `WorkBackend` (and the `CommandBackend`
//! job log) over canned lists, with `ReadSpooledFile` and the spooled-file
//! actions sent over a real `qap_client::Connection` on an in-memory
//! transport, so their `Pending` replies are `qap-client`'s own.

#![allow(dead_code)]

use std::collections::VecDeque;
use std::io::{self, Cursor, Read, Write};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use code_host::registry_with;
use code_host::session::{
    Backend, CommandBackend, DevelopBackend, Endpoint, Factory, IfsBackend, JobDto, Sessions,
    SystemDto, WorkBackend,
};
use host_rpc::framing::read_frame;
use host_rpc::{Context, Outbound, Registry, RpcError};
use qap_client::proto::ops::connection::HelloReply;
use qap_client::proto::ops::jobs::{JobEntry, JobLog, JobLogEntries, JobLogEntry, JobState};
use qap_client::proto::ops::messages::{
    Key, MessageType, Messages, Queue, QueuedMessage, Recipient,
};
use qap_client::proto::ops::spool::{
    DeviceType, HoldSpooledFile, ListSpooledFiles, MoveSpooledFile, OutputQueue, ReadFormat,
    ReadSpooledFile, SpoolStatus, SpooledData, SpooledFile, SpooledFileId, SpooledFileRef,
};
use qap_client::proto::types::{EndHow, JobId, ObjectName};
use qap_client::proto::{Envelope, Kind, Op, Service};
use qap_client::spool::Action;
use qap_client::{
    Connection, Error, Pending, Secret, ServerMessage, Status, Target, Wake, Watch, WatchEvent,
    Wire,
};
use qsa_net::{Security, Transport};
use serde_json::Value;

pub fn message(id: &str, severity: u8, text: &str, help: &str) -> ServerMessage {
    ServerMessage {
        id: id.into(),
        severity,
        data: Vec::new(),
        text: text.into(),
        help: help.into(),
    }
}

/// When a job entered: 2025-11-08 00:00 UTC.
pub const ENTERED: i64 = 1_762_560_000_000;

pub fn job_id(number: &str, user: &str, name: &str) -> JobId {
    JobId {
        number: number.into(),
        user: user.into(),
        name: name.into(),
    }
}

pub fn job_entry(number: &str, user: &str, name: &str, state: JobState) -> JobEntry {
    let (status, kind, subsystem, function) = match state {
        JobState::Active => ("*ACTIVE", "INTER", "QINTER", "CMD-WRKSPLF"),
        JobState::OnJobQueue => ("*JOBQ", "BATCH", "", ""),
        JobState::OnOutputQueue => ("*OUTQ", "BATCH", "", ""),
    };
    JobEntry {
        id: job_id(number, user, name),
        state,
        status: status.into(),
        r#type: kind.into(),
        subsystem: subsystem.into(),
        function: function.into(),
        entered: ENTERED,
    }
}

pub fn log_entry(i: usize) -> JobLogEntry {
    JobLogEntry {
        message: message("CPC2191", 0, &format!("Message {i}."), ""),
        kind: MessageType::Completion,
        sent: ENTERED + i as i64 * 1000,
        from_program: "QCMD".into(),
        to_program: "*EXT".into(),
    }
}

/// The connection job, whose compiles make `QSYSPRT`.
pub fn conn_job() -> JobId {
    job_id("123456", "QUSER", "QAPCNN")
}

pub fn spooled(job: JobId, file: &str, number: u32, status: SpoolStatus) -> SpooledFile {
    SpooledFile {
        id: SpooledFileId {
            job,
            file: file.into(),
            number,
        },
        status,
        outq: ObjectName {
            library: "QUSRSYS".into(),
            name: "CWELLMAN".into(),
        },
        user: "CWELLMAN".into(),
        user_data: "ASSETS".into(),
        form_type: "*STD".into(),
        device_type: DeviceType::Scs,
        pages: 3,
        copies: 1,
        size: 4096,
        created: ENTERED,
    }
}

pub fn queued(key: u32, kind: MessageType, text: &str, sent: i64) -> QueuedMessage {
    QueuedMessage {
        key: key.to_be_bytes(),
        id: String::new(),
        kind,
        severity: if kind == MessageType::Inquiry { 99 } else { 0 },
        text: text.into(),
        help: String::new(),
        sent,
        from_user: "CWELLMAN".into(),
        from_job: job_id("100200", "CWELLMAN", "QPADEV0001"),
        needs_reply: kind == MessageType::Inquiry,
        reply: None,
        answers: None,
    }
}

/// A body as the server encodes it.
pub fn body<B: Wire>(b: &B) -> Vec<u8> {
    let probe = Envelope::request(1, Op::RunCommand, &());
    Envelope::reply(&probe, Status::Ok, None, Vec::new())
        .with_body(b)
        .body
}

#[derive(Default)]
pub struct Script {
    /// The version agreed; `None` is 9.
    pub qap: Option<u16>,
    /// Each call, in order, as a line.
    pub asked: Vec<String>,
    /// Refusals, by method, each used once.
    pub refusals: Vec<(String, Status, ServerMessage)>,
    pub jobs: Vec<JobEntry>,
    pub log: Vec<JobLogEntry>,
    pub files: Vec<SpooledFile>,
    pub queues: Vec<OutputQueue>,
    /// Each page's text, for `ReadSpooledFile` as `Text`.
    pub pages: Vec<String>,
    /// Messages per queue, oldest first.
    pub messages: Vec<(Queue, QueuedMessage)>,
    /// The key `send_message` answers.
    pub sent_key: Option<Key>,
    /// What `watch_events` hands over next.
    pub events: Vec<WatchEvent>,
    /// Watched now, by the fake client.
    pub watched: Vec<Watch>,
}

pub type Shared = Arc<Mutex<Script>>;

impl Script {
    fn refused(&mut self, method: &str) -> Option<Error> {
        let i = self.refusals.iter().position(|(m, _, _)| m == method)?;
        let (_, status, m) = self.refusals.remove(i);
        Some(Error::Status {
            status,
            message: Some(m),
        })
    }

    fn ask(&mut self, method: &str, line: String) -> Result<(), Error> {
        self.asked.push(line);
        match self.refused(method) {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

// The canned server, for the requests that answer a `Pending`.

struct Canned {
    script: Shared,
    incoming: Vec<u8>,
    outgoing: VecDeque<u8>,
    closed: bool,
}

fn job_text(j: &JobId) -> String {
    format!("{}/{}/{}", j.number, j.user, j.name)
}

fn file_text(i: &SpooledFileId) -> String {
    format!("{}({}) {}", i.file, i.number, job_text(&i.job))
}

impl Canned {
    fn send(&mut self, to: &Envelope, status: Status, msg: Option<ServerMessage>, body: Vec<u8>) {
        for r in Envelope::replies(to, status, msg, body).expect("replies that frame") {
            let b = r.to_frame().expect("a frame");
            self.outgoing
                .extend((b.len() as u32).to_le_bytes().iter().chain(b.iter()));
        }
    }

    fn answer(&mut self, env: Envelope) {
        if env.kind == Kind::Cancel {
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
            self.send(&env, Status::Ok, None, b);
            return;
        }
        let mut s = self.script.lock().unwrap();
        let (method, line) = match op {
            Op::ReadSpooledFile => {
                let r = env.body_as::<ReadSpooledFile>().expect("a read");
                (
                    "read",
                    format!(
                        "read {} {:?} {} {}",
                        file_text(&r.id),
                        r.format,
                        r.first_page,
                        r.last_page
                    ),
                )
            }
            Op::HoldSpooledFile => {
                let r = env.body_as::<HoldSpooledFile>().expect("a hold");
                (
                    "hold",
                    format!("hold {} immediately={}", file_text(&r.id), r.immediately),
                )
            }
            Op::ReleaseSpooledFile | Op::DeleteSpooledFile => {
                let r = env.body_as::<SpooledFileRef>().expect("a file");
                let m = if op == Op::DeleteSpooledFile {
                    "delete"
                } else {
                    "release"
                };
                (m, format!("{m} {}", file_text(&r.id)))
            }
            Op::MoveSpooledFile => {
                let r = env.body_as::<MoveSpooledFile>().expect("a move");
                (
                    "move",
                    format!(
                        "move {} to {}/{} first={}",
                        file_text(&r.id),
                        r.outq.library,
                        r.outq.name,
                        r.first
                    ),
                )
            }
            _ => ("other", format!("{op:?}")),
        };
        s.asked.push(line);
        if let Some(i) = s.refusals.iter().position(|(m, _, _)| m == method) {
            let (_, status, m) = s.refusals.remove(i);
            drop(s);
            self.send(&env, status, Some(m), Vec::new());
            return;
        }
        if op == Op::ReadSpooledFile {
            let r = env.body_as::<ReadSpooledFile>().expect("a read");
            let total = s.pages.len() as u32;
            let first = r.first_page.max(1) as usize;
            let last = if r.last_page == 0 {
                s.pages.len()
            } else {
                (r.last_page as usize).min(s.pages.len())
            };
            let data = match r.format {
                ReadFormat::Text => s.pages[first - 1..last].join("\u{c}").into_bytes(),
                ReadFormat::Pdf => b"%PDF-1.7\n% canned\n%%EOF\n".to_vec(),
                ReadFormat::Scs => s.pages[first - 1..last]
                    .iter()
                    .flat_map(|p| {
                        let mut b = vec![0x2B, 0xD2];
                        b.extend_from_slice(p.as_bytes());
                        b.push(0x0C);
                        b
                    })
                    .collect(),
            };
            let reply = body(&SpooledData {
                format: r.format,
                pages: total,
                data,
            });
            drop(s);
            self.send(&env, Status::Ok, None, reply);
            return;
        }
        drop(s);
        self.send(&env, Status::Ok, None, body(&()));
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

// The fake backend.

pub struct Fake {
    script: Shared,
    conn: Option<Connection>,
}

impl Fake {
    fn version(&self) -> u16 {
        self.script.lock().unwrap().qap.unwrap_or(9)
    }

    fn s(&self) -> MutexGuard<'_, Script> {
        self.script.lock().unwrap()
    }

    fn conn(&mut self) -> Result<&Connection, Error> {
        if self.conn.is_none() {
            let canned = Canned {
                script: Arc::clone(&self.script),
                incoming: Vec::new(),
                outgoing: VecDeque::new(),
                closed: false,
            };
            let target =
                Target::new("qshq400.example", 2320, qsa_net::Trust::default()).with_max_version(9);
            self.conn = Some(Connection::over(Box::new(canned), &target)?);
        }
        Ok(self.conn.as_ref().expect("opened above"))
    }
}

fn queue_text(q: &Queue) -> String {
    match q {
        Queue::Own => "own".into(),
        Queue::SystemOperator => "sysopr".into(),
        Queue::Named { queue } => format!("{}/{}", queue.library, queue.name),
    }
}

fn keys_text(keys: &[Key]) -> String {
    keys.iter()
        .map(|k| format!("{:08X}", u32::from_be_bytes(*k)))
        .collect::<Vec<_>>()
        .join(",")
}

impl WorkBackend for Fake {
    fn all_jobs(&mut self, user: &str, status: Option<JobState>) -> Result<Vec<JobEntry>, Error> {
        let mut s = self.s();
        s.ask("all_jobs", format!("all_jobs {user} {status:?}"))?;
        Ok(s.jobs.clone())
    }
    fn hold_job(&mut self, job: &JobId) -> Result<(), Error> {
        self.s()
            .ask("hold_job", format!("hold_job {}", job_text(job)))
    }
    fn release_job(&mut self, job: &JobId) -> Result<(), Error> {
        self.s()
            .ask("release_job", format!("release_job {}", job_text(job)))
    }
    fn end_job(&mut self, job: &JobId, how: EndHow, delay: Option<u32>) -> Result<(), Error> {
        self.s().ask(
            "end_job",
            format!("end_job {} {how:?} {delay:?}", job_text(job)),
        )
    }
    fn all_spooled_files(&mut self, req: &ListSpooledFiles) -> Result<Vec<SpooledFile>, Error> {
        let mut s = self.s();
        let outq = req
            .outq
            .as_ref()
            .map(|o| format!("{}/{}", o.library, o.name));
        s.ask(
            "all_spooled_files",
            format!(
                "all_spooled_files {} outq={outq:?} status={:?} form={:?} data={:?}",
                req.user, req.status, req.form_type, req.user_data
            ),
        )?;
        Ok(s.files.clone())
    }
    fn all_output_queues(&mut self, library: &str) -> Result<Vec<OutputQueue>, Error> {
        let mut s = self.s();
        s.ask("all_output_queues", format!("all_output_queues {library}"))?;
        Ok(s.queues.clone())
    }
    fn read_spooled_file(&mut self, req: &ReadSpooledFile) -> Result<Pending, Error> {
        self.conn()?.request(Op::ReadSpooledFile, req)
    }
    fn spool_action(&mut self, action: &Action) -> Result<Pending, Error> {
        let c = self.conn()?;
        match action {
            Action::Hold { id, immediately } => c.request(
                Op::HoldSpooledFile,
                &HoldSpooledFile {
                    id: id.clone(),
                    immediately: *immediately,
                },
            ),
            Action::Release(id) => {
                c.request(Op::ReleaseSpooledFile, &SpooledFileRef { id: id.clone() })
            }
            Action::Delete(id) => {
                c.request(Op::DeleteSpooledFile, &SpooledFileRef { id: id.clone() })
            }
            Action::Move { id, outq, first } => c.request(
                Op::MoveSpooledFile,
                &MoveSpooledFile {
                    id: id.clone(),
                    outq: outq.clone(),
                    first: *first,
                },
            ),
        }
    }
    fn list_messages(
        &mut self,
        queue: &Queue,
        newest_first: bool,
        start: u32,
        max: u32,
    ) -> Result<Messages, Error> {
        let mut s = self.s();
        s.ask(
            "list_messages",
            format!(
                "list_messages {} newest_first={newest_first} {start} {max}",
                queue_text(queue)
            ),
        )?;
        let mut on: Vec<QueuedMessage> = s
            .messages
            .iter()
            .filter(|(q, _)| q == queue)
            .map(|(_, m)| m.clone())
            .collect();
        if newest_first {
            on.reverse();
        }
        let total = on.len() as u32;
        let from = (start as usize).min(on.len());
        let to = if max == 0 {
            on.len()
        } else {
            (from + max as usize).min(on.len())
        };
        Ok(Messages {
            total,
            messages: on[from..to].to_vec(),
        })
    }
    fn reply_message(&mut self, queue: &Queue, key: Key, reply: &str) -> Result<(), Error> {
        let mut s = self.s();
        s.ask(
            "reply_message",
            format!(
                "reply_message {} {} {reply:?}",
                queue_text(queue),
                keys_text(&[key])
            ),
        )?;
        for (q, m) in s.messages.iter_mut() {
            if q == queue && m.key == key {
                m.needs_reply = false;
                m.reply = Some(reply.into());
            }
        }
        Ok(())
    }
    fn remove_messages(&mut self, queue: &Queue, keys: &[Key]) -> Result<(), Error> {
        let mut s = self.s();
        s.ask(
            "remove_messages",
            format!("remove_messages {} {}", queue_text(queue), keys_text(keys)),
        )?;
        s.messages
            .retain(|(q, m)| !(q == queue && keys.contains(&m.key)));
        Ok(())
    }
    fn send_message(
        &mut self,
        to: &Recipient,
        text: &str,
        inquiry: bool,
    ) -> Result<Option<Key>, Error> {
        let mut s = self.s();
        let to = match to {
            Recipient::User { profile } => format!("user {profile}"),
            Recipient::Queue { queue } => format!("queue {}", queue_text(queue)),
        };
        s.ask(
            "send_message",
            format!("send_message {to} {text:?} inquiry={inquiry}"),
        )?;
        Ok(s.sent_key)
    }
    fn may_read_queue(&mut self, queue: &Queue) -> Result<bool, Error> {
        let mut s = self.s();
        s.asked
            .push(format!("may_read_queue {}", queue_text(queue)));
        match s.refused("may_read_queue") {
            Some(e) if e.status() == Some(Status::NotAuthorized) => Ok(false),
            Some(e) => Err(e),
            None => Ok(true),
        }
    }
    fn watch(&mut self, w: Watch) -> Result<(), Error> {
        let mut s = self.s();
        s.ask("watch", format!("watch {w:?}"))?;
        if !s.watched.contains(&w) {
            s.watched.push(w);
        }
        Ok(())
    }
    fn unwatch(&mut self, w: &Watch) -> Result<(), Error> {
        let mut s = self.s();
        s.ask("unwatch", format!("unwatch {w:?}"))?;
        s.watched.retain(|x| x != w);
        Ok(())
    }
    fn watch_events(&mut self) -> Vec<WatchEvent> {
        std::mem::take(&mut self.s().events)
    }
    fn reply_timeout(&self) -> Duration {
        Duration::from_secs(5)
    }
}

impl CommandBackend for Fake {
    fn run_command(&mut self, _: &str) -> Result<Pending, Error> {
        unreachable!("these tests run no command")
    }
    fn send_check(&mut self, _: &str) -> Result<Pending, Error> {
        unreachable!("these tests check no command")
    }
    fn compile(&mut self, _: &str) -> Result<Pending, Error> {
        unreachable!("these tests compile nothing")
    }
    fn job_log(&mut self, req: &JobLog) -> Result<JobLogEntries, Error> {
        let mut s = self.s();
        s.ask(
            "job_log",
            format!("job_log {} {} {}", job_text(&req.job), req.start, req.max),
        )?;
        let start = (req.start as usize).min(s.log.len());
        let end = (start + req.max as usize).min(s.log.len());
        Ok(JobLogEntries {
            total: s.log.len() as u32,
            entries: s.log[start..end].to_vec(),
        })
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
        unreachable!("these tests send no Develop request")
    }
    fn ifs(&mut self) -> &mut dyn IfsBackend {
        unreachable!("these tests send no Ifs request")
    }
    fn command(&mut self) -> &mut dyn CommandBackend {
        self
    }
    fn work(&mut self) -> Option<&mut dyn WorkBackend> {
        Some(self)
    }
}

// The outbound stream, read back.

#[derive(Clone, Default)]
pub struct Sink(pub Arc<Mutex<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// The host.

pub struct Host {
    pub script: Shared,
    pub registry: Arc<Registry>,
    pub outbound: Outbound,
    pub sessions: Arc<Sessions>,
    sink: Sink,
}

impl Host {
    /// A host with `QSHQ400` signed on at `qap` (`None`: 9).
    pub fn at(qap: Option<u16>) -> Host {
        let script: Shared = Arc::default();
        script.lock().unwrap().qap = qap;
        let s = Arc::clone(&script);
        let factory: Factory = Arc::new(move |_: &Endpoint, _: Wake| {
            Ok(Box::new(Fake {
                script: Arc::clone(&s),
                conn: None,
            }) as Box<dyn Backend>)
        });
        let sink = Sink::default();
        let outbound = Outbound::new(sink.clone());
        let sessions = Sessions::new(factory, outbound.clone());
        let h = Host {
            script,
            registry: Arc::new(registry_with(&sessions)),
            outbound,
            sessions,
            sink,
        };
        h.call(
            "session.connect",
            serde_json::json!({"name":"QSHQ400","host":"qshq400.example","user":"cwellman","password":"secret"}),
        )
        .unwrap();
        h.notes();
        h
    }

    pub fn new() -> Host {
        Host::at(None)
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.registry
            .dispatch(method, params, &Context::new(self.outbound.clone()))
    }

    pub fn script(&self) -> MutexGuard<'_, Script> {
        self.script.lock().unwrap()
    }

    pub fn refuse(&self, method: &str, status: Status, m: ServerMessage) {
        self.script().refusals.push((method.into(), status, m));
    }

    pub fn asked(&self) -> Vec<String> {
        std::mem::take(&mut self.script().asked)
    }

    /// Every notification sent since the last look, but `host.log` and
    /// `session.changed`, as `(method, params)`.
    pub fn notes(&self) -> Vec<(String, Value)> {
        let bytes = std::mem::take(&mut *self.sink.0.lock().unwrap());
        let mut r = Cursor::new(bytes);
        let mut out = Vec::new();
        while let Some(b) = read_frame(&mut r).unwrap() {
            let v: Value = serde_json::from_slice(&b).unwrap();
            let Some(m) = v["method"].as_str() else {
                continue;
            };
            if m != "host.log" && m != "session.changed" {
                out.push((m.to_owned(), v["params"].clone()));
            }
        }
        out
    }

    /// Hands `events` to the fake's watches and lets the watcher look.
    pub fn report(&self, events: Vec<WatchEvent>) {
        self.script().events.extend(events);
        self.sessions.check_all();
    }
}
