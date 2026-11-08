// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `sql.*` at the method-registry level, against canned replies, and
//! `sql::values` and `sql::csv` at their edges. The fake connection sends
//! every statement request over a real `qap_client::Connection` on an
//! in-memory transport, and reads the replies with `qap-client`'s own
//! `ExecuteOutcome` and `FetchOutcome`, so `SqlError`, `Cancelled` and
//! `end` come back as `qap-client` gives them. The canned messages use the
//! IDs and texts QS/400's SQL sends (`SQL0104`, `SQL0752`, `SQL0952`).

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use code_host::registry_with;
use code_host::session::{
    Backend, CommandBackend, DevelopBackend, Endpoint, Factory, IfsBackend, JobDto, Sessions,
    SystemDto,
};
use code_host::sql::values::{MAX_SAFE, hex, to_csv, to_json};
use code_host::sql::{SqlBackend, SqlConn, first_keyword};
use host_rpc::framing::read_frame;
use host_rpc::{Context, Outbound, Registry, RpcError};
use qap_client::proto::ops::connection::HelloReply;
use qap_client::proto::ops::sql::{
    Column, CommitLevel, CursorRef, Execute, Executed, Fetch, Fetched, Index, ListRoutines,
    ListSchemas, ListTables, Prepare, Prepared, Routine, RoutineKind, Routines, Schema, Schemas,
    SetOptions, SqlFailure, SqlValue, StatementRef, Table, TableKind, Tables,
};
use qap_client::proto::{Envelope, Kind, Op, Service};
use qap_client::{
    Connection, Error, ExecuteOutcome, FetchOutcome, Pending, Reply, Secret, ServerMessage, Status,
    Target, Wake, Wire,
};
use qsa_net::{Security, Transport};
use serde_json::{Value, json};

// sql::values

fn ms(days: i64) -> i64 {
    days * 86_400_000
}

#[test]
fn integers_are_numbers_up_to_53_bits_and_text_past_them() {
    let v = |value| to_json(&SqlValue::Integer { value }, None);
    assert_eq!(MAX_SAFE, 9_007_199_254_740_991);
    assert_eq!(v(0), json!(0));
    assert_eq!(v(MAX_SAFE), json!(9_007_199_254_740_991_i64));
    assert_eq!(v(-MAX_SAFE), json!(-9_007_199_254_740_991_i64));
    assert_eq!(v(MAX_SAFE + 1), json!("9007199254740992"));
    assert_eq!(v(-MAX_SAFE - 1), json!("-9007199254740992"));
    assert_eq!(v(i64::MAX), json!("9223372036854775807"));
    assert_eq!(v(i64::MIN), json!("-9223372036854775808"));
    assert_eq!(
        to_csv(&SqlValue::Integer { value: i64::MIN }, None).as_deref(),
        Some("-9223372036854775808")
    );
}

#[test]
fn decimals_and_floats_are_the_servers_text() {
    for t in [
        "-12.50",
        "0.00",
        "-0.01",
        "123456789012345678901234567890.12",
        "1.5E-30",
        "-Infinity",
        "NaN",
        "sNaN",
        "-0",
    ] {
        assert_eq!(
            to_json(&SqlValue::Decimal { text: t.into() }, None),
            json!(t)
        );
        assert_eq!(
            to_csv(&SqlValue::Decimal { text: t.into() }, None).as_deref(),
            Some(t)
        );
    }
    assert_eq!(
        to_json(
            &SqlValue::Float {
                text: "1E300".into()
            },
            None
        ),
        json!("1E300")
    );
    assert_eq!(
        to_json(
            &SqlValue::Float {
                text: "-2.5E-308".into()
            },
            None
        ),
        json!("-2.5E-308")
    );
}

#[test]
fn null_text_binary_and_boolean() {
    assert_eq!(to_json(&SqlValue::Null, None), Value::Null);
    assert_eq!(to_csv(&SqlValue::Null, None), None);
    assert_eq!(
        to_json(
            &SqlValue::Text {
                text: "Forklift é".into()
            },
            None
        ),
        json!("Forklift é")
    );
    assert_eq!(
        to_json(
            &SqlValue::Text {
                text: String::new()
            },
            None
        ),
        json!("")
    );
    assert_eq!(
        to_csv(
            &SqlValue::Text {
                text: String::new()
            },
            None
        )
        .as_deref(),
        Some("")
    );
    let b = SqlValue::Binary {
        data: vec![0xC1, 0x00, 0xFF],
    };
    assert_eq!(to_json(&b, None), json!({ "hex": "C100FF" }));
    assert_eq!(to_csv(&b, None).as_deref(), Some("C100FF"));
    assert_eq!(hex(&[]), "");
    assert_eq!(
        to_json(&SqlValue::Boolean { value: true }, None),
        json!(true)
    );
    assert_eq!(
        to_csv(&SqlValue::Boolean { value: false }, None).as_deref(),
        Some("FALSE")
    );
}

