// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The RPG language server: `rpgfront`'s `analyze` of fixed form,
//! free form and `**FREE`, `/COPY` and `/INCLUDE` members fetched from
//! the client, and the `EXEC SQL` of `SQLRPGLE`, which `rpgfront` owns.

pub mod blocks;
pub mod words;

use compdiag::front::{Analysis, Fetch, Source};
use lsp_common::uri::DocSource;
use lsp_common::{Analyzed, Language, MemberContext, Word};
use lsp_types::{FoldingRange, FoldingRangeKind};
use rpgfront::analysis::{Options, analyze};
use rpgfront::ast::Module;
use serde::Serialize;
use serde_json::Value;

/// `qs400/specForms`: the fixed-form specifications' columns, from
/// `rpgspecs`, the table `rpgfront` reads records by.
pub const SPEC_FORMS: &str = "qs400/specForms";

/// One field of a specification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SpecField {
    /// The table's name for it.
    pub name: String,
    /// First column, from 1.
    pub from: usize,
    /// Last column.
    pub to: usize,
    /// What SEU's format line shows over it; empty for a field that
    /// overlaps others.
    pub ruler: String,
}

/// One specification form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SpecForm {
    /// `H`, `F`, `D`, `I`, `IX`, `IR`, `IF`, `C`, `CX`, `O`, `OF`, `P`.
    pub id: String,
    /// The letter in column 6.
    pub letter: String,
    /// What it describes.
    pub title: String,
    /// Its fields, in column order.
    pub fields: Vec<SpecField>,
}

/// Every form of `rpgspecs`.
#[must_use]
pub fn spec_forms() -> Vec<SpecForm> {
    rpgspecs::forms()
        .iter()
        .map(|f| SpecForm {
            id: f.id.clone(),
            letter: f.letter.clone(),
            title: f.title.clone(),
            fields: f
                .fields
                .iter()
                .map(|x| SpecField {
                    name: x.name.clone(),
                    from: x.from,
                    to: x.to,
                    ruler: x.ruler.clone(),
                })
                .collect(),
        })
        .collect()
}

/// The RPG language.
#[derive(Clone, Copy, Debug, Default)]
pub struct Rpgle;

impl Language for Rpgle {
    type Ast = Module;

    fn id(&self) -> &'static str {
        "qs400-rpgle"
    }

    /// `DEFINE` and `COPYNEST` as the compile commands default them: no
    /// condition names, nesting 32.
    fn analyze(&self, _doc: &DocSource, source: &Source, fetch: Fetch<'_>) -> Analysis<Module> {
        analyze(
            source,
            &Options {
                defines: &[],
                copynest: 0,
                fetch: Some(fetch),
            },
        )
    }

    fn folding(&self, a: &Analyzed<Module>) -> Vec<FoldingRange> {
        blocks::blocks(&a.analysis)
            .into_iter()
            .map(|b| FoldingRange {
                start_line: b.first - 1,
                end_line: b.last - 1,
                kind: Some(FoldingRangeKind::Region),
                ..FoldingRange::default()
            })
            .collect()
    }

    /// The procedure whose lines hold `line` (from 0).
    fn scope_at(&self, a: &Analyzed<Module>, line: u32) -> Option<String> {
        let l = line + 1;
        blocks::blocks(&a.analysis)
            .into_iter()
            .filter(|b| b.first <= l && l <= b.last)
            .find_map(|b| b.procedure)
    }

    fn words(&self) -> &'static [Word] {
        words::all()
    }

    fn member_context(&self, before: &str) -> Option<MemberContext> {
        member_context(before)
    }

    fn trigger_characters(&self) -> Vec<String> {
        vec!["%".into(), ",".into()]
    }

    fn request(&self, method: &str, _params: &Value) -> Option<Result<Value, String>> {
        (method == SPEC_FORMS)
            .then(|| serde_json::to_value(spec_forms()).map_err(|e| e.to_string()))
    }
}

/// After `/COPY` or `/INCLUDE`, the source file whose members complete:
/// `/COPY FILE,MBR`, `/COPY LIB/FILE,MBR`, or just a member, of
/// `QRPGLESRC`, as the compiler defaults it. A stream file (a path or a
/// quoted name) is not completed.
#[must_use]
pub fn member_context(before: &str) -> Option<MemberContext> {
    let upper = before.to_ascii_uppercase();
    let at = ["/COPY", "/INCLUDE"]
        .iter()
        .filter_map(|d| upper.rfind(d).map(|i| i + d.len()))
        .max()?;
    let rest = &upper[at..];
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let word = rest.trim_start();
    if word.contains(char::is_whitespace) || word.contains(['\'', '"', '.']) {
        return None;
    }
    let name_ok = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_#@$*".contains(c))
    };
    let (lib_file, prefix) = word.rsplit_once(',').map_or(("", word), |(a, b)| (a, b));
    let (library, file) = match lib_file.split_once('/') {
        Some((l, f)) => (l, f),
        None if lib_file.is_empty() && word.contains('/') => return None,
        None => ("", lib_file),
    };
    if !name_ok(library) || !name_ok(file) || !name_ok(prefix) {
        return None;
    }
    Some(MemberContext {
        library: if library.is_empty() {
            "*LIBL".into()
        } else {
            library.into()
        },
        file: if file.is_empty() {
            "QRPGLESRC".into()
        } else {
            file.into()
        },
        prefix: prefix.into(),
    })
}

/// Serve RPG on stdio.
///
/// # Errors
///
/// When the stream breaks.
pub fn serve() -> Result<(), String> {
    lsp_common::serve_stdio(Rpgle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn members_complete_after_copy() {
        let c = |s: &str| member_context(s).map(|m| (m.library, m.file, m.prefix));
        let t = |l: &str, f: &str, p: &str| Some((l.to_string(), f.to_string(), p.to_string()));
        assert_eq!(
            c("      /COPY QRPGLESRC,ASS"),
            t("*LIBL", "QRPGLESRC", "ASS")
        );
        assert_eq!(c("      /copy hlinv/qcpysrc,"), t("HLINV", "QCPYSRC", ""));
        assert_eq!(c("/include CP"), t("*LIBL", "QRPGLESRC", "CP"));
        assert_eq!(c("      /COPY "), t("*LIBL", "QRPGLESRC", ""));
        assert_eq!(c("/include 'inc/cp.rpgleinc"), None);
        assert_eq!(c("/include /home/x/cp"), None);
        assert_eq!(c("      /COPYX"), None);
        assert_eq!(c("     C                   EVAL      X = 1"), None);
    }

    #[test]
    fn the_spec_table_is_rpgspecs() {
        let forms = spec_forms();
        let ids: Vec<&str> = forms.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "H", "F", "D", "I", "IX", "IR", "IF", "C", "CX", "O", "OF", "P"
            ]
        );
        let d = forms.iter().find(|f| f.id == "D").unwrap();
        let name = d.fields.iter().find(|x| x.name == "name").unwrap();
        assert_eq!((name.from, name.to, name.ruler.as_str()), (7, 21, "Name"));
        let c = forms.iter().find(|f| f.id == "C").unwrap();
        let op = c.fields.iter().find(|x| x.name == "opcode").unwrap();
        assert_eq!((op.from, op.to), (26, 35));
    }
}
