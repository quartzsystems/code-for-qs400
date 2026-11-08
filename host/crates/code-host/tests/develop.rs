// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `object.*` and `member.*` at the method-registry level, against a fake
//! `Develop` with canned `qap-client` replies. The refusals carry the IDs,
//! statuses and texts the spec and `qap-client` name: `CPF1002` (`InUse`),
//! `TCP1A5A` (`Error`, data the file's CCSID cannot hold) and `TCP1A61`
//! (`NotFound`, no lock held), each passed through with its second-level
//! text.

use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex};

use code_host::registry_with;
use code_host::session::{
    Backend, DevelopBackend, Endpoint, Factory, JobDto, Sessions, SystemDto, codes,
};
use host_rpc::{Context, Outbound, Registry, RpcError};
use qap_client::develop::WriteOptions;
use qap_client::proto::Status;
use qap_client::proto::ops::develop::{
    Attribute, Libraries, Library, LibraryKind, LibraryList, ListLibraries, ListMembers,
    ListObjects, MemberData, MemberEntry, Members, ObjectEntry, Objects, SetLibraryList,
};
use qap_client::proto::types::{MemberName, ObjectName, SourceRecord};
use qap_client::{Error, Secret, ServerMessage, Wake};
use serde_json::{Value, json};

/// What the fake answers, and what it was asked.
#[derive(Default)]
struct Script {
    /// The version agreed; `None` is 9.
    qap: Option<u16>,
    libraries: Vec<Library>,
    objects: Vec<ObjectEntry>,
    members: Vec<MemberEntry>,
    attributes: Vec<Attribute>,
    member: MemberData,
    /// Each `Develop` call, in order, as a line.
    asked: Vec<String>,
    /// The records and options of the last `write_member`.
    written: Option<(Vec<SourceRecord>, WriteOptions)>,
    /// Answers the next calls in place of their replies.
    refusals: VecDeque<Error>,
}

type Shared = Arc<Mutex<Script>>;

struct Fake(Shared);

impl Fake {
    /// Logs the call; the next refusal, if one is queued.
    fn ask(&self, line: String) -> Result<(), Error> {
        self.answer(line).map(drop)
    }

    /// As [`Fake::ask`], with the script to answer from.
    fn answer(&self, line: String) -> Result<std::sync::MutexGuard<'_, Script>, Error> {
        let mut s = self.0.lock().unwrap();
        s.asked.push(line);
        match s.refusals.pop_front() {
            Some(e) => Err(e),
            None => Ok(s),
        }
    }
}

fn page<T: Clone>(all: &[T], start: u32, max: u32) -> (u32, Vec<T>) {
    let start = (start as usize).min(all.len());
    let end = if max == 0 {
        all.len()
    } else {
        (start + max as usize).min(all.len())
    };
    (all.len() as u32, all[start..end].to_vec())
}

