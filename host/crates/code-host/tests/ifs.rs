// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `ifs.*` at the method-registry level, against canned `qap-client`
//! replies. The fake implements `qap-client`'s own [`Files`] trait
//! (`ifs_call`, `ifs_request`, `ifs_supports`), so the host's calls go
//! through `qap-client`'s real `Listing`, `stamp`, `checked`, `resolve`,
//! `resume_offset`, `read` and `write`; only the server is canned. Requests
//! sent with `ifs_request` travel over a real `qap_client::Connection` on an
//! in-memory transport, answered by the same canned server. Refusals carry
//! the file-system commands' IDs (`CPFA0A9`, `CPFA0A0`, `CPFA0AC`) and
//! `TCP1A5A`, passed through with their second-level text.

use std::collections::{BTreeMap, VecDeque};
use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use code_host::registry_with;
use code_host::session::{
    Backend, DevelopBackend, Endpoint, Factory, IfsBackend, JobDto, Sessions, SystemDto, codes,
};
use host_rpc::{Context, Outbound, Registry, RpcError};
use qap_client::ifs::{self, whole_utf8};
use qap_client::proto::ops::connection::HelloReply;
use qap_client::proto::ops::ifs::{
    CreateDirectory, Entries, Entry, EntryKind, FileData, FromTo, ListDirectory, PathRef, ReadFile,
    Stat, WriteFile, WriteMode, Written,
};
use qap_client::proto::{Envelope, Kind, Op, Service};
use qap_client::{
    Connection, Error, Files, Pending, Reply, Secret, ServerMessage, Status, Target, Wake, Wire,
};
use qsa_net::{Security, Transport};
use serde_json::{Value, json};

// The canned server.

/// One file, directory or link on the fake system.
#[derive(Clone, Debug)]
struct Node {
    kind: EntryKind,
    /// As stored, in the file's own CCSID.
    data: Vec<u8>,
    ccsid: u16,
    change: u64,
    target: Option<String>,
}

/// A refusal: the status and the message the server sends.
type Refusal = (Status, ServerMessage);

/// What the server holds and answers, and what it was asked.
#[derive(Default)]
struct Script {
    /// The version agreed; `None` is 9.
    qap: Option<u16>,
    files: BTreeMap<String, Node>,
    /// Hands out every `change`.
    counter: u64,
    /// Each request, in order, as a line.
    asked: Vec<String>,
    /// The next request of the op is refused with this.
    refuse: Vec<(Op, Refusal)>,
    /// `WriteFile`s answered so far.
    writes: usize,
    /// Called after each `WriteFile` is applied, before its reply goes.
    on_write: Option<Arc<dyn Fn(usize) + Send + Sync>>,
}

type Shared = Arc<Mutex<Script>>;

fn message(id: &str, text: &str, help: &str) -> ServerMessage {
    ServerMessage {
        id: id.into(),
        severity: 40,
        data: Vec::new(),
        text: text.into(),
        help: help.into(),
    }
}

const TCP1A5A: (&str, &str) = (
    "Data cannot be converted to or from CCSID.",
    "Cause . . . . . :   The data could not be converted between the CCSID of the file and the CCSID asked for.",
);

fn tcp1a5a() -> Refusal {
    (Status::Error, message("TCP1A5A", TCP1A5A.0, TCP1A5A.1))
}

fn not_found(path: &str) -> Refusal {
    (
        Status::NotFound,
        message(
            "CPFA0A9",
            "Object not found.",
            &format!("Cause . . . . . :   The object {path} was not found."),
        ),
    )
}

fn exists(path: &str) -> Refusal {
    (
        Status::Exists,
        message(
            "CPFA0A0",
            "Object already exists.",
            &format!("Cause . . . . . :   The object {path} already exists."),
        ),
    )
}

/// Text as a file of `ccsid` stores it. 1208 is UTF-8; 37, 500 and 819
/// stand in for single-byte CCSIDs with one byte per character up to
/// U+00FF (the real tables do not matter here); 65535 holds no text.
fn encode(text: &str, ccsid: u16) -> Option<Vec<u8>> {
    match ccsid {
        0 | 1208 => Some(text.as_bytes().to_vec()),
        37 | 500 | 819 => text
            .chars()
            .map(|c| u8::try_from(u32::from(c)).ok())
            .collect(),
        _ => None,
    }
}

fn parent(path: &str) -> &str {
    ifs::parent(path)
}

