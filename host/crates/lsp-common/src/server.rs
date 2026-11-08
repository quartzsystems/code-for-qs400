// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The loop every language server runs: one thread, messages in order,
//! as rust-analyzer's `lsp-server` expects.
//!
//! A document is analyzed when it opens and 300 ms after its last
//! change. An analysis that asks for an include the cache lacks is not
//! kept: the server asks the client (`qs400/fetchInclude`) and analyzes
//! again when the answer is in, so a document's diagnostics are never
//! published from a half-read source. Diagnostics are published per
//! URI, merged over every open document's analysis, and sent only when
//! they change.

use crate::analyzed::Analyzed;
use crate::debounce::{self, Debounce};
use crate::diagnostics;
use crate::includes::{Includes, Key, Lookup};
use crate::lang::Language;
use crate::protocol::{
    self, DiagnosticItem, DiagnosticsParams, FetchIncludeParams, Fetched, IncludesChangedParams,
};
use crate::uri::{self, DocSource};
use compdiag::front::{IncludeRequest, Source};
use crossbeam_channel::RecvTimeoutError;
use lsp_server::{
    Connection, ErrorCode, Message, Notification, ProtocolError, Request, RequestId, Response,
};
use lsp_types::notification::Notification as _;
use lsp_types::{
    DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
    PublishDiagnosticsParams, ServerCapabilities, TextDocumentSyncCapability, TextDocumentSyncKind,
    Uri, notification,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::str::FromStr;
use std::time::{Duration, Instant};

/// An open document.
#[derive(Clone, Debug)]
pub struct Doc {
    /// Its URI, as the client sent it.
    pub uri: String,
    /// Its version.
    pub version: i32,
    /// Its text.
    pub text: String,
    /// What the URI names.
    pub src: DocSource,
}

/// What the loop does next.
#[derive(Debug, PartialEq, Eq)]
enum Flow {
    Go,
    Exit,
}

/// One language server's state.
pub struct Server<'c, L: Language> {
    pub(crate) conn: &'c Connection,
    pub(crate) lang: L,
    pub(crate) docs: BTreeMap<String, Doc>,
    pub(crate) results: HashMap<String, Analyzed<L::Ast>>,
    waiting: HashMap<String, HashSet<Key>>,
    pub(crate) includes: Includes,
    debounce: Debounce,
    published: HashMap<String, Vec<lsp_types::Diagnostic>>,
    pending: HashMap<RequestId, Key>,
    next_id: i32,
    backlog: VecDeque<Message>,
}

/// What every server offers; the features are added by
/// [`crate::features::capabilities`].
#[must_use]
pub fn capabilities<L: Language>(lang: &L) -> ServerCapabilities {
    let mut caps = ServerCapabilities {
        text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::FULL)),
        ..ServerCapabilities::default()
    };
    crate::features::capabilities(lang, &mut caps);
    caps
}

/// Serve `lang` on stdin and stdout until the client says `exit`.
///
/// # Errors
///
/// When the stream breaks or the client does not follow the protocol.
pub fn serve_stdio<L: Language>(lang: L) -> Result<(), String> {
    let (conn, io) = Connection::stdio();
    let caps =
        serde_json::to_value(capabilities(&lang)).map_err(|e| format!("capabilities: {e}"))?;
    conn.initialize(caps)
        .map_err(|e| format!("initialize: {e}"))?;
    eprintln!("[info] {} language server started", lang.id());
    Server::new(&conn, lang).run().map_err(|e| e.to_string())?;
    drop(conn);
    io.join().map_err(|e| format!("stdio: {e}"))
}

impl<'c, L: Language> Server<'c, L> {
    /// Over an initialized connection.
    pub fn new(conn: &'c Connection, lang: L) -> Self {
        Self::with_delay(conn, lang, debounce::DELAY)
    }

    /// The same, with another debounce delay (for tests).
    pub fn with_delay(conn: &'c Connection, lang: L, delay: Duration) -> Self {
        Self {
            conn,
            lang,
            docs: BTreeMap::new(),
            results: HashMap::new(),
            waiting: HashMap::new(),
            includes: Includes::default(),
            debounce: Debounce::new(delay),
            published: HashMap::new(),
            pending: HashMap::new(),
            next_id: 1,
            backlog: VecDeque::new(),
        }
    }

