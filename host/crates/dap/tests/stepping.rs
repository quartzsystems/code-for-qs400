// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! Breakpoints, plain, moved and conditional; the sources they are set
//! from; stepping; `pause`; `terminate`.

mod common;

use std::time::Duration;

use common::{ASSETS_MEMBER, Client, Mock, frame, launch_call, module, msg, refusal, stop};
use dap::adapter::{NO_PAUSE, NO_SOURCE_VIEW, NOT_UNDER_DEBUG, path_key};
use qap_client::proto::ops::debug::{StopReason, View};
use qap_client::{CommandOutcome, Status};
use serde_json::json;

#[test]
fn breakpoints_go_to_the_module_their_source_was_compiled_into() {
    let mock = Mock::assets();
    mock.script().moves.insert(11, 12);
    let mut c = Client::new(&mock);
    launch_call(&mut c, json!({}));
    assert_eq!(c.asked, ["HLINV/ASSETS/ASSETS"]);
    // The writable member, in another case: the same source.
    let r = c.ok(
        "setBreakpoints",
        json!({
            "source": { "path": "qs400mbr://qshq400/HLINV/QRPGLESRC/ASSETS.rpgle" },
            "breakpoints": [
                { "line": 9 },
                { "line": 11 },
                { "line": 13, "condition": " ASSETCOUNT > 3 " }
            ],
        }),
    );
    assert_eq!(
        mock.calls().last().unwrap(),
        "SetBreakpoints HLINV/ASSETS ASSETS [9, 11, 13 if ASSETCOUNT > 3]"
    );
    let bs = r["breakpoints"].as_array().unwrap();
    assert!(bs.iter().all(|b| b["verified"] == true));
    // 11 starts no statement: it landed on 12, which moves it in the editor.
    let lines: Vec<u64> = bs.iter().map(|b| b["line"].as_u64().unwrap()).collect();
    assert_eq!(lines, [9, 12, 13]);

    // An empty list removes the module's breakpoints.
    c.ok(
        "setBreakpoints",
        json!({ "source": { "path": ASSETS_MEMBER }, "breakpoints": [] }),
    );
    assert_eq!(
        mock.calls().last().unwrap(),
        "SetBreakpoints HLINV/ASSETS ASSETS []"
    );
    c.close();
}

#[test]
fn a_conditional_breakpoint_stops_only_when_the_server_says() {
    let mock = Mock::assets();
    let mut c = Client::new(&mock);
    launch_call(&mut c, json!({}));
    c.ok(
        "setBreakpoints",
        json!({
            "source": { "path": ASSETS_MEMBER },
            "breakpoints": [{ "line": 10, "condition": "ASSETCOUNT > 3" }],
        }),
    );
    c.ok("configurationDone", json!({}));
    // The condition is the server's to evaluate; the adapter only passes
    // the stop on.
    assert!(!c.has_event("stopped", Duration::from_millis(100)));
    mock.event(stop(StopReason::Breakpoint, 10));
    assert_eq!(c.event("stopped")["body"]["reason"], "breakpoint");
    c.close();
}

#[test]
fn a_refused_breakpoint_changes_nothing_and_says_why() {
    let mock = Mock::assets();
    mock.script().breakpoints_error = Some(refusal(
        Status::Error,
        "CPF9C59",
        "Condition ASSETCOUNT >> 3 is not valid.",
    ));
    let mut c = Client::new(&mock);
    launch_call(&mut c, json!({}));
    let r = c.ok(
        "setBreakpoints",
        json!({
            "source": { "path": ASSETS_MEMBER },
            "breakpoints": [{ "line": 9 }, { "line": 13, "condition": "ASSETCOUNT >> 3" }],
        }),
    );
    for b in r["breakpoints"].as_array().unwrap() {
        assert_eq!(b["verified"], false);
        assert_eq!(
            b["message"],
            "CPF9C59: Condition ASSETCOUNT >> 3 is not valid."
        );
    }
    c.close();
}

