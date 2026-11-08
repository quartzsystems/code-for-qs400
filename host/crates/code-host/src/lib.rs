// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The `qs400-code-host` method set.

pub mod session;

use std::sync::Arc;

use host_rpc::{Context, NoParams, Outbound, Registry, RpcError};
use serde::{Deserialize, Serialize};

/// Host version (semver), from the crate.
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
/// QS/400 release this host is built for.
pub const PRODUCT_VERSION: &str = "V1R0M0";
/// The newest QAP version this host speaks: what every connection asks
/// for in `Hello`. Each session reports the version its server agreed.
pub const QAP_VERSION: u32 = session::QAP_ASKED as u32;

/// The `--version` line, after the program name.
pub const VERSION_LINE: &str = concat!(env!("CARGO_PKG_VERSION"), " (QS/400 V1R0M0, QAP v9)");

/// Result of `host.version`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionResult {
    pub host: String,
    pub product: String,
    pub qap: u32,
}

/// Params and result of `host.ping`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ping {
    pub nonce: String,
}

/// Level of a `host.log` notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

/// Params of the `host.log` notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogParams {
    pub level: LogLevel,
    pub message: String,
}

/// Writes a log line to stderr and sends it as `host.log`.
pub fn log(outbound: &Outbound, level: LogLevel, message: impl Into<String>) {
    let message = message.into();
    let tag = match level {
        LogLevel::Info => "info",
        LogLevel::Warn => "warn",
        LogLevel::Error => "error",
    };
    eprintln!("[{tag}] {message}");
    let _ = outbound.notify("host.log", &LogParams { level, message });
}

/// Every method this release serves, with sessions over QAP. Session
/// notifications go to `outbound`, the stream [`host_rpc::serve`] answers on.
pub fn registry(outbound: &Outbound) -> Registry {
    let sessions = session::Sessions::new(session::qap_factory(), outbound.clone());
    sessions.watch();
    registry_with(&sessions)
}

/// Every method, with `sessions` behind `session.*` and `libl.*`.
pub fn registry_with(sessions: &Arc<session::Sessions>) -> Registry {
    let mut r = Registry::new();
    session::register(&mut r, sessions);
    r.register("host.version", |_: NoParams, _: &Context| {
        Ok::<_, RpcError>(VersionResult {
            host: HOST_VERSION.to_owned(),
            product: PRODUCT_VERSION.to_owned(),
            qap: QAP_VERSION,
        })
    });
    r.register("host.ping", |p: Ping, _: &Context| Ok::<_, RpcError>(p));
    r.register("host.shutdown", |_: NoParams, ctx: &Context| {
        log(ctx.outbound(), LogLevel::Info, "shutdown requested");
        ctx.request_exit();
        Ok::<_, RpcError>(())
    });
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use host_rpc::framing::{read_frame, write_frame};
    use host_rpc::{Exit, codes, serve};
    use serde_json::{Value, json};
    use std::io::{self, Cursor, Write};
    use std::sync::{Arc, Mutex};

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

    fn call(requests: &[Value]) -> (Exit, Vec<Value>) {
        let mut input = Vec::new();
        for r in requests {
            write_frame(&mut input, &serde_json::to_vec(r).unwrap()).unwrap();
        }
        let sink = Sink::default();
        let outbound = Outbound::new(sink.clone());
        let exit = serve(&registry(&outbound), &mut Cursor::new(input), outbound).unwrap();
        let bytes = sink.0.lock().unwrap().clone();
        let mut r = Cursor::new(bytes);
        let mut out = Vec::new();
        while let Some(b) = read_frame(&mut r).unwrap() {
            out.push(serde_json::from_slice(&b).unwrap());
        }
        (exit, out)
    }

    #[test]
    fn version() {
        let (_, out) = call(&[json!({"jsonrpc":"2.0","id":1,"method":"host.version"})]);
        assert_eq!(
            out,
            vec![
                json!({"jsonrpc":"2.0","id":1,"result":{"host":"1.0.0","product":"V1R0M0","qap":9}})
            ]
        );
    }

    #[test]
    fn version_line_matches_constants() {
        assert_eq!(
            VERSION_LINE,
            format!("{HOST_VERSION} (QS/400 {PRODUCT_VERSION}, QAP v{QAP_VERSION})")
        );
    }

    #[test]
    fn ping_echoes_nonce() {
        let (_, out) = call(&[
            json!({"jsonrpc":"2.0","id":"p","method":"host.ping","params":{"nonce":"abc-123"}}),
        ]);
        assert_eq!(
            out,
            vec![json!({"jsonrpc":"2.0","id":"p","result":{"nonce":"abc-123"}})]
        );
    }

    #[test]
    fn ping_without_nonce_is_invalid_params() {
        let (_, out) = call(&[json!({"jsonrpc":"2.0","id":2,"method":"host.ping","params":{}})]);
        assert_eq!(out[0]["error"]["code"], json!(codes::INVALID_PARAMS));
    }

    #[test]
    fn shutdown_replies_null_then_exits() {
        let (exit, out) = call(&[
            json!({"jsonrpc":"2.0","id":9,"method":"host.shutdown"}),
            json!({"jsonrpc":"2.0","id":10,"method":"host.version"}),
        ]);
        assert_eq!(exit, Exit::Requested);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["method"], json!("host.log"));
        assert_eq!(out[0]["params"]["level"], json!("info"));
        assert_eq!(out[1], json!({"jsonrpc":"2.0","id":9,"result":null}));
    }

    #[test]
    fn registry_lists_methods() {
        assert_eq!(
            registry(&Outbound::new(io::sink())).method_names(),
            vec![
                "host.ping",
                "host.shutdown",
                "host.version",
                "libl.get",
                "libl.set",
                "session.changePassword",
                "session.connect",
                "session.disconnect",
                "session.list",
                "session.status",
            ]
        );
    }

    #[test]
    fn qap_version_is_the_one_asked_for() {
        assert_eq!(QAP_VERSION, 9);
        // What qap-proto defines, so asking for it is asking for all of it.
        assert_eq!(qap_client::proto::VERSION, 9);
    }
}
