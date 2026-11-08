// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `spool.*`: `qap-client`'s `Spool` (version 3, the spec's "Service 4
//! `Spool`"; its watches version 6), thin, through [`Sessions::work`].
//!
//! - `spool.files` and `spool.queues` are `all_spooled_files` and
//!   `all_output_queues`, in pages of 500. `ListSpooledFiles` has no job
//!   among its filters, so `spool.files` with a `job` lists the files of
//!   `user` (`*CURRENT` when absent) and keeps that job's.
//! - `spool.readText` sends one `ReadSpooledFile` as `Text` for the pages
//!   asked (the whole file when none are), and waits for it with the
//!   session let go; a reply split with `More` is joined by the
//!   connection. The text is the server's: one line per printed line,
//!   UTF-8, a form feed between pages, kept as it came.
//! - `spool.download` writes `text`, `pdf` or `scs` to a local file
//!   through `qap_client::spool::read` (SCS in batches of 25 pages), with
//!   `spool.progress { download, pages, total }` at most every 250 ms and
//!   `spool.cancel`. A cancelled or failed download removes its file.
//! - `spool.hold`, `spool.release`, `spool.delete` and `spool.move` send
//!   one `Action` and wait for its reply outside the session.
//! - `spool.watch` and `spool.unwatch` are the extension's watch of a
//!   target, counted in [`Watches`]; `spool.awaitFile` waits for one of a
//!   job's files with a one-shot watch of the profile's own files, dropped
//!   after the first match or its timeout (10 minutes by default).
//!
//! `readText`, `download` and `awaitFile` are deferred, each on a thread
//! of its own, so they hold up no other request. Refusals (`NotFound`,
//! `NotAuthorized`, `InUse` `TCP1A57` for a file still open, `Error`
//! `TCP1A56` for a format the device type cannot make) come back with the
//! server's message.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufWriter;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use host_rpc::{Context, Outbound, Registry, Responder, RpcError};
use qap_client::proto::ops::spool::{
    ListSpooledFiles, OutputQueue, ReadFormat, ReadSpooledFile, SpooledData, SpooledFile,
    SpooledFileId,
};
use qap_client::proto::types::JobId;
use qap_client::spool::{Action, BATCH_PAGES, ReadEnd};
use qap_client::{Error, Watch};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::codec::{
    DeviceTypeDto, JobDto, ObjectDto, SpoolStatusDto, SpoolTargetDto, SpooledFileIdDto, job_id,
    name_param,
};
use crate::ifs::SendFailure;
use crate::session::{QAP_SPOOL, Sessions, codes as session_codes, rpc_error};
use crate::watches::{Told, Watches, wanted};

/// JSON-RPC error codes of `spool.*`.
pub mod codes {
    /// A download was cancelled. `data` is `{ download, pages }`.
    pub const CANCELLED: i64 = -32040;
}

/// The shortest time between two `spool.progress` of one download.
pub const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// How long `spool.awaitFile` waits by default: 10 minutes.
pub const AWAIT_FOR: Duration = Duration::from_secs(600);

/// A spooled file as lists show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpooledFileDto {
    pub id: SpooledFileIdDto,
    pub status: SpoolStatusDto,
    pub outq: ObjectDto,
    /// Its owner.
    pub user: String,
    pub user_data: String,
    pub form_type: String,
    pub device_type: DeviceTypeDto,
    pub pages: u32,
    pub copies: u16,
    /// Bytes.
    pub size: u64,
    /// Milliseconds since 1970-01-01 UTC.
    pub created: i64,
}

impl From<SpooledFile> for SpooledFileDto {
    fn from(f: SpooledFile) -> SpooledFileDto {
        SpooledFileDto {
            id: SpooledFileIdDto::from(&f.id),
            status: f.status.into(),
            outq: ObjectDto::from(&f.outq),
            user: f.user,
            user_data: f.user_data,
            form_type: f.form_type,
            device_type: f.device_type.into(),
            pages: f.pages,
            copies: f.copies,
            size: f.size,
            created: f.created,
        }
    }
}

/// An output queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputQueueDto {
    pub outq: ObjectDto,
    pub text: String,
    pub files: u32,
    /// Empty when none.
    pub writer: String,
    pub held: bool,
}

impl From<OutputQueue> for OutputQueueDto {
    fn from(q: OutputQueue) -> OutputQueueDto {
        OutputQueueDto {
            outq: ObjectDto::from(&q.outq),
            text: q.text,
            files: q.files,
            writer: q.writer,
            held: q.held,
        }
    }
}

