// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The SQL language server: the `sql` front end's `analyze` of SQL
//! sources (what `RUNSQLSTM` runs). The SQL inside an SQLRPGLE member is
//! `rpgfront`'s, analyzed by the RPG server.
//!
//! `NAMING` is `*SYS`, as `RUNSQLSTM` defaults it.

use compdiag::front::{Analysis, Fetch, Source};
use lsp_common::uri::DocSource;
use lsp_common::{Analyzed, Language, Word, WordKind};
use lsp_types::{FoldingRange, FoldingRangeKind};
use sql::analysis::{Options, Tree, analyze};
use sql::ast::Naming;
use std::sync::OnceLock;

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
