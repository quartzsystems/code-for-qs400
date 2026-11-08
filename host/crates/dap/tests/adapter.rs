// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The DAP ↔ QAP mapping, one request or event at a time, against a canned
//! `DebugBackend`.

mod common;

use std::time::Duration;

use common::{Client, Mock, frame, job, launch_call, msg, refusal};
use dap::Failure;
use dap::backend::QAP_UNAVAILABLE;
use qap_client::proto::ops::debug::{DebugEnded, StopReason, Stopped, View};
use qap_client::{CommandOutcome, DebugEvent, Status};
use serde_json::json;

fn stopped(reason: StopReason, stmt: u32) -> DebugEvent {
    DebugEvent::Stopped(Stopped {
        job: job("123456", "QUSER", "QAPCNN"),
        reason,
        frame: frame(
            "HLINV",
            "ASSETS",
            "ASSETS",
            "ASSETS",
            stmt,
            stmt,
            View::Source,
        ),
    })
}

#[test]
fn initialize_advertises_only_what_the_service_does() {
    let mut c = Client::new(&Mock::assets());
    let caps = c.ok("initialize", json!({ "adapterID": "qs400" }));
    assert_eq!(caps["supportsConfigurationDoneRequest"], true);
    assert_eq!(caps["supportsConditionalBreakpoints"], true);
    assert_eq!(caps["supportsEvaluateForHovers"], true);
    assert_eq!(caps["supportsTerminateRequest"], true);
    // Until the probe says otherwise.
    assert_eq!(caps["supportsSetVariable"], false);
    assert_eq!(caps["supportsFunctionBreakpoints"], false);
    assert_eq!(caps["supportsStepBack"], false);
    assert_eq!(caps["supportsRestartRequest"], false);
    c.close();
}

#[test]
fn call_starts_own_adds_programs_and_runs_the_call_at_configuration_done() {
    let mock = Mock::assets();
    let (call_tx, call_rx) = std::sync::mpsc::channel();
    mock.script().call = Some(call_rx);
    mock.script().programs.insert(
        "HLINV/ASSETSRV *SRVPGM".into(),
        Ok(vec![common::module("ASSETSRV", &[View::Source])]),
    );
    let mut c = Client::new(&mock);
    let r = launch_call(&mut c, json!({ "programs": ["HLINV/ASSETSRV"] }));
    assert_eq!(r["success"], true, "{r:#}");
    c.event("initialized");
    assert_eq!(
        c.signed_on.lock().unwrap().as_slice(),
        ["CWELLMAN:secret@qshq400"]
    );
    // `*PGM` first; `NotFound` there, then `*SRVPGM`.
    assert_eq!(
        mock.calls(),
        [
            "Start Own",
            "AddProgram HLINV/ASSETS *PGM",
            "AddProgram HLINV/ASSETSRV *PGM",
            "AddProgram HLINV/ASSETSRV *SRVPGM",
        ]
    );
    // Nothing runs before the configuration is done.
    c.ok("configurationDone", json!({}));
    assert_eq!(
        mock.calls().last().unwrap(),
        "RunCommand CALL PGM(HLINV/ASSETS)"
    );

    let threads = c.ok("threads", json!({}));
    assert_eq!(
        threads["threads"],
        json!([{ "id": 1, "name": "123456/QUSER/QAPCNN" }])
    );

    // The program ends: its messages, the outcome, and the end.
    call_tx
        .send(Ok(CommandOutcome {
            status: Status::Ok,
            escape: None,
            job: Some(job("123456", "QUSER", "QAPCNN")),
            messages: vec![msg("CPC2191", "Assets counted: 4.")],
        }))
        .unwrap();
    c.event("terminated");
    let lines = c.console(Duration::from_millis(50));
    assert_eq!(
        lines,
        [
            "CPC2191: Assets counted: 4.",
            "CALL PGM(HLINV/ASSETS) ended: Ok"
        ]
    );
    c.ok("disconnect", json!({}));
    c.close();
    let calls = mock.calls();
    assert_eq!(&calls[calls.len() - 2..], ["End", "SignOff"]);
    assert!(!calls.contains(&"Cancel".to_owned()));
}

#[test]
fn a_stop_is_a_stopped_event_and_the_stack_stands_on_the_synthetic_source() {
    let mock = Mock::assets();
    mock.script().stack = vec![
        frame("HLINV", "ASSETS", "ASSETS", "main", 12, 0, View::Statement),
        frame("QSYS", "QCMD", "", "", 0, 0, View::Statement),
    ];
    let mut c = Client::new(&mock);
    launch_call(&mut c, json!({}));
    c.ok("configurationDone", json!({}));
    mock.event(stopped(StopReason::Breakpoint, 12));
    let ev = c.event("stopped");
    assert_eq!(ev["body"]["reason"], "breakpoint");
    assert_eq!(ev["body"]["threadId"], 1);
    assert_eq!(ev["body"]["allThreadsStopped"], true);

    let st = c.ok("stackTrace", json!({ "threadId": 1 }));
    assert_eq!(st["totalFrames"], 2);
    let f = &st["stackFrames"][0];
    assert_eq!(f["id"], 1);
    assert_eq!(f["name"], "ASSETS › ASSETS › main · stmt 12");
    assert_eq!(f["source"]["path"], "qs400dbg:/HLINV/ASSETS/ASSETS");
    assert_eq!(f["line"], 12);
    // A frame with no statement has nowhere to stand.
    let q = &st["stackFrames"][1];
    assert_eq!(q["name"], "QCMD · stmt 0");
    assert!(q.get("source").is_none());
    assert_eq!(q["line"], 0);
    assert_eq!(q["presentationHint"], "subtle");

    // levels and startFrame page the stack.
    let page = c.ok(
        "stackTrace",
        json!({ "threadId": 1, "startFrame": 1, "levels": 1 }),
    );
    assert_eq!(page["stackFrames"].as_array().unwrap().len(), 1);
    assert_eq!(page["stackFrames"][0]["id"], 2);
    c.close();
}

