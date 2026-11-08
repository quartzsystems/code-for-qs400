// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `ifs.*`: integrated file system files, thin over `qap-client`'s
//! [`qap_client::Files`] and its `read` and `write` helpers, through
//! [`Sessions::ifs`] (QAP version 5; `Stat` 6).
//!
//! - Every method names its connection first (`name`). Paths go as typed:
//!   the server resolves them, `/QSYS.LIB` included; nothing here maps a
//!   path or shells out.
//! - Text is converted by the server: reads ask for CCSID 1208
//!   (`ReadOptions::as_ccsid`), writes send 1208 (`WriteOptions::data_ccsid`)
//!   for the system to convert to the file's CCSID. A file that cannot be
//!   converted (65535), or a character its CCSID lacks, is the server's
//!   `TCP1A5A`, passed through unchanged.
//! - A text read answers the file's `change`, the stamp
//!   ([`qap_client::ifs::Stamp`]) taken before the data is read, so a
//!   change in between is seen as one. A write with `expect` refuses with
//!   [`codes::CHANGED`] when the stamp differs, before sending anything.
//! - Text documents are capped at [`TEXT_LIMIT`] file bytes.

use std::io::Cursor;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use host_rpc::{Context, Registry, RpcError};
use qap_client::ifs::{self, End, ReadOptions, Stamp, UTF8, WriteOptions};
use qap_client::proto::Status;
use qap_client::proto::ops::ifs::{Entry, EntryKind, WriteMode};
use qap_client::{Error, Pending};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::session::Sessions;

/// JSON-RPC error codes of `ifs.*`, beside the session codes.
pub mod codes {
    /// `ifs.writeText` with `expect`: the file changed on the system since
    /// it was read. `data` is `{ change }`, the stamp now (null when the
    /// file is gone).
    pub const CHANGED: i64 = -32020;
    /// `ifs.readText` of a file over [`super::TEXT_LIMIT`]. `data` is
    /// `{ size, limit }`.
    pub const TOO_LARGE: i64 = -32021;
    /// A transfer was cancelled. `data` is `{ transfer, offset }`: the
    /// bytes the system (upload) or the local file (download) has.
    pub const CANCELLED: i64 = -32022;
    /// `ifs.resolve`: more than [`super::MAX_LINKS`] symbolic links in a
    /// row.
    pub const LINK_LOOP: i64 = -32023;
}

/// The most file bytes `ifs.readText` reads: 10 MiB.
pub const TEXT_LIMIT: u64 = 10 << 20;

/// The most symbolic links `ifs.resolve` follows in a row.
pub const MAX_LINKS: usize = 16;

/// What an entry is, as JSON names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KindDto {
    File,
    Directory,
    Symlink,
    Other,
}

impl From<EntryKind> for KindDto {
    fn from(k: EntryKind) -> KindDto {
        match k {
            EntryKind::File => KindDto::File,
            EntryKind::Directory => KindDto::Directory,
            EntryKind::Symlink => KindDto::Symlink,
            EntryKind::Other => KindDto::Other,
        }
    }
}

/// An `ifs.list` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryDto {
    pub name: String,
    pub kind: KindDto,
    /// Bytes.
    pub size: u64,
    /// Milliseconds since 1970-01-01 UTC.
    pub modified: i64,
    pub owner: String,
    pub ccsid: u16,
    /// A symbolic link's target, as stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl From<Entry> for EntryDto {
    fn from(e: Entry) -> EntryDto {
        EntryDto {
            name: e.name,
            kind: e.kind.into(),
            size: e.size,
            modified: e.modified,
            owner: e.owner,
            ccsid: e.ccsid,
            target: e.target,
        }
    }
}

/// Result of `ifs.info`: the entry and its `change`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InfoDto {
    #[serde(flatten)]
    pub entry: EntryDto,
    pub change: String,
}

/// A stamp as JSON carries it: a string, since `Stat`'s counter is a u64
/// a JSON number cannot always hold. `Stat`'s counter is its digits;
/// before version 6, `GetInfo`'s `modified` is `m` and its digits. The
/// extension only compares it.
pub fn change_text(s: Stamp) -> String {
    match s {
        Stamp::Change(n) => n.to_string(),
        Stamp::Modified(ms) => format!("m{ms}"),
    }
}

/// Params of `ifs.list`.
#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub name: String,
    pub path: String,
    /// `*` and `?` wildcards; absent or empty for every entry.
    #[serde(default)]
    pub pattern: Option<String>,
}

/// Params of the methods that take one path.
#[derive(Debug, Deserialize)]
pub struct PathParams {
    pub name: String,
    pub path: String,
}

/// Result of `ifs.readText`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextDto {
    pub text: String,
    /// The file's own CCSID.
    pub ccsid: u16,
    /// The file's size in its own bytes.
    pub size: u64,
    pub change: String,
}

/// How `ifs.writeText` and `ifs.upload` start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// The file must not exist (`Exists` otherwise).
    Create,
    /// Created, or emptied first.
    Replace,
    /// `ifs.upload` only: on from the size the system has.
    Resume,
}

