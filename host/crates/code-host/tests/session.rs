// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The session state machine at the method-registry level. `qap-client`
//! has no transport trait, so a fake [`Backend`] answers with canned
//! replies. The sign-on refusals are the IDs and texts QS/400's sign-on
//! sends (`CPF1107`, `CPF1392`, `CPF1393`, `CPF1394`); the expired
//! password's ID is the one QS/400's QAP test engine uses.

use std::collections::VecDeque;
use std::io::{self, Cursor, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use code_host::registry_with;
use code_host::session::{
    Backend, CommandBackend, DevelopBackend, Endpoint, Factory, IfsBackend, JobDto, Sessions,
    SystemDto, codes, qap_factory,
};
use host_rpc::framing::read_frame;
use host_rpc::{Context, Outbound, Registry, RpcError};
use qap_client::develop::WriteOptions;
use qap_client::proto::Status;
use qap_client::proto::ops::develop::{
    Attribute, Libraries, LibraryList, ListLibraries, ListMembers, ListObjects, MemberData,
    Members, Objects, SetLibraryList,
};
use qap_client::proto::types::{MemberName, ObjectName, SourceRecord};
use qap_client::{Error, Secret, ServerMessage, Wake};
use serde_json::{Value, json};

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

/// What the fake server will answer, and what it was asked.
#[derive(Default)]
struct Script {
    sign_on: VecDeque<Result<(), Error>>,
    change_password: VecDeque<Result<(), Error>>,
    reconnect: VecDeque<Result<bool, Error>>,
    live: bool,
    jobs: u32,
    calls: Vec<String>,
    endpoints: Vec<Endpoint>,
    wake: Option<Wake>,
    /// The version the connection agrees; `None` is 9.
    qap: Option<u16>,
    /// The session job's library list, as `GetLibraryList` answers it.
    libl: LibraryList,
    /// Each `SetLibraryList` asked, in order.
    libl_sets: Vec<SetLibraryList>,
    /// What `SetLibraryList` answers instead of taking the list.
    libl_refusal: Option<Error>,
}

type Shared = Arc<Mutex<Script>>;

struct Fake(Shared);

impl Fake {
    fn job(s: &Script, user: &str) -> JobDto {
        JobDto {
            number: format!("{:06}", 100_000 + s.jobs),
            user: user.to_owned(),
            name: "QAPSRV".into(),
        }
    }
}

impl Backend for Fake {
    fn sign_on(&mut self, user: &str, password: &Secret) -> Result<String, Error> {
        let mut s = self.0.lock().unwrap();
        s.calls
            .push(format!("sign_on {user} {}", password.expose()));
        s.sign_on.pop_front().unwrap_or(Ok(()))?;
        s.live = true;
        s.jobs += 1;
        Ok(user.to_owned())
    }

    fn change_password(&mut self, user: &str, old: &Secret, new: &Secret) -> Result<String, Error> {
        let mut s = self.0.lock().unwrap();
        s.calls.push(format!(
            "change_password {user} {} {}",
            old.expose(),
            new.expose()
        ));
        s.change_password.pop_front().unwrap_or(Ok(()))?;
        if !s.live {
            s.jobs += 1;
        }
        s.live = true;
        Ok(user.to_owned())
    }

    fn system(&mut self) -> Result<SystemDto, Error> {
        Ok(SystemDto {
            name: "QSHQ400".into(),
            product: "QS00SS1".into(),
            version: "V1R0M0".into(),
            serial: Some("1234567".into()),
            model: None,
            qap: self.0.lock().unwrap().qap.unwrap_or(9),
        })
    }

    fn job(&mut self) -> Result<Option<JobDto>, Error> {
        let s = self.0.lock().unwrap();
        Ok(Some(Fake::job(&s, "CWELLMAN")))
    }

    fn sign_off(&mut self) -> Result<(), Error> {
        let mut s = self.0.lock().unwrap();
        s.calls.push("sign_off".into());
        s.live = false;
        Ok(())
    }

    fn reconnect(&mut self) -> Result<bool, Error> {
        let mut s = self.0.lock().unwrap();
        s.calls.push("reconnect".into());
        let r = s.reconnect.pop_front().unwrap_or(Ok(true));
        if r.as_ref().is_ok_and(|resumed| *resumed) {
            s.live = true;
        }
        r
    }

    fn live(&self) -> bool {
        self.0.lock().unwrap().live
    }

    fn develop(&mut self) -> &mut dyn DevelopBackend {
        self
    }
    fn ifs(&mut self) -> &mut dyn IfsBackend {
        unreachable!("these tests send no Ifs request")
    }
    fn command(&mut self) -> &mut dyn CommandBackend {
        unreachable!("these tests send no Command request")
    }
}

/// The library list operations; objects and members are tested in
/// `tests/develop.rs`.
impl DevelopBackend for Fake {
    fn get_library_list(&mut self) -> Result<LibraryList, Error> {
        Ok(self.0.lock().unwrap().libl.clone())
    }
    fn set_library_list(&mut self, req: &SetLibraryList) -> Result<LibraryList, Error> {
        let mut s = self.0.lock().unwrap();
        s.libl_sets.push(req.clone());
        if let Some(e) = s.libl_refusal.take() {
            return Err(e);
        }
        s.libl.current = req.current.clone();
        s.libl.user = req.user.clone();
        Ok(s.libl.clone())
    }
    fn list_libraries(&mut self, _: &ListLibraries) -> Result<Libraries, Error> {
        unimplemented!()
    }
    fn list_objects(&mut self, _: &ListObjects) -> Result<Objects, Error> {
        unimplemented!()
    }
    fn describe_object(&mut self, _: &ObjectName, _: &str) -> Result<Vec<Attribute>, Error> {
        unimplemented!()
    }
    fn list_members(&mut self, _: &ListMembers) -> Result<Members, Error> {
        unimplemented!()
    }
    fn read_member(&mut self, _: &MemberName, _: bool) -> Result<MemberData, Error> {
        unimplemented!()
    }
    fn write_member(
        &mut self,
        _: &MemberName,
        _: &[SourceRecord],
        _: &WriteOptions,
    ) -> Result<u32, Error> {
        unimplemented!()
    }
    fn unlock_member(&mut self, _: &MemberName) -> Result<(), Error> {
        unimplemented!()
    }
    fn create_member(&mut self, _: &MemberName, _: &str, _: &str) -> Result<(), Error> {
        unimplemented!()
    }
    fn copy_member(&mut self, _: &MemberName, _: &MemberName, _: bool) -> Result<(), Error> {
        unimplemented!()
    }
    fn rename_member(&mut self, _: &MemberName, _: &str) -> Result<(), Error> {
        unimplemented!()
    }
    fn delete_member(&mut self, _: &MemberName) -> Result<(), Error> {
        unimplemented!()
    }
    fn change_member(
        &mut self,
        _: &MemberName,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<(), Error> {
        unimplemented!()
    }
}

/// A server refusal with its message, as `qap-client` returns it.
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
    sink: Sink,
    script: Shared,
    sessions: Arc<Sessions>,
    registry: Registry,
    ctx: Context,
}

impl Host {
    fn new() -> Host {
        let script: Shared = Arc::default();
        let s = Arc::clone(&script);
        let factory: Factory = Arc::new(move |ep: &Endpoint, wake: Wake| {
            let mut sc = s.lock().unwrap();
            sc.endpoints.push(ep.clone());
            sc.wake = Some(wake);
            Ok(Box::new(Fake(Arc::clone(&s))) as Box<dyn Backend>)
        });
        Host::with(factory, script)
    }

    fn with(factory: Factory, script: Shared) -> Host {
        let sink = Sink::default();
        let outbound = Outbound::new(sink.clone());
        let sessions = Sessions::new(factory, outbound.clone());
        let registry = registry_with(&sessions);
        Host {
            sink,
            script,
            sessions,
            registry,
            ctx: Context::new(outbound),
        }
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.registry.dispatch(method, params, &self.ctx)
    }

    fn connect(&self, password: &str) -> Result<Value, RpcError> {
        self.call(
            "session.connect",
            json!({"name":"QSHQ400","host":"qshq400.example","user":"cwellman","password":password}),
        )
    }

    /// The states sent as `session.changed` since the last look.
    fn changes(&self) -> Vec<String> {
        let bytes = std::mem::take(&mut *self.sink.0.lock().unwrap());
        let mut r = Cursor::new(bytes);
        let mut out = Vec::new();
        while let Some(b) = read_frame(&mut r).unwrap() {
            let v: Value = serde_json::from_slice(&b).unwrap();
            if v["method"] == "session.changed" {
                assert_eq!(v["params"]["name"], "QSHQ400");
                out.push(v["params"]["state"].as_str().unwrap().to_owned());
            }
        }
        out
    }

    fn calls(&self) -> Vec<String> {
        std::mem::take(&mut self.script.lock().unwrap().calls)
    }

    fn script(&self) -> std::sync::MutexGuard<'_, Script> {
        self.script.lock().unwrap()
    }
}

