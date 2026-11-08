// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! JSON-RPC 2.0 over `Content-Length` framed byte streams.
//!
//! This crate knows nothing about any particular product: it frames
//! messages, classifies them, and dispatches requests to typed handlers in
//! a [`Registry`]. The same framing serves the host's own protocol and,
//! later, language servers.

pub mod framing;
pub mod message;
pub mod server;

pub use message::{Incoming, NoParams, RpcError, codes};
pub use server::{Context, Exit, Outbound, Registry, Responder, serve};
