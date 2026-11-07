// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! Sessions: one per connection name, owned by the host for the life of the
//! process.
//!
//! Sign-on, resume, password change and sign-off are `qap-client`'s
//! [`Client`] as QS/400 Access uses it; nothing of the exchange is written
//! here. A [`Backend`] stands between a [`Session`] and the client so the
//! state machine can be tested with canned replies (`qap-client` has no
//! transport trait of its own).
//!
//! States: `disconnected` → `connecting` → `connected`; `connected` →
//! `stale` when the connection closes (the server's idle close, a dropped
//! link, the session ended); `stale` → `connecting` → `connected` on the
//! first call that needs the session. That call resumes the session, or,
//! when the server has ended it, signs on again with the password kept in
//! memory. If the server refuses that password the call fails with
//! `needs_password` and the extension asks once.
//!
//! Every transition is sent as `session.changed`. A watcher thread, woken
//! by the client's [`Wake`] and every few seconds, notices a connection the
//! server closed while nothing was being asked. It only looks; it never
//! reconnects.

use std::collections::BTreeMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError, Weak};
use std::time::Duration;

use host_rpc::{Context, NoParams, Outbound, Registry, RpcError};
use qap_client::proto::Status;
use qap_client::{Client, Error, Secret, Target, Wake};
use qsa_net::Trust;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{LogLevel, log};

/// JSON-RPC error codes of the session methods.
pub mod codes {
    /// `libl.*`: the server has no `library_list` service.
    pub const LIBL_UNAVAILABLE: i64 = -32001;
    /// No signed-on session by that name.
    pub const NOT_CONNECTED: i64 = -32002;
    /// The session must sign on again and the password kept in memory was
    /// refused, or none is kept.
    pub const NEEDS_PASSWORD: i64 = -32003;
    /// The server answered with a status other than `Ok`. `data` carries its
    /// message exactly: `messageId`, `text`, `secondLevel`, and `status`.
    pub const SERVER: i64 = -32010;
    /// The connection could not be opened or was lost: name lookup, TCP,
    /// TLS, a closed connection, no reply in time.
    pub const TRANSPORT: i64 = -32011;
}

/// How often the watcher looks at the sessions without being woken.
const WATCH_EVERY: Duration = Duration::from_secs(5);

/// A session's state, as `session.status` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Disconnected,
    Connecting,
    Connected,
    Stale,
}

/// The system a session is signed on to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemDto {
    /// The system's name (`QSHQ400`).
    pub name: String,
    /// The operating system product (`QS00SS1`), the first product the
    /// server lists.
    pub product: String,
    /// The release (`V1R0M0`).
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The QAP version this connection agreed.
    pub qap: u16,
}

/// The session's job: the QAP server job signed on as the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobDto {
    pub number: String,
    pub user: String,
    pub name: String,
}

/// `session.status`, `session.list` entries and `session.changed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusDto {
    pub name: String,
    pub state: State,
    /// The signed-on profile, as the server names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<SystemDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<JobDto>,
}

/// `tls` of `session.connect`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsParams {
    /// Must be absent or `true`: QAP accepts only a verified certificate.
    #[serde(default)]
    pub verify: Option<bool>,
    /// PEM file of certificates to trust beyond the platform's store: CA
    /// roots, or the server's own certificate as it stands.
    #[serde(default)]
    pub ca_file: Option<String>,
}

/// Where a connection goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    /// `None`: `qap-client`'s default port.
    pub port: Option<u16>,
    pub tls: TlsParams,
}

/// Params of `session.connect`. Not `Debug`: it holds the password.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    pub user: String,
    pub password: String,
    #[serde(default)]
    pub tls: TlsParams,
}

/// Params of `session.changePassword`. Not `Debug`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordParams {
    pub name: String,
    pub old_password: String,
    pub new_password: String,
}

/// Params of methods that name a session.
#[derive(Debug, Deserialize)]
pub struct NameParams {
    pub name: String,
}

/// Result of `libl.get` and `libl.set`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiblDto {
    pub current: Option<String>,
    pub system: Vec<String>,
    pub user: Vec<String>,
}