fn glob(pattern: &str, name: &str) -> bool {
    fn m(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some('*'), _) => m(&p[1..], n) || (!n.is_empty() && m(p, &n[1..])),
            (Some('?'), Some(_)) => m(&p[1..], &n[1..]),
            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b) && m(&p[1..], &n[1..]),
            _ => false,
        }
    }
    pattern.is_empty()
        || m(
            &pattern.chars().collect::<Vec<_>>(),
            &name.chars().collect::<Vec<_>>(),
        )
}

impl Script {
    fn bump(&mut self) -> u64 {
        self.counter += 1;
        self.counter
    }

    /// Puts a node at `path`.
    fn put(
        &mut self,
        path: &str,
        kind: EntryKind,
        data: Vec<u8>,
        ccsid: u16,
        target: Option<&str>,
    ) {
        let change = self.bump();
        self.files.insert(
            path.to_owned(),
            Node {
                kind,
                data,
                ccsid,
                change,
                target: target.map(str::to_owned),
            },
        );
    }

    fn file(&mut self, path: &str, ccsid: u16, text: &str) {
        let data = encode(text, ccsid).expect("text the CCSID holds");
        self.put(path, EntryKind::File, data, ccsid, None);
    }

    fn bytes(&mut self, path: &str, ccsid: u16, data: Vec<u8>) {
        self.put(path, EntryKind::File, data, ccsid, None);
    }

    fn dir(&mut self, path: &str) {
        self.put(path, EntryKind::Directory, Vec::new(), 1208, None);
    }

    fn link(&mut self, path: &str, target: &str) {
        self.put(path, EntryKind::Symlink, Vec::new(), 1208, Some(target));
    }

    fn entry(path: &str, n: &Node) -> Entry {
        Entry {
            name: ifs::file_name(path).to_owned(),
            kind: n.kind,
            size: n.data.len() as u64,
            modified: 1_760_000_000_000 + n.change as i64,
            owner: "CWELLMAN".into(),
            ccsid: n.ccsid,
            target: n.target.clone(),
        }
    }

    fn refused(&mut self, op: Op) -> Option<Refusal> {
        let i = self.refuse.iter().position(|(o, _)| *o == op)?;
        Some(self.refuse.remove(i).1)
    }

