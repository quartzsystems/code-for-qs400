// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The messages beyond LSP's own, between a language server and the
//! extension. The server never reads the network: everything from the
//! system comes through these. Keep in step with
//! `src/languages/protocol.ts`.
//!
//! - `qs400/fetchInclude` (server to client): the source a `/COPY` or
//!   `/INCLUDE` asks for, or `null`.
//! - `qs400/listMembers` (server to client): a source file's members,
//!   for completion after `/COPY`.
//! - `qs400/includesChanged` (client to server): a member or stream
//!   file was saved; fetched copies of it are dropped.
//! - `qs400/diagnostics` (client to server): a document's diagnostics
//!   exactly as `analyze` returned them, every source, for the parity
//!   test.

use compdiag::front::IncludeRequest;
use compdiag::{Diagnostic, MemberName, Where};
use serde::{Deserialize, Serialize};

/// `qs400/fetchInclude`.
pub const FETCH_INCLUDE: &str = "qs400/fetchInclude";
/// `qs400/listMembers`.
pub const LIST_MEMBERS: &str = "qs400/listMembers";
/// `qs400/includesChanged`.
pub const INCLUDES_CHANGED: &str = "qs400/includesChanged";
/// `qs400/diagnostics`.
pub const DIAGNOSTICS: &str = "qs400/diagnostics";

/// A source's place, as the host's compile diagnostics name it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum At {
    /// A member.
    Member {
        /// The library.
        library: String,
        /// The source file.
        file: String,
        /// The member.
        member: String,
    },
    /// A stream file.
    Path {
        /// The path.
        path: String,
    },
    /// Nowhere.
    None,
}

impl From<&Where> for At {
    fn from(w: &Where) -> Self {
        match w {
            Where::Member(m) => Self::Member {
                library: m.library.clone(),
                file: m.file.clone(),
                member: m.member.clone(),
            },
            Where::Path(p) => Self::Path { path: p.clone() },
            Where::None => Self::None,
        }
    }
}

impl From<&At> for Where {
    fn from(a: &At) -> Self {
        match a {
            At::Member {
                library,
                file,
                member,
            } => Self::Member(MemberName {
                library: library.trim().to_ascii_uppercase(),
                file: file.trim().to_ascii_uppercase(),
                member: member.trim().to_ascii_uppercase(),
            }),
            At::Path { path } => Self::Path(path.clone()),
            At::None => Self::None,
        }
    }
}

/// What a directive asks for, as sent.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Request {
    /// The library, `*LIBL` when not given; empty for a stream file.
    pub library: String,
    /// The source file; for a stream file, the including stream file's
    /// directory.
    pub file: String,
    /// The member; empty for a stream file.
    pub member: String,
    /// The path as written, for a stream file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl From<&IncludeRequest> for Request {
    fn from(r: &IncludeRequest) -> Self {
        Self {
            library: r.library.clone(),
            file: r.file.clone(),
            member: r.member.clone(),
            path: r.path.clone(),
        }
    }
}

/// Params of `qs400/fetchInclude`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FetchIncludeParams {
    /// The document whose analysis asks (its connection is the one to
    /// read from).
    pub uri: String,
    /// What the directive asks for.
    pub request: Request,
}

/// Result of `qs400/fetchInclude`, when found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fetched {
    /// The URI to open it at (a member's read-only URI).
    pub uri: String,
    /// Where it is: for `*LIBL`, the library it was found in.
    pub at: At,
    /// Its text.
    pub text: String,
}

/// Params of `qs400/listMembers`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListMembersParams {
    /// The document asking.
    pub uri: String,
    /// The library, `*LIBL` when not written.
    pub library: String,
    /// The source file.
    pub file: String,
}

/// One entry of `qs400/listMembers`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberItem {
    /// The member.
    pub member: String,
    /// Its source type.
    #[serde(rename = "type", default)]
    pub ty: String,
    /// Its text.
    #[serde(default)]
    pub text: String,
}

/// Params of `qs400/includesChanged`: what was saved. Nothing given is
/// everything.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncludesChangedParams {
    /// The connection (any case); absent for every one.
    #[serde(default)]
    pub connection: Option<String>,
    /// The member saved.
    #[serde(default)]
    pub member: Option<At>,
}

/// Params of `qs400/diagnostics`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticsParams {
    /// The document.
    pub uri: String,
}

/// One diagnostic as `analyze` returned it, shaped as the host's
/// compile diagnostics are (`action.run`), so the two compare directly.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticItem {
    /// The source it points into.
    pub at: At,
    /// From 1; 0 unknown.
    pub line: u32,
    /// From 1; 0 unknown.
    pub column: u16,
    /// 0 when it is `line`.
    pub end_line: u32,
    /// The last column; 0 unknown.
    pub end_column: u16,
    /// 0 to 99.
    pub severity: u8,
    /// The message ID.
    pub id: String,
    /// The first-level text.
    pub text: String,
    /// The second-level text.
    pub help: String,
}

impl From<&Diagnostic> for DiagnosticItem {
    fn from(d: &Diagnostic) -> Self {
        Self {
            at: At::from(&d.at),
            line: d.line,
            column: d.column,
            end_line: d.end_line,
            end_column: d.end_column,
            severity: d.severity,
            id: d.id.clone(),
            text: d.text.clone(),
            help: d.help.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn at_is_the_hosts_shape() {
        let w = Where::Member(MemberName {
            library: "HLINV".into(),
            file: "QRPGLESRC".into(),
            member: "ASSETS".into(),
        });
        assert_eq!(
            serde_json::to_value(At::from(&w)).unwrap(),
            json!({ "kind": "member", "library": "HLINV", "file": "QRPGLESRC", "member": "ASSETS" })
        );
        assert_eq!(
            serde_json::to_value(At::from(&Where::Path("/a".into()))).unwrap(),
            json!({ "kind": "path", "path": "/a" })
        );
        assert_eq!(
            serde_json::to_value(At::from(&Where::None)).unwrap(),
            json!({ "kind": "none" })
        );
    }

    #[test]
    fn a_fetch_answer_parses() {
        let f: Option<Fetched> = serde_json::from_value(json!({
            "uri": "qs400mbr://qshq400/HLINV/QRPGLESRC/ASSETSCP.rpgle?readonly",
            "at": { "kind": "member", "library": "hlinv", "file": "QRPGLESRC", "member": "ASSETSCP" },
            "text": "     D X               S              1A\n"
        }))
        .unwrap();
        let f = f.unwrap();
        assert_eq!(
            Where::from(&f.at),
            Where::Member(MemberName {
                library: "HLINV".into(),
                file: "QRPGLESRC".into(),
                member: "ASSETSCP".into(),
            })
        );
        let none: Option<Fetched> = serde_json::from_value(json!(null)).unwrap();
        assert!(none.is_none());
    }
}
