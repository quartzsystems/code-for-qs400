// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The SQL language server: the `sql` front end's `analyze` of SQL
//! sources (what `RUNSQLSTM` runs). The SQL inside an SQLRPGLE member is
//! `rpgfront`'s, analyzed by the RPG server.
//!
//! `NAMING` is `*SYS`, as `RUNSQLSTM` defaults it.
//!
//! `qs400/sqlStatements` answers each statement's range, from its first
//! token to the end of its last (the `;` left out), as the front end's
//! parser splits the script: on `;` outside strings and comments, a
//! statement that does not parse still its own. Run Statement takes its
//! scope from them, so the editor and the server agree. The front end
//! measures a string or number token by its value, not its source (a
//! doubled quote counts once), so each range's end is taken from the
//! source: the last character before the `;` that ends the statement,
//! comments and blanks left out ([`statement_end`]).

use compdiag::front::{Analysis, Fetch, Source};
use lsp_common::uri::DocSource;
use lsp_common::{Analyzed, Language, Word, WordKind};
use lsp_types::{FoldingRange, FoldingRangeKind};
use serde_json::{Value, json};
use sql::analysis::{Options, Tree, analyze};
use sql::ast::Naming;
use std::sync::OnceLock;

/// `qs400/sqlStatements`.
pub const STATEMENTS: &str = "qs400/sqlStatements";

/// The SQL language.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sql;

impl Language for Sql {
    type Ast = Tree;

    fn id(&self) -> &'static str {
        "qs400-sql"
    }

    fn analyze(&self, _doc: &DocSource, source: &Source, _fetch: Fetch<'_>) -> Analysis<Tree> {
        analyze(
            source,
            &Options {
                naming: Naming::Sys,
            },
        )
    }

    /// Each statement over more than one line.
    fn folding(&self, a: &Analyzed<Tree>) -> Vec<FoldingRange> {
        a.analysis
            .ast
            .statements
            .iter()
            .filter(|s| s.span.line > 0 && s.span.end_line > s.span.line)
            .map(|s| FoldingRange {
                start_line: s.span.line - 1,
                end_line: s.span.end_line - 1,
                kind: Some(FoldingRangeKind::Region),
                ..FoldingRange::default()
            })
            .collect()
    }

    fn words(&self) -> &'static [Word] {
        words()
    }

    fn document_methods(&self) -> &'static [&'static str] {
        &[STATEMENTS]
    }

    /// Each statement's range; none when the script does not lex.
    fn document_request(
        &self,
        _method: &str,
        a: &Analyzed<Tree>,
        _params: &Value,
    ) -> Result<Value, String> {
        let index = a.lines_of(0);
        let text = index.text();
        let ranges: Vec<Value> = a
            .analysis
            .ast
            .statements
            .iter()
            .filter(|s| s.span.line > 0 && s.span.end > s.span.start)
            .map(|s| {
                let end = statement_end(text, s.span.start, s.span.end);
                json!({ "range": { "start": index.position(s.span.start), "end": index.position(end) } })
            })
            .collect();
        Ok(Value::Array(ranges))
    }
}

/// The byte after a statement's last character: scanning from `start`,
/// strings (`'...'`, `"..."`, quotes doubled) and comments (`--` to the
/// line's end, `/* ... */`) are passed over, and the statement ends at the
/// first `;` outside them at or after `approx` (the front end's end, at
/// most the true one), or at the end of the text. Blanks and comments
/// before that `;` are not the statement's.
#[must_use]
pub fn statement_end(text: &str, start: usize, approx: usize) -> usize {
    let b = text.as_bytes();
    let mut i = start.min(b.len());
    let mut last = i;
    while i < b.len() {
        match b[i] {
            q @ (b'\'' | b'"') => {
                i += 1;
                while i < b.len() {
                    if b[i] == q {
                        if b.get(i + 1) == Some(&q) {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i = (i + 1).min(b.len());
                last = i;
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i = (i + 2).min(b.len());
            }
            b';' if i >= approx => return last,
            c if c.is_ascii_whitespace() => i += 1,
            _ => {
                // A whole character, so `last` stays on a boundary.
                let n = text[i..].chars().next().map_or(1, char::len_utf8);
                i += n;
                last = i;
            }
        }
    }
    last
}

macro_rules! words {
    ($($w:literal)*) => { [$(Word { label: $w, kind: WordKind::Keyword }),*] };
}

/// SQL's keywords. The `sql` front end exports its special registers and
/// built-in globals (`sql::words`), which completion takes from it; it
/// exports no keyword table, so the keywords are kept here, from the SQL
/// reference.
const KEYWORDS: &[Word] = &words!(
    "ADD" "ALIAS" "ALL" "ALTER" "AND" "AS" "ASC" "BEGIN" "BETWEEN" "BY" "CALL" "CASE" "CAST" "CHAR"
    "CHECK" "COLUMN" "COMMENT" "COMMIT" "CONSTRAINT" "CREATE" "CURSOR" "DATE" "DECIMAL" "DECLARE"
    "DEFAULT" "DELETE" "DESC" "DISTINCT" "DROP" "ELSE" "END" "EXISTS" "FETCH" "FIRST" "FOR" "FOREIGN"
    "FROM" "FUNCTION" "GRANT" "GROUP" "HAVING" "IN" "INDEX" "INNER" "INSERT" "INTEGER" "INTO" "IS"
    "JOIN" "KEY" "LABEL" "LEFT" "LIKE" "MERGE" "NOT" "NULL" "NUMERIC" "OF" "ON" "OR" "ORDER" "OUTER"
    "PRIMARY" "PROCEDURE" "REFERENCES" "RENAME" "REPLACE" "RETURN" "RETURNS" "REVOKE" "RIGHT"
    "ROLLBACK" "ROWS" "SCHEMA" "SELECT" "SEQUENCE" "SET" "TABLE" "THEN" "TIME" "TIMESTAMP" "TRIGGER"
    "UNION" "UNIQUE" "UPDATE" "USING" "VALUES" "VARCHAR" "VIEW" "WHEN" "WHERE" "WITH"
);

fn words() -> &'static [Word] {
    static ALL: OnceLock<Vec<Word>> = OnceLock::new();
    ALL.get_or_init(|| {
        let registers = sql::words::CURRENT.iter().map(|(_, full)| Word {
            label: full,
            kind: WordKind::Register,
        });
        let globals = sql::words::GLOBALS.iter().map(|(_, _, full)| Word {
            label: full,
            kind: WordKind::Register,
        });
        KEYWORDS
            .iter()
            .copied()
            .chain(registers)
            .chain(globals)
            .collect()
    })
}

/// Serve SQL on stdio.
///
/// # Errors
///
/// When the stream breaks.
pub fn serve() -> Result<(), String> {
    lsp_common::serve_stdio(Sql)
}