    /// Answers one request: the status, message and encoded body.
    fn handle(&mut self, env: &Envelope) -> (Status, Option<ServerMessage>, Vec<u8>) {
        let Some(op) = env.operation() else {
            return (Status::InvalidRequest, None, Vec::new());
        };
        let ok = |b: Vec<u8>| (Status::Ok, None, b);
        let no = |(s, m): Refusal| (s, Some(m), Vec::new());
        macro_rules! req {
            ($t:ty) => {
                env.body_as::<$t>().expect("a body that decodes")
            };
        }
        fn enc<B: Wire>(env: &Envelope, b: &B) -> Vec<u8> {
            Envelope::reply(env, Status::Ok, None, Vec::new())
                .with_body(b)
                .body
        }
        match op {
            Op::ListDirectory => {
                let r = req!(ListDirectory);
                self.asked.push(format!(
                    "ListDirectory {} {:?} {} {}",
                    r.path, r.pattern, r.start, r.max
                ));
                if let Some(x) = self.refused(op) {
                    return no(x);
                }
                if !self.files.contains_key(&r.path) {
                    return no(not_found(&r.path));
                }
                let all: Vec<Entry> = self
                    .files
                    .iter()
                    .filter(|(k, _)| k.as_str() != r.path && parent(k) == r.path)
                    .filter(|(k, _)| glob(&r.pattern, ifs::file_name(k)))
                    .map(|(k, n)| Script::entry(k, n))
                    .collect();
                let start = (r.start as usize).min(all.len());
                let end = if r.max == 0 {
                    all.len()
                } else {
                    (start + r.max as usize).min(all.len())
                };
                ok(enc(
                    env,
                    &Entries {
                        total: all.len() as u32,
                        entries: all[start..end].to_vec(),
                    },
                ))
            }
            Op::GetInfo | Op::Stat => {
                let r = req!(PathRef);
                self.asked.push(format!("{op:?} {}", r.path));
                if let Some(x) = self.refused(op) {
                    return no(x);
                }
                let Some(n) = self.files.get(&r.path) else {
                    return no(not_found(&r.path));
                };
                let entry = Script::entry(&r.path, n);
                if op == Op::Stat {
                    let change = n.change;
                    ok(enc(env, &Stat { entry, change }))
                } else {
                    ok(enc(env, &entry))
                }
            }
            Op::ReadFile => {
                let r = req!(ReadFile);
                self.asked.push(format!(
                    "ReadFile {} {} {} {:?}",
                    r.path, r.offset, r.length, r.as_ccsid
                ));
                if let Some(x) = self.refused(op) {
                    return no(x);
                }
                // ReadFile follows a link.
                let mut path = r.path.clone();
                while let Some(Node {
                    kind: EntryKind::Symlink,
                    target: Some(t),
                    ..
                }) = self.files.get(&path)
                {
                    path = if t.starts_with('/') {
                        t.clone()
                    } else {
                        ifs::join(parent(&path), t)
                    };
                }
                let Some(n) = self.files.get(&path) else {
                    return no(not_found(&r.path));
                };
                let size = n.data.len() as u64;
                let start = r.offset.min(size) as usize;
                let mut end = if r.length == 0 {
                    size as usize
                } else {
                    (r.offset + r.length).min(size) as usize
                };
                let data = match (r.as_ccsid, n.ccsid) {
                    (None, _) => n.data[start..end].to_vec(),
                    (Some(_), 65535) => return no(tcp1a5a()),
                    (Some(_), 0 | 1208) => {
                        if (end as u64) < size {
                            end = start + whole_utf8(&n.data[start..end]);
                        }
                        n.data[start..end].to_vec()
                    }
                    (Some(_), _) => n.data[start..end]
                        .iter()
                        .map(|&b| char::from(b))
                        .collect::<String>()
                        .into_bytes(),
                };
                ok(enc(
                    env,
                    &FileData {
                        size,
                        next_offset: end as u64,
                        data,
                    },
                ))
            }
            Op::WriteFile => {
                let r = req!(WriteFile);
                self.asked.push(format!(
                    "WriteFile {} {:?} {} ccsid={} bytes={} data_ccsid={:?}",
                    r.path,
                    r.mode,
                    r.offset,
                    r.ccsid,
                    r.data.len(),
                    r.data_ccsid
                ));
                if let Some(x) = self.refused(op) {
                    return no(x);
                }
                let existing = self.files.get(&r.path).cloned();
                if r.mode == WriteMode::Create && existing.is_some() {
                    return no(exists(&r.path));
                }
                if r.mode == WriteMode::Update && existing.is_none() {
                    return no(not_found(&r.path));
                }
                let ccsid = match &existing {
                    Some(n) => n.ccsid,
                    None if r.ccsid == 0 => 1208,
                    None => r.ccsid,
                };
                let data = match r.data_ccsid {
                    None => r.data.clone(),
                    Some(_) => match encode(&String::from_utf8_lossy(&r.data), ccsid) {
                        Some(d) => d,
                        // Nothing is written.
                        None => return no(tcp1a5a()),
                    },
                };
                let mut stored = match r.mode {
                    WriteMode::Create | WriteMode::Replace => Vec::new(),
                    _ => existing.map(|n| n.data).unwrap_or_default(),
                };
                match r.mode {
                    WriteMode::Update => {
                        let at = r.offset as usize;
                        if stored.len() < at + data.len() {
                            stored.resize(at + data.len(), 0);
                        }
                        stored[at..at + data.len()].copy_from_slice(&data);
                    }
                    _ => stored.extend_from_slice(&data),
                }
                let size = stored.len() as u64;
                self.put(&r.path, EntryKind::File, stored, ccsid, None);
                self.writes += 1;
                ok(enc(env, &Written { size }))
            }
            Op::CreateDirectory => {
                let r = req!(CreateDirectory);
                self.asked
                    .push(format!("CreateDirectory {} parents={}", r.path, r.parents));
                if let Some(x) = self.refused(op) {
                    return no(x);
                }
                if self.files.contains_key(&r.path) && !r.parents {
                    return no(exists(&r.path));
                }
                self.dir(&r.path);
                ok(Vec::new())
            }
            Op::Delete => {
                let r = req!(PathRef);
                self.asked.push(format!("Delete {}", r.path));
                if let Some(x) = self.refused(op) {
                    return no(x);
                }
                if self.files.remove(&r.path).is_none() {
                    return no(not_found(&r.path));
                }
                ok(Vec::new())
            }
            Op::Rename | Op::Copy => {
                let r = req!(FromTo);
                self.asked
                    .push(format!("{op:?} {} {} replace={}", r.from, r.to, r.replace));
                if let Some(x) = self.refused(op) {
                    return no(x);
                }
                let Some(n) = self.files.get(&r.from).cloned() else {
                    return no(not_found(&r.from));
                };
                if self.files.contains_key(&r.to) && !r.replace {
                    return no(exists(&r.to));
                }
                if op == Op::Rename {
                    self.files.remove(&r.from);
                }
                self.put(&r.to, n.kind, n.data, n.ccsid, n.target.as_deref());
                ok(Vec::new())
            }
            _ => (Status::InvalidRequest, None, Vec::new()),
        }
    }
}