    /// Handle messages until `exit` or the end of the stream.
    ///
    /// # Errors
    ///
    /// When the shutdown is not followed by `exit`.
    pub fn run(&mut self) -> Result<(), ProtocolError> {
        loop {
            let msg = if let Some(m) = self.backlog.pop_front() {
                Some(m)
            } else {
                let deadline = match (self.debounce.next(), self.includes.next_timeout()) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
                let got = match deadline {
                    Some(d) => self.conn.receiver.recv_deadline(d),
                    None => self
                        .conn
                        .receiver
                        .recv()
                        .map_err(|_| RecvTimeoutError::Disconnected),
                };
                match got {
                    Ok(m) => Some(m),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return Ok(()),
                }
            };
            if let Some(m) = msg
                && self.handle(m)? == Flow::Exit
            {
                return Ok(());
            }
            let now = Instant::now();
            for uri in self.debounce.take_due(now) {
                self.analyze(&uri);
            }
            for key in self.includes.expire(now) {
                self.answered(&key);
            }
        }
    }

    fn handle(&mut self, m: Message) -> Result<Flow, ProtocolError> {
        match m {
            Message::Request(r) => {
                if self.conn.handle_shutdown(&r)? {
                    return Ok(Flow::Exit);
                }
                self.request(r);
            }
            Message::Notification(n) => {
                if n.method == notification::Exit::METHOD {
                    return Ok(Flow::Exit);
                }
                self.notification(n);
            }
            Message::Response(r) => self.response(r),
        }
        Ok(Flow::Go)
    }

    fn request(&mut self, r: Request) {
        let id = r.id.clone();
        let result = if r.method == protocol::DIAGNOSTICS {
            parse::<DiagnosticsParams>(r.params).map(|p| self.diagnostics_of(&p.uri))
        } else if let Some(res) = crate::features::request(self, &r.method, &r.params) {
            res
        } else if self.lang.document_methods().contains(&r.method.as_str()) {
            match r.params["textDocument"]["uri"].as_str().map(str::to_string) {
                None => Err("bad params: textDocument.uri missing".to_string()),
                Some(uri) => {
                    self.current(&uri);
                    match self.results.get(&uri) {
                        Some(an) => self.lang.document_request(&r.method, an, &r.params),
                        None => Ok(Value::Null),
                    }
                }
            }
        } else if let Some(res) = self.lang.request(&r.method, &r.params) {
            res
        } else {
            self.reply(Response::new_err(
                id,
                ErrorCode::MethodNotFound as i32,
                format!("unknown method {}", r.method),
            ));
            return;
        };
        match result {
            Ok(v) => self.reply(Response::new_ok(id, v)),
            Err(e) => self.reply(Response::new_err(id, ErrorCode::RequestFailed as i32, e)),
        }
    }

    fn notification(&mut self, n: Notification) {
        match n.method.as_str() {
            notification::DidOpenTextDocument::METHOD => {
                let Ok(p) = parse::<DidOpenTextDocumentParams>(n.params) else {
                    return;
                };
                let uri = p.text_document.uri.as_str().to_string();
                self.docs.insert(
                    uri.clone(),
                    Doc {
                        src: uri::doc_source(&uri),
                        uri: uri.clone(),
                        version: p.text_document.version,
                        text: p.text_document.text,
                    },
                );
                self.debounce.cancel(&uri);
                self.analyze(&uri);
                // Another document's include may now be open.
                self.publish();
            }
            notification::DidChangeTextDocument::METHOD => {
                let Ok(p) = parse::<DidChangeTextDocumentParams>(n.params) else {
                    return;
                };
                let uri = p.text_document.uri.as_str().to_string();
                if let (Some(d), Some(c)) = (
                    self.docs.get_mut(&uri),
                    p.content_changes.into_iter().last(),
                ) {
                    d.text = c.text;
                    d.version = p.text_document.version;
                    self.debounce.touch(&uri, Instant::now());
                }
            }
            notification::DidCloseTextDocument::METHOD => {
                let Ok(p) = parse::<DidCloseTextDocumentParams>(n.params) else {
                    return;
                };
                let uri = p.text_document.uri.as_str().to_string();
                self.docs.remove(&uri);
                self.results.remove(&uri);
                self.waiting.remove(&uri);
                self.debounce.cancel(&uri);
                self.publish();
            }
            protocol::INCLUDES_CHANGED => {
                let p = parse::<IncludesChangedParams>(n.params).unwrap_or_default();
                if self
                    .includes
                    .invalidate(p.connection.as_deref(), p.member.as_ref())
                {
                    let uris: Vec<String> = self.docs.keys().cloned().collect();
                    for u in uris {
                        self.analyze(&u);
                    }
                }
            }
            _ => {}
        }
    }