/// Params of `libl.set`.
#[derive(Debug, Deserialize)]
pub struct LiblSetParams {
    pub name: String,
    #[serde(default)]
    pub current: Option<String>,
    pub user: Vec<String>,
}

/// What a session needs from its QAP client. [`QapBackend`] is the real
/// one; each method is one `qap-client` call.
pub trait Backend: Send {
    /// Opens a connection and signs on; the profile signed on.
    fn sign_on(&mut self, user: &str, password: &Secret) -> Result<String, Error>;
    /// Changes the password, signing on when not signed on (after
    /// `PasswordExpired`); the profile signed on.
    fn change_password(&mut self, user: &str, old: &Secret, new: &Secret) -> Result<String, Error>;
    /// `SystemInfo`, and the version the connection agreed.
    fn system(&mut self) -> Result<SystemDto, Error>;
    /// `JobInfo`; `None` when the server's version has none (before 4).
    fn job(&mut self) -> Result<Option<JobDto>, Error>;
    fn sign_off(&mut self) -> Result<(), Error>;
    /// Opens a connection again and resumes the session. `Ok(false)`: the
    /// connection is open but the session is gone; sign on again.
    fn reconnect(&mut self) -> Result<bool, Error>;
    /// Signed on, with the connection open, by what is known now. Sends
    /// nothing.
    fn live(&self) -> bool;
}

/// Makes a backend for an endpoint; the [`Wake`] is called from the
/// connection's thread when it closes or an event arrives.
pub type Factory = Arc<dyn Fn(&Endpoint, Wake) -> Result<Box<dyn Backend>, RpcError> + Send + Sync>;

/// `qap-client`'s [`Client`].
pub struct QapBackend {
    client: Client,
}

impl Backend for QapBackend {
    fn sign_on(&mut self, user: &str, password: &Secret) -> Result<String, Error> {
        Ok(self.client.sign_on(user, password)?.profile.clone())
    }

    fn change_password(&mut self, user: &str, old: &Secret, new: &Secret) -> Result<String, Error> {
        Ok(self.client.change_password(user, old, new)?.profile.clone())
    }

    fn system(&mut self) -> Result<SystemDto, Error> {
        let info = self.client.system_info()?;
        let qap = self.client.version().unwrap_or_default();
        let non_empty = |s: String| (!s.trim().is_empty()).then_some(s);
        Ok(SystemDto {
            name: info.system_name,
            product: info
                .products
                .into_iter()
                .next()
                .map(|p| p.id)
                .unwrap_or_default(),
            version: info.release,
            serial: non_empty(info.serial),
            model: non_empty(info.model),
            qap,
        })
    }

