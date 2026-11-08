// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! Scopes, variables and their parts, `evaluate` in each context, the
//! `setVariable` probe both ways, and events while a `Stack` is in flight.

mod common;

use std::time::Duration;

use common::{Client, Mock, frame, launch_call, msg, stop, var};
use dap::adapter::{NO_ASSIGNMENT, STALE};
use qap_client::DebugEvent;
use qap_client::proto::ops::debug::{DebugEnded, StopReason, View};
use serde_json::{Value, json};

/// `ASSETS` stopped at 12 with `COUNT`, `NAME` and the structure `ASSET`.
fn stopped_assets() -> (Mock, Client) {
    let mock = Mock::assets();
    {
        let mut s = mock.script();
        s.stack = vec![frame(
            "HLINV",
            "ASSETS",
            "ASSETS",
            "main",
            12,
            12,
            View::Source,
        )];
        s.variables.insert(
            String::new(),
            vec![
                var("COUNT", "int(10)", "1", false),
                var("NAME", "char(10)", "'DESK      '", false),
                var("ASSET", "ds", "", true),
            ],
        );
        s.variables.insert(
            "ASSET".into(),
            vec![
                var("ASSET.ID", "int(10)", "1", false),
                var("ASSET.TAG", "char(8)", "'        '", false),
            ],
        );
        s.evals.insert("COUNT".into(), "1".into());
        s.evals.insert("COUNT:x".into(), "00000001".into());
        s.evals.insert("NAME:c".into(), "'DESK      '".into());
    }
    let mut c = Client::new(&mock);
    launch_call(&mut c, json!({}));
    c.ok("configurationDone", json!({}));
    mock.event(stop(StopReason::Breakpoint, 12));
    c.event("stopped");
    c.ok("stackTrace", json!({ "threadId": 1 }));
    (mock, c)
}

fn locals(c: &mut Client) -> i64 {
    let s = c.ok("scopes", json!({ "frameId": 1 }));
    assert_eq!(s["scopes"].as_array().unwrap().len(), 1);
    assert_eq!(s["scopes"][0]["name"], "Locals");
    s["scopes"][0]["variablesReference"].as_i64().unwrap()
}

