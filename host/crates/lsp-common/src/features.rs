// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The editor features over a document's [`Analysis`]: document
//! symbols, go to definition, hover, completion, rename within the
//! document and folding. Every answer is read from what `analyze`
//! returned; nothing is parsed here.
//!
//! [`Analysis`]: compdiag::front::Analysis

use crate::analyzed::Analyzed;
use crate::lang::{Language, MemberContext};
use crate::protocol::{self, ListMembersParams, MemberItem};
use crate::server::{Server, parse};
use crate::uri;
use compdiag::front::{Declaration, SymbolKind};
use lsp_types::request::Request as _;
use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionOptions, CompletionParams, CompletionResponse,
    DocumentSymbol, DocumentSymbolParams, DocumentSymbolResponse, FoldingRangeParams,
    FoldingRangeProviderCapability, GotoDefinitionParams, GotoDefinitionResponse, Hover,
    HoverContents, HoverParams, HoverProviderCapability, Location, MarkupContent, MarkupKind,
    OneOf, Position, PrepareRenameResponse, Range, RenameOptions, RenameParams, ServerCapabilities,
    TextDocumentPositionParams, TextEdit, Uri, WorkDoneProgressOptions, WorkspaceEdit, request,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::time::Duration;

/// How long completion waits for the client's member list.
const MEMBERS_WAIT: Duration = Duration::from_secs(3);

/// Add the features' capabilities.
pub fn capabilities<L: Language>(lang: &L, caps: &mut ServerCapabilities) {
    caps.document_symbol_provider = Some(OneOf::Left(true));
    caps.definition_provider = Some(OneOf::Left(true));
    caps.hover_provider = Some(HoverProviderCapability::Simple(true));
    caps.completion_provider = Some(CompletionOptions {
        trigger_characters: Some(lang.trigger_characters()).filter(|t| !t.is_empty()),
        ..CompletionOptions::default()
    });
    caps.rename_provider = Some(OneOf::Right(RenameOptions {
        prepare_provider: Some(true),
        work_done_progress_options: WorkDoneProgressOptions::default(),
    }));
    caps.folding_range_provider = Some(FoldingRangeProviderCapability::Simple(true));
}

/// Answer a feature request; `None` when `method` is not one.
pub fn request<L: Language>(
    server: &mut Server<'_, L>,
    method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    let p = params.clone();
    let out = match method {
        request::DocumentSymbolRequest::METHOD => parse::<DocumentSymbolParams>(p).map(|p| {
            let uri = p.text_document.uri.as_str().to_string();
            server.current(&uri);
            json(
                server
                    .results
                    .get(&uri)
                    .map(|an| DocumentSymbolResponse::Nested(symbols(an))),
            )
        }),
        request::GotoDefinition::METHOD => parse::<GotoDefinitionParams>(p).map(|p| {
            let (uri, pos) = at(&p.text_document_position_params);
            server.current(&uri);
            json(
                server
                    .results
                    .get(&uri)
                    .and_then(|an| definition(an, pos))
                    .map(GotoDefinitionResponse::Scalar),
            )
        }),
        request::HoverRequest::METHOD => parse::<HoverParams>(p).map(|p| {
            let (uri, pos) = at(&p.text_document_position_params);
            server.current(&uri);
            let id = server.lang.id();
            json(server.results.get(&uri).and_then(|an| hover(an, pos, id)))
        }),
        request::Completion::METHOD => {
            parse::<CompletionParams>(p).map(|p| json(completion(server, &p)))
        }
        request::PrepareRenameRequest::METHOD => {
            parse::<TextDocumentPositionParams>(p).and_then(|p| {
                let (uri, pos) = at(&p);
                server.current(&uri);
                match server.results.get(&uri) {
                    Some(an) => prepare_rename(an, pos).map(json),
                    None => Ok(Value::Null),
                }
            })
        }
        request::Rename::METHOD => parse::<RenameParams>(p).and_then(|p| {
            let (uri, pos) = at(&p.text_document_position);
            server.current(&uri);
            match server.results.get(&uri) {
                Some(an) => rename(an, &uri, pos, &p.new_name).map(json),
                None => Err("the document is not analyzed yet".into()),
            }
        }),
        request::FoldingRangeRequest::METHOD => parse::<FoldingRangeParams>(p).map(|p| {
            let uri = p.text_document.uri.as_str().to_string();
            server.current(&uri);
            json(server.results.get(&uri).map(|an| server.lang.folding(an)))
        }),
        _ => return None,
    };
    Some(out)
}