    fn job(&mut self) -> Result<Option<JobDto>, Error> {
        match self.client.job_info() {
            Ok(j) => Ok(Some(JobDto {
                number: j.job.number,
                user: j.job.user,
                name: j.job.name,
            })),
            Err(Error::Unsupported { .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn sign_off(&mut self) -> Result<(), Error> {
        self.client.sign_off()
    }

    fn reconnect(&mut self) -> Result<bool, Error> {
        let opened = if self.client.server_ending() {
            self.client.reconnect().map(|_| ())
        } else {
            self.client.connect().map(|_| ())
        };
        match opened {
            Ok(()) => Ok(self.client.is_signed_on()),
            // The client has ended the session and kept the connection.
            Err(e) if e.status() == Some(Status::SessionExpired) => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn live(&self) -> bool {
        self.client.is_signed_on()
            && self
                .client
                .connection()
                .is_some_and(|c| c.closed().is_none())
    }
}

/// Trust for `tls`: the platform's store, plus `caFile` when given. The
/// same rule as QS/400 Access: nothing unverified is ever accepted.
pub fn trust_for(tls: &TlsParams) -> Result<Trust, RpcError> {
    if tls.verify == Some(false) {
        return Err(RpcError::invalid_params(
            "tls.verify cannot be false: QAP accepts only a verified server certificate; \
             trust a self-signed one with tls.caFile",
        ));
    }
    let Some(path) = tls.ca_file.as_deref().filter(|p| !p.trim().is_empty()) else {
        return Ok(Trust::default());
    };
    let pem = std::fs::read_to_string(path)
        .map_err(|e| RpcError::invalid_params(format!("tls.caFile {path}: {e}")))?;
    let trust = Trust::from_pem([pem.as_str()]);
    if trust.certificates.is_empty() {
        return Err(RpcError::invalid_params(format!(
            "tls.caFile {path}: no certificate in it"
        )));
    }
    Ok(trust)
}

/// The real factory: a [`Client`] for the endpoint.
pub fn qap_factory() -> Factory {
    Arc::new(|ep: &Endpoint, wake: Wake| {
        let trust = trust_for(&ep.tls)?;
        let port = ep.port.unwrap_or(qap_client::proto::DEFAULT_PORT);
        let mut target = Target::new(ep.host.clone(), port, trust);
        target.wake = Some(wake);
        Ok(Box::new(QapBackend {
            client: Client::new(target),
        }) as Box<dyn Backend>)
    })
}

/// A `qap-client` error as a JSON-RPC error. A server's refusal keeps its
/// message exactly as sent; the error's `message` is `qap-client`'s own
/// text, which for a server message is `messageId: text`.
pub fn rpc_error(e: &Error) -> RpcError {
    let mut err = RpcError::new(codes::TRANSPORT, e.to_string());
    if let Some(status) = e.status() {
        err.code = codes::SERVER;
        err.data = Some(server_data(status, e));
    } else if let Error::Connect(qsa_net::ConnectError::Tls(qsa_net::TlsError::Untrusted {
        reason,
        ..
    })) = e
    {
        err.data = Some(json!({ "kind": "untrusted", "reason": reason }));
    }
    err
}

fn server_data(status: Status, e: &Error) -> Value {
    let mut data = json!({ "status": format!("{status:?}") });
    if let Some(m) = e.server_message() {
        data["messageId"] = json!(m.id);
        data["text"] = json!(m.text);
        if !m.help.trim().is_empty() {
            data["secondLevel"] = json!(m.help);
        }
    }
    data
}

fn needs_password(refused: Option<&Error>) -> RpcError {
    let mut err = RpcError::new(codes::NEEDS_PASSWORD, "needs_password");
    if let Some(e) = refused
        && let Some(status) = e.status()
    {
        err.data = Some(server_data(status, e));
    }
    err
}

fn not_connected(name: &str) -> RpcError {
    RpcError::new(codes::NOT_CONNECTED, format!("{name} is not connected"))
}

// QAP v2: library_list
fn libl_unavailable() -> RpcError {
    RpcError::new(
        codes::LIBL_UNAVAILABLE,
        "library_list not available on this server",
    )
}

/// Whether the server refused the profile or its password.
fn refused(e: &Error) -> bool {
    matches!(
        e.status(),
        Some(Status::SignOnFailed | Status::PasswordExpired | Status::NotAuthorized)
    )
}

/// A library name as QS/400 takes it: 1 to 10 characters, the first `A-Z`,
/// `$`, `#` or `@`, the rest those, digits, `_` or `.`. Upper-cased.
pub fn library_name(s: &str) -> Result<String, RpcError> {
    let n = s.trim().to_ascii_uppercase();
    let first_ok = n
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || "$#@".contains(c));
    let rest_ok = n
        .chars()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || "$#@_.".contains(c));
    if n.len() > 10 || !first_ok || !rest_ok {
        return Err(RpcError::invalid_params(format!(
            "not a library name: {s:?}"
        )));
    }
    Ok(n)
}

/// One connection's session.
pub struct Session {
    name: String,
    state: State,
    endpoint: Option<Endpoint>,
    user: String,
    backend: Option<Box<dyn Backend>>,
    /// The server said `PasswordExpired`; the connection waits for
    /// `session.changePassword`.
    expired: bool,
    /// Kept in memory only, for signing on again after the server ended
    /// the session.
    password: Option<Secret>,
    profile: Option<String>,
    system: Option<SystemDto>,
    job: Option<JobDto>,
    /// The status last sent as `session.changed`.
    sent: Option<StatusDto>,
}

impl Session {
    fn new(name: &str) -> Session {
        Session {
            name: name.to_owned(),
            state: State::Disconnected,
            endpoint: None,
            user: String::new(),
            backend: None,
            expired: false,
            password: None,
            profile: None,
            system: None,
            job: None,
            sent: None,
        }
    }

    pub fn status(&self) -> StatusDto {
        let signed_on = matches!(self.state, State::Connected | State::Stale);
        StatusDto {
            name: self.name.clone(),
            state: self.state,
            user: self.profile.clone().filter(|_| signed_on),
            system: self.system.clone().filter(|_| signed_on),
            job: self.job.clone().filter(|_| signed_on),
        }
    }

    /// `connected` with a closed connection is `stale`. Sends nothing.
    fn observe(&mut self) {
        if self.state == State::Connected && !self.backend.as_ref().is_some_and(|b| b.live()) {
            self.state = State::Stale;
        }
    }

    /// Signs on with `password` and reads the system and the job.
    fn sign_on(&mut self, password: &Secret) -> Result<(), Error> {
        let b = self.backend.as_mut().expect("a backend to sign on with");
        let profile = b.sign_on(&self.user, password)?;
        self.signed_on(profile)
    }

    fn signed_on(&mut self, profile: String) -> Result<(), Error> {
        let b = self.backend.as_mut().expect("a backend");
        let system = b.system()?;
        let job = b.job()?;
        self.profile = Some(profile);
        self.system = Some(system);
        self.job = job;
        self.expired = false;
        Ok(())
    }

    /// Ends the session, politely when the connection is open, and forgets
    /// the password.
    fn close(&mut self) -> Option<String> {
        let mut problem = None;
        if let Some(mut b) = self.backend.take()
            && b.live()
            && let Err(e) = b.sign_off()
        {
            problem = Some(e.to_string());
        }
        self.state = State::Disconnected;
        self.expired = false;
        self.password = None;
        self.profile = None;
        self.system = None;
        self.job = None;
        problem
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Every session of this host.
pub struct Sessions {
    map: Mutex<BTreeMap<String, Arc<Mutex<Session>>>>,
    factory: Factory,
    outbound: Outbound,
    wake_tx: Mutex<Sender<()>>,
    wake_rx: Mutex<Option<Receiver<()>>>,
}

impl Sessions {
    pub fn new(factory: Factory, outbound: Outbound) -> Arc<Sessions> {
        let (tx, rx) = mpsc::channel();
        Arc::new(Sessions {
            map: Mutex::new(BTreeMap::new()),
            factory,
            outbound,
            wake_tx: Mutex::new(tx),
            wake_rx: Mutex::new(Some(rx)),
        })
    }

    /// Starts the watcher thread. It ends when the sessions are dropped.
    pub fn watch(self: &Arc<Self>) {
        let Some(rx) = lock(&self.wake_rx).take() else {
            return;
        };
        let me: Weak<Sessions> = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("session-watch".into())
            .spawn(move || {
                loop {
                    match rx.recv_timeout(WATCH_EVERY) {
                        Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                    let Some(me) = me.upgrade() else { return };
                    me.check_all();
                }
            })
            .expect("watcher thread");
    }

    fn wake(&self) -> Wake {
        let tx = Mutex::new(lock(&self.wake_tx).clone());
        Arc::new(move || {
            let _ = lock(&tx).send(());
        })
    }

    fn get(&self, name: &str) -> Option<Arc<Mutex<Session>>> {
        lock(&self.map).get(name).cloned()
    }

    fn entry(&self, name: &str) -> Arc<Mutex<Session>> {
        lock(&self.map)
            .entry(name.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(Session::new(name))))
            .clone()
    }

    /// Sends `session.changed` when the status differs from the last sent.
    fn publish(&self, s: &mut Session) {
        let status = s.status();
        if s.sent.as_ref() == Some(&status) {
            return;
        }
        let what = match (&status.state, &status.job) {
            (State::Connected, Some(j)) => {
                format!("connected, job {}/{}/{}", j.number, j.user, j.name)
            }
            (state, _) => format!("{state:?}").to_lowercase(),
        };
        log(
            &self.outbound,
            LogLevel::Info,
            format!("{}: {what}", s.name),
        );
        let _ = self.outbound.notify("session.changed", &status);
        s.sent = Some(status);
    }

    /// Looks at every session not busy with a request; sends what changed.
    pub fn check_all(&self) {
        let all: Vec<_> = lock(&self.map).values().cloned().collect();
        for s in all {
            let mut s = match s.try_lock() {
                Ok(g) => g,
                Err(TryLockError::Poisoned(p)) => p.into_inner(),
                // A request holds it and publishes when it ends.
                Err(TryLockError::WouldBlock) => continue,
            };
            s.observe();
            self.publish(&mut s);
        }
    }

    pub fn connect(&self, p: ConnectParams) -> Result<StatusDto, RpcError> {
        let password = Secret::new(p.password);
        for (field, v) in [("name", &p.name), ("host", &p.host), ("user", &p.user)] {
            if v.trim().is_empty() {
                return Err(RpcError::invalid_params(format!("{field} is empty")));
            }
        }
        trust_for(&p.tls)?;
        let endpoint = Endpoint {
            host: p.host.trim().to_owned(),
            port: p.port,
            tls: p.tls,
        };
        let user = p.user.trim().to_ascii_uppercase();
        let sess = self.entry(&p.name);
        let mut s = lock(&sess);
        s.observe();
        if s.state == State::Connected && s.endpoint.as_ref() == Some(&endpoint) && s.user == user {
            return Ok(s.status());
        }
        if let Some(problem) = s.close() {
            log(
                &self.outbound,
                LogLevel::Warn,
                format!("{}: sign-off before connecting again: {problem}", s.name),
            );
        }
        s.endpoint = Some(endpoint.clone());
        s.user = user;
        s.state = State::Connecting;
        self.publish(&mut s);

        match (self.factory)(&endpoint, self.wake()) {
            Ok(b) => s.backend = Some(b),
            Err(e) => {
                s.state = State::Disconnected;
                self.publish(&mut s);
                return Err(e);
            }
        }
        match s.sign_on(&password) {
            Ok(()) => {
                s.password = Some(password);
                s.state = State::Connected;
                self.publish(&mut s);
                Ok(s.status())
            }
            Err(e) => {
                if e.status() == Some(Status::PasswordExpired) {
                    // The connection stays open for the password change.
                    s.expired = true;
                } else {
                    s.backend = None;
                }
                s.state = State::Disconnected;
                self.publish(&mut s);
                Err(rpc_error(&e))
            }
        }
    }

    pub fn change_password(&self, p: ChangePasswordParams) -> Result<StatusDto, RpcError> {
        let old = Secret::new(p.old_password);
        let new = Secret::new(p.new_password);
        let sess = self.get(&p.name).ok_or_else(|| not_connected(&p.name))?;
        let mut s = lock(&sess);
        s.observe();
        let signed_on = matches!(s.state, State::Connected | State::Stale);
        if s.backend.is_none() || !(signed_on || s.expired) {
            return Err(not_connected(&p.name));
        }
        let user = s.user.clone();
        let b = s.backend.as_mut().expect("checked above");
        let profile = b
            .change_password(&user, &old, &new)
            .map_err(|e| rpc_error(&e))?;
        if !signed_on {
            s.state = State::Connecting;
            self.publish(&mut s);
            if let Err(e) = s.signed_on(profile) {
                s.close();
                self.publish(&mut s);
                return Err(rpc_error(&e));
            }
        }
        s.password = Some(new);
        s.state = State::Connected;
        self.publish(&mut s);
        Ok(s.status())
    }

    pub fn disconnect(&self, name: &str) {
        let Some(sess) = self.get(name) else { return };
        let mut s = lock(&sess);
        if let Some(problem) = s.close() {
            log(
                &self.outbound,
                LogLevel::Warn,
                format!("{name}: sign-off: {problem}"),
            );
        }
        self.publish(&mut s);
    }

    pub fn status(&self, name: &str) -> StatusDto {
        let Some(sess) = self.get(name) else {
            return Session::new(name).status();
        };
        let mut s = lock(&sess);
        s.observe();
        self.publish(&mut s);
        s.status()
    }

    pub fn list(&self) -> Vec<StatusDto> {
        let names: Vec<String> = lock(&self.map).keys().cloned().collect();
        names.iter().map(|n| self.status(n)).collect()
    }

    /// A signed-on session with an open connection: resumed, or signed on
    /// again with the password kept, when the connection was lost.
    fn ensure(&self, s: &mut Session) -> Result<(), RpcError> {
        s.observe();
        match s.state {
            State::Connected => return Ok(()),
            State::Disconnected | State::Connecting => return Err(not_connected(&s.name)),
            State::Stale => {}
        }
        self.publish(s);
        s.state = State::Connecting;
        self.publish(s);
        let reconnected = s
            .backend
            .as_mut()
            .expect("a stale session keeps its backend")
            .reconnect();
        let outcome = match reconnected {
            Ok(true) => match s.backend.as_mut().expect("kept").job() {
                Ok(job) => {
                    s.job = job;
                    Ok(())
                }
                Err(e) => Err(rpc_error(&e)),
            },
            Ok(false) => match s.password.clone() {
                None => Err(needs_password(None)),
                Some(pw) => match s.sign_on(&pw) {
                    Ok(()) => Ok(()),
                    Err(e) if refused(&e) => {
                        s.password = None;
                        Err(needs_password(Some(&e)))
                    }
                    Err(e) => Err(rpc_error(&e)),
                },
            },
            Err(e) => Err(rpc_error(&e)),
        };
        s.state = if outcome.is_ok() {
            State::Connected
        } else {
            State::Stale
        };
        self.publish(s);
        outcome
    }

    /// `libl.get`.
    // QAP v2: library_list
    pub fn libl_get(&self, name: &str) -> Result<LiblDto, RpcError> {
        let sess = self.get(name).ok_or_else(|| not_connected(name))?;
        let mut s = lock(&sess);
        self.ensure(&mut s)?;
        Err(libl_unavailable())
    }

    /// `libl.set`.
    // QAP v2: library_list
    pub fn libl_set(&self, p: LiblSetParams) -> Result<LiblDto, RpcError> {
        let current = p.current.as_deref().map(library_name).transpose()?;
        let mut user = Vec::with_capacity(p.user.len());
        for l in &p.user {
            let l = library_name(l)?;
            if user.contains(&l) {
                return Err(RpcError::invalid_params(format!(
                    "{l} is in the list twice"
                )));
            }
            user.push(l);
        }
        let request = SetLibraryList { current, user };
        let sess = self.get(&p.name).ok_or_else(|| not_connected(&p.name))?;
        let mut s = lock(&sess);
        self.ensure(&mut s)?;
        set_library_list(&mut s, &request)
    }
}

/// The plan's proposed `library_list.set` (QAP additions): the user part
/// and the current library, applied to the session job. The system part is
/// the server's.
// QAP v2: library_list
struct SetLibraryList {
    #[allow(dead_code)]
    current: Option<String>,
    #[allow(dead_code)]
    user: Vec<String>,
}

/// Sends [`SetLibraryList`] once QAP has the service. The pinned
/// `qap-client` has none, so nothing is sent; it is never emulated with
/// remote commands.
// QAP v2: library_list
fn set_library_list(_s: &mut Session, _request: &SetLibraryList) -> Result<LiblDto, RpcError> {
    Err(libl_unavailable())
}

/// Registers `session.*` and `libl.*`.
pub fn register(r: &mut Registry, sessions: &Arc<Sessions>) {
    let s = Arc::clone(sessions);
    r.register("session.connect", move |p: ConnectParams, _: &Context| {
        s.connect(p)
    });
    let s = Arc::clone(sessions);
    r.register(
        "session.changePassword",
        move |p: ChangePasswordParams, _: &Context| s.change_password(p),
    );
    let s = Arc::clone(sessions);
    r.register("session.disconnect", move |p: NameParams, _: &Context| {
        s.disconnect(&p.name);
        Ok::<_, RpcError>(())
    });
    let s = Arc::clone(sessions);
    r.register("session.status", move |p: NameParams, _: &Context| {
        Ok::<_, RpcError>(s.status(&p.name))
    });
    let s = Arc::clone(sessions);
    r.register("session.list", move |_: NoParams, _: &Context| {
        Ok::<_, RpcError>(s.list())
    });
    let s = Arc::clone(sessions);
    r.register("libl.get", move |p: NameParams, _: &Context| {
        s.libl_get(&p.name)
    });
    let s = Arc::clone(sessions);
    r.register("libl.set", move |p: LiblSetParams, _: &Context| {
        s.libl_set(p)
    });
}
