// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `jobs.*` and Phase 4's `job.log`: `qap-client`'s `Jobs` (version 8,
//! the spec's "Service 10 `Jobs`"), thin, through [`Sessions::work`] and,
//! for the log, [`Sessions::command`].
//!
//! - `jobs.list` is `Jobs::all_jobs`: every job of `user` (`*CURRENT`,
//!   `*ALL` or a profile), in pages of 500, active first, then on job
//!   queues, then on output queues, as the server orders them.
//! - `jobs.log` and `job.log` drain a log whole, a page of [`PAGE`] at a
//!   time from the start, until the entries reach the `total` the server
//!   counts or a page comes back empty (the log was cleared meanwhile).
//!   Entries are oldest first. An ended job's log is its spooled
//!   `QPJOBLOG`, or `NotFound`, as the server answers. `job.log` without a
//!   `job` is the session's own, the QAP server job the actions run in.
//! - `jobs.hold`, `jobs.release` and `jobs.end` are `HLDJOB`, `RLSJOB` and
//!   `ENDJOB`. `how` is `controlled` (`*CNTRLD`, with an optional `delay`
//!   in seconds, 1 to 999999 as `ENDJOB DELAY` takes) or `immediate`
//!   (`*IMMED`, no delay).
//!
//! Authority is the server's: another profile's jobs, or `*ALL`, without
//! `*JOBCTL` come back `NotAuthorized` with the server's message
//! (`CPF1343`), never checked here first.

use std::sync::Arc;

use host_rpc::{Context, Registry, RpcError};
use qap_client::proto::ops::jobs::{JobEntry, JobLog, JobLogEntry};
use qap_client::proto::types::{EndHow, JobId};
use serde::{Deserialize, Serialize};

use crate::codec::{EndHowDto, JobStateDto, MessageTypeDto, job_dto, job_id, name_param};
use crate::session::{JobDto, QAP_JOBS, Sessions, codes};

/// Entries asked for in one `JobLog`.
pub const PAGE: u32 = 500;

/// The longest `ENDJOB DELAY`, seconds.
pub const MAX_DELAY: u32 = 999_999;

/// Params of `job.log`.
#[derive(Debug, Deserialize)]
pub struct JobLogParams {
    /// The connection.
    pub name: String,
    /// The job; absent for the connection's own.
    #[serde(default)]
    pub job: Option<JobDto>,
}

/// Params of `jobs.log`, `jobs.hold` and `jobs.release`.
#[derive(Debug, Deserialize)]
pub struct JobParams {
    pub name: String,
    pub job: JobDto,
}

/// Params of `jobs.list`.
#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub name: String,
    /// `*CURRENT`, `*ALL` or a profile.
    pub user: String,
    /// Only jobs in this state; absent for all.
    #[serde(default)]
    pub state: Option<JobStateDto>,
}

/// Params of `jobs.end`.
#[derive(Debug, Deserialize)]
pub struct EndParams {
    pub name: String,
    pub job: JobDto,
    pub how: EndHowDto,
    /// Seconds, for `controlled`; absent for the job's default.
    #[serde(default)]
    pub delay: Option<u32>,
}

/// A job, as `WRKUSRJOB` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobEntryDto {
    pub job: JobDto,
    pub state: JobStateDto,
    /// As `WRKUSRJOB` shows it: `*ACTIVE`, `*JOBQ`, `*OUTQ`.
    pub status: String,
    /// `BATCH`, `INTER`, `AUTO` …
    #[serde(rename = "type")]
    pub kind: String,
    /// Empty when not active.
    pub subsystem: String,
    /// As `WRKACTJOB` shows it (`PGM-QCMD`); empty when none.
    pub function: String,
    /// When it entered the system, milliseconds since 1970-01-01 UTC.
    pub entered: i64,
}

impl From<JobEntry> for JobEntryDto {
    fn from(e: JobEntry) -> JobEntryDto {
        JobEntryDto {
            job: job_dto(&e.id),
            state: e.state.into(),
            status: e.status,
            kind: e.r#type,
            subsystem: e.subsystem,
            function: e.function,
            entered: e.entered,
        }
    }
}

/// One message of a job log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLogEntryDto {
    /// When it was sent, milliseconds since 1970-01-01 UTC.
    pub sent: i64,
    /// Empty for an impromptu message.
    pub id: String,
    pub severity: u8,
    /// Its `MessageType`: `completion`, `escape`, `diagnostic` …
    pub kind: MessageTypeDto,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub second_level: Option<String>,
    pub from_program: String,
    pub to_program: String,
}

impl From<JobLogEntry> for JobLogEntryDto {
    fn from(e: JobLogEntry) -> JobLogEntryDto {
        let m = e.message;
        JobLogEntryDto {
            sent: e.sent,
            id: m.id,
            severity: m.severity,
            kind: e.kind.into(),
            text: m.text,
            second_level: (!m.help.trim().is_empty()).then_some(m.help),
            from_program: e.from_program,
            to_program: e.to_program,
        }
    }
}

/// Result of `job.log`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobLogDto {
    pub job: JobDto,
    /// The entries, oldest first: the newest is last.
    pub entries: Vec<JobLogEntryDto>,
}

/// Every entry of `job`'s log, oldest first.
fn drain(s: &Sessions, name: &str, job: &JobId) -> Result<Vec<JobLogEntryDto>, RpcError> {
    let mut entries: Vec<JobLogEntryDto> = Vec::new();
    loop {
        let req = JobLog {
            job: job.clone(),
            start: u32::try_from(entries.len()).unwrap_or(u32::MAX),
            max: PAGE,
        };
        let page = s.command(name, QAP_JOBS, |c| c.job_log(&req))?;
        let n = page.entries.len();
        entries.extend(page.entries.into_iter().map(JobLogEntryDto::from));
        if n == 0 || entries.len() >= page.total as usize {
            return Ok(entries);
        }
    }
}

