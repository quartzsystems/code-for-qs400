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
//!
//! Every connection asks for QAP version 9 ([`QAP_ASKED`]). The `Develop`
//! service (version 8) is reached through [`Backend::develop`]: the
//! library list here, objects and members in `objects` and `members`,
//! each one `qap-client` call through [`Sessions::develop`]. The `Ifs`
//! service (version 5, `Stat` 6) is reached through [`Backend::ifs`] and
//! [`Sessions::ifs`], for `crate::ifs`. `Command` (version 2), `Develop`'s
//! `Compile` and `Jobs`' `JobLog` (version 8) are reached through
//! [`Backend::command`] and [`Sessions::command`], for `crate::actions`
//! and `crate::jobs`. `Sql` (version 4, the catalog's routines and
//! indexes 8) is reached through [`Backend::sql`] and [`Sessions::sql`],
//! for `crate::sql`, which keeps each session's own attached connection.
//! `Jobs` (version 8), `Spool` (3, its watches 6) and `Messages` (6) are
//! reached through [`Backend::work`] and [`Sessions::work`], for
//! `crate::jobs`, `crate::spool` and `crate::messages`. What the client's
//! watches report is taken after every call and whenever the watcher
//! looks, and handed to the hooks of [`Sessions::on_events`].

use std::collections::BTreeMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError, Weak};
use std::time::Duration;

use host_rpc::{Context, NoParams, Outbound, Registry, RpcError};
use qap_client::develop::WriteOptions;
use qap_client::ifs::Stamp;
use qap_client::proto::ops::command::CommandText;
use qap_client::proto::ops::develop::{
    Attribute, Libraries, LibraryList, ListLibraries, ListMembers, ListObjects, MemberData,
    Members, Objects, SetLibraryList,
};
use qap_client::proto::ops::ifs::{Entry, ReadFile, WriteFile};
use qap_client::proto::ops::jobs::{JobEntry, JobLog, JobLogEntries, JobState};
use qap_client::proto::ops::messages::{Key, Messages, Queue, Recipient};
use qap_client::proto::ops::spool::{ListSpooledFiles, OutputQueue, ReadSpooledFile, SpooledFile};
use qap_client::proto::types::{EndHow, JobId, MemberName, ObjectName, SourceRecord};
use qap_client::proto::{Op, Status};
use qap_client::spool::Action;
use qap_client::{
    Client, Error, Files, Jobs, Pending, Requests, Secret, Target, Wake, Watch, WatchEvent,
};
use qsa_net::Trust;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{LogLevel, log};

/// JSON-RPC error codes of the session methods.
pub mod codes {
    /// `libl.*`, `object.*`, `member.*`: the connection agreed a QAP
    /// version below 8, which has no `Develop` service. `data` is
    /// `{ version }`, the version agreed.
    pub const QAP_UNAVAILABLE: i64 = -32001;
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
    /// A local file a transfer reads or writes failed (`ifs.upload`'s
    /// `from`, `ifs.download`'s `to`): nothing the server said.
    pub const LOCAL: i64 = -32012;
}

/// The QAP version every connection asks for: 9, so that `Develop` (8)
/// is there when the server has it. The server picks the highest both
/// speak.
pub const QAP_ASKED: u16 = 9;

/// The version `Develop` needs.
pub const QAP_DEVELOP: u16 = 8;

/// The version `Ifs` needs. `Stat` is 6; before it a file's stamp is
/// `GetInfo`'s `modified`, as [`Files::stamp`] falls back.
pub const QAP_IFS: u16 = 5;

/// The version `Command` (`RunCommand`, `CheckCommand`) needs.
pub const QAP_COMMAND: u16 = 2;

/// The version `Sql` needs: statements, cursors and `ListSchemas` to
/// `ListColumns`. `ListRoutines` and `ListIndexes` need [`QAP_DEVELOP`].
pub const QAP_SQL: u16 = 4;

/// The version `Spool` needs: lists, reads and actions. Its watches need
/// [`QAP_WATCH`].
pub const QAP_SPOOL: u16 = 3;

/// The version `Messages` and the watches (`WatchQueue`, `WatchSpool`)
/// need.
pub const QAP_WATCH: u16 = 6;

