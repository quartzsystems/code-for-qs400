// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The CL server's features on one source.

use lsp_cl::Cl;
use lsp_common::testing::Client;
use lsp_types::NumberOrString;
use serde_json::{Value, json};
use std::time::Duration;

const URI: &str = "qs400mbr://qshq400/HLINV/QCLSRC/T.clle";
const SOURCE: &str = "             PGM        PARM(&LIB)
             DCL        VAR(&LIB) TYPE(*CHAR) LEN(10)
             DCL        VAR(&N) TYPE(*DEC) LEN(5 0)
             IF         COND(&N *EQ 0) THEN(DO)
                CHGVAR     VAR(&N) +
                             VALUE(1)
             ENDDO
 LOOP:       CHGVAR     VAR(&X) VALUE(2)
             GOTO       CMDLBL(LOOP)
             SUBR       SUBR(S1)
             ENDSUBR
             ENDPGM
";

fn pos(line: u32, character: u32) -> Value {
    json!({ "textDocument": { "uri": URI }, "position": { "line": line, "character": character } })
}

fn ranges(v: &Value) -> Vec<(u64, u64)> {
    let mut r: Vec<(u64, u64)> = v
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
    r.sort_unstable();
    r
}

#[test]
fn cl_features() {
    let mut c = Client::start(Cl, Duration::from_millis(20));
    c.open(URI, "qs400-cl", SOURCE);
    let d = c.diagnostics(URI);
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].range.start.line, 7);
    assert_eq!(d[0].code, Some(NumberOrString::String("CPD0727".into())));
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
    assert_eq!(names, ["LIB", "N", "LOOP", "S1"]);
    // &N on line 4 (from 0) to its DCL on line 2.
    let def = c.request("textDocument/definition", pos(4, 33));
    assert_eq!(def["range"]["start"]["line"], json!(2));
    // The DCL and its two uses.
    let mut p = pos(2, 30);
    p["newName"] = json!("COUNT");
    let e = c.request("textDocument/rename", p);
    assert_eq!(e["changes"][URI].as_array().unwrap().len(), 3, "{e}");
    let f = c.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": URI } }),
    );
    assert_eq!(ranges(&f), [(0, 11), (3, 6), (9, 10)]);
    let w = c.request("textDocument/completion", pos(5, 0));
    assert!(
        w.as_array()
            .unwrap()
            .iter()
            .any(|i| i["label"] == json!("%SST"))
    );
    c.stop();
}