/// Params of `spool.files`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesParams {
    pub name: String,
    /// `*CURRENT` (absent), `*ALL` or a profile.
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub outq: Option<ObjectDto>,
    #[serde(default)]
    pub status: Option<SpoolStatusDto>,
    #[serde(default)]
    pub form_type: Option<String>,
    #[serde(default)]
    pub user_data: Option<String>,
    /// Only this job's files.
    #[serde(default)]
    pub job: Option<JobDto>,
}

/// Params of `spool.queues`.
#[derive(Debug, Deserialize)]
pub struct QueuesParams {
    pub name: String,
    /// `*ALL`, `*LIBL` or a library.
    pub library: String,
}

/// Params of `spool.readText`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextParams {
    pub name: String,
    pub id: SpooledFileIdDto,
    /// 1-based; absent for 1.
    #[serde(default)]
    pub first_page: Option<u32>,
    /// Absent or 0 for the last.
    #[serde(default)]
    pub last_page: Option<u32>,
}

/// Result of `spool.readText`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDto {
    /// Pages in the whole file.
    pub pages: u32,
    /// The pages read, 1-based and inclusive.
    pub first_page: u32,
    pub last_page: u32,
    /// One line per printed line, a form feed between pages.
    pub text: String,
}

/// What `spool.download` writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormatDto {
    Text,
    Pdf,
    Scs,
}

impl From<FormatDto> for ReadFormat {
    fn from(f: FormatDto) -> ReadFormat {
        match f {
            FormatDto::Text => ReadFormat::Text,
            FormatDto::Pdf => ReadFormat::Pdf,
            FormatDto::Scs => ReadFormat::Scs,
        }
    }
}

/// Params of `spool.download`.
#[derive(Debug, Deserialize)]
pub struct DownloadParams {
    pub name: String,
    pub id: SpooledFileIdDto,
    pub format: FormatDto,
    /// The local file written, created or replaced.
    pub to: String,
    /// The ID `spool.progress` and `spool.cancel` use; the host makes one
    /// when absent.
    #[serde(default)]
    pub download: Option<String>,
}

/// Result of `spool.download`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadedDto {
    pub pages: u32,
    /// Bytes written.
    pub size: u64,
}

/// Params of `spool.cancel`.
#[derive(Debug, Deserialize)]
pub struct CancelParams {
    pub name: String,
    pub download: String,
}

/// Params of `spool.release` and `spool.delete`.
#[derive(Debug, Deserialize)]
pub struct IdParams {
    pub name: String,
    pub id: SpooledFileIdDto,
}

/// Params of `spool.hold`.
#[derive(Debug, Deserialize)]
pub struct HoldParams {
    pub name: String,
    pub id: SpooledFileIdDto,
    /// Now, or (false) at the end of the page.
    pub immediately: bool,
}

/// Params of `spool.move`.
#[derive(Debug, Deserialize)]
pub struct MoveParams {
    pub name: String,
    pub id: SpooledFileIdDto,
    pub outq: ObjectDto,
    /// To the top of the queue.
    #[serde(default)]
    pub first: bool,
}

/// Params of `spool.watch` and `spool.unwatch`.
#[derive(Debug, Deserialize)]
pub struct WatchParams {
    pub name: String,
    pub target: SpoolTargetDto,
}

/// Params of `spool.awaitFile`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwaitParams {
    pub name: String,
    pub job: JobDto,
    /// The file's name (`QSYSPRT`); absent for any of the job's.
    #[serde(default)]
    pub file: Option<String>,
    /// How long to wait; absent for 10 minutes.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// The same job, the names without case.
fn same_job(a: &JobId, b: &JobId) -> bool {
    a.number == b.number
        && a.user.eq_ignore_ascii_case(&b.user)
        && a.name.eq_ignore_ascii_case(&b.name)
}

/// `spool.files`: every file matching, drained; with `job`, that job's only.
pub fn files(s: &Sessions, p: &FilesParams) -> Result<Vec<SpooledFileDto>, RpcError> {
    let user = match &p.user {
        Some(u) => name_param("user", u)?,
        None => "*CURRENT".into(),
    };
    let job = p.job.as_ref().map(job_id).transpose()?;
    let req = ListSpooledFiles {
        user,
        outq: p.outq.as_ref().map(ObjectDto::object).transpose()?,
        status: p.status.map(Into::into),
        form_type: p.form_type.clone(),
        user_data: p.user_data.clone(),
        start: 0,
        max: 0,
    };
    let all = s.work(&p.name, QAP_SPOOL, |w| w.all_spooled_files(&req))?;
    Ok(all
        .into_iter()
        .filter(|f| job.as_ref().is_none_or(|j| same_job(&f.id.job, j)))
        .map(SpooledFileDto::from)
        .collect())
}