#[test]
fn dates_and_times_are_iso() {
    let d = |days| to_json(&SqlValue::Date { ms: ms(days) }, None);
    assert_eq!(d(0), json!("1970-01-01"));
    assert_eq!(d(-1), json!("1969-12-31"));
    assert_eq!(d(20_400), json!("2025-11-08"));
    assert_eq!(d(11_016), json!("2000-02-29"));
    assert_eq!(d(-719_162), json!("0001-01-01"));
    assert_eq!(d(2_932_896), json!("9999-12-31"));
    let t = |ms| to_json(&SqlValue::Time { ms }, None);
    assert_eq!(t(0), json!("00:00:00"));
    assert_eq!(t(86_399_000), json!("23:59:59"));
    assert_eq!(t(86_400_000), json!("24:00:00"));
    assert_eq!(t(45_296_789), json!("12:34:56.789"));
}

#[test]
fn timestamps_take_the_columns_scale_from_the_picoseconds() {
    // 2026-11-08 12:34:56.789, and 123 456 789 picoseconds past it.
    let at = ms(20_765) + 45_296_789;
    let ts = SqlValue::Timestamp {
        ms: at,
        picos: 123_456_789,
    };
    let t = |s| to_json(&ts, s);
    assert_eq!(t(Some(0)), json!("2026-11-08T12:34:56"));
    assert_eq!(t(Some(3)), json!("2026-11-08T12:34:56.789"));
    assert_eq!(t(Some(6)), json!("2026-11-08T12:34:56.789123"));
    assert_eq!(t(Some(12)), json!("2026-11-08T12:34:56.789123456789"));
    assert_eq!(t(None), json!("2026-11-08T12:34:56.789123456789"));
    let whole = SqlValue::Timestamp {
        ms: ms(20_765),
        picos: 0,
    };
    assert_eq!(
        to_json(&whole, Some(6)),
        json!("2026-11-08T00:00:00.000000")
    );
    assert_eq!(to_json(&whole, None), json!("2026-11-08T00:00:00"));
    let before = SqlValue::Timestamp { ms: -1, picos: 0 };
    assert_eq!(to_json(&before, Some(3)), json!("1969-12-31T23:59:59.999"));
}

// Columns.

fn column(name: &str, ty: &str, scale: u16) -> Column {
    Column {
        name: name.into(),
        label: name.into(),
        sql_type: ty.into(),
        length: 10,
        scale,
        nullable: true,
        ccsid: 37,
    }
}

#[test]
fn first_keyword_skips_comments_and_parentheses() {
    assert_eq!(first_keyword("  select 1"), "SELECT");
    assert_eq!(first_keyword("-- note\n/* x */ (VALUES 1)"), "VALUES");
    assert_eq!(first_keyword("update t set a = 1"), "UPDATE");
    assert_eq!(first_keyword(""), "");
}

// The canned server.

type Answer = (Status, Option<ServerMessage>, Vec<u8>);

enum Plan {
    Now(Answer),
    /// Not until the request is cancelled; then this.
    Hold(Answer),
}

#[derive(Default)]
struct Script {
    qap: Option<u16>,
    plans: Vec<(Op, Plan)>,
    asked: Vec<String>,
    /// `lost()` answers this once.
    lose: bool,
    schemas: Vec<Schema>,
    /// Connections attached.
    attached: u32,
}

type Shared = Arc<Mutex<Script>>;

fn message(id: &str, text: &str, help: &str) -> ServerMessage {
    ServerMessage {
        id: id.into(),
        severity: 30,
        data: Vec::new(),
        text: text.into(),
        help: help.into(),
    }
}

fn body<B: Wire>(b: &B) -> Vec<u8> {
    let probe = Envelope::request(1, Op::RunCommand, &());
    Envelope::reply(&probe, Status::Ok, None, Vec::new())
        .with_body(b)
        .body
}

fn ok<B: Wire>(b: &B) -> Plan {
    Plan::Now((Status::Ok, None, body(b)))
}

