// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! A client for tests: a server on a thread of its own over an
//! in-memory connection, the client's side driven from the test. The
//! server's `qs400/fetchInclude` and `qs400/listMembers` are answered
//! by the closures given, and recorded.

use crate::lang::Language;
use crate::protocol::{self, FetchIncludeParams, ListMembersParams};
use crate::server::{Server, capabilities};
use lsp_server::{Connection, Message, Notification, Request, RequestId, Response};
use lsp_types::{Diagnostic, PublishDiagnosticsParams};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How long a test waits for the server.
pub const WAIT: Duration = Duration::from_secs(10);

type Answer<P> = Box<dyn Fn(&P) -> Value + Send>;

/// The client's side.
pub struct Client {
    conn: Connection,
    server: Option<JoinHandle<()>>,
    next: i32,
    fetch: Answer<FetchIncludeParams>,
    members: Answer<ListMembersParams>,
    /// Every `qs400/fetchInclude` the server sent, in order.
    pub fetches: Vec<FetchIncludeParams>,
    /// The last diagnostics published per URI.
    pub published: HashMap<String, Vec<Diagnostic>>,
    /// Every publish, in order: the URI and when it came.
    pub publishes: Vec<(String, Instant)>,
}

impl Client {
    /// Start `lang`'s server with the debounce `delay`, initialized,
    /// every include not found.
    #[must_use]
    pub fn start<L: Language + Send + 'static>(lang: L, delay: Duration) -> Self {
        let (server, client) = Connection::memory();
        let caps = serde_json::to_value(capabilities(&lang)).expect("capabilities");
        let handle = std::thread::spawn(move || {
            if server.initialize(caps).is_ok() {
                let _ = Server::with_delay(&server, lang, delay).run();
            }
        });
        let mut c = Self {
            conn: client,
            server: Some(handle),
            next: 1,
            fetch: Box::new(|_| Value::Null),
            members: Box::new(|_| json!([])),
            fetches: Vec::new(),
            published: HashMap::new(),
            publishes: Vec::new(),
        };
        let r = c.request("initialize", json!({ "capabilities": {} }));
        assert!(r.get("capabilities").is_some(), "{r}");
        c.notify("initialized", json!({}));
        c
    }

    /// Answer `qs400/fetchInclude` with `f`.
    #[must_use]
    pub fn on_fetch(mut self, f: impl Fn(&FetchIncludeParams) -> Value + Send + 'static) -> Self {
        self.fetch = Box::new(f);
        self
    }

    /// Answer `qs400/listMembers` with `f`.
    #[must_use]
    pub fn on_members(mut self, f: impl Fn(&ListMembersParams) -> Value + Send + 'static) -> Self {
        self.members = Box::new(f);
        self
    }

    /// Send a notification.
    pub fn notify(&self, method: &str, params: Value) {
        self.conn
            .sender
            .send(Notification::new(method.into(), params).into())
            .expect("server gone");
    }

    /// Open `uri` with `text`.
    pub fn open(&self, uri: &str, language: &str, text: &str) {
        self.notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": uri, "languageId": language, "version": 1, "text": text } }),
        );
    }

    /// Replace `uri`'s text.
    pub fn change(&self, uri: &str, version: i32, text: &str) {
        self.notify(
            "textDocument/didChange",
            json!({ "textDocument": { "uri": uri, "version": version },
                    "contentChanges": [ { "text": text } ] }),
        );
    }

    /// Close `uri`.
    pub fn close(&self, uri: &str) {
        self.notify(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": uri } }),
        );
    }

    /// Send a request and wait for its result (an error is
    /// `{"error": message}`).
    pub fn request(&mut self, method: &str, params: Value) -> Value {
        let id = RequestId::from(self.next);
        self.next += 1;
        self.conn
            .sender
            .send(Request::new(id.clone(), method.into(), params).into())
            .expect("server gone");
        let deadline = Instant::now() + WAIT;
        loop {
            match self.recv(deadline) {
                Some(Message::Response(r)) if r.id == id => {
                    return match r.response_result {
                        Ok(v) => v,
                        Err(e) => json!({ "error": e.message }),
                    };
                }
                Some(_) => {}
                None => panic!("no answer to {method}"),
            }
        }
    }

    /// Wait until diagnostics are published for `uri`; the last ones.
    pub fn diagnostics(&mut self, uri: &str) -> Vec<Diagnostic> {
        let n = self.publishes.iter().filter(|(u, _)| u == uri).count();
        let deadline = Instant::now() + WAIT;
        while self.publishes.iter().filter(|(u, _)| u == uri).count() == n {
            assert!(self.recv(deadline).is_some(), "no diagnostics for {uri}");
        }
        self.published.get(uri).cloned().unwrap_or_default()
    }

    /// Take messages for `d`, answering the server's requests.
    pub fn settle(&mut self, d: Duration) {
        let deadline = Instant::now() + d;
        while self.recv(deadline).is_some() {}
    }

    /// The next message by `deadline`, after answering it if it is a
    /// request of the server's.
    fn recv(&mut self, deadline: Instant) -> Option<Message> {
        let m = self.conn.receiver.recv_deadline(deadline).ok()?;
        match &m {
            Message::Request(r) if r.method == protocol::FETCH_INCLUDE => {
                let p: FetchIncludeParams =
                    serde_json::from_value(r.params.clone()).expect("params");
                let v = (self.fetch)(&p);
                self.fetches.push(p);
                self.reply(r.id.clone(), v);
            }
            Message::Request(r) if r.method == protocol::LIST_MEMBERS => {
                let p: ListMembersParams =
                    serde_json::from_value(r.params.clone()).expect("params");
                let v = (self.members)(&p);
                self.reply(r.id.clone(), v);
            }
            Message::Notification(n) if n.method == "textDocument/publishDiagnostics" => {
                let p: PublishDiagnosticsParams =
                    serde_json::from_value(n.params.clone()).expect("params");
                let u = p.uri.as_str().to_string();
                self.publishes.push((u.clone(), Instant::now()));
                self.published.insert(u, p.diagnostics);
            }
            _ => {}
        }
        Some(m)
    }

    fn reply(&self, id: RequestId, v: Value) {
        self.conn
            .sender
            .send(Response::new_ok(id, v).into())
            .expect("server gone");
    }

    /// Shut the server down and wait for its thread.
    pub fn stop(mut self) {
        let _ = self.request("shutdown", Value::Null);
        self.notify("exit", Value::Null);
        if let Some(h) = self.server.take() {
            h.join().expect("server thread");
        }
    }
}