/// The version `Jobs` needs.
pub const QAP_JOBS: u16 = 8;

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
    /// PEM texts trusted for this connection alone: what "Trust for this
    /// connection" saved, as QS/400 Access keeps them in a system's CA list.
    #[serde(default)]
    pub certificates: Vec<String>,
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
    /// Absent: resume the session this name has to the same endpoint and
    /// user, as the first call after a drop would; `needs_password` when
    /// there is none to resume.
    #[serde(default)]
    pub password: Option<String>,
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
    /// The `Develop` operations on this connection.
    fn develop(&mut self) -> &mut dyn DevelopBackend;
    /// The `Ifs` operations on this connection.
    fn ifs(&mut self) -> &mut dyn IfsBackend;
    /// `Command`, `Develop`'s `Compile` and `Jobs`' `JobLog` on this
    /// connection.
    fn command(&mut self) -> &mut dyn CommandBackend;
    /// The `Sql` catalog on this connection, and attaching a connection of
    /// its own for statements. `None` for a backend without them (the
    /// tests of the other services).
    fn sql(&mut self) -> Option<&mut dyn crate::sql::SqlBackend> {
        None
    }
    /// `Jobs`, `Spool`, `Messages` and the watches on this connection.
    /// `None` for a backend without them (the tests of the other
    /// services).
    fn work(&mut self) -> Option<&mut dyn WorkBackend> {
        None
    }
}

/// `qap-client`'s `Jobs`, `Spool` and `Messages`, and the watches its
/// [`Client`] keeps, as an object: one method per `qap-client` call of the
/// same name. `read_spooled_file` and `spool_action` only send, so the
/// caller waits for the reply with the session let go. Tests implement it
/// with canned replies.
pub trait WorkBackend {
    /// [`Jobs::all_jobs`]: every job, a page of 500 at a time.
    fn all_jobs(&mut self, user: &str, status: Option<JobState>) -> Result<Vec<JobEntry>, Error>;
    fn hold_job(&mut self, job: &JobId) -> Result<(), Error>;
    fn release_job(&mut self, job: &JobId) -> Result<(), Error>;
    fn end_job(&mut self, job: &JobId, how: EndHow, delay: Option<u32>) -> Result<(), Error>;
    /// [`Client::all_spooled_files`]: every file matching, 500 at a time.
    fn all_spooled_files(&mut self, req: &ListSpooledFiles) -> Result<Vec<SpooledFile>, Error>;
    /// [`Client::all_output_queues`].
    fn all_output_queues(&mut self, library: &str) -> Result<Vec<OutputQueue>, Error>;
    /// [`Client::read_spooled_file`]: sent, not waited for.
    fn read_spooled_file(&mut self, req: &ReadSpooledFile) -> Result<Pending, Error>;
    /// [`Client::spool_action`]: sent, not waited for; read the reply with
    /// [`Action::outcome`].
    fn spool_action(&mut self, action: &Action) -> Result<Pending, Error>;
    /// [`Client::list_messages`]: one page.
    fn list_messages(
        &mut self,
        queue: &Queue,
        newest_first: bool,
        start: u32,
        max: u32,
    ) -> Result<Messages, Error>;
    fn reply_message(&mut self, queue: &Queue, key: Key, reply: &str) -> Result<(), Error>;
    fn remove_messages(&mut self, queue: &Queue, keys: &[Key]) -> Result<(), Error>;
    fn send_message(
        &mut self,
        to: &Recipient,
        text: &str,
        inquiry: bool,
    ) -> Result<Option<Key>, Error>;
    /// [`Client::may_read_queue`].
    fn may_read_queue(&mut self, queue: &Queue) -> Result<bool, Error>;
    /// [`Client::watch`].
    fn watch(&mut self, w: Watch) -> Result<(), Error>;
    /// [`Client::unwatch`].
    fn unwatch(&mut self, w: &Watch) -> Result<(), Error>;
    /// [`Client::watch_events`]: what the watches reported since the last
    /// look, oldest first. Sends nothing.
    fn watch_events(&mut self) -> Vec<WatchEvent>;
    /// How long a short request (`spool_action`) waits for its reply.
    fn reply_timeout(&self) -> Duration;
}

