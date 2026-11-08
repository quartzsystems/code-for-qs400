// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `sql.*`: statements, cursors, commitment control and the catalog, over
//! `qap-client`'s `Sql` service (version 4; routines and indexes 8).
//!
//! - Each session has one [`SqlConnection`], attached to it on first use
//!   (`Client::sql_connection`), with its options, statements and cursors.
//!   It is made again when the session signs on anew or ends, and when
//!   `qap-client` says it was lost ([`SqlConnection::lost`]); either way
//!   `sql.lost` tells the extension that what was uncommitted, and every
//!   open cursor, is gone. Nothing is ever run again by itself.
//! - `sql.run` is `Prepare`, `Execute` and, for a query, one `Fetch`. The
//!   statement is released at once unless it is a query; a query's is
//!   released with its cursor (at its end, at `sql.close`, or when it is
//!   exported), because `Release` takes the statement's cursors with it.
//! - A query's result is the host's: `cursor` in the JSON is its ID, not
//!   QAP's cursor number, and it holds the rows sent so far, so
//!   `sql.export` can write them before the rest. It stays until
//!   `sql.close`.
//! - Every method is deferred, on a thread of its own: `Execute`, `Fetch`,
//!   `Commit` and `Rollback` wait in the connection job's lane with no
//!   reply timeout, and the connection is held only to send and to read
//!   each reply, so a long query does not hold up the catalog or another
//!   run's `sql.cancel`.
//! - Values become JSON and CSV in [`values`] only; CSV is [`csv`].

pub mod values;

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use host_rpc::{Context, Outbound, Registry, Responder, RpcError};
use qap_client::proto::ops::sql::{
    Column, CommitLevel, Index, ListRoutines, ListSchemas, ListTables, Naming, Prepared, Routines,
    Schemas, SetOptions, SqlValue, Tables,
};
use qap_client::{Client, Error, ExecuteOutcome, FetchOutcome, Pending, Reply, SqlConnection};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::actions::{MessageDto, on_thread};
use crate::session::{QAP_SQL, Sessions, rpc_error};
use crate::{LogLevel, log};

/// JSON-RPC error codes of `sql.*`.
pub mod codes {
    /// No result has that `cursor`, or its rows are no longer held.
    pub const NO_RESULT: i64 = -32031;
}

/// Rows a page asks for when none is given.
pub const PAGE: u32 = 500;

/// How often a wait looks for a cancel.
const CANCEL_EVERY: Duration = Duration::from_millis(50);

// What the host needs of qap-client, as objects.

/// The `Sql` catalog and attaching, on a session's shared connection:
/// each method the `qap-client` call of the same name. [`Client`] has it;
/// tests implement it with canned replies.
pub trait SqlBackend {
    /// [`Client::sql_connection`]: a connection of its own for statements.
    fn sql_connection(&mut self) -> Result<Box<dyn SqlConn>, Error>;
    fn list_schemas(&mut self, req: &ListSchemas) -> Result<Schemas, Error>;
    fn list_tables(&mut self, req: &ListTables) -> Result<Tables, Error>;
    fn list_columns(&mut self, schema: &str, table: &str) -> Result<Vec<Column>, Error>;
    fn list_routines(&mut self, req: &ListRoutines) -> Result<Routines, Error>;
    fn list_indexes(&mut self, schema: &str, table: &str) -> Result<Vec<Index>, Error>;
}

impl SqlBackend for Client {
    fn sql_connection(&mut self) -> Result<Box<dyn SqlConn>, Error> {
        Ok(Box::new(Client::sql_connection(self)?))
    }
    fn list_schemas(&mut self, req: &ListSchemas) -> Result<Schemas, Error> {
        Client::list_schemas(self, req)
    }
    fn list_tables(&mut self, req: &ListTables) -> Result<Tables, Error> {
        Client::list_tables(self, req)
    }
    fn list_columns(&mut self, schema: &str, table: &str) -> Result<Vec<Column>, Error> {
        Client::list_columns(self, schema, table)
    }
    fn list_routines(&mut self, req: &ListRoutines) -> Result<Routines, Error> {
        Client::list_routines(self, req)
    }
    fn list_indexes(&mut self, schema: &str, table: &str) -> Result<Vec<Index>, Error> {
        Client::list_indexes(self, schema, table)
    }
}

