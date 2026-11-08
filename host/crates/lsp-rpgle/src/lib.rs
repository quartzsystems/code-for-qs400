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
}

/// Serve RPG on stdio.
///
/// # Errors
///
/// When the stream breaks.
pub fn serve() -> Result<(), String> {
    lsp_common::serve_stdio(Rpgle)
}
