// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The RPG server over an in-memory connection, with a mock client
//! answering `qs400/fetchInclude`.

use lsp_common::testing::Client;
use lsp_rpgle::Rpgle;
use lsp_types::{DiagnosticSeverity, NumberOrString};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const MAIN: &str = "qs400mbr://qshq400/HLINV/QRPGLESRC/MAIN.rpgle";
const CP: &str = "qs400mbr://qshq400/HLINV/QRPGLESRC/CP.rpgle?readonly";
const LANG: &str = "qs400-rpgle";

/// A member copying CP (which has a bad definition type on its line 2)
/// and NOPE (which is not there).
const WITH_COPY: &str = "     D LOCAL           S             10A
      /COPY QRPGLESRC,CP
      /COPY QRPGLESRC,NOPE
     C                   EVAL      LOCAL = CPFLD
     C                   SETON                                        LR
";
const CP_TEXT: &str = "     D CPFLD           S             10A
     D BAD             X
";

fn codes(d: &[lsp_types::Diagnostic]) -> Vec<(u32, String)> {
    let mut v: Vec<(u32, String)> = d
        .iter()
        .map(|d| {
            let c = match &d.code {
                Some(NumberOrString::String(s)) => s.clone(),
                _ => format!("<{}>", d.message),
            };
            (d.range.start.line + 1, c)
        })
        .collect();
    v.sort();
    v
}

fn answer_cp(p: &lsp_common::protocol::FetchIncludeParams) -> Value {
    if p.request.member == "CP" {
        json!({ "uri": CP, "at": { "kind": "member", "library": "HLINV", "file": "QRPGLESRC", "member": "CP" }, "text": CP_TEXT })
    } else {
        Value::Null
    }
}

fn start() -> Client {
    Client::start(Rpgle, Duration::from_millis(50)).on_fetch(answer_cp)
}

#[test]
fn diagnostics_on_open() {
    let mut c = start();
    c.open(MAIN, LANG, "     C                   FOOBAR\n");
    let d = c.diagnostics(MAIN);
    assert_eq!(codes(&d), vec![(1, "RNF5014".into())]);
    assert_eq!(d[0].severity, Some(DiagnosticSeverity::ERROR));
    assert_eq!(d[0].source.as_deref(), Some(LANG));
    // The second-level text, as the compile diagnostics carry it.
    assert!(
        !d[0].related_information.as_ref().unwrap()[0]
            .message
            .is_empty()
    );
    c.stop();
}

#[test]
fn includes_are_fetched_and_summarized_when_not_open() {
    let mut c = start();
    c.open(MAIN, LANG, WITH_COPY);
    let d = c.diagnostics(MAIN);
    // The member's own RNF0273 for NOPE, and CP's one message
    // summarized on its directive.
    assert_eq!(
        codes(&d),
        vec![
            (2, "<1 message in HLINV/QRPGLESRC(CP)>".into()),
            (3, "RNF0273".into())
        ]
    );
    let s = d.iter().find(|d| d.code.is_none()).unwrap();
    assert_eq!(s.severity, Some(DiagnosticSeverity::ERROR));
    // Asked once each, with what the directive asked for.
    let asked: Vec<&str> = c
        .fetches
        .iter()
        .map(|f| f.request.member.as_str())
        .collect();
    assert_eq!(asked, ["CP", "NOPE"]);
    assert_eq!(c.fetches[0].request.library, "*LIBL");
    assert_eq!(c.fetches[0].request.file, "QRPGLESRC");
    assert_eq!(c.fetches[0].uri, MAIN);
    // Nothing was published from a half-read source: the one publish
    // came after both answers.
    assert_eq!(c.publishes.iter().filter(|(u, _)| u == MAIN).count(), 1);
    c.stop();
}

#[test]
fn an_open_include_gets_its_own_diagnostics() {
    let mut c = start();
    c.open(MAIN, LANG, WITH_COPY);
    let _ = c.diagnostics(MAIN);
    c.open(CP, LANG, CP_TEXT);
    let on_cp = c.diagnostics(CP);
    assert!(
        codes(&on_cp).contains(&(2, "RNF3304".into())),
        "{:?}",
        codes(&on_cp)
    );
    c.settle(Duration::from_millis(200));
    // The summary is gone from the including member.
    assert_eq!(codes(&c.published[MAIN]), vec![(3, "RNF0273".into())]);
    // Closing the include brings the summary back.
    c.close(CP);
    let d = c.diagnostics(MAIN);
    assert_eq!(codes(&d).len(), 2);
    c.stop();
}

