// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! Parity without the system: each compile the live parity test recorded
//! (`host/fixtures/parity/<FILE>/<MEMBER>.<ext>.json`) against the front
//! end's `analyze` of the same source, compared as sets of (source,
//! line, message ID). A difference fails with both sets.
//!
//! The members' text is not in the repository (HLINV's source is not
//! ours to ship): it is read beside the record, where the live test
//! wrote it, or from `QS400_PARITY_SRC/<FILE>/<MEMBER>.<ext>`. A record
//! whose source is absent is skipped and counted.

use compdiag::Where;
use compdiag::front::{IncludeRequest, Source};
use lsp_common::Language;
use lsp_common::protocol::{At, DiagnosticItem, Request};
use lsp_common::uri::DocSource;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// One recorded compile.
#[derive(Debug, Deserialize)]
struct Record {
    member: Member,
    /// The compile command as sent.
    #[allow(dead_code)]
    command: String,
    /// Each include the analysis fetched, and where its text is.
    #[serde(default)]
    includes: Vec<RecordedInclude>,
    /// The compile's diagnostics, as `action.run` returned them.
    diagnostics: Vec<DiagnosticItem>,
}

#[derive(Debug, Deserialize)]
struct Member {
    library: String,
    file: String,
    member: String,
    #[serde(rename = "type")]
    ty: String,
}

#[derive(Debug, Deserialize)]
struct RecordedInclude {
    request: Request,
    at: At,
    /// The text's file, relative to the fixtures folder.
    source: String,
}

/// (source, line, ID): what a listing comparison keys on.
type Key = (String, u32, String);

fn key_of(at: &At, line: u32, id: &str) -> Key {
    let w = Where::from(at);
    (lsp_common::uri::display(&w), line, id.to_string())
}

/// What one side has and the other lacks.
#[derive(Debug, Default, PartialEq, Eq)]
struct Difference {
    only_compiler: Vec<Key>,
    only_editor: Vec<Key>,
}

fn compare(compiler: &BTreeSet<Key>, editor: &BTreeSet<Key>) -> Difference {
    Difference {
        only_compiler: compiler.difference(editor).cloned().collect(),
        only_editor: editor.difference(compiler).cloned().collect(),
    }
}

/// The difference as a table, one row per key.
fn table(member: &str, d: &Difference) -> String {
    let mut out = format!(
        "{member}\n  {:<32} {:>6}  {:<8} {}\n",
        "source", "line", "id", "only in"
    );
    for (k, side) in d
        .only_compiler
        .iter()
        .map(|k| (k, "compiler"))
        .chain(d.only_editor.iter().map(|k| (k, "editor")))
    {
        out.push_str(&format!("  {:<32} {:>6}  {:<8} {side}\n", k.0, k.1, k.2));
    }
    out
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/parity")
}

/// The front end for a member's source type, run as the language
/// server runs it.
fn analyze(
    ty: &str,
    source: &Source,
    fetch: &dyn Fn(&IncludeRequest) -> Option<Source>,
) -> Vec<DiagnosticItem> {
    let ext = ty.to_ascii_lowercase();
    let doc = DocSource {
        at: source.at.clone(),
        ext: ext.clone(),
        origin: String::new(),
    };
    let diags = match ext.as_str() {
        "rpgle" | "sqlrpgle" | "rpg" => lsp_rpgle::Rpgle.analyze(&doc, source, fetch).diagnostics,
        "clle" | "clp" | "cl" => lsp_cl::Cl.analyze(&doc, source, fetch).diagnostics,
        "pf" | "lf" | "prtf" | "dspf" | "icff" => {
            lsp_dds::Dds.analyze(&doc, source, fetch).diagnostics
        }
        "sql" => lsp_sql::Sql.analyze(&doc, source, fetch).diagnostics,
        "cmd" => lsp_cmd::Cmd.analyze(&doc, source, fetch).diagnostics,
        other => panic!("no language for source type {other}"),
    };
    diags.iter().map(DiagnosticItem::from).collect()
}

/// The text of `rel` in the fixtures, else under `QS400_PARITY_SRC`.
fn text_of(rel: &str) -> Option<String> {
    std::fs::read_to_string(root().join(rel)).ok().or_else(|| {
        let src = std::env::var_os("QS400_PARITY_SRC")?;
        std::fs::read_to_string(Path::new(&src).join(rel)).ok()
    })
}