/// The client's end of an in-memory connection: frames written are
/// answered by the script at once, the replies read back in order.
struct Canned {
    script: Shared,
    incoming: Vec<u8>,
    outgoing: VecDeque<u8>,
    closed: bool,
}

impl Canned {
    fn answer(&mut self, env: Envelope) {
        let replies = if env.kind == Kind::Cancel {
            // Every request here is answered at once: nothing to stop.
            Vec::new()
        } else if env.operation() == Some(Op::Hello) {
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
            vec![Envelope::reply(&env, Status::Ok, None, Vec::new()).with_body(&hello)]
        } else {
            let (status, msg, body, hook, writes) = {
                let mut s = self.script.lock().unwrap();
                let before = s.writes;
                let (status, msg, body) = s.handle(&env);
                let hook = (s.writes > before).then(|| s.on_write.clone()).flatten();
                (status, msg, body, hook, s.writes)
            };
            if let Some(hook) = hook {
                hook(writes);
            }
            Envelope::replies(&env, status, msg, body).expect("replies that frame")
        };
        for r in replies {
            let b = r.to_frame().expect("a frame");
            self.outgoing
                .extend((b.len() as u32).to_le_bytes().iter().chain(b.iter()));
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

// The fake backend.

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
                closed: false,
            };
            let target =
                Target::new("qshq400.example", 2320, qsa_net::Trust::default()).with_max_version(9);
            self.conn = Some(Connection::over(Box::new(canned), &target)?);
        }
        Ok(self.conn.as_ref().expect("opened above"))
    }
}

impl Files for Fake {
    fn ifs_call<B: Wire, R: Wire>(&mut self, op: Op, body: &B) -> Result<R, Error> {
        let env = Envelope::request(2, op, body);
        let (status, message, body) = self.script.lock().unwrap().handle(&env);
        Reply {
            status,
            message,
            body,
        }
        .decode()
    }

    fn ifs_request<B: Wire>(&mut self, op: Op, body: &B) -> Result<Pending, Error> {
        self.conn()?.request(op, body)
    }

    fn ifs_supports(&mut self, op: Op) -> bool {
        op.since() <= self.version()
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
        Ok(None)
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
        self
    }
}

// The host.

/// A writer whose frames the test reads back: the notifications.
#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Host {
    script: Shared,
    registry: Arc<Registry>,
    outbound: Outbound,
    _sink: Sink,
}

impl Host {
    /// A host with `QSHQ400` signed on.
    fn new() -> Host {
        Host::at(None)
    }

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
        let sink = Sink::default();
        let outbound = Outbound::new(sink.clone());
        let sessions = Sessions::new(factory, outbound.clone());
        let h = Host {
            script,
            registry: Arc::new(registry_with(&sessions)),
            outbound,
            _sink: sink,
        };
        h.call(
            "session.connect",
            json!({"name":"QSHQ400","host":"qshq400.example","user":"cwellman","password":"secret"}),
        )
        .unwrap();
        h
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.registry
            .dispatch(method, params, &Context::new(self.outbound.clone()))
    }

    fn script(&self) -> MutexGuard<'_, Script> {
        self.script.lock().unwrap()
    }

    fn asked(&self) -> Vec<String> {
        std::mem::take(&mut self.script().asked)
    }
}

/// The server's refusal as the host must pass it on: `-32010`, the
/// message as `id: text`, and `data` exactly as sent.
fn assert_passed_through(e: &RpcError, status: &str, id: &str, text: &str, help: &str) {
    assert_eq!(e.code, codes::SERVER, "{e:?}");
    assert_eq!(e.message, format!("{id}: {text}"));
    assert_eq!(
        e.data.as_ref().unwrap(),
        &json!({"status":status,"messageId":id,"text":text,"secondLevel":help})
    );
}

const HOME: &str = "/home/CWELLMAN";

fn p(extra: Value) -> Value {
    let mut v = json!({"name":"QSHQ400"});
    v.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    v
}

fn ifs_code(name: &str) -> i64 {
    match name {
        "changed" => code_host::ifs::codes::CHANGED,
        "too large" => code_host::ifs::codes::TOO_LARGE,
        "loop" => code_host::ifs::codes::LINK_LOOP,
        _ => unreachable!(),
    }
}