struct Canned {
    script: Shared,
    incoming: Vec<u8>,
    outgoing: VecDeque<u8>,
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
                Op::Prepare => format!("Prepare {}", env.body_as::<Prepare>().unwrap().sql),
                Op::Execute => format!("Execute {}", env.body_as::<Execute>().unwrap().statement),
                Op::Fetch => {
                    let f = env.body_as::<Fetch>().unwrap();
                    format!("Fetch {} {}", f.cursor, f.max_rows)
                }
                Op::CloseCursor => {
                    format!("CloseCursor {}", env.body_as::<CursorRef>().unwrap().cursor)
                }
                Op::Release => {
                    format!(
                        "Release {}",
                        env.body_as::<StatementRef>().unwrap().statement
                    )
                }
                Op::SetOptions => {
                    let o = env.body_as::<SetOptions>().unwrap();
                    format!(
                        "SetOptions {:?} {:?} {:?}",
                        o.commit, o.naming, o.default_schema
                    )
                }
                _ => format!("{op:?}"),
            };
            s.asked.push(line);
            let i = s.plans.iter().position(|(o, _)| *o == op);
            match i {
                Some(i) => Some(s.plans.remove(i).1),
                // What needs no script.
                None if matches!(
                    op,
                    Op::CloseCursor | Op::Release | Op::SetOptions | Op::Commit | Op::Rollback
                ) =>
                {
                    Some(ok(&()))
                }
                None => None,
            }
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
            let env = Envelope::from_frame(&self.incoming[4..4 + n]).expect("a frame");
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

fn canned(script: &Shared) -> Connection {
    let c = Canned {
        script: Arc::clone(script),
        incoming: Vec::new(),
        outgoing: VecDeque::new(),
        held: Vec::new(),
        closed: false,
    };
    let target =
        Target::new("qshq400.example", 2320, qsa_net::Trust::default()).with_max_version(9);
    Connection::over(Box::new(c), &target).unwrap()
}

// The fake SQL connection: SqlConnection's bookkeeping over the canned
// connection, its replies read by qap-client's own outcomes.

struct FakeConn {
    script: Shared,
    conn: Connection,
    commit: CommitLevel,
    queries: HashMap<u32, bool>,
    uncommitted: bool,
}

fn decoded<R: Wire>(r: Result<Reply, Error>) -> Result<R, Error> {
    let mut reply = r?;
    if reply.status == Status::SqlError {
        let failure = reply.body_as::<SqlFailure>()?.unwrap_or_default();
        return Err(Error::Sql {
            failure: Box::new(failure),
            message: reply.message.take(),
        });
    }
    reply.decode()
}

impl FakeConn {
    fn wait(&self, op: Op, b: &impl Wire) -> Result<Reply, Error> {
        self.conn.request(op, b)?.wait(Duration::from_secs(5))
    }
}

impl SqlConn for FakeConn {
    fn set_options(&mut self, options: SetOptions) -> Result<(), Error> {
        let c = options.commit;
        decoded::<()>(self.wait(Op::SetOptions, &options))?;
        self.commit = c;
        Ok(())
    }
    fn uncommitted(&self) -> bool {
        self.uncommitted
    }
    fn lost(&mut self) -> bool {
        let lost = std::mem::take(&mut self.script.lock().unwrap().lose);
        if lost {
            self.uncommitted = false;
        }
        lost
    }
    fn ended(&self) -> bool {
        false
    }
    fn prepare(&mut self, sql: &str) -> Result<Prepared, Error> {
        let p: Prepared = decoded(self.wait(Op::Prepare, &Prepare { sql: sql.into() }))?;
        self.queries.insert(p.statement, !p.columns.is_empty());
        Ok(p)
    }
    fn execute(&mut self, statement: u32) -> Result<Pending, Error> {
        let p = self.conn.request(
            Op::Execute,
            &Execute {
                statement,
                rows: Vec::new(),
            },
        )?;
        if !self.queries.get(&statement).copied().unwrap_or(false)
            && self.commit != CommitLevel::None
        {
            self.uncommitted = true;
        }
        Ok(p)
    }
    fn executed(&mut self, _: u32, reply: Result<Reply, Error>) -> Result<ExecuteOutcome, Error> {
        ExecuteOutcome::from_reply(reply?)
    }
    fn fetch(&mut self, cursor: u32, max_rows: u32) -> Result<Pending, Error> {
        self.conn.request(Op::Fetch, &Fetch { cursor, max_rows })
    }
    fn fetched(&mut self, _: u32, reply: Result<Reply, Error>) -> Result<FetchOutcome, Error> {
        FetchOutcome::from_reply(reply?)
    }
    fn close_cursor(&mut self, cursor: u32) -> Result<(), Error> {
        decoded(self.wait(Op::CloseCursor, &CursorRef { cursor }))
    }
    fn release(&mut self, statement: u32) -> Result<(), Error> {
        self.queries.remove(&statement);
        decoded(self.wait(Op::Release, &StatementRef { statement }))
    }
    fn commit(&mut self) -> Result<(), Error> {
        decoded::<()>(self.wait(Op::Commit, &()))?;
        self.uncommitted = false;
        Ok(())
    }
    fn rollback(&mut self) -> Result<(), Error> {
        decoded::<()>(self.wait(Op::Rollback, &()))?;
        self.uncommitted = false;
        Ok(())
    }
    fn close(&mut self) {
        self.script.lock().unwrap().asked.push("close".into());
        self.conn.close();
    }
}

