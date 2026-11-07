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
        "qs400-code-host 1.0.0 (QS/400 V1R0M0, QAP v1)"
    );
}

#[test]
fn lsp_and_dap_not_implemented() {
    for args in [&["lsp", "rpgle"][..], &["dap"][..]] {
        let out = Command::new(BIN).args(args).output().unwrap();
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("not implemented in this release"),
            "{args:?}"
        );
    }
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
        json!({"host":"1.0.0","product":"V1R0M0","qap":1})
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