impl WorkBackend for Client {
    fn all_jobs(&mut self, user: &str, status: Option<JobState>) -> Result<Vec<JobEntry>, Error> {
        Jobs::all_jobs(self, user, status)
    }
    fn hold_job(&mut self, job: &JobId) -> Result<(), Error> {
        Jobs::hold_job(self, job)
    }
    fn release_job(&mut self, job: &JobId) -> Result<(), Error> {
        Jobs::release_job(self, job)
    }
    fn end_job(&mut self, job: &JobId, how: EndHow, delay: Option<u32>) -> Result<(), Error> {
        Jobs::end_job(self, job, how, delay)
    }
    fn all_spooled_files(&mut self, req: &ListSpooledFiles) -> Result<Vec<SpooledFile>, Error> {
        Client::all_spooled_files(self, req)
    }
    fn all_output_queues(&mut self, library: &str) -> Result<Vec<OutputQueue>, Error> {
        Client::all_output_queues(self, library)
    }
    fn read_spooled_file(&mut self, req: &ReadSpooledFile) -> Result<Pending, Error> {
        Client::read_spooled_file(self, req)
    }
    fn spool_action(&mut self, action: &Action) -> Result<Pending, Error> {
        Client::spool_action(self, action)
    }
    fn list_messages(
        &mut self,
        queue: &Queue,
        newest_first: bool,
        start: u32,
        max: u32,
    ) -> Result<Messages, Error> {
        Client::list_messages(self, queue, newest_first, start, max)
    }
    fn reply_message(&mut self, queue: &Queue, key: Key, reply: &str) -> Result<(), Error> {
        Client::reply_message(self, queue, key, reply)
    }
    fn remove_messages(&mut self, queue: &Queue, keys: &[Key]) -> Result<(), Error> {
        Client::remove_messages(self, queue, keys)
    }
    fn send_message(
        &mut self,
        to: &Recipient,
        text: &str,
        inquiry: bool,
    ) -> Result<Option<Key>, Error> {
        Client::send_message(self, to, text, inquiry)
    }
    fn may_read_queue(&mut self, queue: &Queue) -> Result<bool, Error> {
        Client::may_read_queue(self, queue)
    }
    fn watch(&mut self, w: Watch) -> Result<(), Error> {
        Client::watch(self, w)
    }
    fn unwatch(&mut self, w: &Watch) -> Result<(), Error> {
        Client::unwatch(self, w)
    }
    fn watch_events(&mut self) -> Vec<WatchEvent> {
        Client::watch_events(self)
    }
    fn reply_timeout(&self) -> Duration {
        self.target().options.reply_timeout
    }
}

/// The lane's commands and the job log as an object, for a [`Backend`]
/// trait object. The three `send_*`/`compile`/`run_command` methods only
/// send and return the [`Pending`], so the caller waits for the reply with
/// the session let go: a command waits in the connection job's lane
/// behind any other, and a compile has no reply timeout. Implemented for
/// every `qap-client` connection through its [`Requests`]; tests do it over
/// a canned connection.
pub trait CommandBackend {
    /// `RunCommand`, as [`Client::run_command`] sends it. Read the reply
    /// with [`qap_client::CommandOutcome::from_reply`].
    fn run_command(&mut self, command: &str) -> Result<Pending, Error>;
    /// `CheckCommand`, sent and not waited for; read the reply with
    /// [`qap_client::CheckOutcome::from_reply`].
    fn send_check(&mut self, command: &str) -> Result<Pending, Error>;
    /// [`qap_client::Develop::compile`]. Read the reply with
    /// [`qap_client::CompileOutcome::from_reply`].
    fn compile(&mut self, command: &str) -> Result<Pending, Error>;
    /// [`Jobs::job_log`]: one page of a job's log.
    fn job_log(&mut self, req: &JobLog) -> Result<JobLogEntries, Error>;
    /// How long a short request (`CheckCommand`) waits for its reply.
    fn reply_timeout(&self) -> Duration;
}

impl<T: Requests> CommandBackend for T {
    fn run_command(&mut self, command: &str) -> Result<Pending, Error> {
        self.request_op(
            Op::RunCommand,
            &CommandText {
                command: command.to_owned(),
            },
        )
    }
    fn send_check(&mut self, command: &str) -> Result<Pending, Error> {
        self.request_op(
            Op::CheckCommand,
            &CommandText {
                command: command.to_owned(),
            },
        )
    }
    fn compile(&mut self, command: &str) -> Result<Pending, Error> {
        qap_client::Develop::compile(self, command)
    }
    fn job_log(&mut self, req: &JobLog) -> Result<JobLogEntries, Error> {
        Jobs::job_log(self, req)
    }
    fn reply_timeout(&self) -> Duration {
        Requests::reply_timeout(self)
    }
}

