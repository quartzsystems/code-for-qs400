// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! Method registry and the serve loop.

use crate::framing::{read_frame, write_frame};
use crate::message::{Incoming, RpcError, notification, response_err, response_ok};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::cell::Cell;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};

/// Shared, thread-safe handle on the outgoing stream. Responses and
/// notifications go through it so frames never interleave.
#[derive(Clone)]
pub struct Outbound {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl Outbound {
    pub fn new<W: Write + Send + 'static>(writer: W) -> Self {
        Self {
            writer: Arc::new(Mutex::new(Box::new(writer))),
        }
    }

    /// Writes one JSON value as a frame.
    pub fn send(&self, value: &Value) -> io::Result<()> {
        let body = serde_json::to_vec(value).map_err(io::Error::other)?;
        let mut w = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("outbound writer poisoned"))?;
        write_frame(&mut *w, &body)
    }

    /// Sends a notification with typed params.
    pub fn notify<P: Serialize>(&self, method: &str, params: &P) -> io::Result<()> {
        let params = serde_json::to_value(params).map_err(io::Error::other)?;
        self.send(&notification(method, &params))
    }
}

/// What a handler sees besides its params.
pub struct Context {
    outbound: Outbound,
    exit: Cell<bool>,
}

impl Context {
    /// The outgoing stream, for notifications.
    pub fn outbound(&self) -> &Outbound {
        &self.outbound
    }

    /// Ends the serve loop once the current response is written.
    pub fn request_exit(&self) {
        self.exit.set(true);
    }
}

type Handler = Box<dyn Fn(Value, &Context) -> Result<Value, RpcError> + Send + Sync>;

/// Methods keyed by name.
#[derive(Default)]
pub struct Registry {
    methods: HashMap<String, Handler>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a typed method. Params that do not deserialize into `P`
    /// are answered with `-32602 Invalid params`.
    ///
    /// # Panics
    /// If `name` is already registered.
    pub fn register<P, R, F>(&mut self, name: &str, handler: F)
    where
        P: DeserializeOwned,
        R: Serialize,
        F: Fn(P, &Context) -> Result<R, RpcError> + Send + Sync + 'static,
    {
        let wrapped: Handler = Box::new(move |params, ctx| {
            let p: P = serde_json::from_value(params)
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let r = handler(p, ctx)?;
            serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
        });
        let previous = self.methods.insert(name.to_owned(), wrapped);
        assert!(previous.is_none(), "method registered twice: {name}");
    }

    /// Names of every registered method, sorted.
    pub fn method_names(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self.methods.keys().map(String::as_str).collect();
        v.sort_unstable();
        v
    }

    /// Calls a method by name.
    pub fn dispatch(&self, method: &str, params: Value, ctx: &Context) -> Result<Value, RpcError> {
        let handler = self
            .methods
            .get(method)
            .ok_or_else(|| RpcError::method_not_found(method))?;
        match catch_unwind(AssertUnwindSafe(|| handler(params, ctx))) {
            Ok(r) => r,
            Err(_) => Err(RpcError::internal(format!("handler for {method} panicked"))),
        }
    }
}

/// Why [`serve`] returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    /// The input stream closed.
    EndOfStream,
    /// A handler called [`Context::request_exit`].
    Requested,
}