// list and info

#[test]
fn list_drains_pages_of_500_with_the_pattern_as_typed() {
    let h = Host::new();
    {
        let mut s = h.script();
        s.dir(HOME);
        for i in 0..1203 {
            s.file(&format!("{HOME}/f{i:04}.txt"), 1208, "x");
        }
    }
    let r = h
        .call("ifs.list", p(json!({"path":HOME,"pattern":"f*"})))
        .unwrap();
    assert_eq!(r.as_array().unwrap().len(), 1203);
    assert_eq!(
        h.asked(),
        vec![
            format!("ListDirectory {HOME} \"f*\" 0 500"),
            format!("ListDirectory {HOME} \"f*\" 500 500"),
            format!("ListDirectory {HOME} \"f*\" 1000 500"),
        ]
    );
    // No pattern is every entry.
    h.call("ifs.list", p(json!({"path":HOME}))).unwrap();
    assert_eq!(h.asked()[0], format!("ListDirectory {HOME} \"\" 0 500"));
}

#[test]
fn list_entries_carry_kind_size_ccsid_owner_and_link_target() {
    let h = Host::new();
    {
        let mut s = h.script();
        s.dir(HOME);
        s.dir(&format!("{HOME}/src"));
        s.file(&format!("{HOME}/a.txt"), 37, "abc");
        s.link(&format!("{HOME}/latest"), "src");
    }
    let r = h.call("ifs.list", p(json!({"path":HOME}))).unwrap();
    let by: BTreeMap<String, Value> = r
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["name"].as_str().unwrap().to_owned(), e.clone()))
        .collect();
    let a = &by["a.txt"];
    assert_eq!(a["kind"], "file");
    assert_eq!(a["size"], 3);
    assert_eq!(a["ccsid"], 37);
    assert_eq!(a["owner"], "CWELLMAN");
    assert!(a["modified"].as_i64().unwrap() > 1_700_000_000_000);
    assert!(a.get("target").is_none());
    assert_eq!(by["src"]["kind"], "directory");
    assert_eq!(by["latest"]["kind"], "symlink");
    assert_eq!(by["latest"]["target"], "src");
}

#[test]
fn info_is_stat_with_its_change_as_a_string() {
    let h = Host::new();
    h.script().file(&format!("{HOME}/a.txt"), 1208, "hello");
    let change = h.script().files[&format!("{HOME}/a.txt")].change;
    let r = h
        .call("ifs.info", p(json!({"path":format!("{HOME}/a.txt")})))
        .unwrap();
    assert_eq!(r["name"], "a.txt");
    assert_eq!(r["kind"], "file");
    assert_eq!(r["size"], 5);
    assert_eq!(r["change"], change.to_string());
    assert_eq!(h.asked(), vec![format!("Stat {HOME}/a.txt")]);
}

#[test]
fn before_version_6_the_change_is_get_infos_modified() {
    let h = Host::at(Some(5));
    h.script().file(&format!("{HOME}/a.txt"), 1208, "hello");
    let r = h
        .call("ifs.info", p(json!({"path":format!("{HOME}/a.txt")})))
        .unwrap();
    let modified = r["modified"].as_i64().unwrap();
    assert_eq!(r["change"], format!("m{modified}"));
    assert_eq!(h.asked(), vec![format!("GetInfo {HOME}/a.txt")]);
}

#[test]
fn below_version_5_nothing_is_sent() {
    let h = Host::at(Some(4));
    let e = h.call("ifs.list", p(json!({"path":HOME}))).unwrap_err();
    assert_eq!(e.code, codes::QAP_UNAVAILABLE);
    assert_eq!(e.message, "QAP version 5 not available on this server");
    assert_eq!(e.data, Some(json!({"version":4})));
    assert!(h.asked().is_empty());
}

#[test]
fn an_empty_path_is_refused_before_anything_is_sent() {
    let h = Host::new();
    for (m, params) in [
        ("ifs.list", json!({"path":""})),
        ("ifs.readText", json!({"path":""})),
        ("ifs.rename", json!({"from":"/a","to":""})),
    ] {
        let e = h.call(m, p(params)).unwrap_err();
        assert_eq!(e.code, host_rpc::codes::INVALID_PARAMS, "{m}");
    }
    assert!(h.asked().is_empty());
}

// readText

