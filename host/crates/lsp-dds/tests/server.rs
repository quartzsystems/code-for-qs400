// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The DDS server's features: a PF, and a DSPF it does not analyze.

use lsp_common::testing::Client;
use lsp_dds::Dds;
use lsp_types::NumberOrString;
use serde_json::json;
use std::time::Duration;

const PF: &str = "qs400mbr://qshq400/HLINV/QDDSSRC/ITEMMST.pf";
const SOURCE: &str = "     A          R ITEMR                     TEXT('Item')
     A            ITEMNO        15A         COLHDG('Item')
     A            QTY            7P 0
     A          K ITEMNO
     A          R OTHERR
     A            X              1A
";

#[test]
fn a_physical_file() {
    let mut c = Client::start(Dds, Duration::from_millis(20));
    c.open(PF, "qs400-dds", SOURCE);
    let d = c.diagnostics(PF);
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].range.start.line, 4);
    assert_eq!(d[0].code, Some(NumberOrString::String("DDS1002".into())));
    // Fields under their record format.
    let s = c.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": PF } }),
    );
    assert_eq!(s[0]["name"], json!("ITEMR"));
    let kids: Vec<&str> = s[0]["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap())
        .collect();
    assert_eq!(kids, ["ITEMNO", "QTY"]);
    // The key field to the field.
    let def = c.request(
        "textDocument/definition",
        json!({ "textDocument": { "uri": PF }, "position": { "line": 3, "character": 20 } }),
    );
    assert_eq!(def["range"]["start"]["line"], json!(1));
    let f = c.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": PF } }),
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
    assert_eq!(r, [(0, 3), (4, 5)]);
    c.stop();
}

#[test]
fn a_display_file_is_not_analyzed() {
    let mut c = Client::start(Dds, Duration::from_millis(20));
    let uri = "qs400mbr://qshq400/HLINV/QDDSSRC/ITEMMNTD.dspf";
    c.open(
        uri,
        "qs400-dds",
        "     A          R SCREEN\n     A            X              1A  B  2  2\n",
    );
    assert!(c.diagnostics(uri).is_empty());
    let s = c.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": uri } }),
    );
    assert_eq!(s, json!([]));
    c.stop();
}
