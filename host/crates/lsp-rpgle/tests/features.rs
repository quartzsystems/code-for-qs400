// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The RPG server's features, through the protocol, on one member with a
//! `/COPY`.

use lsp_common::protocol::FetchIncludeParams;
use lsp_common::testing::Client;
use lsp_rpgle::Rpgle;
use serde_json::{Value, json};
use std::time::Duration;

const MAIN: &str = "qs400mbr://qshq400/HLINV/QRPGLESRC/ASSETS.rpgle";
const CP: &str = "qs400mbr://qshq400/HLINV/QRPGLESRC/CP.rpgle?readonly";

/// Lines from 0, as LSP counts them.
const SOURCE: &str = "**FREE
dcl-f itemmst keyed;
dcl-ds cust qualified;
  name char(30);
  qty packed(7:0);
end-ds;
/copy qrpglesrc,cp
dcl-s total packed(9:2);
dcl-proc a;
  dcl-s y int(10);
  y = 1;
  if y > 0;
    y = y + 1;
  endif;
  total = cpfld;
end-proc;
dcl-proc b;
  dcl-s y int(10);
  y = 2;
end-proc;
";
const CP_TEXT: &str = "**FREE\ndcl-s cpfld packed(9:2);\n";

fn answer(p: &FetchIncludeParams) -> Value {
    if p.request.member == "CP" {
        json!({ "uri": CP, "at": { "kind": "member", "library": "HLINV", "file": "QRPGLESRC", "member": "CP" }, "text": CP_TEXT })
    } else {
        Value::Null
    }
}

fn start() -> Client {
    let mut c = Client::start(Rpgle, Duration::from_millis(20))
        .on_fetch(answer)
        .on_members(|p| {
            assert_eq!((p.library.as_str(), p.file.as_str()), ("*LIBL", "QRPGLESRC"));
            json!([{ "member": "CP", "type": "RPGLE", "text": "copy" }, { "member": "ASSETS", "type": "RPGLE", "text": "" }])
        });
    c.open(MAIN, "qs400-rpgle", SOURCE);
    let _ = c.diagnostics(MAIN);
    c
}

fn pos(line: u32, character: u32) -> Value {
    json!({ "textDocument": { "uri": MAIN }, "position": { "line": line, "character": character } })
}

#[test]
fn the_outline() {
    let mut c = start();
    let v = c.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": MAIN } }),
    );
    let top: Vec<(&str, u64)> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["name"].as_str().unwrap(), s["kind"].as_u64().unwrap()))
        .collect();
    // File 1, struct 23, field 8, variable 13, function 12.
    assert_eq!(
        top,
        [
            ("itemmst", 1),
            ("cust", 23),
            ("name", 8),
            ("qty", 8),
            ("total", 13),
            ("a", 12),
            ("b", 12)
        ]
    );
    // A procedure's locals under it; nothing from the copy member.
    let a = &v[5];
    assert_eq!(a["children"][0]["name"], json!("y"));
    assert_eq!(a["children"][0]["detail"], json!("S INT"));
    assert_eq!(
        a["selectionRange"]["start"],
        json!({ "line": 8, "character": 9 })
    );
    assert!(a["range"]["end"]["line"].as_u64().unwrap() >= 9);
    c.stop();
}

#[test]
fn definition_of_a_local_and_into_the_copy_member() {
    let mut c = start();
    // `y` on line 12 is a's own.
    let d = c.request("textDocument/definition", pos(12, 4));
    assert_eq!(d["uri"], json!(MAIN));
    assert_eq!(d["range"]["start"], json!({ "line": 9, "character": 8 }));
    // `cpfld` is declared in the copy member, which opens read-only.
    let d = c.request("textDocument/definition", pos(14, 12));
    assert_eq!(d["uri"], json!(CP));
    assert_eq!(d["range"]["start"], json!({ "line": 1, "character": 6 }));
    // The directive itself goes to the member.
    let d = c.request("textDocument/definition", pos(6, 3));
    assert_eq!(d["uri"], json!(CP));
    c.stop();
}

#[test]
fn hover_shows_the_detail_and_the_directive() {
    let mut c = start();
    let h = c.request("textDocument/hover", pos(14, 4));
    let md = h["contents"]["value"].as_str().unwrap();
    assert!(md.starts_with("```qs400-rpgle\nS PACKED\n```"), "{md}");
    let h = c.request("textDocument/hover", pos(14, 12));
    let md = h["contents"]["value"].as_str().unwrap();
    assert!(
        md.contains("From `/copy qrpglesrc,cp` (HLINV/QRPGLESRC(CP))"),
        "{md}"
    );
    let h = c.request("textDocument/hover", pos(6, 2));
    let md = h["contents"]["value"].as_str().unwrap();
    assert!(
        md.contains("/copy qrpglesrc,cp") && md.ends_with("HLINV/QRPGLESRC(CP)"),
        "{md}"
    );
    assert_eq!(c.request("textDocument/hover", pos(0, 0)), Value::Null);
    c.stop();
}