fn json<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

fn at(p: &TextDocumentPositionParams) -> (String, Position) {
    (p.text_document.uri.as_str().to_string(), p.position)
}

/// LSP's kind for a front end's.
#[must_use]
pub fn symbol_kind(k: SymbolKind) -> lsp_types::SymbolKind {
    use lsp_types::SymbolKind as S;
    match k {
        SymbolKind::File => S::FILE,
        SymbolKind::Format | SymbolKind::Structure => S::STRUCT,
        SymbolKind::Field | SymbolKind::Subfield => S::FIELD,
        SymbolKind::Variable | SymbolKind::Parameter => S::VARIABLE,
        SymbolKind::Constant => S::CONSTANT,
        SymbolKind::Procedure | SymbolKind::Routine => S::FUNCTION,
        SymbolKind::Prototype => S::INTERFACE,
        SymbolKind::Subroutine => S::METHOD,
        SymbolKind::Label => S::KEY,
        SymbolKind::List => S::ARRAY,
        SymbolKind::Table => S::CLASS,
        SymbolKind::Index => S::KEY,
        SymbolKind::Schema => S::NAMESPACE,
        SymbolKind::Cursor => S::OBJECT,
        SymbolKind::Command => S::MODULE,
        SymbolKind::Keyword => S::PROPERTY,
    }
}

fn completion_kind(k: SymbolKind) -> CompletionItemKind {
    use CompletionItemKind as C;
    match k {
        SymbolKind::File => C::FILE,
        SymbolKind::Format | SymbolKind::Structure | SymbolKind::Table => C::STRUCT,
        SymbolKind::Field | SymbolKind::Subfield => C::FIELD,
        SymbolKind::Constant => C::CONSTANT,
        SymbolKind::Procedure | SymbolKind::Prototype | SymbolKind::Routine => C::FUNCTION,
        SymbolKind::Subroutine => C::METHOD,
        SymbolKind::Command | SymbolKind::Schema => C::MODULE,
        SymbolKind::Keyword => C::PROPERTY,
        _ => C::VARIABLE,
    }
}

/// What a name's scope can be: a declaration of these kinds holds the
/// declarations naming it as their scope, preferred in this order.
fn container_rank(k: SymbolKind) -> Option<u8> {
    match k {
        SymbolKind::Procedure => Some(0),
        SymbolKind::Structure => Some(1),
        SymbolKind::Format => Some(2),
        SymbolKind::File => Some(3),
        SymbolKind::Table => Some(4),
        SymbolKind::Command => Some(5),
        SymbolKind::Routine => Some(6),
        SymbolKind::Prototype => Some(7),
        SymbolKind::Label | SymbolKind::Keyword => Some(8),
        _ => None,
    }
}

/// The name as written in its source (the declaration's own is folded
/// to upper case).
fn written<A>(an: &Analyzed<A>, d: &Declaration) -> String {
    an.analysis
        .sources
        .get(d.source)
        .and_then(|s| s.text.get(d.span.start..d.span.end))
        .filter(|t| t.eq_ignore_ascii_case(&d.name))
        .map_or_else(|| d.name.clone(), str::to_string)
}

