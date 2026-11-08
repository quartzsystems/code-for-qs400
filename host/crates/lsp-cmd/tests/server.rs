// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The command definition server's features on one source.

use lsp_cmd::Cmd;
use lsp_common::testing::Client;
use lsp_types::NumberOrString;
use serde_json::json;
use std::time::Duration;

const URI: &str = "qs400mbr://qshq400/HLINV/QCMDSRC/DOIT.cmd";
const SOURCE: &str = "             CMD        PROMPT('Do it')
             PARM       KWD(FILE) TYPE(QUAL) +
                          MIN(1)
QUAL:        QUAL       TYPE(*NAME) LEN(10)
             QUAL       TYPE(*NAME) LEN(10) DFT(*LIBL)
             PARM       KWD(BAD) TYPE(*CHAR) FOOBAR(1)
";

#[test]
fn cmd_features() {
    let mut c = Client::start(Cmd, Duration::from_millis(20));
    c.open(URI, "qs400-cmd", SOURCE);
    let d = c.diagnostics(URI);
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].range.start.line, 5);
    assert_eq!(d[0].code, Some(NumberOrString::String("CPD0242".into())));
    let s = c.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": URI } }),
    );
    let names: Vec<&str> = s
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap())
        .collect();
    // The command takes the member's name.
    assert_eq!(names, ["DOIT", "FILE", "QUAL", "BAD"]);
    let def = c.request(
        "textDocument/definition",
        json!({ "textDocument": { "uri": URI }, "position": { "line": 1, "character": 41 } }),
    );
    assert_eq!(def["range"]["start"]["line"], json!(3));
    let f = c.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": URI } }),
    );
    let r: Vec<(u64, u64)> = f
        .as_array()
        .unwrap()
        .iter()
        .map(|x| {
            (
                x["startLine"].as_u64().unwrap(),
                x["endLine"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(r, [(1, 2)]);
    c.stop();
}
