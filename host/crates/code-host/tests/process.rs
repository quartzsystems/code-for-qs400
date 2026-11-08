// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! Runs the real `qs400-code-host` binary.

use host_rpc::framing::{read_frame, write_frame};
use serde_json::{Value, json};
use std::io::{BufReader, Write};
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_qs400-code-host");

#[test]
fn version_flag() {
    let out = Command::new(BIN).arg("--version").output().unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap().trim_end(),
        "qs400-code-host 1.0.0 (QS/400 V1R0M0, QAP v9)"
    );
}

/// The debug adapter: `initialize`, a `launch` whose sign-on cannot reach
/// a closed port, `disconnect`, and exit 0. The password goes in the
/// arguments, never on the command line.
#[test]
fn dap_initializes_refuses_an_unreachable_launch_and_exits() {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut child = Command::new(BIN)
        .arg("dap")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut send = |v: Value| {
        write_frame(&mut stdin, &serde_json::to_vec(&v).unwrap()).unwrap();
        stdin.flush().unwrap();
    };
    let reply = |r: &mut BufReader<_>, seq: i64| until(r, |v| v["request_seq"] == json!(seq));
    send(
        json!({"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"qs400"}}),
    );
    let init = reply(&mut stdout, 1);
    assert_eq!(init["success"], json!(true));
    assert_eq!(init["body"]["supportsConditionalBreakpoints"], json!(true));
    send(
        json!({"seq":2,"type":"request","command":"launch","arguments":{
            "program": "HLINV/ASSETS",
            "qs400": { "host": "127.0.0.1", "port": port, "user": "CWELLMAN", "password": "x" }
        }}),
    );
    let launch = reply(&mut stdout, 2);
    assert_eq!(launch["success"], json!(false), "{launch}");
    assert_eq!(launch["body"]["error"]["showUser"], json!(true));
    send(json!({"seq":3,"type":"request","command":"disconnect","arguments":{}}));
    assert_eq!(reply(&mut stdout, 3)["success"], json!(true));
    assert_eq!(child.wait().unwrap().code(), Some(0));
}

#[test]
fn lsp_of_an_unknown_language() {
    let out = Command::new(BIN).args(["lsp", "cobol"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("no language server for \"cobol\""));
}

/// Reads LSP frames until one `pick` takes.
fn until(reader: &mut impl std::io::BufRead, pick: impl Fn(&Value) -> bool) -> Value {
    loop {
        let body = read_frame(reader).unwrap().expect("server closed stdout");
        let v: Value = serde_json::from_slice(&body).unwrap();
        if pick(&v) {
            return v;
        }
    }
}

#[test]
fn lsp_rpgle_publishes_and_exits() {
    let mut child = Command::new(BIN)
        .args(["lsp", "rpgle"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut send = |v: Value| {
        write_frame(&mut stdin, &serde_json::to_vec(&v).unwrap()).unwrap();
        stdin.flush().unwrap();
    };
    send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}));
    let init = until(&mut stdout, |v| v["id"] == json!(1));
    assert_eq!(init["result"]["capabilities"]["textDocumentSync"], json!(1));
    send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
    let uri = "qs400mbr://qshq400/QTEMP/QRPGLESRC/T.rpgle";
    send(
        json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{
        "uri": uri, "languageId": "qs400-rpgle", "version": 1,
        "text": "     C                   FOOBAR\n"}}}),
    );
    let p = until(&mut stdout, |v| {
        v["method"] == json!("textDocument/publishDiagnostics")
    });
    assert_eq!(p["params"]["uri"], json!(uri));
    let ids: Vec<&str> = p["params"]["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|d| d["code"].as_str())
        .collect();
    assert_eq!(ids, ["RNF5014"], "{p}");
    send(json!({"jsonrpc":"2.0","id":2,"method":"shutdown"}));
    let _ = until(&mut stdout, |v| v["id"] == json!(2));
    send(json!({"jsonrpc":"2.0","method":"exit"}));
    assert_eq!(child.wait().unwrap().code(), Some(0));
}

/// Reads frames until a response with `id`, skipping notifications.
fn response(reader: &mut impl std::io::BufRead, id: i64) -> Value {
    loop {
        let body = read_frame(reader).unwrap().expect("host closed stdout");
        let v: Value = serde_json::from_slice(&body).unwrap();
        if v.get("id") == Some(&json!(id)) {
            return v;
        }
        assert_eq!(v["method"], json!("host.log"), "unexpected frame {v}");
    }
}

fn serve_session(args: &[&str]) {
    let mut child = Command::new(BIN)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut send = |v: Value| {
        write_frame(&mut stdin, &serde_json::to_vec(&v).unwrap()).unwrap();
        stdin.flush().unwrap();
    };

    send(json!({"jsonrpc":"2.0","id":1,"method":"host.version"}));
    assert_eq!(
        response(&mut stdout, 1)["result"],
        json!({"host":"1.0.0","product":"V1R0M0","qap":9})
    );
    send(json!({"jsonrpc":"2.0","id":2,"method":"host.ping","params":{"nonce":"n-42"}}));
    assert_eq!(response(&mut stdout, 2)["result"], json!({"nonce":"n-42"}));
    send(json!({"jsonrpc":"2.0","id":3,"method":"host.shutdown"}));
    assert_eq!(response(&mut stdout, 3)["result"], Value::Null);

    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
}

#[test]
fn serve_explicit() {
    serve_session(&["serve"]);
}

#[test]
fn serve_is_default() {
    serve_session(&[]);
}

#[test]
fn stdin_close_exits_cleanly() {
    let mut child = Command::new(BIN)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(child.stdin.take());
    assert_eq!(child.wait().unwrap().code(), Some(0));
}