fn status(h: &Host) -> Value {
    h.call("session.status", json!({"name":"QSHQ400"})).unwrap()
}

#[test]
fn connect_signs_on_and_reports_the_system_and_job() {
    let h = Host::new();
    let r = h.connect("secret").unwrap();
    assert_eq!(
        r,
        json!({
            "name": "QSHQ400",
            "state": "connected",
            "user": "CWELLMAN",
            "system": {"name":"QSHQ400","product":"QS00SS1","version":"V1R0M0","serial":"1234567","qap":9},
            "job": {"number":"100001","user":"CWELLMAN","name":"QAPSRV"}
        })
    );
    assert_eq!(h.changes(), ["connecting", "connected"]);
    assert_eq!(h.calls(), ["sign_on CWELLMAN secret"]);
    // No port given: qap-client's default applies.
    assert_eq!(h.script().endpoints[0].port, None);
    assert_eq!(status(&h), r);
}

#[test]
fn a_refused_password_is_the_servers_message_exactly() {
    let h = Host::new();
    h.script().sign_on.push_back(Err(refusal(
        Status::SignOnFailed,
        "CPF1107",
        "Password or user profile is not correct.",
        "Cause . . . . . :   The password is not correct.",
    )));
    let e = h.connect("wrong").unwrap_err();
    assert_eq!(e.code, codes::SERVER);
    assert_eq!(
        e.message,
        "CPF1107: Password or user profile is not correct."
    );
    assert_eq!(
        e.data,
        Some(json!({
            "status": "SignOnFailed",
            "messageId": "CPF1107",
            "text": "Password or user profile is not correct.",
            "secondLevel": "Cause . . . . . :   The password is not correct."
        }))
    );
    assert_eq!(h.changes(), ["connecting", "disconnected"]);
    assert_eq!(status(&h)["state"], "disconnected");
}