/// [`SqlConnection`] as an object: each method the one of the same name.
/// `execute` and `fetch` only send; their replies are read with
/// `executed` and `fetched` once waited for, with the connection let go.
pub trait SqlConn: Send {
    fn set_options(&mut self, options: SetOptions) -> Result<(), Error>;
    fn uncommitted(&self) -> bool;
    /// True once after the connection was lost with work on it.
    fn lost(&mut self) -> bool;
    /// The session it is attached to is over: nothing attaches again.
    fn ended(&self) -> bool;
    fn prepare(&mut self, sql: &str) -> Result<Prepared, Error>;
    fn execute(&mut self, statement: u32) -> Result<Pending, Error>;
    fn executed(
        &mut self,
        statement: u32,
        reply: Result<Reply, Error>,
    ) -> Result<ExecuteOutcome, Error>;
    fn fetch(&mut self, cursor: u32, max_rows: u32) -> Result<Pending, Error>;
    fn fetched(&mut self, cursor: u32, reply: Result<Reply, Error>) -> Result<FetchOutcome, Error>;
    fn close_cursor(&mut self, cursor: u32) -> Result<(), Error>;
    fn release(&mut self, statement: u32) -> Result<(), Error>;
    fn commit(&mut self) -> Result<(), Error>;
    fn rollback(&mut self) -> Result<(), Error>;
    /// Closes the connection; the server rolls back what is uncommitted.
    fn close(&mut self);
}

impl SqlConn for SqlConnection {
    fn set_options(&mut self, options: SetOptions) -> Result<(), Error> {
        SqlConnection::set_options(self, options)
    }
    fn uncommitted(&self) -> bool {
        SqlConnection::uncommitted(self)
    }
    fn lost(&mut self) -> bool {
        SqlConnection::lost(self)
    }
    fn ended(&self) -> bool {
        self.attached().ended().is_some()
    }
    fn prepare(&mut self, sql: &str) -> Result<Prepared, Error> {
        SqlConnection::prepare(self, sql)
    }
    fn execute(&mut self, statement: u32) -> Result<Pending, Error> {
        SqlConnection::execute(self, statement, Vec::new())
    }
    fn executed(
        &mut self,
        statement: u32,
        reply: Result<Reply, Error>,
    ) -> Result<ExecuteOutcome, Error> {
        SqlConnection::executed(self, statement, reply)
    }
    fn fetch(&mut self, cursor: u32, max_rows: u32) -> Result<Pending, Error> {
        SqlConnection::fetch(self, cursor, max_rows)
    }
    fn fetched(&mut self, cursor: u32, reply: Result<Reply, Error>) -> Result<FetchOutcome, Error> {
        SqlConnection::fetched(self, cursor, reply)
    }
    fn close_cursor(&mut self, cursor: u32) -> Result<(), Error> {
        SqlConnection::close_cursor(self, cursor)
    }
    fn release(&mut self, statement: u32) -> Result<(), Error> {
        SqlConnection::release(self, statement)
    }
    fn commit(&mut self) -> Result<(), Error> {
        SqlConnection::commit(self)
    }
    fn rollback(&mut self) -> Result<(), Error> {
        SqlConnection::rollback(self)
    }
    fn close(&mut self) {
        SqlConnection::close(self);
    }
}

// JSON.

/// `commit` as JSON names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitDto {
    None,
    ReadUncommitted,
    ReadCommitted,
    RepeatableRead,
    Serializable,
}