#[test]
fn breakpoints_where_no_source_view_or_no_program_is() {
    let mock = Mock::assets();
    mock.script().programs.insert(
        "HLINV/ASSETSTMT *PGM".into(),
        Ok(vec![module("ASSETSTMT", &[View::Statement])]),
    );
    let mut c = Client::new(&mock);
    launch_call(&mut c, json!({ "programs": ["HLINV/ASSETSTMT"] }));
    // No source view: nothing asked.
    assert_eq!(c.asked, ["HLINV/ASSETS/ASSETS"]);
    let before = mock.calls().len();
    let r = c.ok(
        "setBreakpoints",
        json!({
            "source": { "path": "qs400dbg:/HLINV/ASSETSTMT/ASSETSTMT" },
            "breakpoints": [{ "line": 4 }],
        }),
    );
    assert_eq!(r["breakpoints"][0]["verified"], false);
    assert_eq!(r["breakpoints"][0]["message"], NO_SOURCE_VIEW);
    let r = c.ok(
        "setBreakpoints",
        json!({ "source": { "path": "c:\\src\\OTHER.rpgle" }, "breakpoints": [{ "line": 4 }] }),
    );
    assert_eq!(r["breakpoints"][0]["message"], NOT_UNDER_DEBUG);
    assert_eq!(mock.calls().len(), before, "nothing sent");
    c.close();
}

#[test]
fn stepping_is_resume_and_pause_is_refused() {
    let mock = Mock::assets();
    let mut c = Client::new(&mock);
    launch_call(&mut c, json!({}));
    c.ok("configurationDone", json!({}));
    mock.event(stop(StopReason::Breakpoint, 9));
    c.event("stopped");
    let body = c.ok("continue", json!({ "threadId": 1 }));
    assert_eq!(body["allThreadsContinued"], true);
    c.ok("next", json!({ "threadId": 1 }));
    c.ok("stepIn", json!({ "threadId": 1 }));
    c.ok("stepOut", json!({ "threadId": 1 }));
    let resumes: Vec<String> = mock
        .calls()
        .into_iter()
        .filter(|c| c.starts_with("Resume"))
        .collect();
    assert_eq!(
        resumes,
        [
            "Resume Go",
            "Resume StepOver",
            "Resume StepInto",
            "Resume StepOut"
        ]
    );
    mock.event(stop(StopReason::Step, 10));
    assert_eq!(c.event("stopped")["body"]["reason"], "step");

    let r = c.request("pause", json!({ "threadId": 1 }));
    assert_eq!(r["success"], false);
    assert_eq!(r["message"], NO_PAUSE);

    // The server's own refusal, as sent.
    mock.script().resume_error = Some(refusal(Status::Error, "CPD9CCC", "No job is stopped."));
    let r = c.request("next", json!({ "threadId": 1 }));
    assert_eq!(r["message"], "CPD9CCC: No job is stopped.");
    c.close();
}

