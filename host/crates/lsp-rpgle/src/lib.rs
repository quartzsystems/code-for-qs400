// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The RPG language server: `rpgfront`'s `analyze` of fixed form,
//! free form and `**FREE`, `/COPY` and `/INCLUDE` members fetched from
//! the client, and the `EXEC SQL` of `SQLRPGLE`, which `rpgfront` owns.

use compdiag::front::{Analysis, Fetch, Source};
use lsp_common::Language;
use lsp_common::uri::DocSource;
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

    fn request(&self, method: &str, _params: &Value) -> Option<Result<Value, String>> {
        (method == SPEC_FORMS)
            .then(|| serde_json::to_value(spec_forms()).map_err(|e| e.to_string()))
    }
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