#[test]
fn a_frame_has_one_scope_and_structures_expand_to_their_parts() {
    let (mock, mut c) = stopped_assets();
    let r = locals(&mut c);
    let v = c.ok("variables", json!({ "variablesReference": r }));
    let vars = v["variables"].as_array().unwrap();
    let names: Vec<&str> = vars.iter().map(|v| v["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["COUNT", "NAME", "ASSET"]);
    assert_eq!(vars[0]["value"], "1");
    assert_eq!(vars[0]["type"], "int(10)");
    assert_eq!(vars[0]["variablesReference"], 0);
    let ds = vars[2]["variablesReference"].as_i64().unwrap();
    assert!(ds > 0);
    assert!(mock.calls().contains(&"Variables 0 -".to_owned()));

    let parts = c.ok("variables", json!({ "variablesReference": ds }));
    let parts = parts["variables"].as_array().unwrap();
    assert_eq!(mock.calls().last().unwrap(), "Variables 0 ASSET");
    let shown: Vec<(&str, &str)> = parts
        .iter()
        .map(|p| {
            (
                p["name"].as_str().unwrap(),
                p["evaluateName"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(shown, [("ID", "ASSET.ID"), ("TAG", "ASSET.TAG")]);
    c.close();
}

#[test]
fn the_probe_finds_no_assignment_and_set_value_is_refused() {
    let (mock, mut c) = stopped_assets();
    let r = locals(&mut c);
    c.ok("variables", json!({ "variablesReference": r }));
    // QS/400's `Eval` takes the whole text as a name: `CPF7E12`.
    assert!(mock.calls().contains(&"Eval 0 COUNT = COUNT".to_owned()));
    assert!(!c.has_event("capabilities", Duration::from_millis(100)));
    // Once per session, not per list.
    c.ok("variables", json!({ "variablesReference": r }));
    let probes = mock
        .calls()
        .iter()
        .filter(|c| c.ends_with("= COUNT"))
        .count();
    assert_eq!(probes, 1);
    let s = c.request(
        "setVariable",
        json!({ "variablesReference": r, "name": "COUNT", "value": "5" }),
    );
    assert_eq!(s["success"], false);
    assert_eq!(s["message"], NO_ASSIGNMENT);
    assert!(!mock.calls().iter().any(|c| c.contains("COUNT = 5")));
    c.close();
}

#[test]
fn the_probe_finds_an_assignment_and_set_value_is_eval() {
    let (mock, mut c) = stopped_assets();
    {
        let mut s = mock.script();
        s.evals.insert("COUNT = COUNT".into(), "COUNT = 1".into());
        s.evals.insert("ASSET.ID = 7".into(), "ASSET.ID = 7".into());
        s.evals.insert("ASSET.ID".into(), "7".into());
    }
    let r = locals(&mut c);
    let v = c.ok("variables", json!({ "variablesReference": r }));
    let caps = c.event("capabilities");
    assert_eq!(caps["body"]["capabilities"]["supportsSetVariable"], true);
    let ds = v["variables"][2]["variablesReference"].as_i64().unwrap();
    c.ok("variables", json!({ "variablesReference": ds }));
    // The part's shown name is set by its full one.
    let s = c.ok(
        "setVariable",
        json!({ "variablesReference": ds, "name": "ID", "value": " 7 " }),
    );
    assert_eq!(s["value"], "7");
    let calls = mock.calls();
    assert_eq!(
        &calls[calls.len() - 2..],
        ["Eval 0 ASSET.ID = 7", "Eval 0 ASSET.ID"]
    );
    c.close();
}

#[test]
fn evaluate_for_watch_hover_and_the_debug_console() {
    let (mock, mut c) = stopped_assets();
    let w = c.ok(
        "evaluate",
        json!({ "expression": "COUNT", "frameId": 1, "context": "watch" }),
    );
    assert_eq!(w["result"], "1");
    assert_eq!(mock.calls().last().unwrap(), "Eval 0 COUNT");
    // The forms the spec names, and `EVAL` as typed at STRDBG.
    let x = c.ok(
        "evaluate",
        json!({ "expression": "COUNT:x", "frameId": 1, "context": "repl" }),
    );
    assert_eq!(x["result"], "00000001");
    let e = c.ok(
        "evaluate",
        json!({ "expression": "eval NAME:c", "frameId": 1, "context": "repl" }),
    );
    assert_eq!(e["result"], "'DESK      '");
    assert_eq!(mock.calls().last().unwrap(), "Eval 0 NAME:c");
    // No frame named: the newest.
    c.ok(
        "evaluate",
        json!({ "expression": "COUNT", "context": "repl" }),
    );
    assert_eq!(mock.calls().last().unwrap(), "Eval 0 COUNT");

    // A hover on a word that is no variable is not shown; elsewhere it is.
    let h = c.request(
        "evaluate",
        json!({ "expression": "DCL", "frameId": 1, "context": "hover" }),
    );
    assert_eq!(h["success"], false);
    assert_eq!(h["body"]["error"]["showUser"], false);
    let r = c.request(
        "evaluate",
        json!({ "expression": "DCL", "frameId": 1, "context": "repl" }),
    );
    assert_eq!(
        r["message"],
        "CPF7E12: DCL is not a variable of the stopped entry"
    );
    assert_eq!(r["body"]["error"]["variables"]["messageId"], "CPF7E12");
    c.close();
}

#[test]
fn references_of_an_earlier_stop_are_stale() {
    let (mock, mut c) = stopped_assets();
    let r = locals(&mut c);
    c.ok("next", json!({ "threadId": 1 }));
    let v = c.request("variables", json!({ "variablesReference": r }));
    assert_eq!(v["success"], false);
    assert_eq!(v["message"], STALE);
    mock.event(stop(StopReason::Step, 13));
    c.event("stopped");
    // A new stop numbers its references afresh.
    let r2 = locals(&mut c);
    assert_eq!(r2, 1);
    c.ok("variables", json!({ "variablesReference": r2 }));
    c.close();
}

#[test]
fn events_go_out_in_order_while_a_stack_request_waits() {
    let (mock, mut c) = stopped_assets();
    let (gate_tx, gate_rx) = std::sync::mpsc::channel();
    mock.script().stack_gate = Some(gate_rx);
    let seq = c.send("stackTrace", json!({ "threadId": 1 }));
    // The worker is inside `Stack`; the events still come, in order.
    mock.event(stop(StopReason::Step, 13));
    mock.event(DebugEvent::DebugEnded(DebugEnded {
        message: Some(msg("TCP1A75", "The debugged job ended.")),
    }));
    let stopped = c.event("stopped");
    let ended = c.event("terminated");
    let at = |log: &[Value], m: &Value| log.iter().position(|l| l == m).unwrap();
    let ended_at = at(&c.log, &ended);
    assert!(at(&c.log, &stopped) < ended_at);
    assert!(
        !c.log
            .iter()
            .any(|m| m["type"] == "response" && m["request_seq"] == seq),
        "the stack answered before its reply"
    );
    gate_tx.send(()).unwrap();
    let r = c.response(seq);
    assert_eq!(r["success"], true);
    assert!(ended_at < at(&c.log, &r));
    c.close();
}