#[test]
fn terminate_cancels_the_call_and_ends_the_session() {
    let mock = Mock::assets();
    let (call_tx, call_rx) = std::sync::mpsc::channel();
    mock.script().call = Some(call_rx);
    let mut c = Client::new(&mock);
    launch_call(&mut c, json!({}));
    c.ok("configurationDone", json!({}));
    // The cancelled CALL answers `Cancelled` once the server has the cancel.
    let m = mock.clone();
    std::thread::spawn(move || {
        while !m.script().cancelled {
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = call_tx.send(Ok(CommandOutcome {
            status: Status::Cancelled,
            escape: Some(msg("CPF1907", "End request was received.")),
            job: None,
            messages: Vec::new(),
        }));
    });
    c.ok("terminate", json!({}));
    c.event("terminated");
    let calls = mock.calls();
    let tail: Vec<&str> = calls[calls.len() - 3..]
        .iter()
        .map(String::as_str)
        .collect();
    assert_eq!(tail, ["Cancel", "End", "SignOff"]);
    c.ok("disconnect", json!({}));
    c.close();
}

#[test]
fn frames_stand_on_the_source_the_extension_named() {
    let mock = Mock::assets();
    mock.script().stack = vec![
        frame("HLINV", "ASSETS", "ASSETS", "main", 12, 12, View::Source),
        // A line the server does not know: the statement, on the synthetic one.
        frame("HLINV", "ASSETS", "ASSETS", "main", 10, 0, View::Source),
        // A module the extension knows no source for.
        frame("HLINV", "ASSETSRV", "ASSETSRV", "count", 4, 4, View::Source),
    ];
    let mut c = Client::new(&mock);
    c.source("HLINV/ASSETSRV/ASSETSRV", None);
    launch_call(&mut c, json!({}));
    c.ok("configurationDone", json!({}));
    mock.event(stop(StopReason::Breakpoint, 12));
    c.event("stopped");
    let st = c.ok("stackTrace", json!({ "threadId": 1 }));
    let f = &st["stackFrames"];
    assert_eq!(f[0]["source"]["path"], ASSETS_MEMBER);
    assert_eq!(f[0]["line"], 12);
    assert_eq!(f[1]["source"]["path"], "qs400dbg:/HLINV/ASSETS/ASSETS");
    assert_eq!(f[1]["line"], 10);
    assert_eq!(f[2]["source"]["path"], "qs400dbg:/HLINV/ASSETSRV/ASSETSRV");
    assert_eq!(f[2]["line"], 4);
    // Asked once per module, however many frames or stops.
    c.ok("stackTrace", json!({ "threadId": 1 }));
    assert_eq!(c.asked, ["HLINV/ASSETS/ASSETS", "HLINV/ASSETSRV/ASSETSRV"]);
    c.close();
}

#[test]
fn an_unanswered_ask_falls_back_to_the_synthetic_source() {
    let mock = Mock::assets();
    mock.script().stack = vec![frame(
        "HLINV",
        "ASSETS",
        "ASSETS",
        "main",
        12,
        12,
        View::Source,
    )];
    for answer in [Some(""), None] {
        let mut c = Client::new(&mock);
        match answer {
            // The extension knows nothing of it.
            Some(p) => c.source("HLINV/ASSETS/ASSETS", Some(p)),
            // The extension never answers: the ask times out.
            None => c.unanswered("HLINV/ASSETS/ASSETS"),
        }
        launch_call(&mut c, json!({}));
        c.ok("configurationDone", json!({}));
        mock.event(stop(StopReason::Breakpoint, 12));
        c.event("stopped");
        let st = c.ok("stackTrace", json!({ "threadId": 1 }));
        assert_eq!(
            st["stackFrames"][0]["source"]["path"],
            "qs400dbg:/HLINV/ASSETS/ASSETS"
        );
        c.close();
    }
}

#[test]
fn source_paths_compare_as_the_same_document() {
    assert_eq!(
        path_key("qs400mbr://qshq400/HLINV/QRPGLESRC/ASSETS.rpgle?readonly"),
        path_key("qs400mbr://QSHQ400/HLINV/QRPGLESRC/ASSETS.rpgle")
    );
    assert_eq!(
        path_key("qs400mbr://qshq400/HLINV/QRPGLESRC/%24ASSETS.rpgle"),
        path_key("qs400mbr://qshq400/HLINV/QRPGLESRC/$ASSETS.rpgle?readonly")
    );
    assert_eq!(
        path_key("C:\\src\\QRPGLESRC\\ASSETS.rpgle"),
        "c:/src/qrpglesrc/assets.rpgle"
    );
    // A drive is not a scheme: nothing after a `?` is dropped from a path.
    assert_eq!(path_key("c:\\a?b"), "c:/a?b");
}