/// The document's own declarations as a tree: each under the
/// declaration its `scope` names.
#[must_use]
pub fn symbols<A>(an: &Analyzed<A>) -> Vec<DocumentSymbol> {
    let decls = &an.analysis.declarations;
    let own: Vec<usize> = (0..decls.len()).filter(|&i| decls[i].source == 0).collect();
    let parent: HashMap<usize, usize> = own
        .iter()
        .filter_map(|&i| {
            let scope = decls[i].scope.as_deref()?;
            own.iter()
                .copied()
                .filter(|&j| j != i && decls[j].name.eq_ignore_ascii_case(scope))
                .filter_map(|j| container_rank(decls[j].kind).map(|r| (r, j)))
                .min_by_key(|&(r, j)| (r, j.abs_diff(i)))
                .map(|(_, j)| (i, j))
        })
        .collect();
    // A parent chain that loops (a name its own scope's scope) is cut.
    let mut root: Vec<usize> = Vec::new();
    let mut kids: HashMap<usize, Vec<usize>> = HashMap::new();
    for &i in &own {
        let mut seen = HashSet::from([i]);
        let mut p = parent.get(&i).copied();
        while let Some(j) = p {
            if !seen.insert(j) {
                break;
            }
            p = parent.get(&j).copied();
        }
        match parent.get(&i) {
            Some(&j) if p.is_none() => kids.entry(j).or_default().push(i),
            _ => root.push(i),
        }
    }
    root.iter().map(|&i| symbol(an, i, &kids, 0)).collect()
}