#[test]
fn the_cache_serves_every_document() {
    let mut c = start();
    c.open(MAIN, LANG, WITH_COPY);
    let _ = c.diagnostics(MAIN);
    let other = "qs400mbr://qshq400/HLINV/QRPGLESRC/OTHER.rpgle";
    c.open(other, LANG, WITH_COPY);
    let _ = c.diagnostics(other);
    assert_eq!(c.fetches.len(), 2, "{:?}", c.fetches);
    c.stop();
}

#[test]
fn a_saved_include_is_fetched_again() {
    let mut c = start();
    c.open(MAIN, LANG, WITH_COPY);
    let _ = c.diagnostics(MAIN);
    c.notify(
        "qs400/includesChanged",
        json!({ "connection": "QSHQ400", "member": { "kind": "member", "library": "HLINV", "file": "QRPGLESRC", "member": "CP" } }),
    );
    c.settle(Duration::from_millis(300));
    let asked: Vec<&str> = c
        .fetches
        .iter()
        .map(|f| f.request.member.as_str())
        .collect();
    assert_eq!(asked, ["CP", "NOPE", "CP"]);
    c.stop();
}

#[test]
fn changes_are_debounced() {
    let mut c = Client::start(Rpgle, Duration::from_millis(300)).on_fetch(answer_cp);
    c.open(
        MAIN,
        LANG,
        "     C                   SETON                                        LR\n",
    );
    assert!(c.diagnostics(MAIN).is_empty());
    let t0 = Instant::now();
    for v in 2..6 {
        c.change(MAIN, v, &format!("     C                   FOOBA{v}\n"));
        c.settle(Duration::from_millis(50));
    }
    let d = c.diagnostics(MAIN);
    let waited = t0.elapsed();
    assert!(waited >= Duration::from_millis(300 + 150), "{waited:?}");
    assert!(waited < Duration::from_millis(1500), "{waited:?}");
    assert_eq!(codes(&d), vec![(1, "RNF5014".into())]);
    // One publish for the four changes.
    c.settle(Duration::from_millis(400));
    let after = c.publishes.iter().filter(|(_, t)| *t > t0).count();
    assert_eq!(after, 1);
    c.stop();
}

#[test]
fn deleting_the_line_clears_the_diagnostic() {
    let mut c = start();
    c.open(
        MAIN,
        LANG,
        "     C                   SETON                                        LR\n",
    );
    c.settle(Duration::from_millis(100));
    c.change(MAIN, 2, "     C                   FOOBAR\n     C                   SETON                                        LR\n");
    assert_eq!(codes(&c.diagnostics(MAIN)), vec![(1, "RNF5014".into())]);
    c.change(
        MAIN,
        3,
        "     C                   SETON                                        LR\n",
    );
    assert!(c.diagnostics(MAIN).is_empty());
    c.stop();
}

#[test]
fn qs400_diagnostics_is_what_analyze_returned() {
    let mut c = start();
    c.open(MAIN, LANG, WITH_COPY);
    let _ = c.diagnostics(MAIN);
    let v = c.request("qs400/diagnostics", json!({ "uri": MAIN }));
    let items = v.as_array().unwrap();
    let mut keys: Vec<(String, u64, String)> = items
        .iter()
        .map(|i| {
            (
                i["at"]["member"].as_str().unwrap().to_string(),
                i["line"].as_u64().unwrap(),
                i["id"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            ("CP".into(), 2, "RNF3304".into()),
            ("MAIN".into(), 3, "RNF0273".into())
        ]
    );
    assert_eq!(items[0]["at"]["library"], json!("HLINV"));
    // A document not analyzed is null.
    assert_eq!(
        c.request(
            "qs400/diagnostics",
            json!({ "uri": "qs400mbr://x/A/B/C.rpgle" })
        ),
        Value::Null
    );
    c.stop();
}
