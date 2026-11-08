// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The editor features over a document's [`Analysis`]: none yet beyond
//! diagnostics.
//!
//! [`Analysis`]: compdiag::front::Analysis

use crate::lang::Language;
use crate::server::Server;
use lsp_types::ServerCapabilities;
use serde_json::Value;

/// Add the features' capabilities.
pub fn capabilities<L: Language>(_lang: &L, _caps: &mut ServerCapabilities) {}

/// Answer a feature request; `None` when `method` is not one.
pub fn request<L: Language>(
    _server: &mut Server<'_, L>,
    _method: &str,
    _params: &Value,
) -> Option<Result<Value, String>> {
    None
}
