// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The Debug Adapter Protocol messages the adapter reads and writes, as
//! serde types written here. The `dap` crate on crates.io is published
//! only as a pre-release (`0.4.1-alpha1`) and would share this crate's
//! name, so it is not used; these are the requests, bodies and events the
//! adapter answers, nothing more.

use std::io::{self, Write};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::backend::Failure;

/// A message from the client: a request, or (for `qs400/debugSource`) the
/// answer to one of the adapter's events.
#[derive(Debug, Clone, Deserialize)]
pub struct Incoming {
    pub seq: i64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub arguments: Value,
}

/// What `initialize` answers. Nothing the service cannot do is advertised:
/// no function breakpoints, no step back, no restart.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub supports_configuration_done_request: bool,
    pub supports_conditional_breakpoints: bool,
    pub supports_evaluate_for_hovers: bool,
    pub supports_set_variable: bool,
    pub supports_terminate_request: bool,
    pub supports_function_breakpoints: bool,
    pub supports_step_back: bool,
    pub supports_restart_request: bool,
}

/// A source as DAP names it: `path` is a file system path or a URI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackFrame {
    pub id: i64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    pub line: u32,
    pub column: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Thread {
    pub id: i64,
    pub name: String,
}

/// Writes the adapter's messages, numbering them.
pub struct Out {
    inner: Mutex<(Box<dyn Write + Send>, i64)>,
}

impl Out {
    pub fn new(w: Box<dyn Write + Send>) -> Out {
        Out {
            inner: Mutex::new((w, 0)),
        }
    }

    fn send(&self, mut msg: Value) -> io::Result<()> {
        let mut g = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        g.1 += 1;
        msg["seq"] = json!(g.1);
        let body = serde_json::to_vec(&msg).map_err(io::Error::other)?;
        host_rpc::framing::write_frame(&mut g.0, &body)
    }

    /// A success response to `req`.
    pub fn ok(&self, req: &Incoming, body: impl Serialize) {
        let body = serde_json::to_value(body).unwrap_or(Value::Null);
        let mut msg = json!({
            "type": "response",
            "request_seq": req.seq,
            "success": true,
            "command": req.command,
        });
        if !body.is_null() {
            msg["body"] = body;
        }
        let _ = self.send(msg);
    }

    /// A failed response to `req`: the message as `message`, and as the
    /// body's `error` with `showUser` and the server's message ID among its
    /// `variables` (not in its `format`, so nothing is substituted).
    pub fn fail(&self, req: &Incoming, f: &Failure) {
        let mut error = json!({
            "id": 1,
            "format": f.message,
            "showUser": f.show_user,
        });
        if let Some(id) = &f.message_id {
            error["variables"] = json!({ "messageId": id });
        }
        let _ = self.send(json!({
            "type": "response",
            "request_seq": req.seq,
            "success": false,
            "command": req.command,
            "message": f.message,
            "body": { "error": error },
        }));
    }

    pub fn event(&self, event: &str, body: impl Serialize) {
        let body = serde_json::to_value(body).unwrap_or(Value::Null);
        let mut msg = json!({ "type": "event", "event": event });
        if !body.is_null() {
            msg["body"] = body;
        }
        let _ = self.send(msg);
    }

    /// A line in the Debug Console.
    pub fn console(&self, line: &str) {
        self.event(
            "output",
            json!({ "category": "console", "output": format!("{line}\n") }),
        );
    }
}
