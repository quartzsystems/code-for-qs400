// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The command definition language server: the `cmd` front end's
//! `analyze` of CMD sources. The command's name is left to `analyze`,
//! which takes the member's (or the stream file's) name, as the default
//! `CRTCMD CMD(&LIBRARY/&NAME)` does.

use cmd::analysis::{Options, Tree, analyze};
use compdiag::front::{Analysis, Fetch, Source};
use lsp_common::uri::DocSource;
use lsp_common::{Analyzed, Language, Word, WordKind};
use lsp_types::{FoldingRange, FoldingRangeKind};

/// The command definition language.
#[derive(Clone, Copy, Debug, Default)]
pub struct Cmd;

impl Language for Cmd {
    type Ast = Tree;

    fn id(&self) -> &'static str {
        "qs400-cmd"
    }

    fn analyze(&self, _doc: &DocSource, source: &Source, _fetch: Fetch<'_>) -> Analysis<Tree> {
        analyze(source, &Options { name: None })
    }

    /// Each statement continued over more than one line: from its line to
    /// the line before the next statement, blank and comment lines at its
    /// end left out.
    fn folding(&self, a: &Analyzed<Tree>) -> Vec<FoldingRange> {
        let idx = a.lines_of(0);
        let starts: Vec<usize> = a.analysis.ast.statements.iter().map(|s| s.line).collect();
        let mut out = Vec::new();
        for (i, &first) in starts.iter().enumerate() {
            let first = first.saturating_sub(1);
            let mut last = starts
                .get(i + 1)
                .map_or(idx.line_count().saturating_sub(1), |n| n.saturating_sub(2));
            while last > first && {
                let t = idx.line(last).trim();
                t.is_empty() || t.starts_with("/*")
            } {
                last -= 1;
            }
            if last > first {
                out.push(FoldingRange {
                    start_line: u32::try_from(first).unwrap_or(u32::MAX),
                    end_line: u32::try_from(last).unwrap_or(u32::MAX),
                    kind: Some(FoldingRangeKind::Region),
                    ..FoldingRange::default()
                });
            }
        }
        out
    }

    fn words(&self) -> &'static [Word] {
        WORDS
    }
}

macro_rules! words {
    ($($kind:ident: [$($w:literal)*])*) => { [$($(Word { label: $w, kind: WordKind::$kind }),*),*] };
}

/// The words completion offers. The `cmd` front end exports no table of
/// its statements' keywords (they are its parser's own), so this one is
/// kept here, from the command definition reference; use the front end's
/// when it has one.
const WORDS: &[Word] = &words! {
    Command: ["CMD" "PARM" "ELEM" "QUAL" "DEP" "PMTCTL"]
    Keyword: [
        "KWD" "TYPE" "LEN" "CONSTANT" "RSTD" "DFT" "VALUES" "REL" "RANGE" "SPCVAL" "SNGVAL" "MIN" "MAX"
        "ALWUNPRT" "ALWVAR" "PGM" "DTAARA" "FILE" "FULL" "EXPR" "VARY" "PASSATR" "PASSVAL" "CASE"
        "LISTDSPL" "DSPINPUT" "CHOICE" "CHOICEPGM" "PROMPT" "PMTCTL" "PMTCTLPGM" "KEYPARM" "INLPMTLEN"
        "ALWQTE" "CTL" "NBRTRUE" "MSGID" "COND" "LGLREL"
    ]
    Register: [
        "*CHAR" "*DEC" "*LGL" "*NAME" "*SNAME" "*CNAME" "*GENERIC" "*PNAME" "*PATH" "*DATE" "*TIME"
        "*HEX" "*ZEROELEM" "*NULL" "*INT2" "*INT4" "*UINT2" "*UINT4" "*X" "*VARNAME" "*CMDSTR" "*CMD"
        "*YES" "*NO" "*NONE" "*ALL" "*SPCFD" "*UNSPFD"
    ]
};

/// Serve CMD on stdio.
///
/// # Errors
///
/// When the stream breaks.
pub fn serve() -> Result<(), String> {
    lsp_common::serve_stdio(Cmd)
}