// The fake backend.

struct Fake {
    script: Shared,
}

impl SqlBackend for Fake {
    fn sql_connection(&mut self) -> Result<Box<dyn SqlConn>, Error> {
        self.script.lock().unwrap().attached += 1;
        Ok(Box::new(FakeConn {
            conn: canned(&self.script),
            script: Arc::clone(&self.script),
            commit: CommitLevel::None,
            queries: HashMap::new(),
            uncommitted: false,
        }))
    }
    fn list_schemas(&mut self, req: &ListSchemas) -> Result<Schemas, Error> {
        let mut s = self.script.lock().unwrap();
        s.asked.push(format!(
            "ListSchemas {} {} {}",
            req.pattern, req.start, req.max
        ));
        let start = (req.start as usize).min(s.schemas.len());
        let end = (start + req.max as usize).min(s.schemas.len());
        Ok(Schemas {
            total: s.schemas.len() as u32,
            schemas: s.schemas[start..end].to_vec(),
        })
    }
    fn list_tables(&mut self, req: &ListTables) -> Result<Tables, Error> {
        self.script.lock().unwrap().asked.push(format!(
            "ListTables {} {} {:?}",
            req.schema, req.pattern, req.kinds
        ));
        Ok(Tables {
            total: 2,
            tables: vec![
                Table {
                    schema: "HLINV".into(),
                    name: "ASSETS".into(),
                    kind: TableKind::Table,
                    text: "Assets in service".into(),
                },
                Table {
                    schema: "HLINV".into(),
                    name: "ASSETS_BY_SITE".into(),
                    kind: TableKind::View,
                    text: "Assets by site".into(),
                },
            ],
        })
    }
    fn list_columns(&mut self, schema: &str, table: &str) -> Result<Vec<Column>, Error> {
        if table == "SALARIES" {
            return Err(Error::Status {
                status: Status::NotAuthorized,
                message: Some(message(
                    "SQL0551",
                    "Not authorized to object SALARIES in HLPAY type *FILE.",
                    "",
                )),
            });
        }
        self.script
            .lock()
            .unwrap()
            .asked
            .push(format!("ListColumns {schema} {table}"));
        Ok(vec![
            column("ASSET_ID", "INTEGER", 0),
            column("COST", "DECIMAL", 2),
        ])
    }
    fn list_routines(&mut self, req: &ListRoutines) -> Result<Routines, Error> {
        self.script
            .lock()
            .unwrap()
            .asked
            .push(format!("ListRoutines {} {:?}", req.schema, req.kinds));
        Ok(Routines {
            total: 1,
            routines: vec![Routine {
                schema: "HLINV".into(),
                name: "RETIRE_ASSET".into(),
                specific: "RETIRE00001".into(),
                kind: RoutineKind::Procedure,
                text: "Retire an asset".into(),
            }],
        })
    }
    fn list_indexes(&mut self, schema: &str, table: &str) -> Result<Vec<Index>, Error> {
        self.script
            .lock()
            .unwrap()
            .asked
            .push(format!("ListIndexes {schema} {table}"));
        Ok(vec![Index {
            schema: "HLINV".into(),
            name: "ASSETS_PK".into(),
            unique: true,
            columns: vec!["ASSET_ID".into()],
        }])
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
            qap: self.script.lock().unwrap().qap.unwrap_or(9),
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
        unreachable!("no Develop request")
    }
    fn ifs(&mut self) -> &mut dyn IfsBackend {
        unreachable!("no Ifs request")
    }
    fn command(&mut self) -> &mut dyn CommandBackend {
        unreachable!("no Command request")
    }
    fn sql(&mut self) -> Option<&mut dyn SqlBackend> {
        Some(self)
    }
}