#[test]
fn read_text_asks_for_1208_and_carries_ccsid_size_and_change() {
    let h = Host::new();
    let path = format!("{HOME}/utf8.txt");
    h.script().file(&path, 1208, "café — ok\n");
    let change = h.script().files[&path].change;
    let r = h.call("ifs.readText", p(json!({"path":path}))).unwrap();
    assert_eq!(
        r,
        json!({"text":"café — ok\n","ccsid":1208,"size":"café — ok\n".len(),"change":change.to_string()})
    );
    // The stamp before the data.
    assert_eq!(
        h.asked(),
        vec![
            format!("Stat {path}"),
            format!("ReadFile {path} 0 1048576 Some(1208)"),
        ]
    );
}

#[test]
fn read_text_of_an_ebcdic_file_is_the_servers_conversion() {
    let h = Host::new();
    let path = format!("{HOME}/ebcdic.txt");
    h.script().file(&path, 37, "Grüße, é\n");
    let r = h.call("ifs.readText", p(json!({"path":path}))).unwrap();
    assert_eq!(r["text"], "Grüße, é\n");
    assert_eq!(r["ccsid"], 37);
    // The size is the file's, one byte a character.
    assert_eq!(r["size"], 9);
}

#[test]
fn read_text_of_several_chunks_joins_on_whole_characters() {
    let h = Host::new();
    let path = format!("{HOME}/big.txt");
    // 3 MiB of two-byte characters, offset by one so a chunk ends inside one.
    let text = format!("a{}", "é".repeat(3 << 19));
    h.script().file(&path, 1208, &text);
    let r = h.call("ifs.readText", p(json!({"path":path}))).unwrap();
    assert_eq!(r["text"].as_str().unwrap(), text);
    let reads: Vec<String> = h
        .asked()
        .into_iter()
        .filter(|l| l.starts_with("ReadFile"))
        .collect();
    assert_eq!(reads.len(), 4);
    // The second starts where the first's whole characters ended.
    assert_eq!(
        reads[1],
        format!("ReadFile {path} 1048575 1048576 Some(1208)")
    );
}

#[test]
fn read_text_over_10_mib_is_refused_with_the_size_and_nothing_read() {
    let h = Host::new();
    let path = format!("{HOME}/huge.log");
    h.script().bytes(&path, 1208, vec![b'x'; (10 << 20) + 1]);
    let e = h.call("ifs.readText", p(json!({"path":path}))).unwrap_err();
    assert_eq!(e.code, ifs_code("too large"));
    assert_eq!(
        e.data,
        Some(json!({"size":(10 << 20) + 1,"limit":10 << 20}))
    );
    assert!(e.message.contains("10485761 bytes"), "{}", e.message);
    assert_eq!(h.asked(), vec![format!("Stat {path}")]);
    // Exactly 10 MiB is read.
    h.script().bytes(&path, 1208, vec![b'x'; 10 << 20]);
    h.call("ifs.readText", p(json!({"path":path}))).unwrap();
}

#[test]
fn read_text_of_a_binary_file_is_tcp1a5a_passed_through() {
    let h = Host::new();
    let path = format!("{HOME}/a.savf");
    h.script().bytes(&path, 65535, vec![0, 1, 2]);
    let e = h.call("ifs.readText", p(json!({"path":path}))).unwrap_err();
    assert_passed_through(&e, "Error", "TCP1A5A", TCP1A5A.0, TCP1A5A.1);
}

#[test]
fn read_text_of_a_link_is_stamped_by_its_target() {
    let h = Host::new();
    {
        let mut s = h.script();
        s.file(&format!("{HOME}/real.txt"), 1208, "real");
        s.link(&format!("{HOME}/alias.txt"), "real.txt");
    }
    let change = h.script().files[&format!("{HOME}/real.txt")].change;
    let r = h
        .call(
            "ifs.readText",
            p(json!({"path":format!("{HOME}/alias.txt")})),
        )
        .unwrap();
    assert_eq!(r["text"], "real");
    assert_eq!(r["change"], change.to_string());
}

#[test]
fn read_text_not_found_is_cpfa0a9_passed_through() {
    let h = Host::new();
    let path = format!("{HOME}/gone.txt");
    let e = h.call("ifs.readText", p(json!({"path":path}))).unwrap_err();
    assert_passed_through(
        &e,
        "NotFound",
        "CPFA0A9",
        "Object not found.",
        &format!("Cause . . . . . :   The object {path} was not found."),
    );
}

// writeText

