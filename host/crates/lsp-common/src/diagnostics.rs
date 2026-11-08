// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! A front end's [`Diagnostic`] as LSP's: the range by the Problems
//! panel's rules, the severity from the one table, the message ID as
//! the code and the second-level text as related information, as the
//! compile diagnostics carry it.

use crate::position::TextIndex;
use compdiag::Diagnostic;
use lsp_types::{
    DiagnosticRelatedInformation, DiagnosticSeverity, Location, NumberOrString, Position, Range,
    Uri,
};
use std::str::FromStr;

/// LSP's severity for a compiler message's.
#[must_use]
pub fn severity(s: u8) -> DiagnosticSeverity {
    match severity::of(s) {
        severity::Severity::Information => DiagnosticSeverity::INFORMATION,
        severity::Severity::Warning => DiagnosticSeverity::WARNING,
        severity::Severity::Error => DiagnosticSeverity::ERROR,
    }
}

/// `d` in the source `index` indexes, published on `uri`.
#[must_use]
pub fn to_lsp(index: &TextIndex, d: &Diagnostic, source: &str, uri: &str) -> lsp_types::Diagnostic {
    let range = index.diagnostic(d);
    let related = (!d.help.trim().is_empty())
        .then(|| Uri::from_str(uri).ok())
        .flatten()
        .map(|u| {
            vec![DiagnosticRelatedInformation {
                location: Location::new(u, range),
                message: d.help.trim().to_string(),
            }]
        });
    lsp_types::Diagnostic {
        range,
        severity: Some(severity(d.severity)),
        code: (!d.id.is_empty()).then(|| NumberOrString::String(d.id.clone())),
        source: Some(source.to_string()),
        message: if d.text.is_empty() {
            d.id.clone()
        } else {
            d.text.clone()
        },
        related_information: related,
        ..lsp_types::Diagnostic::default()
    }
}

/// `n` messages of an include not open in the editor, on the line of
/// the directive that brought it in.
#[must_use]
pub fn summary(
    index: &TextIndex,
    line: u32,
    n: usize,
    highest: u8,
    name: &str,
    source: &str,
) -> lsp_types::Diagnostic {
    let line = line.max(1);
    lsp_types::Diagnostic {
        range: Range::new(Position::new(line - 1, 0), index.line_end(line)),
        severity: Some(severity(highest)),
        source: Some(source.to_string()),
        message: format!(
            "{n} {} in {name}",
            if n == 1 { "message" } else { "messages" }
        ),
        ..lsp_types::Diagnostic::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rnf7030_as_lsp() {
        let text = "     C                   EVAL      X = UNDEF\n";
        let idx = TextIndex::new(text);
        // UNDEF is columns 40 to 44, the line's last five.
        let col = u16::try_from(text.find("UNDEF").unwrap() + 1).unwrap();
        assert_eq!(col, 40);
        let d = Diagnostic {
            line: 1,
            column: col,
            end_column: col + 4,
            severity: 30,
            id: "RNF7030".into(),
            text: "The name or indicator UNDEF is not defined.".into(),
            help: "Cause . . . . . :   The name or indicator is not defined.".into(),
            ..Diagnostic::default()
        };
        let l = to_lsp(
            &idx,
            &d,
            "qs400-rpgle",
            "qs400mbr://qshq400/HLINV/QRPGLESRC/ASSETS.rpgle",
        );
        assert_eq!(
            l.range,
            Range::new(Position::new(0, 39), Position::new(0, 44))
        );
        assert_eq!(l.severity, Some(DiagnosticSeverity::ERROR));
        assert_eq!(l.code, Some(NumberOrString::String("RNF7030".into())));
        assert_eq!(l.message, "The name or indicator UNDEF is not defined.");
        let rel = l.related_information.unwrap();
        assert_eq!(
            rel[0].message,
            "Cause . . . . . :   The name or indicator is not defined."
        );
    }

    #[test]
    fn the_table_is_the_problems_panels() {
        assert_eq!(severity(0), DiagnosticSeverity::INFORMATION);
        assert_eq!(severity(10), DiagnosticSeverity::WARNING);
        assert_eq!(severity(19), DiagnosticSeverity::WARNING);
        assert_eq!(severity(20), DiagnosticSeverity::ERROR);
    }

    #[test]
    fn a_summary_counts() {
        let idx = TextIndex::new("      /COPY QRPGLESRC,CP\n");
        let s = summary(&idx, 1, 3, 30, "HLINV/QRPGLESRC(CP)", "qs400-rpgle");
        assert_eq!(s.message, "3 messages in HLINV/QRPGLESRC(CP)");
        assert_eq!(s.range.end, Position::new(0, 24));
        let s = summary(&idx, 1, 1, 0, "X", "qs400-rpgle");
        assert_eq!(s.message, "1 message in X");
        assert_eq!(s.severity, Some(DiagnosticSeverity::INFORMATION));
    }
}