#[allow(deprecated)]
fn symbol<A>(
    an: &Analyzed<A>,
    i: usize,
    kids: &HashMap<usize, Vec<usize>>,
    depth: usize,
) -> DocumentSymbol {
    let d = &an.analysis.declarations[i];
    let selection = an.lines_of(0).span(&d.span);
    let children: Vec<DocumentSymbol> = if depth < 16 {
        kids.get(&i)
            .map(|v| v.iter().map(|&k| symbol(an, k, kids, depth + 1)).collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut range = selection;
    for c in &children {
        if c.range.start < range.start {
            range.start = c.range.start;
        }
        if c.range.end > range.end {
            range.end = c.range.end;
        }
    }
    DocumentSymbol {
        name: written(an, d),
        detail: Some(d.detail.clone()).filter(|s| !s.is_empty()),
        kind: symbol_kind(d.kind),
        tags: None,
        deprecated: None,
        range,
        selection_range: selection,
        children: Some(children).filter(|c| !c.is_empty()),
    }
}

/// The declaration at `pos` of the document: the one a reference there
/// resolves to, or one declared there.
#[must_use]
pub fn target<A>(an: &Analyzed<A>, pos: Position) -> Option<(usize, Range)> {
    let idx = an.lines_of(0);
    let a = &an.analysis;
    a.references
        .iter()
        .filter(|r| r.source == 0 && idx.contains(&r.span, pos))
        .find_map(|r| r.declaration.map(|d| (d, idx.span(&r.span))))
        .or_else(|| {
            a.declarations
                .iter()
                .position(|d| d.source == 0 && idx.contains(&d.span, pos))
                .map(|i| (i, idx.span(&a.declarations[i].span)))
        })
}

fn location<A>(an: &Analyzed<A>, source: usize, range: Range) -> Option<Location> {
    let u = an.uris.get(source)?.as_deref()?;
    Some(Location::new(Uri::from_str(u).ok()?, range))
}

/// The include directive on the line of `pos`, if any.
fn directive_at<A>(an: &Analyzed<A>, pos: Position) -> Option<&compdiag::front::Include> {
    an.analysis
        .includes
        .iter()
        .find(|i| i.source == 0 && i.span.line == pos.line + 1)
}

/// Where the name at `pos` is declared, or what the directive at `pos`
/// brings in.
#[must_use]
pub fn definition<A>(an: &Analyzed<A>, pos: Position) -> Option<Location> {
    if let Some((d, _)) = target(an, pos) {
        let decl = &an.analysis.declarations[d];
        return location(an, decl.source, an.lines_of(decl.source).span(&decl.span));
    }
    let i = directive_at(an, pos)?;
    let k = i.resolved?;
    location(an, k, Range::default())
}

/// The declaration's detail in a code block, and for a name declared in
/// an include, the directive that brought it in.
#[must_use]
pub fn hover<A>(an: &Analyzed<A>, pos: Position, lang: &str) -> Option<Hover> {
    if let Some((d, range)) = target(an, pos) {
        let decl = &an.analysis.declarations[d];
        let mut md = format!(
            "```{lang}\n{}\n```\n\n**{}**",
            decl.detail.trim(),
            written(an, decl)
        );
        md.push_str(&format!(" · {}", kind_name(decl.kind)));
        if let Some(s) = &decl.scope {
            md.push_str(&format!(" in {s}"));
        }
        if decl.source != 0
            && let Some(i) = an.top_directive(decl.source)
        {
            let line = an
                .lines_of(0)
                .line(usize::try_from(i.span.line.saturating_sub(1)).unwrap_or(0));
            md.push_str(&format!(
                "\n\nFrom `{}` ({})",
                line.trim(),
                uri::display(&an.analysis.sources[decl.source].at)
            ));
        }
        return Some(markdown(md, Some(range)));
    }
    let i = directive_at(an, pos)?;
    let line = an.lines_of(0).line(usize::try_from(pos.line).unwrap_or(0));
    let what = i.resolved.map_or_else(
        || "not found".to_string(),
        |k| uri::display(&an.analysis.sources[k].at),
    );
    Some(markdown(
        format!("```{lang}\n{}\n```\n\n{what}", line.trim()),
        None,
    ))
}

fn markdown(value: String, range: Option<Range>) -> Hover {
    Hover {
        contents: HoverContents::Markup(MarkupContent {
            kind: MarkupKind::Markdown,
            value,
        }),
        range,
    }
}

fn kind_name(k: SymbolKind) -> &'static str {
    match k {
        SymbolKind::File => "file",
        SymbolKind::Format => "record format",
        SymbolKind::Field => "field",
        SymbolKind::Variable => "variable",
        SymbolKind::Constant => "constant",
        SymbolKind::Structure => "data structure",
        SymbolKind::Subfield => "subfield",
        SymbolKind::Procedure => "procedure",
        SymbolKind::Prototype => "prototype",
        SymbolKind::Parameter => "parameter",
        SymbolKind::Subroutine => "subroutine",
        SymbolKind::Label => "label",
        SymbolKind::List => "list",
        SymbolKind::Table => "table",
        SymbolKind::Index => "index",
        SymbolKind::Schema => "schema",
        SymbolKind::Routine => "routine",
        SymbolKind::Cursor => "cursor",
        SymbolKind::Command => "command",
        SymbolKind::Keyword => "keyword",
    }
}

fn completion<L: Language>(
    server: &mut Server<'_, L>,
    p: &CompletionParams,
) -> Option<CompletionResponse> {
    let (uri, pos) = at(&p.text_document_position);
    let before: String = {
        let doc = server.docs.get(&uri)?;
        let idx = crate::position::TextIndex::new(&doc.text);
        let line = idx.line(usize::try_from(pos.line).unwrap_or(0)).to_string();
        let cut = idx.offset(pos) - idx.offset(Position::new(pos.line, 0));
        line.get(..cut).unwrap_or(&line).to_string()
    };
    if let Some(ctx) = server.lang.member_context(&before) {
        return Some(CompletionResponse::Array(members(server, &uri, &ctx)));
    }
    let mut items: Vec<CompletionItem> = server
        .lang
        .words()
        .iter()
        .map(|w| CompletionItem {
            label: w.label.to_string(),
            kind: Some(w.kind.lsp()),
            detail: Some(w.kind.detail().to_string()),
            ..CompletionItem::default()
        })
        .collect();
    if let Some(an) = server.results.get(&uri) {
        let scope = server.lang.scope_at(an, pos.line);
        let procedures: HashSet<String> = an
            .analysis
            .declarations
            .iter()
            .filter(|d| d.kind == SymbolKind::Procedure)
            .map(|d| d.name.to_ascii_uppercase())
            .collect();
        let mut seen = HashSet::new();
        for d in &an.analysis.declarations {
            let visible = match &d.scope {
                None => true,
                Some(s) => {
                    !procedures.contains(&s.to_ascii_uppercase())
                        || scope.as_ref().is_some_and(|c| c.eq_ignore_ascii_case(s))
                }
            };
            if visible && seen.insert(d.name.to_ascii_uppercase()) {
                items.push(CompletionItem {
                    label: written(an, d),
                    kind: Some(completion_kind(d.kind)),
                    detail: Some(d.detail.clone()).filter(|s| !s.is_empty()),
                    sort_text: Some(format!("0{}", d.name)),
                    ..CompletionItem::default()
                });
            }
        }
    }
    Some(CompletionResponse::Array(items))
}

fn members<L: Language>(
    server: &mut Server<'_, L>,
    uri: &str,
    ctx: &MemberContext,
) -> Vec<CompletionItem> {
    let params = ListMembersParams {
        uri: uri.to_string(),
        library: ctx.library.clone(),
        file: ctx.file.clone(),
    };
    let got = server.ask_client(protocol::LIST_MEMBERS, params, MEMBERS_WAIT);
    let list: Vec<MemberItem> = got
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    list.into_iter()
        .filter(|m| {
            m.member
                .to_ascii_uppercase()
                .starts_with(&ctx.prefix.to_ascii_uppercase())
        })
        .map(|m| CompletionItem {
            label: m.member,
            kind: Some(CompletionItemKind::FILE),
            detail: Some(m.ty).filter(|s| !s.is_empty()),
            documentation: Some(lsp_types::Documentation::String(m.text))
                .filter(|d| matches!(d, lsp_types::Documentation::String(s) if !s.is_empty())),
            ..CompletionItem::default()
        })
        .collect()
}

/// The name at `pos` can be renamed: its range, or why not.
///
/// # Errors
///
/// When the name is declared in an include.
pub fn prepare_rename<A>(
    an: &Analyzed<A>,
    pos: Position,
) -> Result<Option<PrepareRenameResponse>, String> {
    let Some((d, range)) = target(an, pos) else {
        return Ok(None);
    };
    refuse_include(an, d)?;
    Ok(Some(PrepareRenameResponse::Range(range)))
}

fn refuse_include<A>(an: &Analyzed<A>, d: usize) -> Result<(), String> {
    let decl = &an.analysis.declarations[d];
    if decl.source == 0 {
        return Ok(());
    }
    Err(format!(
        "{} is declared in {}; rename it there.",
        written(an, decl),
        uri::display(&an.analysis.sources[decl.source].at)
    ))
}

/// Rename the name at `pos` in this document: its declaration and every
/// reference resolving to it, nothing in any other document.
///
/// # Errors
///
/// When nothing is at `pos`, the new name is empty or has blanks, or the
/// name is declared in an include.
pub fn rename<A>(
    an: &Analyzed<A>,
    uri: &str,
    pos: Position,
    new_name: &str,
) -> Result<WorkspaceEdit, String> {
    let new_name = new_name.trim();
    if new_name.is_empty() || new_name.contains(char::is_whitespace) {
        return Err(format!("{new_name:?} is not a name"));
    }
    let Some((d, _)) = target(an, pos) else {
        return Err("No name to rename here.".into());
    };
    refuse_include(an, d)?;
    let idx = an.lines_of(0);
    let a = &an.analysis;
    let mut edits: Vec<TextEdit> = vec![TextEdit::new(
        idx.span(&a.declarations[d].span),
        new_name.to_string(),
    )];
    for r in &a.references {
        if r.source == 0 && r.declaration == Some(d) {
            let e = TextEdit::new(idx.span(&r.span), new_name.to_string());
            if !edits.contains(&e) {
                edits.push(e);
            }
        }
    }
    let u = Uri::from_str(uri).map_err(|e| e.to_string())?;
    Ok(WorkspaceEdit {
        changes: Some(HashMap::from([(u, edits)])),
        ..WorkspaceEdit::default()
    })
}