#[test]
fn write_text_with_the_change_read_writes_and_answers_the_new_change() {
    let h = Host::new();
    let path = format!("{HOME}/utf8.txt");
    h.script().file(&path, 1208, "old\n");
    let read = h.call("ifs.readText", p(json!({"path":path}))).unwrap();
    h.asked();
    let r = h
        .call(
            "ifs.writeText",
            p(json!({"path":path,"text":"new — é\n","mode":"replace","expect":read["change"]})),
        )
        .unwrap();
    let node = h.script().files[&path].clone();
    assert_eq!(node.data, "new — é\n".as_bytes());
    assert_eq!(
        r,
        json!({"size":node.data.len(),"change":node.change.to_string()})
    );
    assert_ne!(r["change"], read["change"]);
    assert_eq!(
        h.asked(),
        vec![
            format!("Stat {path}"),
            format!("WriteFile {path} Replace 0 ccsid=0 bytes=11 data_ccsid=Some(1208)"),
            format!("Stat {path}"),
        ]
    );
}

#[test]
fn write_text_refuses_when_the_file_changed_and_sends_no_write() {
    let h = Host::new();
    let path = format!("{HOME}/utf8.txt");
    h.script().file(&path, 1208, "old\n");
    let read = h.call("ifs.readText", p(json!({"path":path}))).unwrap();
    // Someone else's edit.
    h.script().file(&path, 1208, "theirs\n");
    let theirs = h.script().files[&path].change;
    h.asked();
    let e = h
        .call(
            "ifs.writeText",
            p(json!({"path":path,"text":"mine\n","mode":"replace","expect":read["change"]})),
        )
        .unwrap_err();
    assert_eq!(e.code, ifs_code("changed"));
    assert_eq!(e.message, "changed on the system");
    assert_eq!(e.data, Some(json!({"change":theirs.to_string()})));
    assert_eq!(h.asked(), vec![format!("Stat {path}")]);
    assert_eq!(h.script().files[&path].data, b"theirs\n");

    // A file deleted since: changed, with no change now.
    h.script().files.remove(&path);
    let e = h
        .call(
            "ifs.writeText",
            p(json!({"path":path,"text":"mine\n","mode":"replace","expect":read["change"]})),
        )
        .unwrap_err();
    assert_eq!(e.code, ifs_code("changed"));
    assert_eq!(e.data, Some(json!({"change":null})));

    // Without expect it overwrites.
    h.script().file(&path, 1208, "theirs\n");
    h.call(
        "ifs.writeText",
        p(json!({"path":path,"text":"mine\n","mode":"replace"})),
    )
    .unwrap();
    assert_eq!(h.script().files[&path].data, b"mine\n");
}

#[test]
fn write_text_create_tags_the_new_file_with_the_ccsid_given() {
    let h = Host::new();
    let path = format!("{HOME}/ebcdic.txt");
    let r = h
        .call(
            "ifs.writeText",
            p(json!({"path":path,"text":"Grüße\n","mode":"create","ccsid":37})),
        )
        .unwrap();
    let node = h.script().files[&path].clone();
    assert_eq!(node.ccsid, 37);
    // The system converted it: one byte a character.
    assert_eq!(node.data.len(), 6);
    assert_eq!(r["size"], 6);
    assert_eq!(
        h.asked()[0],
        format!("WriteFile {path} Create 0 ccsid=37 bytes=8 data_ccsid=Some(1208)")
    );
    let back = h.call("ifs.readText", p(json!({"path":path}))).unwrap();
    assert_eq!(back["text"], "Grüße\n");
    // No ccsid is 1208.
    let path2 = format!("{HOME}/new.txt");
    h.call(
        "ifs.writeText",
        p(json!({"path":path2,"text":"","mode":"create"})),
    )
    .unwrap();
    assert_eq!(h.script().files[&path2].ccsid, 1208);
}

#[test]
fn write_text_create_over_an_existing_file_is_cpfa0a0_passed_through() {
    let h = Host::new();
    let path = format!("{HOME}/a.txt");
    h.script().file(&path, 1208, "keep");
    let e = h
        .call(
            "ifs.writeText",
            p(json!({"path":path,"text":"x","mode":"create"})),
        )
        .unwrap_err();
    assert_passed_through(
        &e,
        "Exists",
        "CPFA0A0",
        "Object already exists.",
        &format!("Cause . . . . . :   The object {path} already exists."),
    );
    assert_eq!(h.script().files[&path].data, b"keep");
}