fn qualified(m: &MemberName) -> String {
    format!("{}/{}({})", m.file.library, m.file.name, m.member)
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
            qap: self.0.lock().unwrap().qap.unwrap_or(9),
        })
    }
    fn job(&mut self) -> Result<Option<JobDto>, Error> {
        Ok(Some(JobDto {
            number: "100001".into(),
            user: "CWELLMAN".into(),
            name: "QAPSRV".into(),
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
}

impl DevelopBackend for Fake {
    fn get_library_list(&mut self) -> Result<LibraryList, Error> {
        self.ask("get_library_list".into())?;
        Ok(LibraryList::default())
    }
    fn set_library_list(&mut self, _: &SetLibraryList) -> Result<LibraryList, Error> {
        self.ask("set_library_list".into())?;
        Ok(LibraryList::default())
    }
    fn list_libraries(&mut self, r: &ListLibraries) -> Result<Libraries, Error> {
        let s = self.answer(format!(
            "list_libraries {:?} {} {}",
            r.pattern, r.start, r.max
        ))?;
        let (total, libraries) = page(&s.libraries, r.start, r.max);
        Ok(Libraries { total, libraries })
    }
    fn list_objects(&mut self, r: &ListObjects) -> Result<Objects, Error> {
        let s = self.answer(format!(
            "list_objects {} {:?} {:?} {:?} {} {}",
            r.library, r.pattern, r.types, r.attribute, r.start, r.max
        ))?;
        let (total, objects) = page(&s.objects, r.start, r.max);
        Ok(Objects { total, objects })
    }
    fn describe_object(&mut self, o: &ObjectName, ty: &str) -> Result<Vec<Attribute>, Error> {
        let s = self.answer(format!("describe_object {}/{} {ty}", o.library, o.name))?;
        Ok(s.attributes.clone())
    }
    fn list_members(&mut self, r: &ListMembers) -> Result<Members, Error> {
        let s = self.answer(format!(
            "list_members {}/{} {:?} {} {}",
            r.file.library, r.file.name, r.pattern, r.start, r.max
        ))?;
        let (total, members) = page(&s.members, r.start, r.max);
        Ok(Members { total, members })
    }
    fn read_member(&mut self, m: &MemberName, lock: bool) -> Result<MemberData, Error> {
        let s = self.answer(format!("read_member {} lock={lock}", qualified(m)))?;
        Ok(s.member.clone())
    }
    fn write_member(
        &mut self,
        m: &MemberName,
        records: &[SourceRecord],
        options: &WriteOptions,
    ) -> Result<u32, Error> {
        let mut s = self.answer(format!("write_member {}", qualified(m)))?;
        s.written = Some((records.to_vec(), options.clone()));
        Ok(records.len() as u32)
    }
    fn unlock_member(&mut self, m: &MemberName) -> Result<(), Error> {
        self.ask(format!("unlock_member {}", qualified(m)))?;
        Ok(())
    }
    fn create_member(&mut self, m: &MemberName, srctype: &str, text: &str) -> Result<(), Error> {
        self.ask(format!("create_member {} {srctype} {text:?}", qualified(m)))?;
        Ok(())
    }
    fn copy_member(
        &mut self,
        from: &MemberName,
        to: &MemberName,
        replace: bool,
    ) -> Result<(), Error> {
        self.ask(format!(
            "copy_member {} {} replace={replace}",
            qualified(from),
            qualified(to)
        ))?;
        Ok(())
    }
    fn rename_member(&mut self, m: &MemberName, new_name: &str) -> Result<(), Error> {
        self.ask(format!("rename_member {} {new_name}", qualified(m)))?;
        Ok(())
    }
    fn delete_member(&mut self, m: &MemberName) -> Result<(), Error> {
        self.ask(format!("delete_member {}", qualified(m)))?;
        Ok(())
    }
    fn change_member(
        &mut self,
        m: &MemberName,
        srctype: Option<&str>,
        text: Option<&str>,
    ) -> Result<(), Error> {
        self.ask(format!(
            "change_member {} {srctype:?} {text:?}",
            qualified(m)
        ))?;
        Ok(())
    }
}

fn refusal(status: Status, id: &str, text: &str, help: &str) -> Error {
    Error::Status {
        status,
        message: Some(ServerMessage {
            id: id.into(),
            severity: 40,
            data: Vec::new(),
            text: text.into(),
            help: help.into(),
        }),
    }
}

struct Host {
    script: Shared,
    registry: Registry,
    ctx: Context,
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
            Ok(Box::new(Fake(Arc::clone(&s))) as Box<dyn Backend>)
        });
        let outbound = Outbound::new(io::sink());
        let sessions = Sessions::new(factory, outbound.clone());
        let h = Host {
            script,
            registry: registry_with(&sessions),
            ctx: Context::new(outbound),
        };
        h.call(
            "session.connect",
            json!({"name":"QSHQ400","host":"qshq400.example","user":"cwellman","password":"secret"}),
        )
        .unwrap();
        h
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.registry.dispatch(method, params, &self.ctx)
    }

    fn script(&self) -> std::sync::MutexGuard<'_, Script> {
        self.script.lock().unwrap()
    }

    fn asked(&self) -> Vec<String> {
        std::mem::take(&mut self.script().asked)
    }
}

fn record(seq: u32, date: u32, data: &str) -> SourceRecord {
    SourceRecord {
        seq,
        date,
        data: data.into(),
    }
}

const ASSETS: &str = r#""library":"HLINV","file":"QRPGLESRC","member":"ASSETS""#;