/// `qap-client`'s [`Files`] as an object: one method per operation or
/// helper, each the `qap-client` call of the same name, so a [`Backend`]
/// trait object reaches them. The two `send_*` methods only send, for
/// `qap_client::ifs::read` and `write`, which wait for each reply
/// themselves with the session let go. Tests implement it with canned
/// replies.
pub trait IfsBackend {
    /// [`Files::all_entries`]: every entry, a page of
    /// [`qap_client::ifs::LIST_PAGE`] at a time through
    /// [`qap_client::ifs::Listing`].
    fn all_entries(&mut self, path: &str, pattern: &str) -> Result<Vec<Entry>, Error>;
    fn get_info(&mut self, path: &str) -> Result<Entry, Error>;
    /// [`Files::stamp`]: the entry and its stamp, a link itself.
    fn stamp(&mut self, path: &str) -> Result<(Entry, Stamp), Error>;
    /// [`Files::checked`]: the path a copy of `path` is checked against (a
    /// link's target), with its entry and stamp.
    fn checked(&mut self, path: &str) -> Result<(String, Entry, Stamp), Error>;
    /// [`Files::resolve`]: what `entry`, in `dir`, opens as.
    fn resolve(&mut self, dir: &str, entry: &Entry) -> Result<(String, Entry), Error>;
    fn create_directory(&mut self, path: &str, parents: bool) -> Result<(), Error>;
    fn delete(&mut self, path: &str) -> Result<(), Error>;
    fn rename(&mut self, from: &str, to: &str, replace: bool) -> Result<(), Error>;
    fn copy(&mut self, from: &str, to: &str, replace: bool) -> Result<(), Error>;
    /// [`qap_client::ifs::resume_offset`].
    fn resume_offset(&mut self, path: &str, local_len: u64) -> Result<u64, Error>;
    /// Sends one `ReadFile` and returns at once.
    fn send_read(&mut self, req: &ReadFile) -> Result<Pending, Error>;
    /// Sends one `WriteFile` and returns at once.
    fn send_write(&mut self, req: &WriteFile) -> Result<Pending, Error>;
}

impl<T: Files> IfsBackend for T {
    fn all_entries(&mut self, path: &str, pattern: &str) -> Result<Vec<Entry>, Error> {
        Files::all_entries(self, path, pattern)
    }
    fn get_info(&mut self, path: &str) -> Result<Entry, Error> {
        Files::get_info(self, path)
    }
    fn stamp(&mut self, path: &str) -> Result<(Entry, Stamp), Error> {
        Files::stamp(self, path)
    }
    fn checked(&mut self, path: &str) -> Result<(String, Entry, Stamp), Error> {
        Files::checked(self, path)
    }
    fn resolve(&mut self, dir: &str, entry: &Entry) -> Result<(String, Entry), Error> {
        Files::resolve(self, dir, entry)
    }
    fn create_directory(&mut self, path: &str, parents: bool) -> Result<(), Error> {
        Files::create_directory(self, path, parents)
    }
    fn delete(&mut self, path: &str) -> Result<(), Error> {
        Files::delete(self, path)
    }
    fn rename(&mut self, from: &str, to: &str, replace: bool) -> Result<(), Error> {
        Files::rename(self, from, to, replace)
    }
    fn copy(&mut self, from: &str, to: &str, replace: bool) -> Result<(), Error> {
        Files::copy(self, from, to, replace)
    }
    fn resume_offset(&mut self, path: &str, local_len: u64) -> Result<u64, Error> {
        qap_client::ifs::resume_offset(self, path, local_len)
    }
    fn send_read(&mut self, req: &ReadFile) -> Result<Pending, Error> {
        self.ifs_request(Op::ReadFile, req)
    }
    fn send_write(&mut self, req: &WriteFile) -> Result<Pending, Error> {
        self.ifs_request(Op::WriteFile, req)
    }
}