// The host.

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
    sink: Sink,
}

impl Host {
    fn at(qap: Option<u16>) -> Host {
        let script: Shared = Arc::default();
        script.lock().unwrap().qap = qap;
        let s = Arc::clone(&script);
        let factory: Factory = Arc::new(move |_: &Endpoint, _: Wake| {
            Ok(Box::new(Fake {
                script: Arc::clone(&s),
            }) as Box<dyn Backend>)
        });
        let sink = Sink::default();
        let outbound = Outbound::new(sink.clone());
        let sessions = Sessions::new(factory, outbound.clone());
        let h = Host {
            script,
            registry: Arc::new(registry_with(&sessions)),
            outbound,
            sink,
        };
        h.connect();
        h
    }

    fn new() -> Host {
        Host::at(None)
    }

    fn connect(&self) {
        self.call(
            "session.connect",
            json!({"name":"QSHQ400","host":"qshq400.example","user":"cwellman","password":"secret"}),
        )
        .unwrap();
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.registry
            .dispatch(method, params, &Context::new(self.outbound.clone()))
    }

    fn script(&self) -> MutexGuard<'_, Script> {
        self.script.lock().unwrap()
    }

    fn plan(&self, op: Op, plan: Plan) {
        self.script().plans.push((op, plan));
    }

    fn asked(&self) -> Vec<String> {
        std::mem::take(&mut self.script().asked)
    }

    /// The notifications sent so far named `method`.
    fn notes(&self, method: &str) -> Vec<Value> {
        let bytes = self.sink.0.lock().unwrap().clone();
        let mut r = io::Cursor::new(bytes);
        let mut out = Vec::new();
        while let Some(b) = read_frame(&mut r).unwrap() {
            let v: Value = serde_json::from_slice(&b).unwrap();
            if v["method"] == json!(method) {
                out.push(v["params"].clone());
            }
        }
        out
    }

    fn run(&self, sql: &str) -> Result<Value, RpcError> {
        self.call("sql.run", json!({"name":"QSHQ400","sql":sql,"maxRows":500}))
    }
}

fn assets_columns() -> Vec<Column> {
    vec![
        Column {
            name: "ASSET_ID".into(),
            label: "ASSET_ID".into(),
            sql_type: "INTEGER".into(),
            length: 4,
            scale: 0,
            nullable: false,
            ccsid: 0,
        },
        Column {
            name: "COST".into(),
            label: "Cost".into(),
            sql_type: "DECIMAL".into(),
            length: 11,
            scale: 2,
            nullable: true,
            ccsid: 0,
        },
    ]
}

fn prepared(statement: u32, columns: Vec<Column>) -> Plan {
    ok(&Prepared {
        statement,
        columns,
        parameters: Vec::new(),
    })
}

fn asset(i: i64) -> Vec<SqlValue> {
    vec![
        SqlValue::Integer { value: i },
        if i % 5 == 0 {
            SqlValue::Null
        } else {
            SqlValue::Decimal {
                text: format!("{i}.50"),
            }
        },
    ]
}

fn fetched(from: i64, n: i64, end: bool) -> Plan {
    ok(&Fetched {
        rows: (from..from + n).map(asset).collect(),
        end,
    })
}

const SELECT: &str = "SELECT * FROM HLINV.ASSETS";

fn query(h: &Host, first: Plan) -> Value {
    h.plan(Op::Prepare, prepared(7, assets_columns()));
    h.plan(
        Op::Execute,
        ok(&Executed {
            updated: 0,
            cursor: Some(3),
        }),
    );
    h.plan(Op::Fetch, first);
    h.run(SELECT).unwrap()
}

// sql.run