/// `spool.queues`: every output queue in `library`.
pub fn queues(s: &Sessions, p: &QueuesParams) -> Result<Vec<OutputQueueDto>, RpcError> {
    let library = name_param("library", &p.library)?;
    let q = s.work(&p.name, QAP_SPOOL, |w| w.all_output_queues(&library))?;
    Ok(q.into_iter().map(OutputQueueDto::from).collect())
}

/// The pages a `spool.readText` reads: 1-based, `last` 0 for the end.
pub fn page_range(first: Option<u32>, last: Option<u32>) -> Result<(u32, u32), RpcError> {
    let first = first.unwrap_or(1);
    let last = last.unwrap_or(0);
    if first == 0 {
        return Err(RpcError::invalid_params("firstPage is 1-based"));
    }
    if last != 0 && last < first {
        return Err(RpcError::invalid_params(format!(
            "lastPage {last} is before firstPage {first}"
        )));
    }
    Ok((first, last))
}

/// The text of a `Text` reply, and the pages it holds: its form feeds
/// kept, bytes that are not UTF-8 shown, not refused.
pub fn reply_text(data: Vec<u8>, pages: u32, first: u32, last: u32) -> TextDto {
    let text = match String::from_utf8(data) {
        Ok(t) => t,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    let last_page = if last == 0 || last > pages {
        pages
    } else {
        last
    };
    TextDto {
        pages,
        first_page: if pages == 0 { 0 } else { first.min(pages) },
        last_page,
        text,
    }
}

/// `spool.readText`, to its end.
pub fn read_text(s: &Sessions, p: &ReadTextParams) -> Result<TextDto, RpcError> {
    let id = p.id.id()?;
    let (first, last) = page_range(p.first_page, p.last_page)?;
    let req = ReadSpooledFile {
        id,
        format: ReadFormat::Text,
        first_page: first,
        last_page: last,
    };
    let pending = s.work(&p.name, QAP_SPOOL, |w| w.read_spooled_file(&req))?;
    let reply = pending.wait_done().map_err(|e| rpc_error(&e))?;
    let data: SpooledData = reply.decode().map_err(|e| rpc_error(&e))?;
    Ok(reply_text(data.data, data.pages, first, last))
}

/// Sends `action` and waits for its reply with the session let go.
fn act(s: &Sessions, name: &str, action: Action) -> Result<(), RpcError> {
    let (pending, timeout) = s.work(name, QAP_SPOOL, |w| {
        Ok((w.spool_action(&action)?, w.reply_timeout()))
    })?;
    let reply = pending.wait(timeout).map_err(|e| rpc_error(&e))?;
    Action::outcome(reply).map_err(|e| rpc_error(&e))
}

pub fn hold(s: &Sessions, p: &HoldParams) -> Result<(), RpcError> {
    let id = p.id.id()?;
    act(
        s,
        &p.name,
        Action::Hold {
            id,
            immediately: p.immediately,
        },
    )
}

pub fn release(s: &Sessions, p: &IdParams) -> Result<(), RpcError> {
    act(s, &p.name, Action::Release(p.id.id()?))
}

pub fn delete(s: &Sessions, p: &IdParams) -> Result<(), RpcError> {
    act(s, &p.name, Action::Delete(p.id.id()?))
}

pub fn move_to(s: &Sessions, p: &MoveParams) -> Result<(), RpcError> {
    let id = p.id.id()?;
    let outq = p.outq.object()?;
    act(
        s,
        &p.name,
        Action::Move {
            id,
            outq,
            first: p.first,
        },
    )
}

/// The downloads running, by ID, each with its cancel flag.
#[derive(Default)]
pub struct Downloads {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    made: Mutex<u64>,
}

impl Downloads {
    fn begin(&self, asked: Option<&str>) -> Result<(String, Arc<AtomicBool>), RpcError> {
        let id = match asked {
            Some("") => return Err(RpcError::invalid_params("download is empty")),
            Some(d) => d.to_owned(),
            None => {
                let mut m = self.made.lock().unwrap_or_else(PoisonError::into_inner);
                *m += 1;
                format!("d{m}")
            }
        };
        let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        if running.contains_key(&id) {
            return Err(RpcError::invalid_params(format!(
                "download {id} is running"
            )));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        running.insert(id.clone(), Arc::clone(&cancel));
        Ok((id, cancel))
    }

    fn end(&self, id: &str) {
        self.running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
    }

    /// Asks a running download to stop; false when none has that ID.
    pub fn cancel(&self, id: &str) -> bool {
        match self
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
        {
            Some(c) => {
                c.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }
}

/// `spool.progress`.
#[derive(Serialize)]
struct ProgressNote<'a> {
    download: &'a str,
    pages: u32,
    total: u32,
}

/// `spool.download`, to its end.
fn run_download(
    s: &Sessions,
    outbound: &Outbound,
    p: &DownloadParams,
    download: &str,
    cancel: &AtomicBool,
) -> Result<DownloadedDto, RpcError> {
    let id: SpooledFileId = p.id.id()?;
    let to = name_param("to", &p.to)?;
    let file =
        File::create(&to).map_err(|e| RpcError::new(session_codes::LOCAL, format!("{to}: {e}")))?;
    let mut sink = BufWriter::new(file);
    let mut failure = SendFailure::new();
    let mut last: Option<Instant> = None;
    let read = qap_client::spool::read(
        |r| failure.keep(s.work(&p.name, QAP_SPOOL, |w| w.read_spooled_file(r))),
        &id,
        p.format.into(),
        BATCH_PAGES,
        &mut sink,
        |pr| {
            let now = Instant::now();
            if last.is_some_and(|t| now.duration_since(t) < PROGRESS_EVERY) {
                return;
            }
            last = Some(now);
            let _ = outbound.notify(
                "spool.progress",
                &ProgressNote {
                    download,
                    pages: pr.pages_read,
                    total: pr.total,
                },
            );
        },
        cancel,
    );
    drop(sink);
    let out = match read {
        Ok(ReadEnd::Done { pages, .. }) => {
            let size = std::fs::metadata(&to).map(|m| m.len()).unwrap_or(0);
            return Ok(DownloadedDto { pages, size });
        }
        Ok(ReadEnd::Cancelled(pr)) => {
            let mut e = RpcError::new(codes::CANCELLED, "cancelled");
            e.data = Some(json!({ "download": download, "pages": pr.pages_read }));
            e
        }
        Err(Error::Write(e)) => RpcError::new(session_codes::LOCAL, format!("{to}: {e}")),
        Err(e) => failure.error(&e),
    };
    // Nothing half-written is left looking like the file.
    let _ = std::fs::remove_file(&to);
    Err(out)
}

/// `spool.awaitFile`: the first closed file of `job` (named `file`) the
/// one-shot watch reports or a list finds; `null` after the timeout or when
/// the session ends.
pub fn await_file(
    s: &Sessions,
    watches: &Watches,
    p: &AwaitParams,
) -> Result<Option<SpooledFileDto>, RpcError> {
    let job = job_id(&p.job)?;
    let file = p
        .file
        .as_deref()
        .map(|f| name_param("file", f))
        .transpose()?;
    let wait = p.timeout_ms.map_or(AWAIT_FOR, Duration::from_millis);
    let (wid, rx) = watches.begin_wait(&p.name, job.clone(), file.clone())?;
    let listed = || -> Result<Option<SpooledFile>, RpcError> {
        let req = ListSpooledFiles {
            user: "*CURRENT".into(),
            ..ListSpooledFiles::default()
        };
        let all = s.work(&p.name, QAP_SPOOL, |w| w.all_spooled_files(&req))?;
        Ok(all
            .into_iter()
            .filter(|f| wanted(f, &job, file.as_deref()))
            .max_by_key(|f| f.id.number))
    };
    let deadline = Instant::now() + wait;
    // What was there before the watch began counts too.
    let mut found = listed();
    while matches!(found, Ok(None)) {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(Told::Found(f)) => found = Ok(Some(*f)),
            Ok(Told::Recheck) => found = listed(),
            Ok(Told::Closed) | Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                break;
            }
        }
    }
    watches.end_wait(&p.name, wid);
    found.map(|f| f.map(SpooledFileDto::from))
}

/// Starts `run` on a thread of its own; the method is answered when it
/// ends.
fn spawn<T: Serialize + Send + 'static>(
    what: &str,
    responder: Responder,
    run: impl FnOnce() -> Result<T, RpcError> + Send + 'static,
) {
    let spawned = std::thread::Builder::new()
        .name(what.to_owned())
        .spawn(move || responder.send(run()));
    // On failure the closure, and the responder with it, is dropped:
    // answered.
    drop(spawned);
}