    fn response(&mut self, r: Response) {
        let Some(key) = self.pending.remove(&r.id) else {
            return;
        };
        let fetched = match r.response_result {
            Ok(v) => serde_json::from_value::<Option<Fetched>>(v).unwrap_or_else(|e| {
                eprintln!(
                    "[warn] {}: a fetchInclude answer did not parse: {e}",
                    self.lang.id()
                );
                None
            }),
            Err(e) => {
                eprintln!(
                    "[warn] {}: fetchInclude failed: {}",
                    self.lang.id(),
                    e.message
                );
                None
            }
        };
        self.includes.answer(key.clone(), fetched);
        self.answered(&key);
    }

    /// `key` is in the cache now: analyze again whatever waited for it.
    fn answered(&mut self, key: &Key) {
        let waiting: Vec<String> = self
            .waiting
            .iter()
            .filter(|(_, ks)| ks.contains(key))
            .map(|(u, _)| u.clone())
            .collect();
        for u in waiting {
            self.analyze(&u);
        }
    }

    /// Bring `uri`'s analysis up to its text before a request answers
    /// from it: a change still waiting out the debounce is analyzed now.
    pub(crate) fn current(&mut self, uri: &str) {
        if self.debounce.waiting(uri) {
            self.debounce.cancel(uri);
            self.analyze(uri);
        }
    }

    /// Analyze `uri` now: keep and publish the result, or ask for the
    /// includes it lacks and wait.
    pub(crate) fn analyze(&mut self, uri: &str) {
        let Some(doc) = self.docs.get(uri) else {
            return;
        };
        let source = Source {
            at: doc.src.at.clone(),
            text: doc.text.clone(),
        };
        let src = doc.src.clone();
        let (analysis, missing) = {
            let lookup = Lookup::new(&self.includes, &src.origin);
            let fetch = |r: &IncludeRequest| lookup.fetch(r);
            let a = self.lang.analyze(&src, &source, &fetch);
            (a, lookup.missing())
        };
        if !missing.is_empty() {
            for k in &missing {
                if !self.includes.asked(k) {
                    self.send_fetch(uri, k.clone());
                }
            }
            self.waiting
                .insert(uri.to_string(), missing.into_iter().collect());
            return;
        }
        self.waiting.remove(uri);
        let includes = &self.includes;
        let analyzed = Analyzed::new(analysis, uri, |i| {
            includes
                .uri(&Key::new(&src.origin, &i.request))
                .map(str::to_string)
        });
        self.results.insert(uri.to_string(), analyzed);
        self.publish();
    }

    fn send_fetch(&mut self, uri: &str, key: Key) {
        let id = self.next_request_id();
        let params = FetchIncludeParams {
            uri: uri.to_string(),
            request: key.request.clone(),
        };
        self.pending.insert(id.clone(), key.clone());
        self.includes.ask(key, Instant::now());
        self.send(Request::new(id, protocol::FETCH_INCLUDE.into(), params).into());
    }

    fn next_request_id(&mut self) -> RequestId {
        let id = RequestId::from(self.next_id);
        self.next_id += 1;
        id
    }

    /// Ask the client and wait for its answer, up to `timeout`; what
    /// arrives meanwhile is handled after.
    pub fn ask_client<P: Serialize>(
        &mut self,
        method: &str,
        params: P,
        timeout: Duration,
    ) -> Option<Value> {
        let id = self.next_request_id();
        self.send(Request::new(id.clone(), method.into(), params).into());
        let deadline = Instant::now() + timeout;
        loop {
            match self.conn.receiver.recv_deadline(deadline) {
                Ok(Message::Response(r)) if r.id == id => return r.response_result.ok(),
                Ok(m) => self.backlog.push_back(m),
                Err(_) => return None,
            }
        }
    }