/// `qap-client`'s [`qap_client::Develop`] as an object: one method per
/// operation, each the `qap-client` call of the same name. Every
/// `qap-client` connection has it; tests implement it with canned replies.
pub trait DevelopBackend {
    fn get_library_list(&mut self) -> Result<LibraryList, Error>;
    fn set_library_list(&mut self, req: &SetLibraryList) -> Result<LibraryList, Error>;
    fn list_libraries(&mut self, req: &ListLibraries) -> Result<Libraries, Error>;
    fn list_objects(&mut self, req: &ListObjects) -> Result<Objects, Error>;
    fn describe_object(&mut self, object: &ObjectName, ty: &str) -> Result<Vec<Attribute>, Error>;
    fn list_members(&mut self, req: &ListMembers) -> Result<Members, Error>;
    fn read_member(&mut self, member: &MemberName, lock: bool) -> Result<MemberData, Error>;
    fn write_member(
        &mut self,
        member: &MemberName,
        records: &[SourceRecord],
        options: &WriteOptions,
    ) -> Result<u32, Error>;
    fn unlock_member(&mut self, member: &MemberName) -> Result<(), Error>;
    fn create_member(
        &mut self,
        member: &MemberName,
        srctype: &str,
        text: &str,
    ) -> Result<(), Error>;
    fn copy_member(
        &mut self,
        from: &MemberName,
        to: &MemberName,
        replace: bool,
    ) -> Result<(), Error>;
    fn rename_member(&mut self, member: &MemberName, new_name: &str) -> Result<(), Error>;
    fn delete_member(&mut self, member: &MemberName) -> Result<(), Error>;
    fn change_member(
        &mut self,
        member: &MemberName,
        srctype: Option<&str>,
        text: Option<&str>,
    ) -> Result<(), Error>;
}

impl<T: Requests> DevelopBackend for T {
    fn get_library_list(&mut self) -> Result<LibraryList, Error> {
        qap_client::Develop::get_library_list(self)
    }
    fn set_library_list(&mut self, req: &SetLibraryList) -> Result<LibraryList, Error> {
        qap_client::Develop::set_library_list(self, req)
    }
    fn list_libraries(&mut self, req: &ListLibraries) -> Result<Libraries, Error> {
        qap_client::Develop::list_libraries(self, req)
    }
    fn list_objects(&mut self, req: &ListObjects) -> Result<Objects, Error> {
        qap_client::Develop::list_objects(self, req)
    }
    fn describe_object(&mut self, object: &ObjectName, ty: &str) -> Result<Vec<Attribute>, Error> {
        qap_client::Develop::describe_object(self, object, ty)
    }
    fn list_members(&mut self, req: &ListMembers) -> Result<Members, Error> {
        qap_client::Develop::list_members(self, req)
    }
    fn read_member(&mut self, member: &MemberName, lock: bool) -> Result<MemberData, Error> {
        qap_client::Develop::read_member(self, member, lock)
    }
    fn write_member(
        &mut self,
        member: &MemberName,
        records: &[SourceRecord],
        options: &WriteOptions,
    ) -> Result<u32, Error> {
        qap_client::Develop::write_member(self, member, records, options)
    }
    fn unlock_member(&mut self, member: &MemberName) -> Result<(), Error> {
        qap_client::Develop::unlock_member(self, member)
    }
    fn create_member(
        &mut self,
        member: &MemberName,
        srctype: &str,
        text: &str,
    ) -> Result<(), Error> {
        qap_client::Develop::create_member(self, member, srctype, text)
    }
    fn copy_member(
        &mut self,
        from: &MemberName,
        to: &MemberName,
        replace: bool,
    ) -> Result<(), Error> {
        qap_client::Develop::copy_member(self, from, to, replace)
    }
    fn rename_member(&mut self, member: &MemberName, new_name: &str) -> Result<(), Error> {
        qap_client::Develop::rename_member(self, member, new_name)
    }
    fn delete_member(&mut self, member: &MemberName) -> Result<(), Error> {
        qap_client::Develop::delete_member(self, member)
    }
    fn change_member(
        &mut self,
        member: &MemberName,
        srctype: Option<&str>,
        text: Option<&str>,
    ) -> Result<(), Error> {
        qap_client::Develop::change_member(self, member, srctype, text)
    }
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