#[test]
fn qmaxsign_lockout_passes_each_message_through() {
    let h = Host::new();
    let messages = [
        ("CPF1107", "Password or user profile is not correct."),
        (
            "CPF1392",
            "Password or user profile is not correct. The next attempt that is not valid disables the profile or the device.",
        ),
        (
            "CPF1393",
            "Too many sign-on attempts were not valid; user profile CWELLMAN or the device is disabled.",
        ),
        (
            "CPF1394",
            "User profile CWELLMAN is disabled and cannot sign on.",
        ),
    ];
    for (id, text) in messages {
        h.script()
            .sign_on
            .push_back(Err(refusal(Status::SignOnFailed, id, text, "")));
    }
    for (id, text) in messages {
        let e = h.connect("wrong").unwrap_err();
        assert_eq!(e.message, format!("{id}: {text}"));
        assert_eq!(e.data.as_ref().unwrap()["messageId"], id);
        assert_eq!(e.data.as_ref().unwrap()["text"], text);
        assert!(e.data.as_ref().unwrap().get("secondLevel").is_none());
    }
    assert_eq!(h.calls().len(), 4, "one sign-on per connect, no retries");
}

#[test]
fn an_expired_password_keeps_the_connection_for_a_change() {
    let h = Host::new();
    h.script().sign_on.push_back(Err(refusal(
        Status::PasswordExpired,
        "CPD9BAE",
        "Password for user profile CWELLMAN has expired.",
        "",
    )));
    let e = h.connect("old").unwrap_err();
    assert_eq!(e.code, codes::SERVER);
    assert_eq!(e.data.as_ref().unwrap()["status"], "PasswordExpired");
    assert_eq!(h.changes(), ["connecting", "disconnected"]);

    let r = h
        .call(
            "session.changePassword",
            json!({"name":"QSHQ400","oldPassword":"old","newPassword":"new"}),
        )
        .unwrap();
    assert_eq!(r["state"], "connected");
    assert_eq!(r["job"]["number"], "100001");
    assert_eq!(h.changes(), ["connecting", "connected"]);
    assert_eq!(
        h.calls(),
        ["sign_on CWELLMAN old", "change_password CWELLMAN old new"]
    );

    // The new password is the one kept for signing on again.
    h.script().live = false;
    h.script().reconnect.push_back(Ok(false));
    let _ = h.call("libl.get", json!({"name":"QSHQ400"}));
    assert_eq!(h.calls(), ["reconnect", "sign_on CWELLMAN new"]);
}