/// Params of `ifs.writeText`.
#[derive(Debug, Deserialize)]
pub struct WriteTextParams {
    pub name: String,
    pub path: String,
    pub text: String,
    /// The CCSID of a file created; absent for 1208. An existing file
    /// keeps its own.
    #[serde(default)]
    pub ccsid: Option<u16>,
    pub mode: Mode,
    /// The `change` the text was read with: refused with
    /// [`codes::CHANGED`] when the file's is different now.
    #[serde(default)]
    pub expect: Option<String>,
}

/// Result of `ifs.writeText`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrittenDto {
    /// The file's size in its own CCSID.
    pub size: u64,
    pub change: String,
}

/// Params of `ifs.mkdir`.
#[derive(Debug, Deserialize)]
pub struct MkdirParams {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub parents: bool,
}

/// Params of `ifs.rename` and `ifs.copy`.
#[derive(Debug, Deserialize)]
pub struct FromToParams {
    pub name: String,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub replace: bool,
}

/// Result of `ifs.resolve`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedDto {
    pub path: String,
}

/// A path as typed; only an empty one is refused, before anything is sent.
fn path_param<'a>(field: &str, p: &'a str) -> Result<&'a str, RpcError> {
    if p.is_empty() {
        return Err(RpcError::invalid_params(format!("{field} is empty")));
    }
    Ok(p)
}

fn not_found(e: &Error) -> bool {
    e.status() == Some(Status::NotFound)
}

/// What a `send` closure for `qap_client::ifs::read` or `write` reports
/// when the session could not send: the host's own error, kept aside so
/// it comes back as it was, not as `qap-client`'s.
pub(crate) struct SendFailure(Option<RpcError>);

impl SendFailure {
    pub(crate) fn new() -> SendFailure {
        SendFailure(None)
    }

    /// `r`, with an error kept and a stand-in handed to `qap-client`.
    pub(crate) fn keep(&mut self, r: Result<Pending, RpcError>) -> Result<Pending, Error> {
        r.map_err(|e| {
            let text = e.message.clone();
            self.0 = Some(e);
            Error::Protocol(text)
        })
    }

    /// The error a helper ended with, as the host answers it: the one
    /// kept, when the stand-in is what came back.
    pub(crate) fn error(self, e: &Error) -> RpcError {
        self.0.unwrap_or_else(|| crate::session::rpc_error(e))
    }
}

/// `ifs.list`: every entry, drained a page of 500 at a time.
pub fn list(s: &Sessions, p: &ListParams) -> Result<Vec<EntryDto>, RpcError> {
    let path = path_param("path", &p.path)?;
    let pattern = p.pattern.as_deref().unwrap_or("");
    let entries = s.ifs(&p.name, |f| f.all_entries(path, pattern))?;
    Ok(entries.into_iter().map(EntryDto::from).collect())
}

/// `ifs.info`: the entry (a link itself) and its `change`.
pub fn info(s: &Sessions, p: &PathParams) -> Result<InfoDto, RpcError> {
    let path = path_param("path", &p.path)?;
    let (entry, stamp) = s.ifs(&p.name, |f| f.stamp(path))?;
    Ok(InfoDto {
        entry: entry.into(),
        change: change_text(stamp),
    })
}