    fn develop(&mut self) -> &mut dyn DevelopBackend {
        &mut self.client
    }

    fn ifs(&mut self) -> &mut dyn IfsBackend {
        &mut self.client
    }

    fn command(&mut self) -> &mut dyn CommandBackend {
        &mut self.client
    }

    fn sql(&mut self) -> Option<&mut dyn crate::sql::SqlBackend> {
        Some(&mut self.client)
    }

    fn work(&mut self) -> Option<&mut dyn WorkBackend> {
        Some(&mut self.client)
    }
}

/// Trust for `tls`: the platform's store, plus `caFile` when given and the
/// connection's own `certificates`. The same rule as QS/400 Access: nothing
/// unverified is ever accepted; a certificate in the list is trusted as it
/// stands.
pub fn trust_for(tls: &TlsParams) -> Result<Trust, RpcError> {
    if tls.verify == Some(false) {
        return Err(RpcError::invalid_params(
            "tls.verify cannot be false: QAP accepts only a verified server certificate; \
             trust a self-signed one with tls.caFile",
        ));
    }
    let mut trust = Trust::from_pem(tls.certificates.iter().map(String::as_str));
    let Some(path) = tls.ca_file.as_deref().filter(|p| !p.trim().is_empty()) else {
        return Ok(trust);
    };
    let pem = std::fs::read_to_string(path)
        .map_err(|e| RpcError::invalid_params(format!("tls.caFile {path}: {e}")))?;
    let from_file = Trust::from_pem([pem.as_str()]);
    if from_file.certificates.is_empty() {
        return Err(RpcError::invalid_params(format!(
            "tls.caFile {path}: no certificate in it"
        )));
    }
    trust.certificates.extend(from_file.certificates);
    Ok(trust)
}