/// Every record's difference; `(checked, skipped)`.
fn run_all() -> (Vec<String>, usize, usize) {
    let mut failures = Vec::new();
    let (mut checked, mut skipped) = (0, 0);
    let Ok(dirs) = std::fs::read_dir(root()) else {
        return (failures, 0, 0);
    };
    let mut records: Vec<PathBuf> = dirs
        .flatten()
        .filter(|d| d.path().is_dir())
        .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    records.sort();
    for path in records {
        let rec: Record = serde_json::from_str(&std::fs::read_to_string(&path).expect("record"))
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let m = &rec.member;
        let rel = format!("{}/{}.{}", m.file, m.member, m.ty.to_ascii_lowercase());
        let Some(text) = text_of(&rel) else {
            eprintln!("parity: {rel}: source not present, skipped");
            skipped += 1;
            continue;
        };
        let source = Source::member(&m.library, &m.file, &m.member, &text);
        let fetch = |r: &IncludeRequest| {
            let want = Request::from(r);
            let inc = rec
                .includes
                .iter()
                .find(|i| same_request(&i.request, &want))?;
            Some(Source {
                at: Where::from(&inc.at),
                text: text_of(&inc.source)?,
            })
        };
        let editor: BTreeSet<Key> = analyze(&m.ty, &source, &fetch)
            .iter()
            .map(|d| key_of(&d.at, d.line, &d.id))
            .collect();
        let compiler: BTreeSet<Key> = rec
            .diagnostics
            .iter()
            .map(|d| key_of(&d.at, d.line, &d.id))
            .collect();
        let d = compare(&compiler, &editor);
        if d != Difference::default() {
            failures.push(table(
                &format!("{}/{}({})", m.library, m.file, m.member),
                &d,
            ));
        }
        checked += 1;
    }
    (failures, checked, skipped)
}

fn same_request(a: &Request, b: &Request) -> bool {
    a.library.eq_ignore_ascii_case(&b.library)
        && a.file.eq_ignore_ascii_case(&b.file)
        && a.member.eq_ignore_ascii_case(&b.member)
        && a.path == b.path
}

#[test]
fn editor_diagnostics_match_the_recorded_compiles() {
    let (failures, checked, skipped) = run_all();
    eprintln!("parity: {checked} member(s) compared, {skipped} skipped for want of their source");
    assert!(
        failures.is_empty(),
        "the editor and the compiler differ:\n{}",
        failures.join("\n")
    );
}

#[test]
fn the_comparison_and_its_table() {
    let at = At::Member {
        library: "HLINV".into(),
        file: "QRPGLESRC".into(),
        member: "ASSETS".into(),
    };
    let cp = At::Member {
        library: "HLINV".into(),
        file: "QRPGLESRC".into(),
        member: "ASSETSCP".into(),
    };
    let compiler: BTreeSet<Key> = [
        key_of(&at, 42, "RNF7030"),
        key_of(&cp, 3, "RNF3304"),
        key_of(&at, 0, "RNS9310"),
    ]
    .into_iter()
    .collect();
    let editor: BTreeSet<Key> = [key_of(&cp, 3, "RNF3304"), key_of(&at, 7, "RNF0273")]
        .into_iter()
        .collect();
    let d = compare(&compiler, &editor);
    assert_eq!(
        d.only_compiler,
        [
            (
                "HLINV/QRPGLESRC(ASSETS)".to_string(),
                0,
                "RNS9310".to_string()
            ),
            (
                "HLINV/QRPGLESRC(ASSETS)".to_string(),
                42,
                "RNF7030".to_string()
            ),
        ]
    );
    assert_eq!(
        d.only_editor,
        [(
            "HLINV/QRPGLESRC(ASSETS)".to_string(),
            7,
            "RNF0273".to_string()
        )]
    );
    let t = table("HLINV/QRPGLESRC(ASSETS)", &d);
    assert!(
        t.contains(&format!(
            "{:<32} {:>6}  {:<8} compiler",
            "HLINV/QRPGLESRC(ASSETS)", 42, "RNF7030"
        )),
        "{t}"
    );
    assert!(t.contains("RNF0273  editor"), "{t}");
    assert_eq!(compare(&editor, &editor), Difference::default());
}

#[test]
fn a_record_and_its_includes_run_through_the_front_end() {
    // A record shaped as the live test writes one, with text of our own
    // in memory: the harness, not parity, is what this checks.
    let rec: Record = serde_json::from_value(serde_json::json!({
        "member": { "library": "QTEMP", "file": "QRPGLESRC", "member": "T", "type": "RPGLE" },
        "command": "CRTBNDRPG PGM(QTEMP/T) SRCFILE(QTEMP/QRPGLESRC)",
        "includes": [{ "request": { "library": "*LIBL", "file": "QRPGLESRC", "member": "CP" },
                       "at": { "kind": "member", "library": "QTEMP", "file": "QRPGLESRC", "member": "CP" },
                       "source": "QRPGLESRC/CP.rpgle" }],
        "diagnostics": [{ "at": { "kind": "member", "library": "QTEMP", "file": "QRPGLESRC", "member": "CP" },
                          "line": 1, "column": 24, "endLine": 0, "endColumn": 0, "severity": 20,
                          "id": "RNF3304", "text": "", "help": "" }]
    }))
    .unwrap();
    let source = Source::member("QTEMP", "QRPGLESRC", "T", "      /COPY QRPGLESRC,CP\n");
    let fetch = |r: &IncludeRequest| {
        let inc = rec
            .includes
            .iter()
            .find(|i| same_request(&i.request, &Request::from(r)))?;
        Some(Source {
            at: Where::from(&inc.at),
            text: "     D BAD             X\n".into(),
        })
    };
    let editor: BTreeSet<Key> = analyze("RPGLE", &source, &fetch)
        .iter()
        .map(|d| key_of(&d.at, d.line, &d.id))
        .collect();
    let compiler: BTreeSet<Key> = rec
        .diagnostics
        .iter()
        .map(|d| key_of(&d.at, d.line, &d.id))
        .collect();
    assert_eq!(compare(&compiler, &editor), Difference::default());
}
