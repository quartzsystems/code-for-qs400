// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The SQL server's features on one script.

use lsp_common::testing::Client;
use lsp_sql::Sql;
use lsp_types::NumberOrString;
use serde_json::json;
use std::time::Duration;

const URI: &str = "qs400mbr://qshq400/HLINV/QSQLSRC/INVSEED.sql";
const SOURCE: &str = "CREATE TABLE ITEMS (
  ID INT NOT NULL,
  NAME CHAR(10)
);
INSERT INTO ITEMS VALUES (1, 'A');
SELECT * FROM ITEMS WHERE ID = = 1;
";

#[test]
fn sql_features() {
    let mut c = Client::start(Sql, Duration::from_millis(20));
    c.open(URI, "qs400-sql", SOURCE);
    let d = c.diagnostics(URI);
    assert_eq!(d.len(), 1);
    assert_eq!((d[0].range.start.line, d[0].range.start.character), (5, 31));
    assert_eq!(d[0].code, Some(NumberOrString::String("SQL0104".into())));
    let s = c.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": URI } }),
    );
    assert_eq!(s[0]["name"], json!("ITEMS"));
    assert_eq!(s[0]["children"].as_array().unwrap().len(), 2);
    let def = c.request(
        "textDocument/definition",
        json!({ "textDocument": { "uri": URI }, "position": { "line": 5, "character": 27 } }),
    );
    assert_eq!(def["range"]["start"]["line"], json!(1));
    let f = c.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": URI } }),
    );
    assert_eq!(f[0]["startLine"], json!(0));
    assert_eq!(f[0]["endLine"], json!(3));
    let w = c.request(
        "textDocument/completion",
        json!({ "textDocument": { "uri": URI }, "position": { "line": 6, "character": 0 } }),
    );
    let labels: Vec<&str> = w
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["label"].as_str())
        .collect();
    // From the front end's own table of registers and globals.
    assert!(labels.contains(&"CURRENT DEGREE") && labels.contains(&"QSYS2.JOB_NAME"));
    assert!(labels.contains(&"SELECT") && labels.contains(&"ITEMS"));
    c.stop();
}

/// Statements split on `;` outside strings and comments, each from its
/// first token to its last.
#[test]
fn statement_ranges() {
    const U: &str = "untitled:Untitled-1";
    let text = "-- a comment; not a split
SELECT 'a;b' AS \"x;y\" FROM T; /* c; d */

  UPDATE T SET A = 1
  WHERE B = 'it''s; ok';
SELECT * FORM T;
VALUES 1";
    let mut c = Client::start(Sql, Duration::from_millis(20));
    c.open(U, "qs400-sql", text);
    let r = c.request(
        "qs400/sqlStatements",
        json!({ "textDocument": { "uri": U } }),
    );
    let ranges: Vec<[u64; 4]> = r
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let r = &s["range"];
            [
                r["start"]["line"].as_u64().unwrap(),
                r["start"]["character"].as_u64().unwrap(),
                r["end"]["line"].as_u64().unwrap(),
                r["end"]["character"].as_u64().unwrap(),
            ]
        })
        .collect();
    assert_eq!(
        ranges,
        vec![[1, 0, 1, 28], [3, 2, 4, 23], [5, 0, 5, 15], [6, 0, 6, 8]]
    );
    let unknown = c.request(
        "qs400/sqlStatements",
        json!({ "textDocument": { "uri": "untitled:none" } }),
    );
    assert_eq!(unknown, json!(null));
    c.stop();
}