/// `ifs.readText`: the file converted by the server to UTF-8, with the
/// stamp taken before the data.
pub fn read_text(s: &Sessions, p: &PathParams) -> Result<TextDto, RpcError> {
    let path = path_param("path", &p.path)?;
    let (_, entry, stamp) = s.ifs(&p.name, |f| f.checked(path))?;
    if entry.size > TEXT_LIMIT {
        let mut e = RpcError::new(
            codes::TOO_LARGE,
            format!(
                "{path} is {} bytes; a text document is at most {TEXT_LIMIT} bytes",
                entry.size
            ),
        );
        e.data = Some(json!({ "size": entry.size, "limit": TEXT_LIMIT }));
        return Err(e);
    }
    let mut data = Vec::with_capacity(usize::try_from(entry.size).unwrap_or(0));
    let mut failure = SendFailure::new();
    let never = AtomicBool::new(false);
    let opts = ReadOptions {
        as_ccsid: Some(UTF8),
        ..ReadOptions::default()
    };
    let read = ifs::read(
        |r| failure.keep(s.ifs(&p.name, |f| f.send_read(r))),
        path,
        opts,
        &mut data,
        |_| {},
        &never,
    );
    let end = read.map_err(|e| failure.error(&e))?;
    let size = match end {
        End::Done(progress) | End::Cancelled(progress) => progress.size,
    };
    let text = match String::from_utf8(data) {
        Ok(t) => t,
        // The server sends whole UTF-8 characters; anything else is shown,
        // not refused.
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    Ok(TextDto {
        text,
        ccsid: entry.ccsid,
        size,
        change: change_text(stamp),
    })
}

/// `ifs.writeText`: the text sent as UTF-8 for the system to convert to
/// the file's CCSID; with `expect`, only when the file has not changed.
pub fn write_text(s: &Sessions, p: &WriteTextParams) -> Result<WrittenDto, RpcError> {
    let path = path_param("path", &p.path)?;
    let first = match p.mode {
        Mode::Create => WriteMode::Create,
        Mode::Replace => WriteMode::Replace,
        Mode::Resume => {
            return Err(RpcError::invalid_params(
                "mode resume is for ifs.upload; text is written whole",
            ));
        }
    };
    if let Some(expect) = &p.expect {
        let now = s.ifs(&p.name, |f| match f.checked(path) {
            Ok((_, _, stamp)) => Ok(Some(change_text(stamp))),
            Err(e) if not_found(&e) => Ok(None),
            Err(e) => Err(e),
        })?;
        if now.as_deref() != Some(expect.as_str()) {
            let mut e = RpcError::new(codes::CHANGED, "changed on the system");
            e.data = Some(json!({ "change": now }));
            return Err(e);
        }
    }
    let opts = WriteOptions {
        data_ccsid: Some(UTF8),
        ccsid: p.ccsid.unwrap_or(0),
        first,
        ..WriteOptions::default()
    };
    let mut failure = SendFailure::new();
    let never = AtomicBool::new(false);
    let written = ifs::write(
        |w| failure.keep(s.ifs(&p.name, |f| f.send_write(w))),
        path,
        &mut Cursor::new(p.text.as_bytes()),
        opts,
        |_| {},
        &never,
    );
    let end = written.map_err(|e| failure.error(&e))?;
    let (_, _, stamp) = s.ifs(&p.name, |f| f.checked(path))?;
    Ok(WrittenDto {
        size: end.progress().size,
        change: change_text(stamp),
    })
}

/// `ifs.mkdir`.
pub fn mkdir(s: &Sessions, p: &MkdirParams) -> Result<(), RpcError> {
    let path = path_param("path", &p.path)?;
    s.ifs(&p.name, |f| f.create_directory(path, p.parents))
}

/// `ifs.delete`: one file, link or empty directory.
pub fn delete(s: &Sessions, p: &PathParams) -> Result<(), RpcError> {
    let path = path_param("path", &p.path)?;
    s.ifs(&p.name, |f| f.delete(path))
}

/// `ifs.rename`: a rename or a move.
pub fn rename(s: &Sessions, p: &FromToParams) -> Result<(), RpcError> {
    let from = path_param("from", &p.from)?;
    let to = path_param("to", &p.to)?;
    s.ifs(&p.name, |f| f.rename(from, to, p.replace))
}

/// `ifs.copy`: a file copied on the system, its CCSID and data as stored.
pub fn copy(s: &Sessions, p: &FromToParams) -> Result<(), RpcError> {
    let from = path_param("from", &p.from)?;
    let to = path_param("to", &p.to)?;
    s.ifs(&p.name, |f| f.copy(from, to, p.replace))
}

/// `ifs.resolve`: the path with symbolic links followed, one
/// [`qap_client::Files::resolve`] per link, at most [`MAX_LINKS`]. A path
/// that is no link comes back as typed; a broken link is the server's
/// `NotFound`.
pub fn resolve(s: &Sessions, p: &PathParams) -> Result<ResolvedDto, RpcError> {
    let mut path = path_param("path", &p.path)?.to_owned();
    let mut entry = s.ifs(&p.name, |f| f.get_info(&path))?;
    for _ in 0..MAX_LINKS {
        if entry.kind != EntryKind::Symlink {
            return Ok(ResolvedDto { path });
        }
        let named = Entry {
            name: ifs::file_name(&path).to_owned(),
            ..entry
        };
        let dir = ifs::parent(&path).to_owned();
        (path, entry) = s.ifs(&p.name, |f| f.resolve(&dir, &named))?;
    }
    if entry.kind != EntryKind::Symlink {
        return Ok(ResolvedDto { path });
    }
    Err(RpcError::new(
        codes::LINK_LOOP,
        format!("{}: more than {MAX_LINKS} symbolic links in a row", p.path),
    ))
}

/// Registers `ifs.*`.
pub fn register(r: &mut Registry, sessions: &Arc<Sessions>) {
    let s = Arc::clone(sessions);
    r.register("ifs.list", move |p: ListParams, _: &Context| list(&s, &p));
    let s = Arc::clone(sessions);
    r.register("ifs.info", move |p: PathParams, _: &Context| info(&s, &p));
    let s = Arc::clone(sessions);
    r.register("ifs.readText", move |p: PathParams, _: &Context| {
        read_text(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("ifs.writeText", move |p: WriteTextParams, _: &Context| {
        write_text(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("ifs.mkdir", move |p: MkdirParams, _: &Context| {
        mkdir(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("ifs.delete", move |p: PathParams, _: &Context| {
        delete(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("ifs.rename", move |p: FromToParams, _: &Context| {
        rename(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("ifs.copy", move |p: FromToParams, _: &Context| copy(&s, &p));
    let s = Arc::clone(sessions);
    r.register("ifs.resolve", move |p: PathParams, _: &Context| {
        resolve(&s, &p)
    });
}