/// Registers `spool.*`.
pub fn register(r: &mut Registry, sessions: &Arc<Sessions>, watches: &Arc<Watches>) {
    let s = Arc::clone(sessions);
    r.register("spool.files", move |p: FilesParams, _: &Context| {
        files(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("spool.queues", move |p: QueuesParams, _: &Context| {
        queues(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register_deferred(
        "spool.readText",
        move |p: ReadTextParams, _: &Context, responder: Responder| {
            let s = Arc::clone(&s);
            spawn("spool read", responder, move || read_text(&s, &p));
        },
    );
    let downloads = Arc::new(Downloads::default());
    let s = Arc::clone(sessions);
    let d = Arc::clone(&downloads);
    r.register_deferred(
        "spool.download",
        move |p: DownloadParams, ctx: &Context, responder: Responder| {
            let (id, cancel) = match d.begin(p.download.as_deref()) {
                Ok(t) => t,
                Err(e) => return responder.send::<DownloadedDto>(Err(e)),
            };
            let s = Arc::clone(&s);
            let d = Arc::clone(&d);
            let outbound = ctx.outbound().clone();
            spawn("spool download", responder, move || {
                let out = run_download(&s, &outbound, &p, &id, &cancel);
                d.end(&id);
                out
            });
        },
    );
    let d = Arc::clone(&downloads);
    r.register("spool.cancel", move |p: CancelParams, _: &Context| {
        d.cancel(&p.download);
        Ok::<_, RpcError>(())
    });
    let s = Arc::clone(sessions);
    r.register("spool.hold", move |p: HoldParams, _: &Context| hold(&s, &p));
    let s = Arc::clone(sessions);
    r.register("spool.release", move |p: IdParams, _: &Context| {
        release(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("spool.delete", move |p: IdParams, _: &Context| {
        delete(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("spool.move", move |p: MoveParams, _: &Context| {
        move_to(&s, &p)
    });
    let w = Arc::clone(watches);
    r.register("spool.watch", move |p: WatchParams, _: &Context| {
        w.watch(&p.name, Watch::Spool(p.target.target()?))
    });
    let w = Arc::clone(watches);
    r.register("spool.unwatch", move |p: WatchParams, _: &Context| {
        w.unwatch(&p.name, Watch::Spool(p.target.target()?))
    });
    let s = Arc::clone(sessions);
    let w = Arc::clone(watches);
    r.register_deferred(
        "spool.awaitFile",
        move |p: AwaitParams, _: &Context, responder: Responder| {
            let s = Arc::clone(&s);
            let w = Arc::clone(&w);
            spawn("spool wait", responder, move || await_file(&s, &w, &p));
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_ranges() {
        assert_eq!(page_range(None, None).unwrap(), (1, 0));
        assert_eq!(page_range(Some(1), Some(100)).unwrap(), (1, 100));
        assert_eq!(page_range(Some(3), Some(3)).unwrap(), (3, 3));
        assert_eq!(page_range(Some(101), None).unwrap(), (101, 0));
        assert!(page_range(Some(0), None).is_err());
        assert!(page_range(Some(5), Some(4)).is_err());
    }

    #[test]
    fn reply_text_keeps_the_form_feeds_and_names_the_pages() {
        let t = reply_text(b"one\n\x0ctwo\n\x0cthree\n".to_vec(), 3, 1, 0);
        assert_eq!(t.text.matches('\u{c}').count(), 2);
        assert_eq!(
            t.text.split('\u{c}').collect::<Vec<_>>(),
            ["one\n", "two\n", "three\n"]
        );
        assert_eq!((t.pages, t.first_page, t.last_page), (3, 1, 3));
        let t = reply_text(b"two\n\x0cthree\n".to_vec(), 3, 2, 100);
        assert_eq!((t.first_page, t.last_page), (2, 3));
        // Not UTF-8: shown, not refused.
        let t = reply_text(vec![b'a', 0xFF, b'b'], 1, 1, 0);
        assert_eq!(t.text, "a\u{FFFD}b");
        // No pages: the first page is 1 with no data.
        let t = reply_text(Vec::new(), 0, 1, 0);
        assert_eq!(
            (t.pages, t.first_page, t.last_page, t.text.as_str()),
            (0, 0, 0, "")
        );
    }
}