#[test]
fn change_password_needs_a_session() {
    let h = Host::new();
    let e = h
        .call(
            "session.changePassword",
            json!({"name":"QSHQ400","oldPassword":"a","newPassword":"b"}),
        )
        .unwrap_err();
    assert_eq!(e.code, codes::NOT_CONNECTED);
    h.script().sign_on.push_back(Err(refusal(
        Status::SignOnFailed,
        "CPF1107",
        "Password or user profile is not correct.",
        "",
    )));
    let _ = h.connect("wrong");
    let e = h
        .call(
            "session.changePassword",
            json!({"name":"QSHQ400","oldPassword":"a","newPassword":"b"}),
        )
        .unwrap_err();
    assert_eq!(e.code, codes::NOT_CONNECTED);
}

#[test]
fn a_server_idle_close_is_stale_and_the_next_call_resumes() {
    let h = Host::new();
    h.connect("secret").unwrap();
    h.changes();
    h.calls();

    h.script().live = false;
    h.sessions.check_all();
    assert_eq!(h.changes(), ["stale"]);
    let s = status(&h);
    assert_eq!(s["state"], "stale");
    assert_eq!(s["job"]["number"], "100001");
    assert!(h.changes().is_empty(), "nothing new to send");

    let l = h.call("libl.get", json!({"name":"QSHQ400"})).unwrap();
    assert_eq!(h.calls(), ["reconnect"]);
    assert_eq!(h.changes(), ["connecting", "connected"]);
    assert_eq!(l, json!({"current":null,"system":[],"user":[]}));
    assert_eq!(status(&h)["job"]["number"], "100001", "same job resumed");
}

#[test]
fn an_ended_session_signs_on_again_with_the_kept_password() {
    let h = Host::new();
    h.connect("secret").unwrap();
    h.calls();
    h.script().live = false;
    h.script().reconnect.push_back(Ok(false));
    let _ = h.call("libl.get", json!({"name":"QSHQ400"}));
    assert_eq!(h.calls(), ["reconnect", "sign_on CWELLMAN secret"]);
    assert_eq!(status(&h)["state"], "connected");
    assert_eq!(status(&h)["job"]["number"], "100002", "a new job");
}

#[test]
fn a_refused_kept_password_needs_one_prompt_and_is_not_tried_again() {
    let h = Host::new();
    h.connect("secret").unwrap();
    h.changes();
    h.calls();
    h.script().live = false;
    h.script().reconnect.push_back(Ok(false));
    h.script().sign_on.push_back(Err(refusal(
        Status::SignOnFailed,
        "CPF1107",
        "Password or user profile is not correct.",
        "",
    )));
    let e = h.call("libl.get", json!({"name":"QSHQ400"})).unwrap_err();
    assert_eq!(e.code, codes::NEEDS_PASSWORD);
    assert_eq!(e.message, "needs_password");
    assert_eq!(e.data.as_ref().unwrap()["messageId"], "CPF1107");
    assert_eq!(h.changes(), ["stale", "connecting", "stale"]);

    // The kept password is gone: no second sign-on counts against QMAXSIGN.
    h.script().reconnect.push_back(Ok(false));
    let e = h.call("libl.get", json!({"name":"QSHQ400"})).unwrap_err();
    assert_eq!(e.code, codes::NEEDS_PASSWORD);
    assert_eq!(e.data, None);
    assert_eq!(
        h.calls(),
        ["reconnect", "sign_on CWELLMAN secret", "reconnect"]
    );

    // The prompt's answer goes through session.connect.
    h.connect("new").unwrap();
    assert_eq!(status(&h)["state"], "connected");
}

#[test]
fn a_lost_link_on_reconnect_stays_stale() {
    let h = Host::new();
    h.connect("secret").unwrap();
    h.script().live = false;
    h.script().reconnect.push_back(Err(Error::TimedOut));
    let e = h.call("libl.get", json!({"name":"QSHQ400"})).unwrap_err();
    assert_eq!(e.code, codes::TRANSPORT);
    assert_eq!(e.message, "no reply in time");
    assert_eq!(status(&h)["state"], "stale");
}