/// The real factory: a [`Client`] for the endpoint.
pub fn qap_factory() -> Factory {
    Arc::new(|ep: &Endpoint, wake: Wake| {
        let trust = trust_for(&ep.tls)?;
        let port = ep.port.unwrap_or(qap_client::proto::DEFAULT_PORT);
        let mut target = Target::new(ep.host.clone(), port, trust).with_max_version(QAP_ASKED);
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
    if matches!(e, Error::Read(_) | Error::Write(_)) {
        err.code = codes::LOCAL;
    } else if let Some(status) = e.status() {
        err.code = codes::SERVER;
        err.data = Some(server_data(status, e));
    } else if let Error::Connect(qsa_net::ConnectError::Tls(qsa_net::TlsError::Untrusted {
        reason,
        certificate,
        info,
    })) = e
    {
        // The server's certificate goes with the error so the editor can
        // show it and offer to trust it, as QS/400 Access's dialog does.
        err.data = Some(json!({
            "kind": "untrusted",
            "reason": reason,
            "certificate": qsa_net::tls::to_pem(certificate),
            "subject": info.subject,
            "issuer": info.issuer,
            "notBefore": info.not_before,
            "notAfter": info.not_after,
            "sha256": info.sha256,
            "serial": info.serial,
        }));
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

/// The connection agreed `version`, below [`QAP_DEVELOP`].
pub fn qap_unavailable(version: u16) -> RpcError {
    qap_unavailable_for(QAP_DEVELOP, version)
}

/// The connection agreed `version`, below `needed`.
pub fn qap_unavailable_for(needed: u16, version: u16) -> RpcError {
    let mut e = RpcError::new(
        codes::QAP_UNAVAILABLE,
        format!("QAP version {needed} not available on this server"),
    );
    e.data = Some(json!({ "version": version }));
    e
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
    /// Counts sign-ons: what was attached to an earlier one (an SQL
    /// connection) belongs to a session token that is gone.
    epoch: u64,
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
            epoch: 0,
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
        self.epoch += 1;
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

/// Called with a session's name after it was closed: disconnected, or
/// replaced by a new sign-on.
pub type CloseHook = Arc<dyn Fn(&str) + Send + Sync>;

/// Called with a session's name and what its watches reported, oldest
/// first, with the session let go.
pub type EventHook = Arc<dyn Fn(&str, Vec<WatchEvent>) + Send + Sync>;

/// What the session's watches reported since the last look; nothing for a
/// backend without watches.
fn take_events(s: &mut Session) -> Vec<WatchEvent> {
    match s.backend.as_mut().and_then(|b| b.work()) {
        Some(w) => w.watch_events(),
        None => Vec::new(),
    }
}

/// Every session of this host.
pub struct Sessions {
    map: Mutex<BTreeMap<String, Arc<Mutex<Session>>>>,
    factory: Factory,
    outbound: Outbound,
    wake_tx: Mutex<Sender<()>>,
    wake_rx: Mutex<Option<Receiver<()>>>,
    closed: Mutex<Vec<CloseHook>>,
    events: Mutex<Vec<EventHook>>,
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
            closed: Mutex::new(Vec::new()),
            events: Mutex::new(Vec::new()),
        })
    }

    /// Calls `f` with what each session's watches report, after the session
    /// is let go.
    pub fn on_events(&self, f: EventHook) {
        lock(&self.events).push(f);
    }

    fn dispatch(&self, name: &str, events: Vec<WatchEvent>) {
        if events.is_empty() {
            return;
        }
        let hooks: Vec<EventHook> = lock(&self.events).clone();
        for h in hooks {
            h(name, events.clone());
        }
    }

    /// Calls `f` with a session's name each time it is closed, after the
    /// session is let go.
    pub fn on_close(&self, f: CloseHook) {
        lock(&self.closed).push(f);
    }

    fn closed(&self, name: &str) {
        let hooks: Vec<CloseHook> = lock(&self.closed).clone();
        for h in hooks {
            h(name);
        }
    }

    /// The outbound stream notifications go on.
    pub fn outbound(&self) -> &Outbound {
        &self.outbound
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

    /// Looks at every session not busy with a request; sends what changed
    /// and what its watches reported.
    pub fn check_all(&self) {
        let all: Vec<_> = lock(&self.map).values().cloned().collect();
        for s in all {
            let mut s = match s.try_lock() {
                Ok(g) => g,
                Err(TryLockError::Poisoned(p)) => p.into_inner(),
                // A request holds it, publishes and takes the events when
                // it ends.
                Err(TryLockError::WouldBlock) => continue,
            };
            s.observe();
            self.publish(&mut s);
            let events = take_events(&mut s);
            let name = s.name.clone();
            drop(s);
            self.dispatch(&name, events);
        }
    }

    pub fn connect(&self, p: ConnectParams) -> Result<StatusDto, RpcError> {
        let password = p.password.map(Secret::new);
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
        let same = s.endpoint.as_ref() == Some(&endpoint) && s.user == user;
        if same && s.state == State::Connected {
            return Ok(s.status());
        }
        let Some(password) = password else {
            if same && s.state == State::Stale {
                self.ensure(&mut s)?;
                return Ok(s.status());
            }
            return Err(needs_password(None));
        };
        let was_signed_on = matches!(s.state, State::Connected | State::Stale);
        if let Some(problem) = s.close() {
            log(
                &self.outbound,
                LogLevel::Warn,
                format!("{}: sign-off before connecting again: {problem}", s.name),
            );
        }
        if was_signed_on {
            // What was attached to the old session goes before the new one.
            drop(s);
            self.closed(&p.name);
            s = lock(&sess);
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
        drop(s);
        self.closed(name);
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

    /// Runs `f` on the session's backend: the session brought back first
    /// if it went stale, and refused with [`qap_unavailable_for`] when the
    /// connection agreed a version below `needed`. A drop `f` met is sent
    /// as `session.changed`. The session is held only while `f` runs.
    fn with_backend<T>(
        &self,
        name: &str,
        needed: u16,
        f: impl FnOnce(&mut dyn Backend) -> Result<T, Error>,
    ) -> Result<T, RpcError> {
        let sess = self.get(name).ok_or_else(|| not_connected(name))?;
        let mut s = lock(&sess);
        self.ensure(&mut s)?;
        let version = s.system.as_ref().map_or(0, |sys| sys.qap);
        if version < needed {
            return Err(qap_unavailable_for(needed, version));
        }
        let b = s
            .backend
            .as_mut()
            .expect("a connected session has a backend");
        let out = f(b.as_mut()).map_err(|e| match e {
            Error::Unsupported { has, .. } => qap_unavailable_for(needed, has),
            e => rpc_error(&e),
        });
        s.observe();
        self.publish(&mut s);
        // A call takes in the server's events (and a resume watches again):
        // what they reported goes on now, not at the watcher's next look.
        let events = take_events(&mut s);
        drop(s);
        self.dispatch(name, events);
        out
    }

    /// Runs `f` on the session's `Jobs`, `Spool`, `Messages` and watches,
    /// refused below version `needed` ([`QAP_JOBS`], [`QAP_SPOOL`] or
    /// [`QAP_WATCH`]), as [`Sessions::with_backend`] does.
    pub fn work<T>(
        &self,
        name: &str,
        needed: u16,
        f: impl FnOnce(&mut dyn WorkBackend) -> Result<T, Error>,
    ) -> Result<T, RpcError> {
        self.with_backend(name, needed, |b| match b.work() {
            Some(w) => f(w),
            None => Err(Error::Unsupported {
                op: Op::ListJobs,
                needs: needed,
                has: 0,
            }),
        })
    }

    /// Runs `f` on the session's `Develop` operations (version 8), as
    /// [`Sessions::with_backend`] does.
    pub fn develop<T>(
        &self,
        name: &str,
        f: impl FnOnce(&mut dyn DevelopBackend) -> Result<T, Error>,
    ) -> Result<T, RpcError> {
        self.with_backend(name, QAP_DEVELOP, |b| f(b.develop()))
    }

    /// Runs `f` on the session's `Ifs` operations (version 5), as
    /// [`Sessions::with_backend`] does. A transfer calls it once per
    /// request it sends and waits for the reply outside it, so the
    /// connection's other requests go on meanwhile.
    pub fn ifs<T>(
        &self,
        name: &str,
        f: impl FnOnce(&mut dyn IfsBackend) -> Result<T, Error>,
    ) -> Result<T, RpcError> {
        self.with_backend(name, QAP_IFS, |b| f(b.ifs()))
    }

    /// Runs `f` on the session's `Command`, `Compile` and `JobLog`
    /// operations, refused below version `needed` ([`QAP_COMMAND`] or
    /// [`QAP_DEVELOP`]), as [`Sessions::with_backend`] does. What waits in
    /// the lane is only sent here; the caller waits outside.
    pub fn command<T>(
        &self,
        name: &str,
        needed: u16,
        f: impl FnOnce(&mut dyn CommandBackend) -> Result<T, Error>,
    ) -> Result<T, RpcError> {
        self.with_backend(name, needed, |b| f(b.command()))
    }

    /// Runs `f` on the session's `Sql` catalog and attach (version 4, or
    /// `needed`), as [`Sessions::with_backend`] does; with the session's
    /// sign-on epoch, which changes when it signs on anew.
    pub fn sql<T>(
        &self,
        name: &str,
        needed: u16,
        f: impl FnOnce(&mut dyn crate::sql::SqlBackend) -> Result<T, Error>,
    ) -> Result<(T, u64), RpcError> {
        let mut epoch = 0;
        let out = self.with_backend(name, needed, |b| match b.sql() {
            Some(q) => f(q),
            None => Err(Error::Unsupported {
                op: Op::Prepare,
                needs: needed,
                has: 0,
            }),
        });
        if out.is_ok()
            && let Some(sess) = self.get(name)
        {
            epoch = lock(&sess).epoch;
        }
        out.map(|t| (t, epoch))
    }

    /// The session's sign-on epoch while it is signed on.
    pub fn epoch(&self, name: &str) -> Option<u64> {
        let sess = self.get(name)?;
        let s = lock(&sess);
        matches!(s.state, State::Connected | State::Stale).then_some(s.epoch)
    }

    /// `libl.get`: `GetLibraryList`, in the connection job's lane.
    pub fn libl_get(&self, name: &str) -> Result<LiblDto, RpcError> {
        self.develop(name, |d| d.get_library_list())
            .map(LiblDto::from)
    }

    /// `libl.set`: `SetLibraryList`, in the lane; the list as it now is.
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
        self.develop(&p.name, |d| d.set_library_list(&request))
            .map(LiblDto::from)
    }
}

impl From<LibraryList> for LiblDto {
    fn from(l: LibraryList) -> LiblDto {
        LiblDto {
            current: l.current,
            system: l.system,
            user: l.user,
        }
    }
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