impl From<CommitLevel> for CommitDto {
    fn from(c: CommitLevel) -> CommitDto {
        match c {
            CommitLevel::None => CommitDto::None,
            CommitLevel::ReadUncommitted => CommitDto::ReadUncommitted,
            CommitLevel::ReadCommitted => CommitDto::ReadCommitted,
            CommitLevel::RepeatableRead => CommitDto::RepeatableRead,
            CommitLevel::Serializable => CommitDto::Serializable,
        }
    }
}

impl From<CommitDto> for CommitLevel {
    fn from(c: CommitDto) -> CommitLevel {
        match c {
            CommitDto::None => CommitLevel::None,
            CommitDto::ReadUncommitted => CommitLevel::ReadUncommitted,
            CommitDto::ReadCommitted => CommitLevel::ReadCommitted,
            CommitDto::RepeatableRead => CommitLevel::RepeatableRead,
            CommitDto::Serializable => CommitLevel::Serializable,
        }
    }
}

/// `naming` as JSON names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NamingDto {
    Sql,
    System,
}

impl From<Naming> for NamingDto {
    fn from(n: Naming) -> NamingDto {
        match n {
            Naming::Sql => NamingDto::Sql,
            Naming::System => NamingDto::System,
        }
    }
}

impl From<NamingDto> for Naming {
    fn from(n: NamingDto) -> Naming {
        match n {
            NamingDto::Sql => Naming::Sql,
            NamingDto::System => Naming::System,
        }
    }
}

/// Result of `sql.options.get` and `sql.options.set`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionsDto {
    pub commit: CommitDto,
    pub naming: NamingDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_schema: Option<String>,
    /// A statement other than a query ran under a commit level since the
    /// last commit or rollback.
    pub uncommitted: bool,
}

/// Params of methods that name only the session.
#[derive(Debug, Deserialize)]
pub struct NameParams {
    pub name: String,
}

/// Params of `sql.options.set`: what is absent stays as it is; an empty
/// `defaultSchema` is none.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionsParams {
    pub name: String,
    #[serde(default)]
    pub commit: Option<CommitDto>,
    #[serde(default)]
    pub naming: Option<NamingDto>,
    #[serde(default)]
    pub default_schema: Option<String>,
}

/// A column, as the spec's `Column`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnDto {
    pub name: String,
    pub label: String,
    /// The SQL type (`DECIMAL`).
    #[serde(rename = "type")]
    pub sql_type: String,
    pub length: u32,
    pub scale: u16,
    pub nullable: bool,
    pub ccsid: u16,
}

impl From<&Column> for ColumnDto {
    fn from(c: &Column) -> ColumnDto {
        ColumnDto {
            name: c.name.clone(),
            label: c.label.clone(),
            sql_type: c.sql_type.clone(),
            length: c.length,
            scale: c.scale,
            nullable: c.nullable,
            ccsid: c.ccsid,
        }
    }
}

/// Params of `sql.run`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunParams {
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub max_rows: Option<u32>,
    /// The ID `sql.cancel` names.
    #[serde(default)]
    pub run: Option<String>,
}

/// What a statement was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunKind {
    /// It has result columns.
    Query,
    /// `INSERT`, `UPDATE`, `DELETE` or `MERGE`: `updated` is its count.
    Update,
    /// Anything else.
    Ddl,
}

/// Result of `sql.run`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDto {
    pub kind: RunKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<ColumnDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Vec<Value>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<bool>,
    /// The result's ID for `sql.fetch`, `sql.export` and `sql.close`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<i64>,
    /// Cancelled while it ran: what it did before.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
    pub messages: Vec<MessageDto>,
    pub uncommitted: bool,
}

/// Params of `sql.fetch`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchParams {
    pub name: String,
    pub cursor: u64,
    #[serde(default)]
    pub max_rows: Option<u32>,
}

/// Result of `sql.fetch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FetchDto {
    pub rows: Vec<Vec<Value>>,
    pub end: bool,
}

/// Params of `sql.close`.
#[derive(Debug, Deserialize)]
pub struct CloseParams {
    pub name: String,
    pub cursor: u64,
}

