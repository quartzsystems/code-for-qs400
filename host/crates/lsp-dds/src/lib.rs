// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The DDS language server: the `dds` front end's `analyze` of PF, LF
//! and PRTF sources, the compiler chosen by the member's source type
//! (the URI's extension).
//!
//! At the pinned commit the front end has no compiler for display or
//! ICF files (`Kind` is `Physical`, `Logical` or `Printer`), so a DSPF
//! or ICFF source is not analyzed: it gets its grammar and nothing
//! else, rather than another compiler's diagnostics.
//!
//! `Options::refs` is left `None`: `REF`, `REFFLD`, `PFILE` and `JFILE`
//! name file objects on the system, and no host method reads a file's
//! fields, so the front end finds none, as it documents.

use compdiag::front::{Analysis, Fetch, Source};
use dds::analysis::{Kind, Options, Tree, analyze};
use lsp_common::uri::DocSource;
use lsp_common::{Analyzed, Language, Word, WordKind};
use lsp_types::{FoldingRange, FoldingRangeKind};

/// The DDS language.
#[derive(Clone, Copy, Debug, Default)]
pub struct Dds;

/// The compiler for a source type; `None` for one the front end has no
/// compiler for (DSPF, ICFF).
#[must_use]
pub fn kind_of(ext: &str) -> Option<Kind> {
    match ext.to_ascii_lowercase().as_str() {
        "dspf" | "icff" => None,
        e => Some(Kind::of_srctype(e).unwrap_or_default()),
    }
}

impl Language for Dds {
    type Ast = Tree;

    fn id(&self) -> &'static str {
        "qs400-dds"
    }

    fn analyze(&self, doc: &DocSource, source: &Source, _fetch: Fetch<'_>) -> Analysis<Tree> {
        match kind_of(&doc.ext) {
            Some(kind) => analyze(source, &Options { kind, refs: None }),
            None => Analysis {
                sources: vec![source.clone()],
                ..Analysis::default()
            },
        }
    }

    /// Each record format, from its `R` line to the line before the
    /// next (blank lines at its end left out).
    fn folding(&self, a: &Analyzed<Tree>) -> Vec<FoldingRange> {
        let idx = a.lines_of(0);
        let formats: Vec<usize> = a
            .analysis
            .ast
            .specs
            .iter()
            .filter(|s| s.name_type == Some(dds::lex::NameType::Record))
            .map(|s| s.line)
            .collect();
        let mut out = Vec::new();
        for (i, &first) in formats.iter().enumerate() {
            let mut last = formats
                .get(i + 1)
                .map_or(idx.line_count().saturating_sub(1), |n| n.saturating_sub(1));
            while last > first && idx.line(last).trim().is_empty() {
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
    ($($w:literal)*) => { [$(Word { label: $w, kind: WordKind::Keyword }),*] };
}

/// The keywords completion offers, for every file type. The `dds` front
/// end exports no keyword table, so this one is kept here, from the DDS
/// reference; use the front end's when it has one.
const WORDS: &[Word] = &words!(
    "ABSVAL" "ALIAS" "ALL" "ALTSEQ" "ALWNULL" "BLINK" "CA01" "CA03" "CA12" "CCSID" "CF01" "CF03" "CF05"
    "CF06" "CF12" "CHANGE" "CHECK" "CHGINPDFT" "CMP" "COLHDG" "COLOR" "COMP" "CONCAT" "CSRLOC" "DATE"
    "DATFMT" "DATSEP" "DESCEND" "DFT" "DIGIT" "DSPATR" "DSPSIZ" "DYNSLT" "EDTCDE" "EDTWRD" "ERRMSG"
    "ERRMSGID" "FCFO" "FIFO" "FLTPCN" "FORMAT" "HELP" "HIGHLIGHT" "HLPARA" "INDARA" "INDTXT" "INVITE"
    "JDFTVAL" "JDUPSEQ" "JFILE" "JFLD" "JOIN" "JREF" "LIFO" "LOCK" "MSGCON" "MSGID" "NOALTSEQ" "OVERLAY"
    "PAGEDOWN" "PAGEUP" "PAGNBR" "PFILE" "PRINT" "PUTOVR" "RANGE" "REF" "REFACCPTH" "REFFLD" "REFSHIFT"
    "RENAME" "ROLLDOWN" "ROLLUP" "RTNCSRLOC" "SFL" "SFLCLR" "SFLCTL" "SFLDSP" "SFLDSPCTL" "SFLEND"
    "SFLNXTCHG" "SFLPAG" "SFLRCDNBR" "SFLSIZ" "SIGNED" "SKIPA" "SKIPB" "SPACEA" "SPACEB" "SST" "SYSNAME"
    "TEXT" "TIME" "TIMFMT" "TIMSEP" "TRNTBL" "UNDERLINE" "UNIQUE" "UNSIGNED" "USER" "VALUES" "VARLEN"
    "WDWBORDER" "WINDOW" "ZONE"
);

/// Serve DDS on stdio.
///
/// # Errors
///
/// When the stream breaks.
pub fn serve() -> Result<(), String> {
    lsp_common::serve_stdio(Dds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_compiler_by_source_type() {
        assert_eq!(kind_of("pf"), Some(Kind::Physical));
        assert_eq!(kind_of("LF"), Some(Kind::Logical));
        assert_eq!(kind_of("prtf"), Some(Kind::Printer));
        assert_eq!(kind_of("dspf"), None);
        assert_eq!(kind_of("icff"), None);
        // Anything else, as CRTPF's default.
        assert_eq!(kind_of("dds"), Some(Kind::Physical));
    }
}
