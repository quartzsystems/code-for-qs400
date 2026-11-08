// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! What a document's URI says about its source: a member for
//! `qs400mbr`, a stream file for `qs400ifs` and local files. The URIs
//! are the strings VS Code sends (`Uri.toString()`), so the path is
//! percent-encoded and the authority, the connection, may be lower case.

use compdiag::{MemberName, Where};

/// What a document is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocSource {
    /// The member or stream file, as the compiler names it.
    pub at: Where,
    /// The extension, lower case, without the dot: the member's source
    /// type for `qs400mbr` (through the member type table).
    pub ext: String,
    /// The scheme and connection the document came from
    /// (`qs400mbr://qshq400`), so includes are cached per system; empty
    /// for a local file.
    pub origin: String,
}

/// The URI without its query (`?readonly`).
#[must_use]
pub fn without_query(uri: &str) -> &str {
    uri.split_once('?').map_or(uri, |(u, _)| u)
}

/// What `uri` names.
#[must_use]
pub fn doc_source(uri: &str) -> DocSource {
    let uri = without_query(uri);
    let uri = uri.split_once('#').map_or(uri, |(u, _)| u);
    let (scheme, rest) = uri.split_once("://").unwrap_or(("", uri));
    let (authority, path) = rest
        .find('/')
        .map_or((rest, ""), |i| (&rest[..i], &rest[i..]));
    let path = decode(path);
    let ext = path
        .rsplit('/')
        .next()
        .and_then(|n| n.rsplit_once('.'))
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    let origin = format!("{scheme}://{}", decode(authority).to_ascii_lowercase());
    match scheme {
        "qs400mbr" => {
            let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
            let at = match parts.as_slice() {
                [lib, file, mbr] => {
                    let member = mbr.rsplit_once('.').map_or(*mbr, |(m, _)| m);
                    Where::Member(MemberName {
                        library: lib.to_ascii_uppercase(),
                        file: file.to_ascii_uppercase(),
                        member: member.to_ascii_uppercase(),
                    })
                }
                _ => Where::None,
            };
            DocSource { at, ext, origin }
        }
        "qs400ifs" => DocSource {
            at: Where::Path(path),
            ext,
            origin,
        },
        _ => DocSource {
            at: Where::Path(path),
            ext,
            origin: String::new(),
        },
    }
}

/// `%XX` decoded; an invalid escape is kept as written.
#[must_use]
pub fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len() + 1
            && let Some(v) = b
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// How the compiler names a source for a message: `LIB/FILE(MEMBER)`,
/// or the path.
#[must_use]
pub fn display(at: &Where) -> String {
    match at {
        Where::Member(m) => format!("{}/{}({})", m.library, m.file, m.member),
        Where::Path(p) => p.clone(),
        Where::None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_member() {
        let d = doc_source("qs400mbr://qshq400/HLINV/QRPGLESRC/ASSETS.rpgle?readonly");
        assert_eq!(
            d.at,
            Where::Member(MemberName {
                library: "HLINV".into(),
                file: "QRPGLESRC".into(),
                member: "ASSETS".into(),
            })
        );
        assert_eq!(d.ext, "rpgle");
        assert_eq!(d.origin, "qs400mbr://qshq400");
        assert_eq!(display(&d.at), "HLINV/QRPGLESRC(ASSETS)");
    }

    #[test]
    fn names_with_escapes() {
        let d = doc_source("qs400mbr://QSHQ400/MY%24LIB/QSRC/%23CP%40Y.rpgle");
        assert_eq!(display(&d.at), "MY$LIB/QSRC(#CP@Y)");
    }

    #[test]
    fn stream_files_and_local_files() {
        let d = doc_source("qs400ifs://qshq400/home/CWELLMAN/src/a%20b.sqlrpgle");
        assert_eq!(d.at, Where::Path("/home/CWELLMAN/src/a b.sqlrpgle".into()));
        assert_eq!(d.ext, "sqlrpgle");
        let d = doc_source("file:///c%3A/work/inv/ITEMMST.PF");
        assert_eq!(d.at, Where::Path("/c:/work/inv/ITEMMST.PF".into()));
        assert_eq!(d.ext, "pf");
        assert_eq!(d.origin, "");
    }

    #[test]
    fn a_bad_escape_is_kept() {
        assert_eq!(decode("a%2"), "a%2");
        assert_eq!(decode("a%zz"), "a%zz");
    }
}