/// Params of `sql.cancel`: a run's or an export's ID.
#[derive(Debug, Deserialize)]
pub struct CancelParams {
    #[serde(default)]
    pub name: Option<String>,
    pub id: String,
}

/// `sql.lost`: the session's SQL connection was lost or replaced, with
/// what was uncommitted and every open cursor.
#[derive(Debug, Clone, Serialize)]
pub struct LostNote {
    pub name: String,
    pub message: String,
}

// State.

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One session's SQL connection.
#[derive(Default)]
struct ConnState {
    conn: Option<Box<dyn SqlConn>>,
    /// The session's sign-on epoch the connection was attached in.
    epoch: u64,
    /// Bumped each time the connection's job is a new one: a result made
    /// under another generation has no cursor any more.
    generation: u64,
    /// The options asked for, set on each new connection.
    options: SetOptions,
}

/// A query's result.
struct ResultSet {
    name: String,
    generation: u64,
    columns: Vec<Column>,
    statement: Option<u32>,
    /// QAP's cursor, until its end.
    cursor: Option<u32>,
    /// The rows sent so far.
    rows: Vec<Vec<SqlValue>>,
}

/// Every session's SQL state.
pub struct Sql {
    sessions: Arc<Sessions>,
    conns: Mutex<BTreeMap<String, Arc<Mutex<ConnState>>>>,
    results: Mutex<HashMap<u64, Arc<Mutex<ResultSet>>>>,
    next: AtomicU64,
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// Each column's scale when it is a timestamp's fraction.
fn scales(columns: &[Column]) -> Vec<Option<u16>> {
    columns
        .iter()
        .map(|c| {
            c.sql_type
                .to_ascii_uppercase()
                .starts_with("TIMESTAMP")
                .then_some(c.scale)
        })
        .collect()
}

/// Rows as JSON, through [`values::to_json`].
#[must_use]
pub fn rows_json(columns: &[Column], rows: &[Vec<SqlValue>]) -> Vec<Vec<Value>> {
    let s = scales(columns);
    rows.iter()
        .map(|r| {
            r.iter()
                .enumerate()
                .map(|(i, v)| values::to_json(v, s.get(i).copied().flatten()))
                .collect()
        })
        .collect()
}

/// The statement's first keyword, upper case, past blanks, comments and
/// opening parentheses.
#[must_use]
pub fn first_keyword(sql: &str) -> String {
    let mut s = sql;
    loop {
        let t = s.trim_start_matches(|c: char| c.is_whitespace() || c == '(');
        if let Some(rest) = t.strip_prefix("--") {
            s = rest.split_once('\n').map_or("", |(_, r)| r);
        } else if let Some(rest) = t.strip_prefix("/*") {
            s = rest.split_once("*/").map_or("", |(_, r)| r);
        } else {
            return t
                .chars()
                .take_while(char::is_ascii_alphabetic)
                .collect::<String>()
                .to_ascii_uppercase();
        }
    }
}

/// `query` when the statement has result columns, `update` for a data
/// change, else `ddl`.
#[must_use]
pub fn kind_of(sql: &str, query: bool) -> RunKind {
    if query {
        return RunKind::Query;
    }
    match first_keyword(sql).as_str() {
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" => RunKind::Update,
        _ => RunKind::Ddl,
    }
}

/// The statement as sent: trimmed, one trailing `;` removed.
fn statement_text(sql: &str) -> Result<&str, RpcError> {
    let s = sql.trim();
    let s = s.strip_suffix(';').unwrap_or(s).trim_end();
    if s.is_empty() {
        return Err(RpcError::invalid_params("sql is empty"));
    }
    Ok(s)
}

/// A `qap-client` error as JSON-RPC's: [`rpc_error`], and for an SQL
/// error its SQLSTATE, SQLCODE and failing row too.
#[must_use]
pub fn sql_error(e: &Error) -> RpcError {
    let mut r = rpc_error(e);
    if let Error::Sql { failure, .. } = e
        && let Some(Value::Object(d)) = r.data.as_mut()
    {
        if !failure.sqlstate.is_empty() {
            d.insert("sqlstate".into(), json!(failure.sqlstate));
            d.insert("sqlcode".into(), json!(failure.sqlcode));
        }
        if let Some(row) = failure.row {
            d.insert("row".into(), json!(row));
        }
    }
    r
}

fn no_result(cursor: u64) -> RpcError {
    RpcError::new(codes::NO_RESULT, format!("no result {cursor}"))
}

/// The reply to `pending`; cancelled once when `cancel` is set.
fn wait(pending: &Pending, cancel: Option<&AtomicBool>) -> Result<Reply, Error> {
    let mut asked = false;
    loop {
        if !asked && cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            pending.cancel();
            asked = true;
        }
        if let Some(r) = pending.wait_for(CANCEL_EVERY) {
            return r;
        }
    }
}

