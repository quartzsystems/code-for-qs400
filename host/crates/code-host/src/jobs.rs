// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `job.*`: the connection job's log, thin over `qap-client`'s
//! `Jobs::job_log` (version 8) through [`Sessions::command`].
//!
//! `job.log` drains the log whole, a page of [`PAGE`] entries at a time
//! from the start, until the entries reach the `total` the server counts
//! or a page comes back empty (the log was cleared meanwhile). Entries are
//! oldest first, as `JobLog` answers them. Without a `job` it is the
//! session's own, the QAP server job the actions run in.

use std::sync::Arc;

use host_rpc::{Context, Registry, RpcError};
use qap_client::proto::ops::jobs::{JobLog, JobLogEntry};
use qap_client::proto::types::JobId;
use serde::{Deserialize, Serialize};

use crate::session::{JobDto, QAP_DEVELOP, Sessions, codes};

/// Entries asked for in one `JobLog`.
pub const PAGE: u32 = 500;

/// Params of `job.log`.
#[derive(Debug, Deserialize)]
pub struct JobLogParams {
    /// The connection.
    pub name: String,
    /// The job; absent for the connection's own.
    #[serde(default)]
    pub job: Option<JobDto>,
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
    /// Its type, as the spec names it, lower case: `completion`, `escape`, `diagnostic` …
    pub kind: String,
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
            kind: format!("{:?}", e.kind).to_lowercase(),
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

/// `job.log`: every entry of the job's log.
pub fn job_log(s: &Sessions, p: &JobLogParams) -> Result<JobLogDto, RpcError> {
    // Bring a stale session back first, so its job is the one it has now.
    s.command(&p.name, QAP_DEVELOP, |_| Ok(()))?;
    let job = match &p.job {
        Some(j) => j.clone(),
        None => s.status(&p.name).job.ok_or_else(|| {
            RpcError::new(
                codes::NOT_CONNECTED,
                format!("{}: the session's job is not known", p.name),
            )
        })?,
    };
    let id = JobId {
        name: job.name.clone(),
        user: job.user.clone(),
        number: job.number.clone(),
    };
    let mut entries: Vec<JobLogEntryDto> = Vec::new();
    loop {
        let req = JobLog {
            job: id.clone(),
            start: u32::try_from(entries.len()).unwrap_or(u32::MAX),
            max: PAGE,
        };
        let page = s.command(&p.name, QAP_DEVELOP, |c| c.job_log(&req))?;
        let n = page.entries.len();
        entries.extend(page.entries.into_iter().map(JobLogEntryDto::from));
        if n == 0 || entries.len() >= page.total as usize {
            return Ok(JobLogDto { job, entries });
        }
    }
}

/// Registers `job.*`.
pub fn register(r: &mut Registry, sessions: &Arc<Sessions>) {
    let s = Arc::clone(sessions);
    r.register("job.log", move |p: JobLogParams, _: &Context| {
        job_log(&s, &p)
    });
}