#[test]
fn a_character_the_files_ccsid_lacks_is_tcp1a5a_and_nothing_is_written() {
    let h = Host::new();
    let path = format!("{HOME}/ebcdic.txt");
    h.script().file(&path, 37, "as typed\n");
    let read = h.call("ifs.readText", p(json!({"path":path}))).unwrap();
    let before = h.script().files[&path].clone();
    let e = h
        .call(
            "ifs.writeText",
            p(json!({"path":path,"text":"as typed 😀\n","mode":"replace","expect":read["change"]})),
        )
        .unwrap_err();
    assert_passed_through(&e, "Error", "TCP1A5A", TCP1A5A.0, TCP1A5A.1);
    let after = h.script().files[&path].clone();
    assert_eq!(after.data, before.data);
    assert_eq!(after.change, before.change);
}

#[test]
fn write_text_refuses_resume() {
    let h = Host::new();
    let e = h
        .call(
            "ifs.writeText",
            p(json!({"path":"/a","text":"x","mode":"resume"})),
        )
        .unwrap_err();
    assert_eq!(e.code, host_rpc::codes::INVALID_PARAMS);
    assert!(h.asked().is_empty());
}

// The other methods

#[test]
fn mkdir_delete_rename_copy_are_one_request_each() {
    let h = Host::new();
    h.script().dir(HOME);
    h.script().file(&format!("{HOME}/a.txt"), 37, "a");
    h.call(
        "ifs.mkdir",
        p(json!({"path":format!("{HOME}/x/y"),"parents":true})),
    )
    .unwrap();
    h.call(
        "ifs.copy",
        p(json!({"from":format!("{HOME}/a.txt"),"to":format!("{HOME}/b.txt"),"replace":false})),
    )
    .unwrap();
    h.call(
        "ifs.rename",
        p(json!({"from":format!("{HOME}/b.txt"),"to":format!("{HOME}/c.txt"),"replace":true})),
    )
    .unwrap();
    h.call("ifs.delete", p(json!({"path":format!("{HOME}/c.txt")})))
        .unwrap();
    assert_eq!(
        h.asked(),
        vec![
            format!("CreateDirectory {HOME}/x/y parents=true"),
            format!("Copy {HOME}/a.txt {HOME}/b.txt replace=false"),
            format!("Rename {HOME}/b.txt {HOME}/c.txt replace=true"),
            format!("Delete {HOME}/c.txt"),
        ]
    );
    assert!(!h.script().files.contains_key(&format!("{HOME}/c.txt")));
}

#[test]
fn delete_of_a_directory_not_empty_is_cpfa0ac_passed_through() {
    let h = Host::new();
    let help = "Cause . . . . . :   The directory is not empty.";
    h.script().refuse.push((
        Op::Delete,
        (
            Status::Error,
            message("CPFA0AC", "Directory not empty.", help),
        ),
    ));
    let e = h.call("ifs.delete", p(json!({"path":HOME}))).unwrap_err();
    assert_passed_through(&e, "Error", "CPFA0AC", "Directory not empty.", help);
}

#[test]
fn copy_onto_an_existing_file_without_replace_is_exists() {
    let h = Host::new();
    h.script().file("/a", 1208, "a");
    h.script().file("/b", 1208, "b");
    let e = h
        .call("ifs.copy", p(json!({"from":"/a","to":"/b"})))
        .unwrap_err();
    assert_eq!(e.data.unwrap()["messageId"], "CPFA0A0");
}

#[test]
fn resolve_follows_links_relative_and_absolute() {
    let h = Host::new();
    {
        let mut s = h.script();
        s.dir("/data");
        s.dir("/data/v2");
        s.link("/data/current", "v2");
        s.link(&format!("{HOME}/data"), "/data/current");
    }
    let r = h
        .call("ifs.resolve", p(json!({"path":format!("{HOME}/data")})))
        .unwrap();
    assert_eq!(r, json!({"path":"/data/v2"}));
    // No link: as typed.
    let r = h.call("ifs.resolve", p(json!({"path":"/data"}))).unwrap();
    assert_eq!(r, json!({"path":"/data"}));
}

#[test]
fn resolve_of_a_broken_link_is_not_found_and_a_loop_is_refused() {
    let h = Host::new();
    {
        let mut s = h.script();
        s.link("/broken", "/nowhere");
        s.link("/a", "/b");
        s.link("/b", "/a");
    }
    let e = h
        .call("ifs.resolve", p(json!({"path":"/broken"})))
        .unwrap_err();
    assert_eq!(e.data.unwrap()["messageId"], "CPFA0A9");
    let e = h.call("ifs.resolve", p(json!({"path":"/a"}))).unwrap_err();
    assert_eq!(e.code, ifs_code("loop"));
}