#[test]
fn no_debug_data_fails_the_launch_with_the_servers_text_and_ends_the_session() {
    let mock = Mock::assets();
    mock.script().programs.insert(
        "HLINV/ASSETS *PGM".into(),
        Err(refusal(
            Status::Error,
            "CPF9C15",
            "Program ASSETS in library HLINV has no debug data.",
        )),
    );
    let mut c = Client::new(&mock);
    let r = launch_call(&mut c, json!({}));
    assert_eq!(r["success"], false);
    assert_eq!(
        r["message"],
        "CPF9C15: Program ASSETS in library HLINV has no debug data."
    );
    assert_eq!(r["body"]["error"]["variables"]["messageId"], "CPF9C15");
    assert_eq!(r["body"]["error"]["showUser"], true);
    assert_eq!(
        mock.calls(),
        [
            "Start Own",
            "AddProgram HLINV/ASSETS *PGM",
            "End",
            "SignOff"
        ]
    );
    c.close();

    // With the extension's recompile offer, VS Code does not show it too.
    let mut c = Client::new(&mock);
    let r = launch_call(&mut c, json!({ "recompileOffer": true }));
    assert_eq!(r["body"]["error"]["showUser"], false);
    assert_eq!(r["body"]["error"]["variables"]["messageId"], "CPF9C15");
    c.close();
}

#[test]
fn a_second_session_on_the_connection_is_the_servers_tcp1a72() {
    let mock = Mock::assets();
    mock.script().start = Some(refusal(
        Status::InUse,
        "TCP1A72",
        "A debug session is already active on this connection.",
    ));
    let mut c = Client::new(&mock);
    let r = launch_call(&mut c, json!({}));
    assert_eq!(r["success"], false);
    assert_eq!(
        r["message"],
        "TCP1A72: A debug session is already active on this connection."
    );
    assert_eq!(r["body"]["error"]["showUser"], true);
    // Nothing else is sent.
    assert_eq!(mock.calls(), ["Start Own", "End", "SignOff"]);
    c.close();
}

#[test]
fn a_server_below_version_9_is_refused_before_anything_is_sent() {
    let mock = Mock::assets();
    let mut c = Client::with(&mock, Some(Failure::new(QAP_UNAVAILABLE)));
    let r = launch_call(&mut c, json!({}));
    assert_eq!(r["success"], false);
    assert_eq!(r["message"], "QAP version 9 not available on this server");
    assert!(mock.calls().is_empty());
    c.close();
}

#[test]
fn debug_ended_is_terminated_with_its_message() {
    let mock = Mock::assets();
    let mut c = Client::new(&mock);
    launch_call(&mut c, json!({}));
    c.ok("configurationDone", json!({}));
    mock.event(DebugEvent::DebugEnded(DebugEnded {
        message: Some(msg("TCP1A75", "The debugged job ended.")),
    }));
    c.event("terminated");
    assert!(
        c.console(Duration::from_millis(50))
            .contains(&"TCP1A75: The debugged job ended.".to_owned())
    );
    c.close();
}

#[test]
fn the_connection_closing_ends_the_session() {
    let mock = Mock::assets();
    let mut c = Client::new(&mock);
    launch_call(&mut c, json!({}));
    mock.close_events();
    c.event("terminated");
    assert!(
        c.console(Duration::from_millis(50))
            .contains(&"The debug session ended: its connection closed.".to_owned())
    );
    c.close();
}

#[test]
fn exception_and_program_end_stops() {
    let mock = Mock::assets();
    let mut c = Client::new(&mock);
    launch_call(&mut c, json!({}));
    c.ok("configurationDone", json!({}));
    mock.event(stopped(
        StopReason::Exception {
            message: msg(
                "MCH1211",
                "Attempt made to divide by zero for fixed point operation.",
            ),
        },
        13,
    ));
    let ev = c.event("stopped");
    assert_eq!(ev["body"]["reason"], "exception");
    assert_eq!(
        ev["body"]["text"],
        "MCH1211: Attempt made to divide by zero for fixed point operation."
    );
    mock.event(stopped(StopReason::ProgramEnd, 14));
    c.event("terminated");
    assert!(
        c.console(Duration::from_millis(50))
            .contains(&"ProgramEnd: HLINV/ASSETS ended".to_owned())
    );
    c.close();
}

#[test]
fn pause_and_the_unknown_are_refused() {
    let mut c = Client::new(&Mock::assets());
    let r = c.request("goto", json!({}));
    assert_eq!(r["success"], false);
    c.close();
}