fn messages(m: Option<qap_client::ServerMessage>) -> Vec<MessageDto> {
    m.into_iter().map(MessageDto::from).collect()
}

impl Sql {
    pub fn new(sessions: &Arc<Sessions>) -> Arc<Sql> {
        let sql = Arc::new(Sql {
            sessions: Arc::clone(sessions),
            conns: Mutex::new(BTreeMap::new()),
            results: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
            running: Mutex::new(HashMap::new()),
        });
        let weak = Arc::downgrade(&sql);
        sessions.on_close(Arc::new(move |name: &str| {
            if let Some(sql) = weak.upgrade() {
                sql.session_closed(name);
            }
        }));
        sql
    }

    fn outbound(&self) -> &Outbound {
        self.sessions.outbound()
    }

    fn state(&self, name: &str) -> Arc<Mutex<ConnState>> {
        lock(&self.conns)
            .entry(name.to_owned())
            .or_default()
            .clone()
    }

    /// The session closed: its connection goes with it, which rolls back.
    fn session_closed(&self, name: &str) {
        let Some(st) = lock(&self.conns).remove(name) else {
            return;
        };
        let mut g = lock(&st);
        if let Some(mut c) = g.conn.take() {
            c.close();
        }
        drop(g);
        self.forget_results(name);
    }

    fn forget_results(&self, name: &str) {
        let all: Vec<_> = lock(&self.results).values().cloned().collect();
        for r in all {
            let mut r = lock(&r);
            if r.name == name {
                r.cursor = None;
                r.statement = None;
            }
        }
    }

    fn lost(&self, name: &str, why: &str) {
        let message = format!(
            "{name}: the SQL connection was lost ({why}); uncommitted changes and open cursors are gone"
        );
        log(self.outbound(), LogLevel::Warn, message.clone());
        let _ = self.outbound().notify(
            "sql.lost",
            &LostNote {
                name: name.to_owned(),
                message,
            },
        );
    }