#[test]
fn disconnect_signs_off_and_forgets_the_password() {
    let h = Host::new();
    h.connect("secret").unwrap();
    h.changes();
    h.calls();
    assert_eq!(
        h.call("session.disconnect", json!({"name":"QSHQ400"}))
            .unwrap(),
        Value::Null
    );
    assert_eq!(h.calls(), ["sign_off"]);
    assert_eq!(h.changes(), ["disconnected"]);
    assert_eq!(status(&h), json!({"name":"QSHQ400","state":"disconnected"}));
    let e = h.call("libl.get", json!({"name":"QSHQ400"})).unwrap_err();
    assert_eq!(e.code, codes::NOT_CONNECTED);
    // Unknown names are fine too.
    assert_eq!(
        h.call("session.disconnect", json!({"name":"NOPE"}))
            .unwrap(),
        Value::Null
    );
}

#[test]
fn connecting_again_reuses_or_replaces_the_session() {
    let h = Host::new();
    h.connect("secret").unwrap();
    h.calls();
    h.connect("secret").unwrap();
    assert!(h.calls().is_empty(), "same endpoint and user: nothing sent");
    h.call(
        "session.connect",
        json!({"name":"QSHQ400","host":"qshq400.example","user":"QSECOFR","password":"x"}),
    )
    .unwrap();
    assert_eq!(h.calls(), ["sign_off", "sign_on QSECOFR x"]);
}

#[test]
fn libl_validates_names_before_anything() {
    let h = Host::new();
    h.connect("secret").unwrap();
    for user in [
        json!(["my lib"]),
        json!(["1ABC"]),
        json!(["ABCDEFGHIJK"]),
        json!(["A", "a"]),
    ] {
        let e = h
            .call("libl.set", json!({"name":"QSHQ400","user":user}))
            .unwrap_err();
        assert_eq!(e.code, host_rpc::codes::INVALID_PARAMS, "{user}");
    }
    assert!(h.script().libl_sets.is_empty(), "nothing sent");
    let l = h
        .call(
            "libl.set",
            json!({"name":"QSHQ400","current":"cwellman","user":["QGPL","$TOOLS","#X_1.A"]}),
        )
        .unwrap();
    assert_eq!(
        h.script().libl_sets,
        [SetLibraryList {
            current: Some("CWELLMAN".into()),
            user: vec!["QGPL".into(), "$TOOLS".into(), "#X_1.A".into()],
        }]
    );
    assert_eq!(l["current"], "CWELLMAN");
}

#[test]
fn libl_reads_and_sets_the_session_jobs_list() {
    let h = Host::new();
    h.script().libl = LibraryList {
        current: Some("CWELLMAN".into()),
        system: vec!["QSYS".into(), "QSYS2".into(), "QHLPSYS".into()],
        user: vec!["QGPL".into(), "QTEMP".into()],
    };
    h.connect("secret").unwrap();
    assert_eq!(
        h.call("libl.get", json!({"name":"QSHQ400"})).unwrap(),
        json!({"current":"CWELLMAN","system":["QSYS","QSYS2","QHLPSYS"],"user":["QGPL","QTEMP"]})
    );
    // No current library and an empty user part: CURLIB(*CRTDFT) LIBL(*NONE).
    assert_eq!(
        h.call(
            "libl.set",
            json!({"name":"QSHQ400","current":null,"user":[]})
        )
        .unwrap(),
        json!({"current":null,"system":["QSYS","QSYS2","QHLPSYS"],"user":[]})
    );
    assert_eq!(h.script().libl_sets, [SetLibraryList::default()]);

    // CHGLIBL's refusal comes back as it was sent.
    h.script().libl_refusal = Some(refusal(
        Status::NotFound,
        "CPF2110",
        "Library NOSUCH not found.",
        "Cause . . . . . :   The library was not found.",
    ));
    let e = h
        .call("libl.set", json!({"name":"QSHQ400","user":["NOSUCH"]}))
        .unwrap_err();
    assert_eq!(e.code, codes::SERVER);
    assert_eq!(e.message, "CPF2110: Library NOSUCH not found.");
    assert_eq!(
        e.data.unwrap(),
        json!({
            "status":"NotFound","messageId":"CPF2110","text":"Library NOSUCH not found.",
            "secondLevel":"Cause . . . . . :   The library was not found."
        })
    );
}

