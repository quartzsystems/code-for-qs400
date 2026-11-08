// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `attach` (`Job`) and service entry (`Own` with `SetServiceEntry`).

mod common;

use std::time::Duration;

use common::{Client, Mock, credentials, job, launch_call, refusal, stop_job};
use qap_client::Status;
use qap_client::proto::ops::debug::StopReason;
use serde_json::json;

#[test]
fn attach_starts_job_adds_programs_and_names_the_thread() {
    let mock = Mock::assets();
    let mut c = Client::new(&mock);
    c.ok("initialize", json!({ "adapterID": "qs400" }));
    let r = c.request(
        "attach",
        json!({
            "job": "654321/cwellman/qpadev0001",
            "programs": ["HLINV/ASSETS"],
            "qs400": credentials(),
        }),
    );
    assert_eq!(r["success"], true, "{r:#}");
    c.event("initialized");
    assert_eq!(
        mock.calls(),
        [
            "Start Job 654321/CWELLMAN/QPADEV0001",
            "AddProgram HLINV/ASSETS *PGM"
        ]
    );
    let t = c.event("qs400/thread");
    assert_eq!(
        t["body"],
        json!({ "threadId": 1, "job": "654321/CWELLMAN/QPADEV0001" })
    );
    let threads = c.ok("threads", json!({}));
    assert_eq!(
        threads["threads"],
        json!([{ "id": 1, "name": "654321/CWELLMAN/QPADEV0001" }])
    );
    // Nothing is called; the job runs on its own.
    c.ok("configurationDone", json!({}));
    assert!(!mock.calls().iter().any(|c| c.starts_with("RunCommand")));
    mock.event(stop_job(
        job("654321", "CWELLMAN", "QPADEV0001"),
        StopReason::Breakpoint,
        12,
    ));
    assert_eq!(c.event("stopped")["body"]["threadId"], 1);
    // Disconnect lets the job go.
    c.ok("disconnect", json!({ "terminateDebuggee": false }));
    c.close();
    let calls = mock.calls();
    assert_eq!(&calls[calls.len() - 2..], ["End", "SignOff"]);
}

#[test]
fn attach_refusals_are_the_servers() {
    for (status, id, text) in [
        (
            Status::NotFound,
            "CPF3520",
            "Job 654321/CWELLMAN/QPADEV0001 not found.",
        ),
        (
            Status::NotAuthorized,
            "CPF3502",
            "Not authorized to job 654321/OTHER/QPADEV0001.",
        ),
        (
            Status::InUse,
            "CPF3503",
            "Job 654321/CWELLMAN/QPADEV0001 already being serviced.",
        ),
        (Status::Error, "CPF3501", "Cannot service own job."),
    ] {
        let mock = Mock::assets();
        mock.script().start = Some(refusal(status, id, text));
        let mut c = Client::new(&mock);
        c.ok("initialize", json!({}));
        let r = c.request(
            "attach",
            json!({ "job": "654321/CWELLMAN/QPADEV0001", "qs400": credentials() }),
        );
        assert_eq!(r["success"], false);
        assert_eq!(r["message"], format!("{id}: {text}"));
        assert_eq!(r["body"]["error"]["showUser"], true);
        c.close();
    }
    // Not a qualified job name: nothing is sent, nothing signs on.
    let mock = Mock::assets();
    let mut c = Client::new(&mock);
    let r = c.request(
        "attach",
        json!({ "job": "QPADEV0001", "qs400": credentials() }),
    );
    assert_eq!(r["success"], false);
    assert!(c.signed_on.lock().unwrap().is_empty());
    c.close();
}

#[test]
fn a_program_that_will_not_go_under_debug_does_not_stop_an_attach() {
    let mock = Mock::assets();
    let mut c = Client::new(&mock);
    c.ok("initialize", json!({}));
    let r = c.request(
        "attach",
        json!({
            "job": "654321/CWELLMAN/QPADEV0001",
            "programs": ["HLINV/NOSUCH", "HLINV/ASSETS"],
            "qs400": credentials(),
        }),
    );
    assert_eq!(r["success"], true);
    assert!(
        c.console(Duration::from_millis(50))
            .iter()
            .any(|l| l.starts_with("HLINV/NOSUCH not under debug: CPF9801"))
    );
    c.close();
}

#[test]
fn service_entry_sets_the_entry_after_the_breakpoints_and_binds_the_job_that_stops() {
    let mock = Mock::assets();
    let mut c = Client::new(&mock);
    let r = launch_call(
        &mut c,
        json!({ "mode": "serviceEntry", "user": "*current", "command": null }),
    );
    assert_eq!(r["success"], true, "{r:#}");
    // No thread until a job calls the program.
    assert_eq!(c.ok("threads", json!({}))["threads"], json!([]));
    c.ok(
        "setBreakpoints",
        json!({ "source": { "path": common::ASSETS_MEMBER }, "breakpoints": [{ "line": 12 }] }),
    );
    c.ok("configurationDone", json!({}));
    assert_eq!(
        mock.calls(),
        [
            "Start Own",
            "AddProgram HLINV/ASSETS *PGM",
            "SetBreakpoints HLINV/ASSETS ASSETS [12]",
            "SetServiceEntry HLINV/ASSETS *CURRENT",
        ]
    );
    // CALL HLINV/ASSETS at a 5250 session: the entry attaches that job.
    let display = job("777777", "CWELLMAN", "QPADEV0004");
    mock.event(stop_job(display.clone(), StopReason::ServiceEntry, 9));
    let t = c.event("qs400/thread");
    assert_eq!(t["body"]["job"], "777777/CWELLMAN/QPADEV0004");
    let s = c.event("stopped");
    assert_eq!(s["body"]["reason"], "entry");
    assert_eq!(s["body"]["threadId"], 1);
    assert_eq!(
        c.ok("threads", json!({}))["threads"],
        json!([{ "id": 1, "name": "777777/CWELLMAN/QPADEV0004" }])
    );
    // A later stop of the same job is the same thread, with no new name.
    c.ok("continue", json!({ "threadId": 1 }));
    mock.event(stop_job(display, StopReason::Breakpoint, 12));
    assert_eq!(c.event("stopped")["body"]["threadId"], 1);
    let lines = c.console(Duration::from_millis(50));
    assert!(lines.contains(&"Waiting for a job of *CURRENT to call HLINV/ASSETS.".to_owned()));
    assert!(
        lines.contains(&"Service entry: 777777/CWELLMAN/QPADEV0004 called HLINV/ASSETS".to_owned())
    );
    assert_eq!(
        c.log
            .iter()
            .filter(|m| m["event"] == "qs400/thread")
            .count(),
        1
    );
    // The end removes the entry first.
    c.ok("disconnect", json!({}));
    c.close();
    let calls = mock.calls();
    assert_eq!(
        &calls[calls.len() - 3..],
        ["RemoveServiceEntry HLINV/ASSETS", "End", "SignOff"]
    );
}

#[test]
fn a_service_entry_for_another_users_jobs_is_the_servers_refusal() {
    let mock = Mock::assets();
    let mut c = Client::new(&mock);
    launch_call(
        &mut c,
        json!({ "mode": "serviceEntry", "user": "OTHER", "command": null }),
    );
    // The user is passed as typed; the server checks *SERVICE (TCP1A74).
    c.ok("configurationDone", json!({}));
    assert_eq!(
        mock.calls().last().unwrap(),
        "SetServiceEntry HLINV/ASSETS OTHER"
    );
    c.close();
}