#[test]
fn a_query_returns_its_columns_and_first_page_and_keeps_its_cursor() {
    let h = Host::new();
    let out = query(&h, fetched(1, 500, false));
    assert_eq!(out["kind"], json!("query"));
    assert_eq!(
        out["columns"],
        json!([
            {"name":"ASSET_ID","label":"ASSET_ID","type":"INTEGER","length":4,"scale":0,"nullable":false,"ccsid":0},
            {"name":"COST","label":"Cost","type":"DECIMAL","length":11,"scale":2,"nullable":true,"ccsid":0},
        ])
    );
    let rows = out["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 500);
    assert_eq!(rows[0], json!([1, "1.50"]));
    assert_eq!(rows[4], json!([5, null]));
    assert_eq!(out["end"], json!(false));
    assert_eq!(out["uncommitted"], json!(false));
    assert!(out["cursor"].is_u64());
    // Released with its cursor, not before.
    assert_eq!(
        h.asked(),
        vec![
            format!("Prepare {SELECT}"),
            "Execute 7".into(),
            "Fetch 3 500".into()
        ]
    );

    // Load more, to the end: the cursor and statement go then.
    let cursor = out["cursor"].clone();
    h.plan(Op::Fetch, fetched(501, 120, true));
    let more = h
        .call(
            "sql.fetch",
            json!({"name":"QSHQ400","cursor":cursor,"maxRows":500}),
        )
        .unwrap();
    assert_eq!(more["rows"].as_array().unwrap().len(), 120);
    assert_eq!(more["rows"][0], json!([501, "501.50"]));
    assert_eq!(more["end"], json!(true));
    assert_eq!(h.asked(), vec!["Fetch 3 500", "CloseCursor 3", "Release 7"]);
    // Past the end: nothing sent.
    let after = h
        .call("sql.fetch", json!({"name":"QSHQ400","cursor":cursor}))
        .unwrap();
    assert_eq!(after, json!({"rows":[],"end":true}));
    assert!(h.asked().is_empty());
    // Closing a result whose cursor ended sends nothing either.
    h.call("sql.close", json!({"name":"QSHQ400","cursor":cursor}))
        .unwrap();
    assert!(h.asked().is_empty());
}

#[test]
fn a_query_that_ends_on_its_first_fetch_closes_its_cursor_at_once() {
    let h = Host::new();
    let out = query(&h, fetched(1, 12, true));
    assert_eq!(out["rows"].as_array().unwrap().len(), 12);
    assert_eq!(out["end"], json!(true));
    // Its result stays for an export.
    assert!(out["cursor"].is_u64());
    assert_eq!(
        h.asked(),
        vec![
            format!("Prepare {SELECT}"),
            "Execute 7".into(),
            "Fetch 3 500".into(),
            "CloseCursor 3".into(),
            "Release 7".into(),
        ]
    );
}

#[test]
fn closing_an_open_result_closes_its_cursor_and_releases_its_statement() {
    let h = Host::new();
    let out = query(&h, fetched(1, 500, false));
    h.asked();
    h.call(
        "sql.close",
        json!({"name":"QSHQ400","cursor":out["cursor"]}),
    )
    .unwrap();
    assert_eq!(h.asked(), vec!["CloseCursor 3", "Release 7"]);
    let e = h
        .call(
            "sql.fetch",
            json!({"name":"QSHQ400","cursor":out["cursor"]}),
        )
        .unwrap_err();
    assert_eq!(e.code, code_host::sql::codes::NO_RESULT);
}

#[test]
fn an_update_reports_its_count_and_releases_at_once_with_no_grid() {
    let h = Host::new();
    h.plan(Op::Prepare, prepared(8, Vec::new()));
    h.plan(
        Op::Execute,
        ok(&Executed {
            updated: 0,
            cursor: None,
        }),
    );
    let out = h
        .run("UPDATE HLINV.ASSETS SET NOTES = NOTES WHERE 1 = 0;")
        .unwrap();
    assert_eq!(
        out,
        json!({"kind":"update","updated":0,"messages":[],"uncommitted":false})
    );
    // The trailing `;` is not sent.
    assert_eq!(
        h.asked(),
        vec![
            "Prepare UPDATE HLINV.ASSETS SET NOTES = NOTES WHERE 1 = 0",
            "Execute 8",
            "Release 8"
        ]
    );
}

#[test]
fn ddl_has_no_count() {
    let h = Host::new();
    h.plan(Op::Prepare, prepared(9, Vec::new()));
    h.plan(
        Op::Execute,
        ok(&Executed {
            updated: 0,
            cursor: None,
        }),
    );
    let out = h.run("CREATE TABLE QTEMP.T (A INT)").unwrap();
    assert_eq!(out, json!({"kind":"ddl","messages":[],"uncommitted":false}));
    assert_eq!(
        h.asked(),
        vec![
            "Prepare CREATE TABLE QTEMP.T (A INT)",
            "Execute 9",
            "Release 9"
        ]
    );
}

#[test]
fn a_syntax_error_carries_the_message_sqlstate_and_sqlcode() {
    let h = Host::new();
    let m = message(
        "SQL0104",
        "Token FORM was not valid. Valid tokens: FROM INTO.",
        "Cause . . . . . :   A syntax error was detected at token FORM.",
    );
    h.plan(
        Op::Prepare,
        Plan::Now((
            Status::SqlError,
            Some(m),
            body(&SqlFailure {
                sqlstate: "42601".into(),
                sqlcode: -104,
                row: None,
            }),
        )),
    );
    let e = h.run("SELECT * FORM HLINV.ASSETS").unwrap_err();
    assert_eq!(e.code, code_host::session::codes::SERVER);
    assert_eq!(
        e.message,
        "SQL0104: Token FORM was not valid. Valid tokens: FROM INTO."
    );
    assert_eq!(
        e.data,
        Some(json!({
            "status": "SqlError",
            "messageId": "SQL0104",
            "text": "Token FORM was not valid. Valid tokens: FROM INTO.",
            "secondLevel": "Cause . . . . . :   A syntax error was detected at token FORM.",
            "sqlstate": "42601",
            "sqlcode": -104,
        }))
    );
    // Nothing was prepared, so nothing is released.
    assert_eq!(h.asked(), vec!["Prepare SELECT * FORM HLINV.ASSETS"]);
}

#[test]
fn an_execute_error_releases_the_statement() {
    let h = Host::new();
    h.plan(Op::Prepare, prepared(4, Vec::new()));
    h.plan(
        Op::Execute,
        Plan::Now((
            Status::SqlError,
            Some(message("SQL0803", "Duplicate key value specified.", "")),
            body(&SqlFailure {
                sqlstate: "23505".into(),
                sqlcode: -803,
                row: Some(0),
            }),
        )),
    );
    let e = h.run("INSERT INTO HLINV.SCRATCH VALUES (1)").unwrap_err();
    let d = e.data.unwrap();
    assert_eq!(
        (
            d["messageId"].clone(),
            d["sqlstate"].clone(),
            d["row"].clone()
        ),
        (json!("SQL0803"), json!("23505"), json!(0))
    );
    assert_eq!(h.asked().last().unwrap(), "Release 4");
}

#[test]
fn a_run_cancelled_while_it_executes_comes_back_with_what_it_did() {
    let h = Arc::new(Host::new());
    h.plan(Op::Prepare, prepared(5, Vec::new()));
    h.plan(
        Op::Execute,
        Plan::Hold((
            Status::Cancelled,
            Some(message(
                "SQL0952",
                "Processing of the SQL statement ended by ENDJOB or cancel.",
                "",
            )),
            body(&Executed {
                updated: 3,
                cursor: None,
            }),
        )),
    );
    let h2 = Arc::clone(&h);
    let t = std::thread::spawn(move || {
        h2.call(
            "sql.run",
            json!({"name":"QSHQ400","sql":"DELETE FROM HLINV.SLOW","run":"r1"}),
        )
    });
    while !h.script().asked.iter().any(|a| a.starts_with("Execute")) {
        std::thread::sleep(Duration::from_millis(5));
    }
    h.call("sql.cancel", json!({"id":"r1"})).unwrap();
    let out = t.join().unwrap().unwrap();
    assert_eq!(out["kind"], json!("update"));
    assert_eq!(out["updated"], json!(3));
    assert_eq!(out["cancelled"], json!(true));
    assert_eq!(out["messages"][0]["id"], json!("SQL0952"));
}

// Commitment control.

#[test]
fn a_change_under_a_commit_level_is_uncommitted_until_commit_or_rollback() {
    let h = Host::new();
    let o = h
        .call("sql.options.get", json!({"name":"QSHQ400"}))
        .unwrap();
    assert_eq!(
        o,
        json!({"commit":"none","naming":"sql","uncommitted":false})
    );
    // Set before the connection exists: kept, sent when it attaches.
    let o = h
        .call(
            "sql.options.set",
            json!({"name":"QSHQ400","commit":"readUncommitted","defaultSchema":"HLINV"}),
        )
        .unwrap();
    assert_eq!(
        o,
        json!({"commit":"readUncommitted","naming":"sql","defaultSchema":"HLINV","uncommitted":false})
    );
    assert!(h.asked().is_empty());

    h.plan(Op::Prepare, prepared(1, Vec::new()));
    h.plan(
        Op::Execute,
        ok(&Executed {
            updated: 1,
            cursor: None,
        }),
    );
    let out = h.run("INSERT INTO SCRATCH VALUES (1)").unwrap();
    assert_eq!(out["updated"], json!(1));
    assert_eq!(out["uncommitted"], json!(true));
    assert_eq!(
        h.asked()[0],
        "SetOptions ReadUncommitted Sql Some(\"HLINV\")"
    );

    // SQL0752 while uncommitted: the options stay as they were.
    h.plan(
        Op::SetOptions,
        Plan::Now((
            Status::InUse,
            Some(message(
                "SQL0752",
                "Connection cannot be changed while changes are uncommitted.",
                "",
            )),
            Vec::new(),
        )),
    );
    let e = h
        .call("sql.options.set", json!({"name":"QSHQ400","commit":"none"}))
        .unwrap_err();
    assert_eq!(e.data.unwrap()["messageId"], json!("SQL0752"));
    let o = h
        .call("sql.options.get", json!({"name":"QSHQ400"}))
        .unwrap();
    assert_eq!(o["commit"], json!("readUncommitted"));
    assert_eq!(o["uncommitted"], json!(true));

    let o = h.call("sql.rollback", json!({"name":"QSHQ400"})).unwrap();
    assert_eq!(o["uncommitted"], json!(false));
    h.plan(Op::Prepare, prepared(2, Vec::new()));
    h.plan(
        Op::Execute,
        ok(&Executed {
            updated: 1,
            cursor: None,
        }),
    );
    assert_eq!(
        h.run("INSERT INTO SCRATCH VALUES (1)").unwrap()["uncommitted"],
        json!(true)
    );
    let o = h.call("sql.commit", json!({"name":"QSHQ400"})).unwrap();
    assert_eq!(o["uncommitted"], json!(false));
    let asked = h.asked();
    assert!(
        asked.contains(&"Rollback".to_owned()) && asked.contains(&"Commit".to_owned()),
        "{asked:?}"
    );
}

#[test]
fn commit_with_no_connection_sends_nothing() {
    let h = Host::new();
    let o = h.call("sql.commit", json!({"name":"QSHQ400"})).unwrap();
    assert_eq!(o["uncommitted"], json!(false));
    assert!(h.asked().is_empty());
    assert_eq!(h.script().attached, 0);
}

#[test]
fn a_lost_connection_is_reported_and_its_cursors_are_gone() {
    let h = Host::new();
    let out = query(&h, fetched(1, 500, false));
    h.script().lose = true;
    h.plan(Op::Prepare, prepared(8, Vec::new()));
    h.plan(
        Op::Execute,
        ok(&Executed {
            updated: 0,
            cursor: None,
        }),
    );
    h.run("VALUES 1").unwrap();
    let lost = h.notes("sql.lost");
    assert_eq!(lost.len(), 1);
    assert_eq!(lost[0]["name"], json!("QSHQ400"));
    assert!(
        lost[0]["message"]
            .as_str()
            .unwrap()
            .contains("uncommitted changes")
    );
    // The old result's cursor belonged to the lost job.
    let e = h
        .call(
            "sql.fetch",
            json!({"name":"QSHQ400","cursor":out["cursor"]}),
        )
        .unwrap_err();
    assert_eq!(e.code, code_host::sql::codes::NO_RESULT);
}

#[test]
fn disconnect_closes_the_sql_connection_and_the_next_run_attaches_anew() {
    let h = Host::new();
    h.plan(Op::Prepare, prepared(1, Vec::new()));
    h.plan(
        Op::Execute,
        ok(&Executed {
            updated: 0,
            cursor: None,
        }),
    );
    h.run("VALUES 1").unwrap();
    h.call("session.disconnect", json!({"name":"QSHQ400"}))
        .unwrap();
    assert!(h.asked().contains(&"close".to_owned()));
    h.connect();
    h.plan(Op::Prepare, prepared(1, Vec::new()));
    h.plan(
        Op::Execute,
        ok(&Executed {
            updated: 0,
            cursor: None,
        }),
    );
    h.run("VALUES 1").unwrap();
    assert_eq!(h.script().attached, 2);
}

#[test]
fn below_version_4_sql_is_refused_before_anything_is_sent() {
    let h = Host::at(Some(3));
    let e = h.run("VALUES 1").unwrap_err();
    assert_eq!(e.code, code_host::session::codes::QAP_UNAVAILABLE);
    assert_eq!(e.message, "QAP version 4 not available on this server");
    assert_eq!(h.script().attached, 0);
}
