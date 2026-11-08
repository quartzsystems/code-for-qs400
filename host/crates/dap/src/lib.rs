// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `qs400-code-host dap`: a Debug Adapter Protocol server over stdio, one
//! process per debug session, bridging DAP to QAP version 9's `Debug`
//! service on a QAP connection of its own.
//!
//! - The connection is the adapter's, signed on with the credentials the
//!   extension puts in the `launch` or `attach` arguments (never on the
//!   command line). It is not `serve`'s session: a `RunCommand` whose
//!   program stops under `Own` gets no reply while it is stopped, so the
//!   debugged `CALL` runs here and holds up nothing in the editor.
//! - Each DAP request is one `Debug` operation through [`DebugBackend`]
//!   (`qap-client`'s `Debugger`, made object-safe); nothing is invented.
//!   The events `Stopped` and `DebugEnded` are drained on a thread of their
//!   own and sent in the order they came.
//! - Messages are hand-written serde types ([`protocol`]) in the
//!   `Content-Length` framing the language servers use.

pub mod adapter;
pub mod backend;
pub mod protocol;

pub use adapter::{Options, serve};
pub use backend::{Connect, Credentials, DebugBackend, Failure, RunningCommand};
