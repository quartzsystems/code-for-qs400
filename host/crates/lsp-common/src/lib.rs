// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! What the QS/400 language servers share. Each `lsp-<lang>` crate
//! implements [`Language`] over its front end's `analyze`; this crate
//! runs the loop, keeps the documents, debounces, converts places to
//! LSP positions, maps diagnostics through the one severity table and
//! fetches includes from the client. The server reports what `analyze`
//! returns, nothing filtered and nothing added.

pub mod analyzed;
pub mod debounce;
pub mod diagnostics;
pub mod features;
pub mod includes;
pub mod lang;
pub mod position;
pub mod protocol;
pub mod server;
pub mod testing;
pub mod uri;

pub use analyzed::Analyzed;
pub use lang::{Language, MemberContext, Word, WordKind};
pub use server::{Server, serve_stdio};