    /// The open documents `uri` is (the same member writable or
    /// read-only counts).
    fn open_as(&self, uri: &str) -> Vec<String> {
        let base = uri::without_query(uri);
        self.docs
            .keys()
            .filter(|k| *k == uri || uri::without_query(k) == base)
            .cloned()
            .collect()
    }

    /// Publish every URI's diagnostics that changed. A document takes
    /// part once it has a complete analysis; one still waiting for its
    /// includes keeps what it last had.
    pub(crate) fn publish(&mut self) {
        let id = self.lang.id();
        let mut out: BTreeMap<String, Vec<lsp_types::Diagnostic>> = BTreeMap::new();
        for u in self.results.keys() {
            out.insert(u.clone(), Vec::new());
        }
        for (doc, an) in &self.results {
            // (directive line, source) -> (count, highest severity).
            let mut summaries: BTreeMap<(u32, usize), (usize, u8)> = BTreeMap::new();
            for d in &an.analysis.diagnostics {
                let k = an.source_of(&d.at).unwrap_or(0);
                if k == 0 {
                    let l = diagnostics::to_lsp(an.lines_of(0), d, id, doc);
                    push_unique(out.entry(doc.clone()).or_default(), l);
                    continue;
                }
                let targets = an.uris[k]
                    .as_deref()
                    .map(|u| self.open_as(u))
                    .unwrap_or_default();
                if targets.is_empty() {
                    let line = an.top_directive(k).map_or(1, |i| i.span.line);
                    let e = summaries.entry((line, k)).or_insert((0, 0));
                    e.0 += 1;
                    e.1 = e.1.max(d.severity);
                } else {
                    for t in targets {
                        let l = diagnostics::to_lsp(an.lines_of(k), d, id, &t);
                        push_unique(out.entry(t).or_default(), l);
                    }
                }
            }
            for ((line, k), (n, sev)) in summaries {
                let name = uri::display(&an.analysis.sources[k].at);
                let s = diagnostics::summary(an.lines_of(0), line, n, sev, &name, id);
                push_unique(out.entry(doc.clone()).or_default(), s);
            }
        }
        let gone: Vec<String> = self
            .published
            .keys()
            .filter(|u| !out.contains_key(*u) && !self.waiting.contains_key(*u))
            .cloned()
            .collect();
        for u in gone {
            out.insert(u, Vec::new());
        }
        for (u, diags) in out {
            if self.published.get(&u) == Some(&diags) {
                continue;
            }
            let Ok(parsed) = Uri::from_str(&u) else {
                continue;
            };
            let version = self.docs.get(&u).map(|d| d.version);
            let params = PublishDiagnosticsParams::new(parsed, diags.clone(), version);
            self.send(
                Notification::new(notification::PublishDiagnostics::METHOD.into(), params).into(),
            );
            if diags.is_empty() && !self.docs.contains_key(&u) {
                self.published.remove(&u);
            } else {
                self.published.insert(u, diags);
            }
        }
    }

    /// `qs400/diagnostics`: the document's analysis as returned, or
    /// `null` while it is not analyzed on its current text.
    fn diagnostics_of(&self, uri: &str) -> Value {
        if self.debounce.waiting(uri) || self.waiting.contains_key(uri) {
            return Value::Null;
        }
        self.results.get(uri).map_or(Value::Null, |an| {
            let items: Vec<DiagnosticItem> = an
                .analysis
                .diagnostics
                .iter()
                .map(DiagnosticItem::from)
                .collect();
            serde_json::to_value(items).unwrap_or(Value::Null)
        })
    }

    pub(crate) fn reply(&self, r: Response) {
        self.send(r.into());
    }

    fn send(&self, m: Message) {
        // The client went away: the loop sees it on the next receive.
        let _ = self.conn.sender.send(m);
    }
}

fn push_unique(v: &mut Vec<lsp_types::Diagnostic>, d: lsp_types::Diagnostic) {
    if !v.contains(&d) {
        v.push(d);
    }
}

/// A message's params as `P`.
///
/// # Errors
///
/// A message naming what did not parse.
pub fn parse<P: DeserializeOwned>(v: Value) -> Result<P, String> {
    serde_json::from_value(v).map_err(|e| format!("bad params: {e}"))
}