/// Reads frames from `reader` until end of stream or an exit request,
/// dispatching each to `registry` and answering on `outbound`.
pub fn serve<R: BufRead>(
    registry: &Registry,
    reader: &mut R,
    outbound: Outbound,
) -> io::Result<Exit> {
    let ctx = Context {
        outbound,
        exit: Cell::new(false),
    };
    while let Some(body) = read_frame(reader)? {
        let reply = match serde_json::from_slice::<Value>(&body) {
            Err(e) => Some(response_err(
                &Value::Null,
                &RpcError::parse_error(e.to_string()),
            )),
            Ok(value) => match Incoming::from_value(value) {
                Err((id, err)) => Some(response_err(&id, &err)),
                Ok(Incoming::Request { id, method, params }) => {
                    Some(match registry.dispatch(&method, params, &ctx) {
                        Ok(result) => response_ok(&id, &result),
                        Err(err) => response_err(&id, &err),
                    })
                }
                Ok(Incoming::Notification { method, params }) => {
                    // Notifications are never answered, errors included.
                    let _ = registry.dispatch(&method, params, &ctx);
                    None
                }
                Ok(Incoming::Response { .. }) => None,
            },
        };
        if let Some(reply) = reply {
            ctx.outbound.send(&reply)?;
        }
        if ctx.exit.get() {
            return Ok(Exit::Requested);
        }
    }
    Ok(Exit::EndOfStream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{NoParams, codes};
    use serde::Deserialize;
    use serde_json::json;
    use std::io::Cursor;

    /// A writer whose bytes the test can read back.
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn frames(values: &[Value]) -> Cursor<Vec<u8>> {
        let mut buf = Vec::new();
        for v in values {
            write_frame(&mut buf, &serde_json::to_vec(v).unwrap()).unwrap();
        }
        Cursor::new(buf)
    }

    fn read_all(sink: &Sink) -> Vec<Value> {
        let bytes = sink.0.lock().unwrap().clone();
        let mut r = Cursor::new(bytes);
        let mut out = Vec::new();
        while let Some(b) = read_frame(&mut r).unwrap() {
            out.push(serde_json::from_slice(&b).unwrap());
        }
        out
    }

    #[derive(Deserialize)]
    struct Add {
        a: i64,
        b: i64,
    }

    fn registry() -> Registry {
        let mut r = Registry::new();
        r.register("t.add", |p: Add, _| Ok(p.a + p.b));
        r.register("t.fail", |_: NoParams, _| -> Result<(), _> {
            Err(RpcError::new(-1, "nope"))
        });
        r.register("t.notify", |_: NoParams, ctx| {
            ctx.outbound().notify("t.event", &json!({"k": 1})).unwrap();
            Ok(())
        });
        r.register("t.stop", |_: NoParams, ctx| {
            ctx.request_exit();
            Ok(Value::Null)
        });
        r.register("t.panic", |_: NoParams, _| -> Result<(), RpcError> {
            panic!("boom")
        });
        r
    }

    fn run(input: &[Value]) -> (Exit, Vec<Value>) {
        let sink = Sink::default();
        let exit = serve(&registry(), &mut frames(input), Outbound::new(sink.clone())).unwrap();
        (exit, read_all(&sink))
    }

    #[test]
    fn typed_request_round_trip() {
        let (exit, out) =
            run(&[json!({"jsonrpc":"2.0","id":1,"method":"t.add","params":{"a":2,"b":3}})]);
        assert_eq!(exit, Exit::EndOfStream);
        assert_eq!(out, vec![json!({"jsonrpc":"2.0","id":1,"result":5})]);
    }

    #[test]
    fn errors_carry_codes() {
        let (_, out) = run(&[
            json!({"jsonrpc":"2.0","id":1,"method":"t.nope"}),
            json!({"jsonrpc":"2.0","id":2,"method":"t.add","params":{"a":"x"}}),
            json!({"jsonrpc":"2.0","id":3,"method":"t.fail"}),
            json!({"jsonrpc":"2.0","id":4,"method":"t.panic"}),
            json!({"id":5,"method":"t.add"}),
        ]);
        let codes: Vec<i64> = out
            .iter()
            .map(|v| v["error"]["code"].as_i64().unwrap())
            .collect();
        assert_eq!(
            codes,
            vec![
                codes::METHOD_NOT_FOUND,
                codes::INVALID_PARAMS,
                -1,
                codes::INTERNAL_ERROR,
                codes::INVALID_REQUEST
            ]
        );
        let ids: Vec<Value> = out.iter().map(|v| v["id"].clone()).collect();
        assert_eq!(ids, vec![json!(1), json!(2), json!(3), json!(4), json!(5)]);
    }

    #[test]
    fn parse_error_answers_null_id() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"{not json").unwrap();
        let sink = Sink::default();
        serve(
            &registry(),
            &mut Cursor::new(buf),
            Outbound::new(sink.clone()),
        )
        .unwrap();
        let out = read_all(&sink);
        assert_eq!(out[0]["id"], Value::Null);
        assert_eq!(out[0]["error"]["code"], json!(codes::PARSE_ERROR));
    }

    #[test]
    fn notifications_are_not_answered() {
        let (_, out) = run(&[
            json!({"jsonrpc":"2.0","method":"t.add","params":{"a":1,"b":1}}),
            json!({"jsonrpc":"2.0","method":"t.unknown"}),
        ]);
        assert!(out.is_empty());
    }

    #[test]
    fn handler_notification_precedes_response() {
        let (_, out) = run(&[json!({"jsonrpc":"2.0","id":"n","method":"t.notify"})]);
        assert_eq!(
            out,
            vec![
                json!({"jsonrpc":"2.0","method":"t.event","params":{"k":1}}),
                json!({"jsonrpc":"2.0","id":"n","result":null}),
            ]
        );
    }

    #[test]
    fn exit_after_reply() {
        let (exit, out) = run(&[
            json!({"jsonrpc":"2.0","id":1,"method":"t.stop"}),
            json!({"jsonrpc":"2.0","id":2,"method":"t.add","params":{"a":1,"b":1}}),
        ]);
        assert_eq!(exit, Exit::Requested);
        assert_eq!(out, vec![json!({"jsonrpc":"2.0","id":1,"result":null})]);
    }

    #[test]
    fn method_names_sorted() {
        assert_eq!(
            registry().method_names(),
            vec!["t.add", "t.fail", "t.notify", "t.panic", "t.stop"]
        );
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn duplicate_registration_panics() {
        let mut r = Registry::new();
        r.register("x", |_: NoParams, _| Ok(()));
        r.register("x", |_: NoParams, _| Ok(()));
    }
}