#[test]
fn below_version_8_libl_is_refused_with_the_version_agreed() {
    let h = Host::new();
    h.script().qap = Some(6);
    h.connect("secret").unwrap();
    for (method, params) in [
        ("libl.get", json!({"name":"QSHQ400"})),
        ("libl.set", json!({"name":"QSHQ400","user":["QGPL"]})),
    ] {
        let e = h.call(method, params).unwrap_err();
        assert_eq!(e.code, codes::QAP_UNAVAILABLE, "{method}");
        assert_eq!(e.message, "QAP version 8 not available on this server");
        assert_eq!(e.data, Some(json!({"version":6})));
    }
    assert!(h.script().libl_sets.is_empty(), "nothing sent");
}

#[test]
fn tls_verification_cannot_be_turned_off() {
    let h = Host::new();
    let e = h
        .call(
            "session.connect",
            json!({"name":"QSHQ400","host":"h","user":"u","password":"p","tls":{"verify":false}}),
        )
        .unwrap_err();
    assert_eq!(e.code, host_rpc::codes::INVALID_PARAMS);
    assert!(e.message.contains("tls.caFile"), "{}", e.message);
    let e = h
        .call(
            "session.connect",
            json!({"name":"QSHQ400","host":"h","user":"u","password":"p","tls":{"caFile":"/no/such/ca.pem"}}),
        )
        .unwrap_err();
    assert_eq!(e.code, host_rpc::codes::INVALID_PARAMS);
    assert!(h.changes().is_empty());
    assert!(h.calls().is_empty());
}

#[test]
fn list_and_status_of_unknown_names() {
    let h = Host::new();
    assert_eq!(h.call("session.list", Value::Null).unwrap(), json!([]));
    assert_eq!(
        h.call("session.status", json!({"name":"X"})).unwrap(),
        json!({"name":"X","state":"disconnected"})
    );
    h.connect("secret").unwrap();
    let list = h.call("session.list", Value::Null).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["state"], "connected");
}

#[test]
fn the_watcher_reports_a_close_when_woken() {
    let h = Host::new();
    h.sessions.watch();
    h.connect("secret").unwrap();
    h.changes();
    h.script().live = false;
    let wake = h.script().wake.clone().unwrap();
    wake();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut seen = Vec::new();
    while seen.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
        seen = h.changes();
    }
    assert_eq!(seen, ["stale"]);
    assert!(h.calls().iter().all(|c| c != "reconnect"), "it only looks");
}

#[test]
fn the_real_client_reports_a_refused_connection() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let h = Host::with(qap_factory(), Arc::default());
    let e = h
        .call(
            "session.connect",
            json!({"name":"QSHQ400","host":"127.0.0.1","port":port,"user":"u","password":"p"}),
        )
        .unwrap_err();
    assert_eq!(e.code, codes::TRANSPORT, "{}", e.message);
    assert_eq!(h.changes(), ["connecting", "disconnected"]);
}

#[test]
fn connect_without_a_password_resumes_a_stale_session() {
    let h = Host::new();
    let params = json!({"name":"QSHQ400","host":"qshq400.example","user":"cwellman"});
    let e = h.call("session.connect", params.clone()).unwrap_err();
    assert_eq!(e.code, codes::NEEDS_PASSWORD, "nothing to resume");
    assert!(h.calls().is_empty());

    h.connect("secret").unwrap();
    h.changes();
    h.calls();
    h.script().live = false;
    let r = h.call("session.connect", params.clone()).unwrap();
    assert_eq!(r["state"], "connected");
    assert_eq!(r["job"]["number"], "100001");
    assert_eq!(h.calls(), ["reconnect"]);
    assert_eq!(h.changes(), ["stale", "connecting", "connected"]);

    // Connected already: nothing sent.
    h.call("session.connect", params.clone()).unwrap();
    assert!(h.calls().is_empty());

    // Another user is a new sign-on, which needs a password.
    let e = h
        .call(
            "session.connect",
            json!({"name":"QSHQ400","host":"qshq400.example","user":"QSECOFR"}),
        )
        .unwrap_err();
    assert_eq!(e.code, codes::NEEDS_PASSWORD);
}
