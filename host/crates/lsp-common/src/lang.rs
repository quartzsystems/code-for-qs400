// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! What each language server supplies: its front end's `analyze`, and
//! the few things the shared features cannot read from the
//! [`Analysis`](compdiag::front::Analysis) alone.

use crate::analyzed::Analyzed;
use crate::uri::DocSource;
use compdiag::front::{Analysis, Fetch, Source};
use lsp_types::{CompletionItemKind, FoldingRange};
use serde_json::Value;

/// A completion word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Word {
    /// As inserted.
    pub label: &'static str,
    /// What it is.
    pub kind: WordKind,
}

/// What a completion word is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WordKind {
    /// A keyword or operation code.
    Keyword,
    /// A built-in function.
    Function,
    /// A command.
    Command,
    /// A directive (`/COPY`).
    Directive,
    /// A special register or built-in variable.
    Register,
}

impl WordKind {
    /// LSP's kind.
    #[must_use]
    pub fn lsp(self) -> CompletionItemKind {
        match self {
            Self::Keyword | Self::Directive => CompletionItemKind::KEYWORD,
            Self::Function => CompletionItemKind::FUNCTION,
            Self::Command => CompletionItemKind::MODULE,
            Self::Register => CompletionItemKind::CONSTANT,
        }
    }

    /// The detail shown beside it.
    #[must_use]
    pub fn detail(self) -> &'static str {
        match self {
            Self::Keyword => "keyword",
            Self::Function => "built-in function",
            Self::Command => "command",
            Self::Directive => "directive",
            Self::Register => "special register",
        }
    }
}

/// A source file whose members complete at the cursor (after `/COPY`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemberContext {
    /// The library, `*LIBL` when not written.
    pub library: String,
    /// The source file.
    pub file: String,
    /// What is typed of the member so far.
    pub prefix: String,
}

/// One language.
pub trait Language {
    /// The front end's tree.
    type Ast;

    /// The VS Code language id (`qs400-rpgle`), also each diagnostic's
    /// `source`.
    fn id(&self) -> &'static str;

    /// The front end's `analyze` of `source`, which `doc` names;
    /// `fetch` answers includes for a front end that has them.
    fn analyze(&self, doc: &DocSource, source: &Source, fetch: Fetch<'_>) -> Analysis<Self::Ast>;

    /// The folding ranges of the analyzed document, from the tree.
    fn folding(&self, _a: &Analyzed<Self::Ast>) -> Vec<FoldingRange> {
        Vec::new()
    }

    /// The scope (procedure) the line `line` (from 0) of the document is
    /// in, for completion.
    fn scope_at(&self, _a: &Analyzed<Self::Ast>, _line: u32) -> Option<String> {
        None
    }

    /// The keywords and built-ins completion offers.
    fn words(&self) -> &'static [Word] {
        &[]
    }

    /// When the line up to the cursor is a directive naming a source
    /// file's member, which file.
    fn member_context(&self, _before: &str) -> Option<MemberContext> {
        None
    }

    /// Characters that start completion beside the identifier ones.
    fn trigger_characters(&self) -> Vec<String> {
        Vec::new()
    }

    /// A request of this language's own (`qs400/<name>`); `None` when
    /// it is not one.
    fn request(&self, _method: &str, _params: &Value) -> Option<Result<Value, String>> {
        None
    }

    /// This language's own requests on one document, whose params carry
    /// `textDocument.uri`: answered by [`Language::document_request`] on
    /// the document's analysis, made current first.
    fn document_methods(&self) -> &'static [&'static str] {
        &[]
    }

    /// A request of [`Language::document_methods`] on `a`, the document's
    /// analysis.
    fn document_request(
        &self,
        _method: &str,
        _a: &Analyzed<Self::Ast>,
        _params: &Value,
    ) -> Result<Value, String> {
        Ok(Value::Null)
    }
}