/// `job.log`: every entry of the job's log, the session's own when no job
/// is named.
pub fn job_log(s: &Sessions, p: &JobLogParams) -> Result<JobLogDto, RpcError> {
    // Bring a stale session back first, so its job is the one it has now.
    s.command(&p.name, QAP_JOBS, |_| Ok(()))?;
    let job = match &p.job {
        Some(j) => j.clone(),
        None => s.status(&p.name).job.ok_or_else(|| {
            RpcError::new(
                codes::NOT_CONNECTED,
                format!("{}: the session's job is not known", p.name),
            )
        })?,
    };
    let id = job_id(&job)?;
    let entries = drain(s, &p.name, &id)?;
    Ok(JobLogDto { job, entries })
}

/// `jobs.log`: every entry of the job's log, oldest first.
pub fn log(s: &Sessions, p: &JobParams) -> Result<Vec<JobLogEntryDto>, RpcError> {
    drain(s, &p.name, &job_id(&p.job)?)
}

/// `jobs.list`: every job of `user`, drained.
pub fn list(s: &Sessions, p: &ListParams) -> Result<Vec<JobEntryDto>, RpcError> {
    let user = name_param("user", &p.user)?;
    let state = p.state.map(Into::into);
    let jobs = s.work(&p.name, QAP_JOBS, |w| w.all_jobs(&user, state))?;
    Ok(jobs.into_iter().map(JobEntryDto::from).collect())
}

/// `jobs.hold`: `HLDJOB`.
pub fn hold(s: &Sessions, p: &JobParams) -> Result<(), RpcError> {
    let job = job_id(&p.job)?;
    s.work(&p.name, QAP_JOBS, |w| w.hold_job(&job))
}

/// `jobs.release`: `RLSJOB`.
pub fn release(s: &Sessions, p: &JobParams) -> Result<(), RpcError> {
    let job = job_id(&p.job)?;
    s.work(&p.name, QAP_JOBS, |w| w.release_job(&job))
}

/// What `jobs.end`'s params send: `ENDJOB OPTION` and `DELAY`.
pub fn end_request(p: &EndParams) -> Result<(EndHow, Option<u32>), RpcError> {
    let how = EndHow::from(p.how);
    match (how, p.delay) {
        (EndHow::Immediate, Some(_)) => Err(RpcError::invalid_params(
            "delay is for a controlled end; *IMMED takes none",
        )),
        (EndHow::Controlled, Some(d)) if d == 0 || d > MAX_DELAY => Err(RpcError::invalid_params(
            format!("delay must be 1 to {MAX_DELAY} seconds: {d}"),
        )),
        (how, delay) => Ok((how, delay)),
    }
}

/// `jobs.end`: `ENDJOB`.
pub fn end(s: &Sessions, p: &EndParams) -> Result<(), RpcError> {
    let job = job_id(&p.job)?;
    let (how, delay) = end_request(p)?;
    s.work(&p.name, QAP_JOBS, |w| w.end_job(&job, how, delay))
}

/// Registers `jobs.*` and `job.log`.
pub fn register(r: &mut Registry, sessions: &Arc<Sessions>) {
    let s = Arc::clone(sessions);
    r.register("job.log", move |p: JobLogParams, _: &Context| {
        job_log(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("jobs.log", move |p: JobParams, _: &Context| log(&s, &p));
    let s = Arc::clone(sessions);
    r.register("jobs.list", move |p: ListParams, _: &Context| list(&s, &p));
    let s = Arc::clone(sessions);
    r.register("jobs.hold", move |p: JobParams, _: &Context| hold(&s, &p));
    let s = Arc::clone(sessions);
    r.register("jobs.release", move |p: JobParams, _: &Context| {
        release(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("jobs.end", move |p: EndParams, _: &Context| end(&s, &p));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn params(v: serde_json::Value) -> EndParams {
        serde_json::from_value(v).unwrap()
    }

    const JOB: &str = r#"{"number":"654321","user":"CWELLMAN","name":"CODETEST"}"#;

    fn with(how: &str, delay: Option<u32>) -> EndParams {
        let job: serde_json::Value = serde_json::from_str(JOB).unwrap();
        let mut v = json!({"name":"QSHQ400","job":job,"how":how});
        if let Some(d) = delay {
            v["delay"] = json!(d);
        }
        params(v)
    }

    #[test]
    fn end_maps_how_and_delay() {
        assert_eq!(
            end_request(&with("immediate", None)).unwrap(),
            (EndHow::Immediate, None)
        );
        assert_eq!(
            end_request(&with("controlled", None)).unwrap(),
            (EndHow::Controlled, None)
        );
        assert_eq!(
            end_request(&with("controlled", Some(30))).unwrap(),
            (EndHow::Controlled, Some(30))
        );
        assert_eq!(
            end_request(&with("controlled", Some(MAX_DELAY))).unwrap(),
            (EndHow::Controlled, Some(MAX_DELAY))
        );
        for bad in [
            with("immediate", Some(30)),
            with("controlled", Some(0)),
            with("controlled", Some(MAX_DELAY + 1)),
        ] {
            assert!(end_request(&bad).is_err(), "{bad:?}");
        }
        assert!(
            serde_json::from_value::<EndParams>(
                json!({"name":"Q","job":{"number":"1","user":"U","name":"N"},"how":"*IMMED"})
            )
            .is_err()
        );
    }
}