#[test]
fn completion_offers_words_names_in_scope_and_members() {
    let mut c = start();
    let v = c.request("textDocument/completion", pos(12, 4));
    let labels: Vec<&str> = v
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["label"].as_str())
        .collect();
    for want in [
        "%FOUND", "DCL-S", "CHAIN", "/COPY", "*INLR", "total", "cpfld", "cust", "y",
    ] {
        assert!(labels.contains(&want), "{want} in {labels:?}");
    }
    // One `y`: a's, in scope; b's is not offered twice.
    assert_eq!(labels.iter().filter(|l| **l == "y").count(), 1);
    // After /COPY, the source file's members from the client.
    c.change(
        MAIN,
        2,
        &SOURCE.replace("/copy qrpglesrc,cp", "/copy qrpglesrc,c"),
    );
    let v = c.request(
        "textDocument/completion",
        json!({ "textDocument": { "uri": MAIN }, "position": { "line": 6, "character": 17 } }),
    );
    let labels: Vec<&str> = v
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["label"].as_str())
        .collect();
    assert_eq!(labels, ["CP"]);
    c.stop();
}

#[test]
fn rename_a_local_touches_its_references_only() {
    let mut c = start();
    let prep = c.request("textDocument/prepareRename", pos(10, 2));
    assert_eq!(prep["start"], json!({ "line": 10, "character": 2 }));
    let mut p = pos(10, 2);
    p["newName"] = json!("count");
    let e = c.request("textDocument/rename", p);
    let edits = e["changes"][MAIN].as_array().unwrap();
    let mut lines: Vec<(u64, u64)> = edits
        .iter()
        .map(|t| {
            (
                t["range"]["start"]["line"].as_u64().unwrap(),
                t["range"]["start"]["character"].as_u64().unwrap(),
            )
        })
        .collect();
    lines.sort_unstable();
    // a's declaration and its four uses; b's `y` (lines 17, 18) untouched.
    assert_eq!(lines, [(9, 8), (10, 2), (11, 5), (12, 4), (12, 8)]);
    assert!(edits.iter().all(|t| t["newText"] == json!("count")));
    assert_eq!(e["changes"].as_object().unwrap().len(), 1);
    c.stop();
}

#[test]
fn rename_refuses_a_name_from_the_copy_member() {
    let mut c = start();
    let prep = c.request("textDocument/prepareRename", pos(14, 12));
    assert_eq!(
        prep["error"],
        json!("cpfld is declared in HLINV/QRPGLESRC(CP); rename it there.")
    );
    let mut p = pos(14, 12);
    p["newName"] = json!("x");
    assert!(c.request("textDocument/rename", p)["error"].is_string());
    c.stop();
}

#[test]
fn folding_from_the_tree() {
    let mut c = start();
    let v = c.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": MAIN } }),
    );
    let mut r: Vec<(u64, u64)> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["startLine"].as_u64().unwrap(),
                f["endLine"].as_u64().unwrap(),
            )
        })
        .collect();
    r.sort_unstable();
    // The DS to its last subfield, procedure a (after the copy member's
    // lines in the listing), its IF, and procedure b.
    assert_eq!(r, [(2, 4), (8, 15), (11, 13), (16, 19)]);
    c.stop();
}

#[test]
fn folding_in_fixed_form() {
    let mut c = Client::start(Rpgle, Duration::from_millis(20)).on_fetch(answer);
    let uri = "qs400mbr://qshq400/HLINV/QRPGLESRC/FIXED.rpgle";
    let text = "     D QTY             S              7P 0
      /COPY QRPGLESRC,CP
      /IF DEFINED(NEVER)
     D GONE            S              1A
      /ENDIF
     C     QTY           IFEQ      0
     C                   EVAL      QTY = 1
     C                   ENDIF
     C     CALC          BEGSR
     C                   EVAL      QTY = QTY + 1
     C                   ENDSR
     PGETQTY           B
     D GETQTY          PI             7P 0
     C                   RETURN    QTY
     PGETQTY           E
";
    c.open(uri, "qs400-rpgle", text);
    let _ = c.diagnostics(uri);
    let v = c.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": uri } }),
    );
    let mut r: Vec<(u64, u64)> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["startLine"].as_u64().unwrap(),
                f["endLine"].as_u64().unwrap(),
            )
        })
        .collect();
    r.sort_unstable();
    assert_eq!(r, [(5, 7), (8, 10), (11, 14)]);
    c.stop();
}