    /// The session's connection, attached when there is none or the one
    /// there is belongs to an ended session.
    fn ready<'a>(
        &self,
        name: &str,
        g: &'a mut ConnState,
    ) -> Result<&'a mut Box<dyn SqlConn>, RpcError> {
        let epoch = self.sessions.epoch(name);
        let mut replace = None;
        if let Some(c) = g.conn.as_mut() {
            if c.ended() {
                replace = Some("the session ended");
            } else if epoch != Some(g.epoch) {
                replace = Some("the session signed on again");
            } else if c.lost() {
                g.generation += 1;
                self.lost(name, "the connection closed");
            }
        }
        if let Some(why) = replace {
            let mut old = g.conn.take().expect("checked above");
            old.close();
            g.generation += 1;
            self.lost(name, why);
        }
        if g.conn.is_none() {
            let (mut c, epoch) = self.sessions.sql(name, QAP_SQL, |b| b.sql_connection())?;
            if g.options != SetOptions::default() {
                c.set_options(g.options.clone())
                    .map_err(|e| sql_error(&e))?;
            }
            g.conn = Some(c);
            g.epoch = epoch;
            g.generation += 1;
        }
        Ok(g.conn.as_mut().expect("attached above"))
    }

    fn options_dto(g: &ConnState) -> OptionsDto {
        OptionsDto {
            commit: g.options.commit.into(),
            naming: g.options.naming.into(),
            default_schema: g.options.default_schema.clone(),
            uncommitted: g.conn.as_ref().is_some_and(|c| c.uncommitted()),
        }
    }

    pub fn options_get(&self, name: &str) -> OptionsDto {
        let st = self.state(name);
        let g = lock(&st);
        Sql::options_dto(&g)
    }

    pub fn options_set(&self, p: &OptionsParams) -> Result<OptionsDto, RpcError> {
        let st = self.state(&p.name);
        let mut g = lock(&st);
        let mut want = g.options.clone();
        if let Some(c) = p.commit {
            want.commit = c.into();
        }
        if let Some(n) = p.naming {
            want.naming = n.into();
        }
        if let Some(s) = &p.default_schema {
            let s = s.trim();
            want.default_schema = (!s.is_empty()).then(|| s.to_owned());
        }
        if g.conn.is_some() {
            let c = self.ready(&p.name, &mut g)?;
            c.set_options(want.clone()).map_err(|e| sql_error(&e))?;
        }
        g.options = want;
        Ok(Sql::options_dto(&g))
    }

    fn begin(
        &self,
        asked: Option<&str>,
        prefix: &str,
    ) -> Result<(String, Arc<AtomicBool>), RpcError> {
        let id = match asked {
            Some("") => return Err(RpcError::invalid_params("id is empty")),
            Some(r) => r.to_owned(),
            None => format!("{prefix}{}", self.next.fetch_add(1, Ordering::SeqCst) + 1),
        };
        let mut running = lock(&self.running);
        if running.contains_key(&id) {
            return Err(RpcError::invalid_params(format!("{id} is running")));
        }
        let flag = Arc::new(AtomicBool::new(false));
        running.insert(id.clone(), Arc::clone(&flag));
        Ok((id, flag))
    }

    fn end(&self, id: &str) {
        lock(&self.running).remove(id);
    }

    /// Asks a run or an export to stop; false when none has that ID.
    pub fn cancel(&self, id: &str) -> bool {
        match lock(&self.running).get(id) {
            Some(c) => {
                c.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// One `Fetch` of at most `max` rows, the connection held only to send
    /// and to read the reply.
    fn fetch_page(
        &self,
        name: &str,
        st: &Mutex<ConnState>,
        generation: u64,
        cursor: u32,
        max: u32,
        cancel: Option<&AtomicBool>,
    ) -> Result<FetchOutcome, RpcError> {
        let pending = {
            let mut g = lock(st);
            if g.generation != generation {
                return Err(gone_error());
            }
            let c = g.conn.as_mut().ok_or_else(gone_error)?;
            c.fetch(cursor, max)
                .map_err(|e| self.after_error(name, &mut g, &e))?
        };
        let reply = wait(&pending, cancel);
        let mut g = lock(st);
        if g.generation != generation {
            return Err(gone_error());
        }
        let c = g.conn.as_mut().ok_or_else(gone_error)?;
        c.fetched(cursor, reply)
            .map_err(|e| self.after_error(name, &mut g, &e))
    }

    /// An error on the connection, after noting a loss it showed.
    fn after_error(&self, name: &str, g: &mut ConnState, e: &Error) -> RpcError {
        if let Some(c) = g.conn.as_mut()
            && c.lost()
        {
            g.generation += 1;
            self.lost(name, &e.to_string());
        }
        sql_error(e)
    }

    /// Releases what a query's end leaves: its cursor and statement.
    fn finish(&self, st: &Mutex<ConnState>, r: &mut ResultSet) {
        let mut g = lock(st);
        if g.generation == r.generation
            && let Some(c) = g.conn.as_mut()
        {
            if let Some(cur) = r.cursor.take() {
                let _ = c.close_cursor(cur);
            }
            if let Some(s) = r.statement.take() {
                let _ = c.release(s);
            }
        }
        r.cursor = None;
        r.statement = None;
    }

    /// `sql.run`, to its end.
    pub fn run(&self, p: &RunParams, cancel: &AtomicBool) -> Result<RunDto, RpcError> {
        let text = statement_text(&p.sql)?;
        let max = p.max_rows.filter(|m| *m > 0).unwrap_or(PAGE);
        let st = self.state(&p.name);
        let (prepared, pending, generation) = {
            let mut g = lock(&st);
            let c = self.ready(&p.name, &mut g)?;
            let prepared = c.prepare(text).map_err(|e| sql_error(&e))?;
            let pending = match c.execute(prepared.statement) {
                Ok(pe) => pe,
                Err(e) => {
                    let _ = c.release(prepared.statement);
                    return Err(self.after_error(&p.name, &mut g, &e));
                }
            };
            (prepared, pending, g.generation)
        };
        let statement = prepared.statement;
        let reply = wait(&pending, Some(cancel));
        let mut g = lock(&st);
        if g.generation != generation {
            return Err(gone_error());
        }
        let c = g.conn.as_mut().ok_or_else(gone_error)?;
        let outcome = match c.executed(statement, reply) {
            Ok(o) => o,
            Err(e) => {
                let _ = c.release(statement);
                return Err(self.after_error(&p.name, &mut g, &e));
            }
        };
        let kind = kind_of(text, !prepared.columns.is_empty());
        let mut out = RunDto {
            kind,
            columns: None,
            rows: None,
            end: None,
            cursor: None,
            updated: None,
            cancelled: outcome.cancelled,
            messages: messages(outcome.message),
            uncommitted: false,
        };
        if kind != RunKind::Query {
            let _ = c.release(statement);
            if kind == RunKind::Update {
                out.updated = Some(outcome.executed.updated);
            }
            out.uncommitted = c.uncommitted();
            return Ok(out);
        }
        out.columns = Some(prepared.columns.iter().map(ColumnDto::from).collect());
        let Some(cursor) = outcome.executed.cursor else {
            // Cancelled before a cursor opened: nothing to read.
            let _ = c.release(statement);
            out.rows = Some(Vec::new());
            out.end = Some(true);
            out.uncommitted = c.uncommitted();
            return Ok(out);
        };
        drop(g);
        let mut r = ResultSet {
            name: p.name.clone(),
            generation,
            columns: prepared.columns,
            statement: Some(statement),
            cursor: Some(cursor),
            rows: Vec::new(),
        };
        let page = match self.fetch_page(&p.name, &st, generation, cursor, max, Some(cancel)) {
            Ok(f) => f,
            Err(e) => {
                self.finish(&st, &mut r);
                return Err(e);
            }
        };
        let end = page.fetched.end || page.cancelled;
        out.rows = Some(rows_json(&r.columns, &page.fetched.rows));
        out.messages.extend(messages(page.message));
        out.cancelled |= page.cancelled;
        r.rows = page.fetched.rows;
        if end {
            self.finish(&st, &mut r);
        }
        out.end = Some(end);
        out.uncommitted = lock(&st).conn.as_ref().is_some_and(|c| c.uncommitted());
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        lock(&self.results).insert(id, Arc::new(Mutex::new(r)));
        out.cursor = Some(id);
        Ok(out)
    }

    fn result(&self, cursor: u64) -> Result<Arc<Mutex<ResultSet>>, RpcError> {
        lock(&self.results)
            .get(&cursor)
            .cloned()
            .ok_or_else(|| no_result(cursor))
    }

    /// `sql.fetch`: the next page; none once the cursor is at its end.
    pub fn fetch(&self, p: &FetchParams) -> Result<FetchDto, RpcError> {
        let r = self.result(p.cursor)?;
        let mut r = lock(&r);
        let Some(cursor) = r.cursor else {
            return Ok(FetchDto {
                rows: Vec::new(),
                end: true,
            });
        };
        let st = self.state(&r.name);
        let max = p.max_rows.filter(|m| *m > 0).unwrap_or(PAGE);
        let page = match self.fetch_page(&r.name.clone(), &st, r.generation, cursor, max, None) {
            Ok(f) => f,
            Err(e) => {
                if e.code == codes::NO_RESULT {
                    r.cursor = None;
                    r.statement = None;
                }
                return Err(e);
            }
        };
        let end = page.fetched.end || page.cancelled;
        let rows = rows_json(&r.columns, &page.fetched.rows);
        r.rows.extend(page.fetched.rows);
        if end {
            self.finish(&st, &mut r);
        }
        Ok(FetchDto { rows, end })
    }

    /// `sql.close`: the result is forgotten, its cursor closed.
    pub fn close(&self, p: &CloseParams) {
        let Some(r) = lock(&self.results).remove(&p.cursor) else {
            return;
        };
        let mut r = lock(&r);
        if r.cursor.is_some() || r.statement.is_some() {
            let st = self.state(&r.name);
            self.finish(&st, &mut r);
        }
    }

    /// `sql.commit` or `sql.rollback`.
    pub fn end_unit(&self, name: &str, commit: bool) -> Result<OptionsDto, RpcError> {
        let st = self.state(name);
        let mut g = lock(&st);
        if g.conn.is_some() {
            let c = self.ready(name, &mut g)?;
            let r = if commit { c.commit() } else { c.rollback() };
            if let Err(e) = r {
                return Err(self.after_error(name, &mut g, &e));
            }
        }
        Ok(Sql::options_dto(&g))
    }
}

/// A result whose cursor went with its connection.
fn gone_error() -> RpcError {
    RpcError::new(
        codes::NO_RESULT,
        "the cursor went with its connection; run the statement again",
    )
}

/// Answers `responder` with `f()` on a thread of its own.
fn deferred<P, R>(
    r: &mut Registry,
    method: &'static str,
    sql: &Arc<Sql>,
    f: impl Fn(&Sql, P) -> Result<R, RpcError> + Send + Sync + Clone + 'static,
) where
    P: serde::de::DeserializeOwned + Send + 'static,
    R: Serialize + 'static,
{
    let sql = Arc::clone(sql);
    r.register_deferred(method, move |p: P, _: &Context, responder: Responder| {
        let sql = Arc::clone(&sql);
        let f = f.clone();
        on_thread(method.to_owned(), responder, move || f(&sql, p));
    });
}

/// Registers `sql.*`.
pub fn register(r: &mut Registry, sessions: &Arc<Sessions>) {
    let sql = Sql::new(sessions);
    deferred(r, "sql.options.get", &sql, |s, p: NameParams| {
        Ok(s.options_get(&p.name))
    });
    deferred(r, "sql.options.set", &sql, |s, p: OptionsParams| {
        s.options_set(&p)
    });
    {
        let sql = Arc::clone(&sql);
        r.register_deferred(
            "sql.run",
            move |p: RunParams, _: &Context, responder: Responder| {
                let (id, cancel) = match sql.begin(p.run.as_deref(), "q") {
                    Ok(x) => x,
                    Err(e) => return responder.send::<RunDto>(Err(e)),
                };
                let sql = Arc::clone(&sql);
                on_thread(format!("sql run {id}"), responder, move || {
                    let out = sql.run(&p, &cancel);
                    sql.end(&id);
                    out
                });
            },
        );
    }
    deferred(r, "sql.fetch", &sql, |s, p: FetchParams| s.fetch(&p));
    deferred(r, "sql.close", &sql, |s, p: CloseParams| {
        s.close(&p);
        Ok(())
    });
    deferred(r, "sql.commit", &sql, |s, p: NameParams| {
        s.end_unit(&p.name, true)
    });
    deferred(r, "sql.rollback", &sql, |s, p: NameParams| {
        s.end_unit(&p.name, false)
    });
    let s = Arc::clone(&sql);
    r.register("sql.cancel", move |p: CancelParams, _: &Context| {
        s.cancel(&p.id);
        Ok::<_, RpcError>(())
    });
}