fn with_member(extra: &str) -> Value {
    serde_json::from_str(&format!(r#"{{"name":"QSHQ400",{ASSETS}{extra}}}"#)).unwrap()
}

/// The server's refusal as the host must pass it on: `-32010`, the
/// message as `id: text`, and `data` exactly as sent.
fn assert_passed_through(e: &RpcError, status: &str, id: &str, text: &str, help: &str) {
    assert_eq!(e.code, codes::SERVER);
    assert_eq!(e.message, format!("{id}: {text}"));
    assert_eq!(
        e.data.as_ref().unwrap(),
        &json!({"status":status,"messageId":id,"text":text,"secondLevel":help})
    );
}

#[test]
fn libraries_are_drained_in_pages_of_500() {
    let h = Host::new();
    h.script().libraries = (0..1203)
        .map(|i| Library {
            name: format!("LIB{i:04}"),
            kind: if i == 1 {
                LibraryKind::Test
            } else {
                LibraryKind::Production
            },
            text: format!("Library {i}"),
        })
        .collect();
    let r = h
        .call(
            "object.libraries",
            json!({"name":"QSHQ400","pattern":"lib*"}),
        )
        .unwrap();
    let r = r.as_array().unwrap();
    assert_eq!(r.len(), 1203);
    assert_eq!(
        r[0],
        json!({"library":"LIB0000","kind":"production","text":"Library 0"})
    );
    assert_eq!(r[1]["kind"], "test");
    assert_eq!(r[1202]["library"], "LIB1202");
    // The pattern goes as typed: the server folds case.
    assert_eq!(
        h.asked(),
        [
            r#"list_libraries "lib*" 0 500"#,
            r#"list_libraries "lib*" 500 500"#,
            r#"list_libraries "lib*" 1000 500"#,
        ]
    );
    // No pattern is the empty pattern, *ALL.
    h.call("object.libraries", json!({"name":"QSHQ400"}))
        .unwrap();
    assert_eq!(h.asked()[0], r#"list_libraries "" 0 500"#);
}

#[test]
fn objects_pass_the_filters_and_return_every_field() {
    let h = Host::new();
    h.script().objects = vec![ObjectEntry {
        library: "HLINV".into(),
        name: "QRPGLESRC".into(),
        r#type: "*FILE".into(),
        attribute: "PF-SRC".into(),
        text: "RPG sources".into(),
        size: 491_520,
        changed: 1_762_473_600_000,
        owner: "CWELLMAN".into(),
    }];
    let r = h
        .call(
            "object.list",
            json!({"name":"QSHQ400","library":"HLINV","pattern":"q*","types":["*FILE"],"attribute":"PF-SRC"}),
        )
        .unwrap();
    assert_eq!(
        r,
        json!([{
            "library":"HLINV","object":"QRPGLESRC","type":"*FILE","attribute":"PF-SRC",
            "text":"RPG sources","size":491520,"changed":1762473600000_i64,"owner":"CWELLMAN"
        }])
    );
    assert_eq!(
        h.asked(),
        [r#"list_objects HLINV "q*" ["*FILE"] Some("PF-SRC") 0 500"#]
    );
    h.call("object.list", json!({"name":"QSHQ400","library":"*LIBL"}))
        .unwrap();
    assert_eq!(h.asked(), [r#"list_objects *LIBL "" [] None 0 500"#]);
    let e = h
        .call("object.list", json!({"name":"QSHQ400","library":" "}))
        .unwrap_err();
    assert_eq!(e.code, host_rpc::codes::INVALID_PARAMS);
    assert!(h.asked().is_empty());
}

#[test]
fn properties_keep_the_servers_order_and_labels() {
    let h = Host::new();
    h.script().attributes = [
        ("Object", "ASSETS"),
        ("Library", "HLINV"),
        ("Type", "*PGM"),
        ("Attribute", "RPGLE"),
        ("Owner", "CWELLMAN"),
        ("Text", "Asset register"),
        ("Created", "11/07/26 09:14:02"),
    ]
    .iter()
    .map(|(n, v)| Attribute {
        name: (*n).into(),
        value: (*v).into(),
    })
    .collect();
    let r = h
        .call(
            "object.properties",
            json!({"name":"QSHQ400","library":"HLINV","object":"ASSETS","type":"*PGM"}),
        )
        .unwrap();
    let names: Vec<_> = r
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        names,
        [
            "Object",
            "Library",
            "Type",
            "Attribute",
            "Owner",
            "Text",
            "Created"
        ]
    );
    assert_eq!(r[6], json!({"name":"Created","value":"11/07/26 09:14:02"}));
    assert_eq!(h.asked(), ["describe_object HLINV/ASSETS *PGM"]);

    h.script().refusals.push_back(refusal(
        Status::NotFound,
        "CPF9801",
        "Object NOSUCH in library HLINV not found.",
        "Cause . . . . . :   The object was not found.",
    ));
    let e = h
        .call(
            "object.properties",
            json!({"name":"QSHQ400","library":"HLINV","object":"NOSUCH","type":"*PGM"}),
        )
        .unwrap_err();
    assert_passed_through(
        &e,
        "NotFound",
        "CPF9801",
        "Object NOSUCH in library HLINV not found.",
        "Cause . . . . . :   The object was not found.",
    );
}

#[test]
fn members_are_listed_whole() {
    let h = Host::new();
    h.script().members = (0..501)
        .map(|i| MemberEntry {
            name: format!("MBR{i:03}"),
            srctype: "RPGLE".into(),
            text: String::new(),
            records: i,
            created: 1_700_000_000_000,
            changed: 1_762_473_600_000,
        })
        .collect();
    let r = h
        .call(
            "member.list",
            json!({"name":"QSHQ400","library":"HLINV","file":"QRPGLESRC"}),
        )
        .unwrap();
    assert_eq!(r.as_array().unwrap().len(), 501);
    assert_eq!(
        r[500],
        json!({"member":"MBR500","type":"RPGLE","text":"","records":500,
               "created":1700000000000_i64,"changed":1762473600000_i64})
    );
    assert_eq!(
        h.asked(),
        [
            r#"list_members HLINV/QRPGLESRC "" 0 500"#,
            r#"list_members HLINV/QRPGLESRC "" 500 500"#
        ]
    );
}

#[test]
fn read_converts_seq_and_date_and_passes_the_lock() {
    let h = Host::new();
    h.script().member = MemberData {
        srctype: "RPGLE".into(),
        text: "Asset register".into(),
        width: 100,
        ccsid: 37,
        records: vec![
            record(100, 260_105, "**free"),
            record(150, 0, ""),
            record(999_999, 10_105, "dcl-s n int(10); // ünïcödé as sent"),
        ],
    };
    let r = h
        .call("member.read", with_member(r#","lock":true"#))
        .unwrap();
    assert_eq!(
        r,
        json!({
            "type":"RPGLE","text":"Asset register","width":100,"ccsid":37,
            "lines":[
                {"seq":"0001.00","date":"260105","text":"**free"},
                {"seq":"0001.50","date":"000000","text":""},
                {"seq":"9999.99","date":"010105","text":"dcl-s n int(10); // ünïcödé as sent"}
            ]
        })
    );
    assert_eq!(h.asked(), ["read_member HLINV/QRPGLESRC(ASSETS) lock=true"]);

    // *LIBL and *CURLIB go through, for Phase 4's Actions.
    h.call(
        "member.read",
        json!({"name":"QSHQ400","library":"*LIBL","file":"QRPGLESRC","member":"ASSETS","lock":false}),
    )
    .unwrap();
    assert_eq!(
        h.asked(),
        ["read_member *LIBL/QRPGLESRC(ASSETS) lock=false"]
    );
}

#[test]
fn a_member_another_job_holds_is_cpf1002_as_sent() {
    let h = Host::new();
    let text = "Cannot allocate member ASSETS file QRPGLESRC in HLINV.";
    let help = "Cause . . . . . :   Member ASSETS is in use by job 123456/CWELLMAN/QPADEV0001.";
    h.script()
        .refusals
        .push_back(refusal(Status::InUse, "CPF1002", text, help));
    let e = h
        .call("member.read", with_member(r#","lock":true"#))
        .unwrap_err();
    assert_passed_through(&e, "InUse", "CPF1002", text, help);
}

#[test]
fn a_file_the_server_cannot_convert_is_tcp1a5a_as_sent() {
    let h = Host::new();
    let text = "Data cannot be converted between CCSID 65535 and UTF-8.";
    let help = "Cause . . . . . :   The file's CCSID has no conversion.";
    h.script()
        .refusals
        .push_back(refusal(Status::Error, "TCP1A5A", text, help));
    let e = h
        .call("member.read", with_member(r#","lock":false"#))
        .unwrap_err();
    assert_passed_through(&e, "Error", "TCP1A5A", text, help);

    // On a write: nothing written, the message as sent.
    h.script()
        .refusals
        .push_back(refusal(Status::Error, "TCP1A5A", text, help));
    let e = h
        .call(
            "member.write",
            with_member(r#","lines":[{"seq":"0001.00","date":"000000","text":"€"}]"#),
        )
        .unwrap_err();
    assert_passed_through(&e, "Error", "TCP1A5A", text, help);
}

#[test]
fn write_sends_every_record_converted_with_renumber_only() {
    let h = Host::new();
    let r = h
        .call(
            "member.write",
            with_member(
                r#","lines":[
                    {"seq":"0001.00","date":"260105","text":"**free"},
                    {"seq":"0001.50","date":"000000","text":"// new"},
                    {"seq":"9999.99","date":"010105","text":""}
                ],"renumber":false"#,
            ),
        )
        .unwrap();
    assert_eq!(r, json!({"lines":3}));
    let (records, options) = h.script().written.take().unwrap();
    assert_eq!(
        records,
        [
            record(100, 260_105, "**free"),
            record(150, 0, "// new"),
            record(999_999, 10_105, "")
        ]
    );
    assert_eq!(options, WriteOptions::default());

    h.call(
        "member.write",
        with_member(r#","lines":[{"seq":"0000.01","date":"000000","text":"x"}],"renumber":true"#),
    )
    .unwrap();
    let (_, options) = h.script().written.take().unwrap();
    assert_eq!(
        options,
        WriteOptions {
            renumber: true,
            srctype: None,
            text: None
        }
    );
    // An empty list empties the member.
    assert_eq!(
        h.call("member.write", with_member(r#","lines":[]"#))
            .unwrap(),
        json!({"lines":0})
    );
}

#[test]
fn write_refuses_a_bad_seq_or_date_before_sending() {
    let h = Host::new();
    h.asked();
    for line in [
        r#"{"seq":"1","date":"000000","text":""}"#,
        r#"{"seq":"10000.00","date":"000000","text":""}"#,
        r#"{"seq":"0001.00","date":"2601","text":""}"#,
        r#"{"seq":"0001.00","date":0,"text":""}"#,
    ] {
        let e = h
            .call(
                "member.write",
                with_member(&format!(r#","lines":[{line}]"#)),
            )
            .unwrap_err();
        assert_eq!(e.code, host_rpc::codes::INVALID_PARAMS, "{line}");
    }
    assert!(h.asked().is_empty(), "nothing sent");
}

#[test]
fn write_passes_the_servers_invalid_request_for_renumbering_too_many() {
    let h = Host::new();
    let text = "Too many records to renumber: 10000; the most is 9999.";
    h.script()
        .refusals
        .push_back(refusal(Status::InvalidRequest, "TCP1A62", text, "Cause"));
    let e = h
        .call(
            "member.write",
            with_member(
                r#","lines":[{"seq":"0001.00","date":"000000","text":""}],"renumber":true"#,
            ),
        )
        .unwrap_err();
    assert_passed_through(&e, "InvalidRequest", "TCP1A62", text, "Cause");
}

#[test]
fn unlock_of_a_member_not_held_is_tcp1a61_as_sent() {
    let h = Host::new();
    assert_eq!(
        h.call("member.unlock", with_member("")).unwrap(),
        Value::Null
    );
    let text = "Member ASSETS is not locked by this connection.";
    let help = "Cause . . . . . :   No lock to release.";
    h.script()
        .refusals
        .push_back(refusal(Status::NotFound, "TCP1A61", text, help));
    let e = h.call("member.unlock", with_member("")).unwrap_err();
    assert_passed_through(&e, "NotFound", "TCP1A61", text, help);
    assert_eq!(
        h.asked(),
        [
            "unlock_member HLINV/QRPGLESRC(ASSETS)",
            "unlock_member HLINV/QRPGLESRC(ASSETS)"
        ]
    );
}

#[test]
fn member_commands_send_one_call_each() {
    let h = Host::new();
    let tmp = r#""library":"HLINV","file":"QTMPSRC""#;
    let calls = [
        (
            "member.create",
            format!(
                r#"{{"name":"QSHQ400",{tmp},"member":"NEW1","type":"RPGLE","text":"New one"}}"#
            ),
        ),
        (
            "member.copy",
            format!(
                r#"{{"name":"QSHQ400","from":{{{ASSETS}}},"to":{{{tmp},"member":"ASSETS"}},"replace":true}}"#
            ),
        ),
        (
            "member.rename",
            format!(r#"{{"name":"QSHQ400",{tmp},"member":"NEW1","newName":"NEW2"}}"#),
        ),
        (
            "member.changeText",
            format!(r#"{{"name":"QSHQ400",{tmp},"member":"NEW2","text":"Renamed"}}"#),
        ),
        (
            "member.changeText",
            format!(r#"{{"name":"QSHQ400",{tmp},"member":"NEW2","type":"SQLRPGLE"}}"#),
        ),
        (
            "member.delete",
            format!(r#"{{"name":"QSHQ400",{tmp},"member":"NEW2"}}"#),
        ),
    ];
    for (method, params) in &calls {
        let v: Value = serde_json::from_str(params).unwrap();
        assert_eq!(h.call(method, v).unwrap(), Value::Null, "{method}");
    }
    assert_eq!(
        h.asked(),
        [
            r#"create_member HLINV/QTMPSRC(NEW1) RPGLE "New one""#,
            "copy_member HLINV/QRPGLESRC(ASSETS) HLINV/QTMPSRC(ASSETS) replace=true",
            "rename_member HLINV/QTMPSRC(NEW1) NEW2",
            r#"change_member HLINV/QTMPSRC(NEW2) None Some("Renamed")"#,
            r#"change_member HLINV/QTMPSRC(NEW2) Some("SQLRPGLE") None"#,
            "delete_member HLINV/QTMPSRC(NEW2)",
        ]
    );

    let text = "Member NEW1 already exists in file QTMPSRC in library HLINV.";
    h.script()
        .refusals
        .push_back(refusal(Status::Exists, "CPF7306", text, "Cause"));
    let e = h
        .call(
            "member.create",
            json!({"name":"QSHQ400","library":"HLINV","file":"QTMPSRC","member":"NEW1","type":"RPGLE","text":""}),
        )
        .unwrap_err();
    assert_passed_through(&e, "Exists", "CPF7306", text, "Cause");
}

#[test]
fn below_version_8_every_method_is_refused_with_the_version() {
    let h = Host::at(Some(7));
    let m = r#""library":"HLINV","file":"QRPGLESRC","member":"ASSETS""#;
    let calls = [
        ("object.libraries", r#"{"name":"QSHQ400"}"#.to_owned()),
        (
            "object.list",
            r#"{"name":"QSHQ400","library":"HLINV"}"#.to_owned(),
        ),
        (
            "object.properties",
            r#"{"name":"QSHQ400","library":"HLINV","object":"ASSETS","type":"*PGM"}"#.to_owned(),
        ),
        (
            "member.list",
            r#"{"name":"QSHQ400","library":"HLINV","file":"QRPGLESRC"}"#.to_owned(),
        ),
        (
            "member.read",
            format!(r#"{{"name":"QSHQ400",{m},"lock":true}}"#),
        ),
        (
            "member.write",
            format!(r#"{{"name":"QSHQ400",{m},"lines":[]}}"#),
        ),
        ("member.unlock", format!(r#"{{"name":"QSHQ400",{m}}}"#)),
        (
            "member.create",
            format!(r#"{{"name":"QSHQ400",{m},"type":"RPGLE"}}"#),
        ),
        (
            "member.copy",
            format!(r#"{{"name":"QSHQ400","from":{{{m}}},"to":{{{m}}}}}"#),
        ),
        (
            "member.rename",
            format!(r#"{{"name":"QSHQ400",{m},"newName":"X"}}"#),
        ),
        ("member.delete", format!(r#"{{"name":"QSHQ400",{m}}}"#)),
        (
            "member.changeText",
            format!(r#"{{"name":"QSHQ400",{m},"text":"x"}}"#),
        ),
    ];
    for (method, params) in &calls {
        let v: Value = serde_json::from_str(params).unwrap();
        let e = h.call(method, v).unwrap_err();
        assert_eq!(e.code, codes::QAP_UNAVAILABLE, "{method}");
        assert_eq!(
            e.message, "QAP version 8 not available on this server",
            "{method}"
        );
        assert_eq!(e.data, Some(json!({"version":7})), "{method}");
    }
    assert!(h.asked().is_empty(), "nothing sent");
}

#[test]
fn qap_clients_own_unsupported_maps_to_the_same_error() {
    let h = Host::new();
    h.script().refusals.push_back(Error::Unsupported {
        op: qap_client::proto::Op::ListLibraries,
        needs: 8,
        has: 6,
    });
    let e = h
        .call("object.libraries", json!({"name":"QSHQ400"}))
        .unwrap_err();
    assert_eq!(e.code, codes::QAP_UNAVAILABLE);
    assert_eq!(e.data, Some(json!({"version":6})));
}

#[test]
fn a_session_that_is_not_signed_on_is_not_connected() {
    let h = Host::new();
    let e = h
        .call(
            "member.list",
            json!({"name":"OTHER","library":"HLINV","file":"QRPGLESRC"}),
        )
        .unwrap_err();
    assert_eq!(e.code, codes::NOT_CONNECTED);
}
