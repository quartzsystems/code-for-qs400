// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `deploy.*`: one local file onto the system, sequenced from the
//! existing `member.*` and `ifs.*` calls. Nothing here is a QAP
//! operation of its own.
//!
//! - `deploy.member`: `member.list` of the member (is it there, and its
//!   `changed`); when it is, `member.read` with `lock: true`, the save
//!   diff ([`plan`], Phase 2's rules) against the local lines, and
//!   `member.write`, whose end ends the lock (the spec); nothing to write
//!   unlocks instead. When it is not, `member.create` with the type and
//!   text given, then `member.write` with `renumber: true`. Then
//!   `member.list` again for the new `changed`.
//! - `deploy.path`: `ifs.info` of the file (its `change`); the parent
//!   made (`ifs.mkdir` with parents) when it is not there; `ifs.upload`
//!   with `mode: "replace"` and the CCSID for a file created; `ifs.info`
//!   again for the new `change`.
//! - `expect` is the timestamp recorded at the last deploy or pull: a
//!   member's `changed` newer than it, or a stream file's `change`
//!   different from it, is [`codes::CONFLICT`] before anything is
//!   written. Absent, nothing is checked (Overwrite, or never deployed).

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use host_rpc::{Context, Outbound, Registry, Responder, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::ifs::{self, EntryDto, InfoDto, KindDto, Transfers};
use crate::members::{self, LineDto, MemberDto, MemberRefDto};
use crate::session::Sessions;

/// JSON-RPC error codes of `deploy.*`.
pub mod codes {
    /// The system changed the file since the timestamp `expect` names.
    /// `data` is `{ changed }` (a member, milliseconds) or `{ change }` (a
    /// stream file).
    pub const CONFLICT: i64 = -32050;
}

/// The save diff of Phase 2 (`src/members/diff.ts`), the same rules on
/// the same fixtures: which records the local lines become.
pub mod plan {
    use crate::members::LineDto;

    /// `9999.99` in hundredths.
    pub const MAX_SEQ: u32 = 999_999;
    /// After the last line, as SEU numbers: `0001.00`.
    pub const STEP: u32 = 100;
    /// Past this many cells the changed middle counts as changed line by line.
    const MAX_CELLS: usize = 8_000_000;
    /// No date: the server dates the record today.
    pub const NO_DATE: &str = "000000";

    /// One step of the line diff.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Edit {
        Same(usize, usize),
        Delete(usize),
        Insert(usize),
    }

    /// `"0001.00"` in hundredths; a malformed one counts as 0.
    pub fn seq_value(s: &str) -> u32 {
        crate::members::codec::seq_to_wire(s).unwrap_or(0)
    }

    /// A longest-common-subsequence line diff of `a` to `b`.
    pub fn diff_lines(a: &[&str], b: &[&str]) -> Vec<Edit> {
        let mut start = 0;
        while start < a.len() && start < b.len() && a[start] == b[start] {
            start += 1;
        }
        let (mut end_a, mut end_b) = (a.len(), b.len());
        while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
            end_a -= 1;
            end_b -= 1;
        }
        let mut out: Vec<Edit> = (0..start).map(|i| Edit::Same(i, i)).collect();
        let (n, m) = (end_a - start, end_b - start);
        if (n + 1).saturating_mul(m + 1) > MAX_CELLS {
            out.extend((0..n).map(|i| Edit::Delete(start + i)));
            out.extend((0..m).map(|j| Edit::Insert(start + j)));
        } else if n > 0 || m > 0 {
            let w = m + 1;
            let mut len = vec![0u32; (n + 1) * w];
            for i in (0..n).rev() {
                for j in (0..m).rev() {
                    len[i * w + j] = if a[start + i] == b[start + j] {
                        len[(i + 1) * w + j + 1] + 1
                    } else {
                        len[(i + 1) * w + j].max(len[i * w + j + 1])
                    };
                }
            }
            let (mut i, mut j) = (0, 0);
            while i < n || j < m {
                if i < n && j < m && a[start + i] == b[start + j] {
                    out.push(Edit::Same(start + i, start + j));
                    i += 1;
                    j += 1;
                } else if j < m && (i == n || len[i * w + j + 1] >= len[(i + 1) * w + j]) {
                    out.push(Edit::Insert(start + j));
                    j += 1;
                } else {
                    out.push(Edit::Delete(start + i));
                    i += 1;
                }
            }
        }
        out.extend((0..a.len() - end_a).map(|k| Edit::Same(end_a + k, end_b + k)));
        out
    }

    /// `k` sequence numbers strictly between `lo` and `hi` (`None`: no
    /// line after), or `None` when there is no room.
    pub fn gap_seqs(lo: u32, hi: Option<u32>, k: u32) -> Option<Vec<u32>> {
        let hi = match hi {
            None if lo + STEP * k <= MAX_SEQ => {
                return Some((1..=k).map(|j| lo + STEP * j).collect());
            }
            None => MAX_SEQ + 1,
            Some(h) => h,
        };
        if hi.saturating_sub(lo).saturating_sub(1) < k {
            return None;
        }
        let span = u64::from(hi - lo);
        Some(
            (1..=k)
                .map(|j| lo + u32::try_from(span * u64::from(j) / u64::from(k + 1)).unwrap_or(0))
                .collect(),
        )
    }

    /// What to send, and whether the server must renumber.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Plan {
        pub lines: Vec<LineDto>,
        pub renumber: bool,
    }

    /// The records `text` becomes over `old`; `None` when nothing changed.
    pub fn plan_write(old: &[LineDto], text: &[String]) -> Option<Plan> {
        let a: Vec<&str> = old.iter().map(|l| l.text.as_str()).collect();
        let b: Vec<&str> = text.iter().map(String::as_str).collect();
        if a == b {
            return None;
        }
        let edits = diff_lines(&a, &b);
        let mut from: Vec<Option<usize>> = vec![None; b.len()];
        let mut k = 0;
        while k < edits.len() {
            if let Edit::Same(ai, bi) = edits[k] {
                from[bi] = Some(ai);
                k += 1;
                continue;
            }
            let (mut deletes, mut inserts) = (Vec::new(), Vec::new());
            while k < edits.len() && !matches!(edits[k], Edit::Same(..)) {
                match edits[k] {
                    Edit::Delete(ai) => deletes.push(ai),
                    Edit::Insert(bi) => inserts.push(bi),
                    Edit::Same(..) => {}
                }
                k += 1;
            }
            for (i, bi) in inserts.into_iter().enumerate() {
                from[bi] = deletes.get(i).copied();
            }
        }
        let mut seqs: Vec<Option<u32>> = from
            .iter()
            .map(|o| o.map(|ai| seq_value(&old[ai].seq)))
            .collect();
        let mut room = true;
        let mut i = 0;
        while i < b.len() {
            if seqs[i].is_some() {
                i += 1;
                continue;
            }
            let mut j = i;
            while j < b.len() && seqs[j].is_none() {
                j += 1;
            }
            let lo = if i > 0 { seqs[i - 1].unwrap_or(0) } else { 0 };
            let hi = if j < b.len() { seqs[j] } else { None };
            let count = u32::try_from(j - i).unwrap_or(u32::MAX);
            match gap_seqs(lo, hi, count) {
                Some(got) => {
                    for (x, s) in got.into_iter().enumerate() {
                        seqs[i + x] = Some(s);
                    }
                }
                None => {
                    room = false;
                    break;
                }
            }
            i = j;
        }
        let kept = |x: usize, t: &str| {
            from[x].map(|ai| LineDto {
                seq: old[ai].seq.clone(),
                date: old[ai].date.clone(),
                text: t.to_owned(),
            })
        };
        let lines = b
            .iter()
            .enumerate()
            .map(|(x, t)| {
                kept(x, t).unwrap_or_else(|| LineDto {
                    seq: crate::members::codec::seq_from_wire(if room {
                        seqs[x].unwrap_or(0)
                    } else {
                        0
                    }),
                    date: NO_DATE.to_owned(),
                    text: (*t).to_owned(),
                })
            })
            .collect();
        Some(Plan {
            lines,
            renumber: !room,
        })
    }
}

/// The existing calls a deploy is made of. [`Live`] is each call of the
/// same name on a session; the tests script them.
pub trait Steps {
    /// `member.list` of one member: its entry, or `None` when it is not there.
    fn member_entry(&mut self, m: &MemberRefDto) -> Result<Option<MemberDto>, RpcError>;
    fn read(&mut self, m: &MemberRefDto, lock: bool) -> Result<members::ReadResult, RpcError>;
    fn write(
        &mut self,
        m: &MemberRefDto,
        lines: Vec<LineDto>,
        renumber: bool,
    ) -> Result<u32, RpcError>;
    fn unlock(&mut self, m: &MemberRefDto) -> Result<(), RpcError>;
    fn create(&mut self, m: &MemberRefDto, ty: &str, text: &str) -> Result<(), RpcError>;
    fn change_type(&mut self, m: &MemberRefDto, ty: &str) -> Result<(), RpcError>;
    /// `ifs.info`, or `None` when the path is not there.
    fn info(&mut self, path: &str) -> Result<Option<InfoDto>, RpcError>;
    fn mkdir(&mut self, path: &str) -> Result<(), RpcError>;
    /// `ifs.upload` with `mode: "replace"`: the system's size after.
    fn upload(&mut self, from: &str, path: &str, ccsid: Option<u16>) -> Result<u64, RpcError>;
}

/// Params of `deploy.member`.
#[derive(Debug, Deserialize)]
pub struct MemberParams {
    pub name: String,
    #[serde(flatten)]
    pub member: MemberRefDto,
    /// The source type of a member created, and the one an existing member
    /// is changed to when it differs.
    #[serde(rename = "type")]
    pub ty: String,
    /// The text of a member created; an existing member keeps its own.
    #[serde(default)]
    pub text: String,
    /// The local file's lines, trailing blanks removed.
    pub lines: Vec<String>,
    /// The `changed` recorded at the last deploy or pull.
    #[serde(default)]
    pub expect: Option<i64>,
}

/// How a deploy ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Created,
    Written,
    /// The member already held the lines: nothing was written.
    Unchanged,
}

/// Result of `deploy.member`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MemberDeployed {
    pub outcome: Outcome,
    /// Records in the member after.
    pub lines: u32,
    /// The server renumbered it: a new member, or an insert with no room.
    pub renumbered: bool,
    /// The member's `changed` after; `null` when it could not be read.
    pub changed: Option<i64>,
}

/// Params of `deploy.path`.
#[derive(Debug, Deserialize)]
pub struct PathParams {
    pub name: String,
    /// The local file.
    pub from: String,
    pub path: String,
    /// The CCSID of a file created (`encoding.ifsCcsid`); absent for 1208.
    #[serde(default)]
    pub ccsid: Option<u16>,
    /// The `change` recorded at the last deploy or pull.
    #[serde(default)]
    pub expect: Option<String>,
    /// The transfer ID `ifs.progress` and `ifs.cancel` use.
    #[serde(default)]
    pub transfer: Option<String>,
}

/// Result of `deploy.path`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathDeployed {
    pub outcome: Outcome,
    pub size: u64,
    /// The file's `change` after; `null` when it could not be read.
    pub change: Option<String>,
}

fn conflict(what: &str, data: serde_json::Value) -> RpcError {
    let mut e = RpcError::new(codes::CONFLICT, format!("{what} changed on the system"));
    e.data = Some(data);
    e
}

fn label(m: &MemberRefDto) -> String {
    format!("{}/{}({})", m.library, m.file, m.member)
}

/// `deploy.member`, step by step.
pub fn member(t: &mut dyn Steps, p: &MemberParams) -> Result<MemberDeployed, RpcError> {
    let m = &p.member;
    let ty = p.ty.trim().to_ascii_uppercase();
    let Some(entry) = t.member_entry(m)? else {
        t.create(m, &ty, &p.text)?;
        let lines = if p.lines.is_empty() {
            0
        } else {
            let records = p
                .lines
                .iter()
                .map(|text| LineDto {
                    seq: members::codec::seq_from_wire(0),
                    date: plan::NO_DATE.to_owned(),
                    text: text.clone(),
                })
                .collect();
            t.write(m, records, true)?
        };
        let changed = t.member_entry(m).ok().flatten().map(|e| e.changed);
        return Ok(MemberDeployed {
            outcome: Outcome::Created,
            lines,
            renumbered: true,
            changed,
        });
    };
    if let Some(expect) = p.expect
        && entry.changed > expect
    {
        return Err(conflict(&label(m), json!({ "changed": entry.changed })));
    }
    let read = t.read(m, true)?;
    let retype = !ty.is_empty() && read.ty.trim().to_ascii_uppercase() != ty;
    let Some(plan) = plan::plan_write(&read.lines, &p.lines) else {
        t.unlock(m)?;
        if retype {
            t.change_type(m, &ty)?;
        }
        let changed = if retype {
            t.member_entry(m).ok().flatten().map(|e| e.changed)
        } else {
            Some(entry.changed)
        };
        return Ok(MemberDeployed {
            outcome: Outcome::Unchanged,
            lines: u32::try_from(read.lines.len()).unwrap_or(u32::MAX),
            renumbered: false,
            changed,
        });
    };
    let renumbered = plan.renumber;
    let lines = match t.write(m, plan.lines, plan.renumber) {
        Ok(n) => n,
        Err(e) => {
            // Not written: the lock is still ours to end.
            let _ = t.unlock(m);
            return Err(e);
        }
    };
    if retype {
        t.change_type(m, &ty)?;
    }
    let changed = t.member_entry(m).ok().flatten().map(|e| e.changed);
    Ok(MemberDeployed {
        outcome: Outcome::Written,
        lines,
        renumbered,
        changed,
    })
}

/// The directory above `path`; `/` for a path just under it.
fn parent(path: &str) -> &str {
    let p = path.trim_end_matches('/');
    match p.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &p[..i],
    }
}

/// `deploy.path`, step by step.
pub fn path(t: &mut dyn Steps, p: &PathParams) -> Result<PathDeployed, RpcError> {
    let before = t.info(&p.path)?;
    let outcome = match &before {
        Some(info) => {
            if info.entry.kind != KindDto::File {
                return Err(RpcError::invalid_params(format!(
                    "{} is not a stream file",
                    p.path
                )));
            }
            if let Some(expect) = &p.expect
                && &info.change != expect
            {
                return Err(conflict(&p.path, json!({ "change": info.change })));
            }
            Outcome::Written
        }
        None => {
            let dir = parent(&p.path);
            if dir != "/" && t.info(dir)?.is_none() {
                t.mkdir(dir)?;
            }
            Outcome::Created
        }
    };
    let size = t.upload(&p.from, &p.path, p.ccsid)?;
    let change = t.info(&p.path).ok().flatten().map(|i| i.change);
    Ok(PathDeployed {
        outcome,
        size,
        change,
    })
}

/// [`Steps`] on a session: each the host's own call of the same name.
pub struct Live<'a> {
    pub sessions: &'a Sessions,
    pub name: &'a str,
    pub outbound: Option<&'a Outbound>,
    pub transfer: &'a str,
    pub cancel: &'a AtomicBool,
}

impl Steps for Live<'_> {
    fn member_entry(&mut self, m: &MemberRefDto) -> Result<Option<MemberDto>, RpcError> {
        let all = self.sessions.members(members::ListParams {
            name: self.name.to_owned(),
            library: m.library.clone(),
            file: m.file.clone(),
            pattern: Some(m.member.clone()),
        })?;
        Ok(all
            .into_iter()
            .find(|e| e.member.eq_ignore_ascii_case(m.member.trim())))
    }
    fn read(&mut self, m: &MemberRefDto, lock: bool) -> Result<members::ReadResult, RpcError> {
        self.sessions.read_member(members::ReadParams {
            name: self.name.to_owned(),
            member: m.clone(),
            lock,
        })
    }
    fn write(
        &mut self,
        m: &MemberRefDto,
        lines: Vec<LineDto>,
        renumber: bool,
    ) -> Result<u32, RpcError> {
        self.sessions
            .write_member(members::WriteParams {
                name: self.name.to_owned(),
                member: m.clone(),
                lines,
                renumber,
            })
            .map(|w| w.lines)
    }
    fn unlock(&mut self, m: &MemberRefDto) -> Result<(), RpcError> {
        self.sessions.unlock_member(members::MemberParams {
            name: self.name.to_owned(),
            member: m.clone(),
        })
    }
    fn create(&mut self, m: &MemberRefDto, ty: &str, text: &str) -> Result<(), RpcError> {
        self.sessions.create_member(members::CreateParams {
            name: self.name.to_owned(),
            member: m.clone(),
            ty: ty.to_owned(),
            text: text.to_owned(),
        })
    }
    fn change_type(&mut self, m: &MemberRefDto, ty: &str) -> Result<(), RpcError> {
        self.sessions.change_member(members::ChangeParams {
            name: self.name.to_owned(),
            member: m.clone(),
            ty: Some(ty.to_owned()),
            text: None,
        })
    }
    fn info(&mut self, path: &str) -> Result<Option<InfoDto>, RpcError> {
        let got = self.sessions.ifs(self.name, |f| match f.stamp(path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if ifs::not_found(&e) => Ok(None),
            Err(e) => Err(e),
        })?;
        Ok(got.map(|(entry, stamp)| InfoDto {
            entry: EntryDto::from(entry),
            change: ifs::change_text(stamp),
        }))
    }
    fn mkdir(&mut self, path: &str) -> Result<(), RpcError> {
        ifs::mkdir(
            self.sessions,
            &ifs::MkdirParams {
                name: self.name.to_owned(),
                path: path.to_owned(),
                parents: true,
            },
        )
    }
    fn upload(&mut self, from: &str, path: &str, ccsid: Option<u16>) -> Result<u64, RpcError> {
        let sink = Outbound::new(std::io::sink());
        let outbound = self.outbound.unwrap_or(&sink);
        let p = ifs::UploadParams {
            name: self.name.to_owned(),
            from: from.to_owned(),
            path: path.to_owned(),
            ccsid,
            mode: ifs::Mode::Replace,
            transfer: Some(self.transfer.to_owned()),
        };
        ifs::run_upload(self.sessions, outbound, &p, self.transfer, self.cancel)
            .map(|s| s.size)
            .map_err(|(e, _)| e)
    }
}

/// Registers `deploy.*`; `transfers` are `ifs.*`'s, so `ifs.cancel` stops
/// a `deploy.path` upload too.
pub fn register(r: &mut Registry, sessions: &Arc<Sessions>, transfers: &Arc<Transfers>) {
    let s = Arc::clone(sessions);
    r.register("deploy.member", move |p: MemberParams, _: &Context| {
        let never = AtomicBool::new(false);
        let mut live = Live {
            sessions: &s,
            name: &p.name,
            outbound: None,
            transfer: "",
            cancel: &never,
        };
        member(&mut live, &p)
    });
    let s = Arc::clone(sessions);
    let t = Arc::clone(transfers);
    r.register_deferred(
        "deploy.path",
        move |p: PathParams, ctx: &Context, responder: Responder| {
            let (id, cancel) = match t.begin(p.transfer.as_deref()) {
                Ok(x) => x,
                Err(e) => return responder.send::<PathDeployed>(Err(e)),
            };
            let s = Arc::clone(&s);
            let t2 = Arc::clone(&t);
            let outbound = ctx.outbound().clone();
            let spawned = std::thread::Builder::new()
                .name(format!("deploy {id}"))
                .spawn({
                    let id = id.clone();
                    move || {
                        let mut live = Live {
                            sessions: &s,
                            name: &p.name,
                            outbound: Some(&outbound),
                            transfer: &id,
                            cancel: &cancel,
                        };
                        let out = path(&mut live, &p);
                        t2.end(&id);
                        responder.send(out);
                    }
                });
            if spawned.is_err() {
                t.end(&id);
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::plan::*;
    use super::*;

    fn l(seq: &str, date: &str, text: &str) -> LineDto {
        LineDto {
            seq: seq.into(),
            date: date.into(),
            text: text.into(),
        }
    }

    fn lines() -> Vec<LineDto> {
        vec![
            l("0001.00", "260105", "**free"),
            l("0002.00", "260105", "dcl-s count int(10);"),
            l("0003.00", "000000", ""),
            l("0004.00", "251231", "*inlr = *on;"),
        ]
    }

    fn texts(t: &[&str]) -> Vec<String> {
        t.iter().map(|s| (*s).to_owned()).collect()
    }

    // The planner on Phase 2's six save fixtures (test/save.test.ts).

    #[test]
    fn plan_1_no_change_is_nothing() {
        let old = lines();
        let same: Vec<String> = old.iter().map(|x| x.text.clone()).collect();
        assert_eq!(plan_write(&old, &same), None);
    }

    #[test]
    fn plan_2_one_change_keeps_its_seq_and_date() {
        let old = lines();
        let p = plan_write(
            &old,
            &texts(&["**free", "dcl-s count int(20);", "", "*inlr = *on;"]),
        )
        .unwrap();
        assert!(!p.renumber);
        assert_eq!(
            p.lines,
            vec![
                old[0].clone(),
                l("0002.00", "260105", "dcl-s count int(20);"),
                old[2].clone(),
                old[3].clone()
            ]
        );
    }

    #[test]
    fn plan_3_insert_at_the_top_is_midway_from_zero() {
        let old = lines();
        let mut t = texts(&["// top"]);
        t.extend(old.iter().map(|x| x.text.clone()));
        let p = plan_write(&old, &t).unwrap();
        assert_eq!(p.lines[0], l("0000.50", "000000", "// top"));
        assert_eq!(&p.lines[1..], &old[..]);
        assert!(!p.renumber);
    }

    #[test]
    fn plan_4_two_inserts_between_their_neighbours() {
        let old = lines();
        let p = plan_write(
            &old,
            &texts(&[
                "**free",
                "dcl-s count int(10);",
                "",
                "dcl-s a int(10);",
                "dcl-s b int(10);",
                "*inlr = *on;",
            ]),
        )
        .unwrap();
        assert_eq!(p.lines[3], l("0003.33", "000000", "dcl-s a int(10);"));
        assert_eq!(p.lines[4], l("0003.66", "000000", "dcl-s b int(10);"));
        assert!(!p.renumber);
    }

    #[test]
    fn plan_5_no_room_renumbers_with_old_seqs_kept() {
        let old = vec![l("0001.00", "260105", "a"), l("0001.01", "251231", "b")];
        let p = plan_write(&old, &texts(&["a", "new", "b"])).unwrap();
        assert!(p.renumber);
        assert_eq!(
            p.lines,
            vec![
                l("0001.00", "260105", "a"),
                l("0000.00", "000000", "new"),
                l("0001.01", "251231", "b")
            ]
        );
    }

    #[test]
    fn plan_6_deletes_keep_the_rest() {
        let old = lines();
        let p = plan_write(&old, &texts(&["**free", "*inlr = *on;"])).unwrap();
        assert_eq!(p.lines, vec![old[0].clone(), old[3].clone()]);
        assert!(!p.renumber);
    }

    #[test]
    fn gaps_as_the_extension_has_them() {
        assert_eq!(gap_seqs(300, Some(400), 1), Some(vec![350]));
        assert_eq!(gap_seqs(300, Some(400), 2), Some(vec![333, 366]));
        assert_eq!(gap_seqs(100, Some(101), 1), None);
        assert_eq!(gap_seqs(400, None, 3), Some(vec![500, 600, 700]));
        assert_eq!(gap_seqs(999_950, None, 1), Some(vec![999_975]));
        assert_eq!(gap_seqs(999_999, None, 1), None);
    }

    /// A scripted system: what each step answers, and every step taken.
    #[derive(Default)]
    struct Mock {
        steps: Vec<String>,
        entry: Option<MemberDto>,
        /// `changed` the member has after a write.
        after: i64,
        read: Vec<LineDto>,
        ty: String,
        written: Option<(Vec<LineDto>, bool)>,
        fail_write: bool,
        files: std::collections::BTreeMap<String, (KindDto, String)>,
        uploads: Vec<(String, String, Option<u16>)>,
    }

    fn entry(changed: i64) -> MemberDto {
        MemberDto {
            member: "ASSETS".into(),
            ty: "RPGLE".into(),
            text: "Asset maintenance".into(),
            records: 4,
            created: 1,
            changed,
        }
    }

    fn info_of(path: &str, kind: KindDto, change: &str) -> InfoDto {
        InfoDto {
            entry: EntryDto {
                name: path.rsplit('/').next().unwrap_or("").into(),
                kind,
                size: 3,
                modified: 0,
                owner: "CWELLMAN".into(),
                ccsid: 1208,
                target: None,
            },
            change: change.into(),
        }
    }

    impl Steps for Mock {
        fn member_entry(&mut self, m: &MemberRefDto) -> Result<Option<MemberDto>, RpcError> {
            self.steps.push(format!("list {}", label(m)));
            Ok(self.entry.clone())
        }
        fn read(&mut self, m: &MemberRefDto, lock: bool) -> Result<members::ReadResult, RpcError> {
            self.steps.push(format!("read {} lock={lock}", label(m)));
            Ok(members::ReadResult {
                ty: self.ty.clone(),
                text: String::new(),
                width: 100,
                ccsid: 37,
                lines: self.read.clone(),
            })
        }
        fn write(
            &mut self,
            m: &MemberRefDto,
            lines: Vec<LineDto>,
            renumber: bool,
        ) -> Result<u32, RpcError> {
            self.steps
                .push(format!("write {} renumber={renumber}", label(m)));
            if self.fail_write {
                return Err(RpcError::new(-32010, "TCP1A5A: not converted"));
            }
            let n = u32::try_from(lines.len()).unwrap();
            self.written = Some((lines, renumber));
            let mut e = self.entry.clone().unwrap_or_else(|| entry(0));
            e.changed = self.after;
            self.entry = Some(e);
            Ok(n)
        }
        fn unlock(&mut self, m: &MemberRefDto) -> Result<(), RpcError> {
            self.steps.push(format!("unlock {}", label(m)));
            Ok(())
        }
        fn create(&mut self, m: &MemberRefDto, ty: &str, text: &str) -> Result<(), RpcError> {
            self.steps
                .push(format!("create {} {ty} {text:?}", label(m)));
            Ok(())
        }
        fn change_type(&mut self, m: &MemberRefDto, ty: &str) -> Result<(), RpcError> {
            self.steps.push(format!("change {} {ty}", label(m)));
            Ok(())
        }
        fn info(&mut self, path: &str) -> Result<Option<InfoDto>, RpcError> {
            self.steps.push(format!("info {path}"));
            Ok(self.files.get(path).map(|(k, c)| info_of(path, *k, c)))
        }
        fn mkdir(&mut self, path: &str) -> Result<(), RpcError> {
            self.steps.push(format!("mkdir {path}"));
            self.files
                .insert(path.into(), (KindDto::Directory, "1".into()));
            Ok(())
        }
        fn upload(&mut self, from: &str, path: &str, ccsid: Option<u16>) -> Result<u64, RpcError> {
            self.steps.push(format!("upload {from} {path}"));
            self.uploads.push((from.into(), path.into(), ccsid));
            let next = self
                .files
                .get(path)
                .map_or(1, |(_, c)| c.parse::<u64>().unwrap_or(0) + 1);
            self.files
                .insert(path.into(), (KindDto::File, next.to_string()));
            Ok(3)
        }
    }

    fn assets() -> MemberRefDto {
        MemberRefDto {
            library: "HLINVDEV".into(),
            file: "QRPGLESRC".into(),
            member: "ASSETS".into(),
        }
    }

    fn params(lines: &[&str], expect: Option<i64>) -> MemberParams {
        MemberParams {
            name: "QSHQ400".into(),
            member: assets(),
            ty: "RPGLE".into(),
            text: "Asset maintenance".into(),
            lines: texts(lines),
            expect,
        }
    }

    #[test]
    fn an_existing_member_is_listed_locked_read_written_and_listed_again() {
        let mut m = Mock {
            entry: Some(entry(1_000)),
            after: 2_000,
            read: lines(),
            ty: "RPGLE".into(),
            ..Mock::default()
        };
        let r = member(
            &mut m,
            &params(
                &["**free", "dcl-s count int(20);", "", "*inlr = *on;"],
                Some(1_000),
            ),
        )
        .unwrap();
        assert_eq!(
            m.steps,
            vec![
                "list HLINVDEV/QRPGLESRC(ASSETS)",
                "read HLINVDEV/QRPGLESRC(ASSETS) lock=true",
                // The write ends the lock: no unlock after it.
                "write HLINVDEV/QRPGLESRC(ASSETS) renumber=false",
                "list HLINVDEV/QRPGLESRC(ASSETS)",
            ]
        );
        let (written, renumber) = m.written.unwrap();
        assert!(!renumber);
        assert_eq!(written[1], l("0002.00", "260105", "dcl-s count int(20);"));
        assert_eq!(written[0], lines()[0], "unchanged lines keep seq and date");
        assert_eq!(
            r,
            MemberDeployed {
                outcome: Outcome::Written,
                lines: 4,
                renumbered: false,
                changed: Some(2_000)
            }
        );
    }

    #[test]
    fn a_new_member_is_created_with_its_type_and_text_then_written_renumbered() {
        let mut m = Mock {
            after: 3_000,
            ..Mock::default()
        };
        let r = member(&mut m, &params(&["**free", "*inlr = *on;"], None)).unwrap();
        assert_eq!(
            m.steps,
            vec![
                "list HLINVDEV/QRPGLESRC(ASSETS)",
                r#"create HLINVDEV/QRPGLESRC(ASSETS) RPGLE "Asset maintenance""#,
                "write HLINVDEV/QRPGLESRC(ASSETS) renumber=true",
                "list HLINVDEV/QRPGLESRC(ASSETS)",
            ]
        );
        let (written, renumber) = m.written.unwrap();
        assert!(renumber);
        assert_eq!(
            written,
            vec![
                l("0000.00", "000000", "**free"),
                l("0000.00", "000000", "*inlr = *on;")
            ],
            "no seq and no date: the server numbers and dates them"
        );
        assert_eq!(r.outcome, Outcome::Created);
        assert!(r.renumbered);
        assert_eq!(r.changed, Some(3_000));
    }

    #[test]
    fn nothing_to_write_unlocks_and_keeps_the_timestamp() {
        let mut m = Mock {
            entry: Some(entry(1_000)),
            read: lines(),
            ty: "RPGLE".into(),
            ..Mock::default()
        };
        let same: Vec<&str> = vec!["**free", "dcl-s count int(10);", "", "*inlr = *on;"];
        let r = member(&mut m, &params(&same, Some(1_000))).unwrap();
        assert_eq!(
            m.steps,
            vec![
                "list HLINVDEV/QRPGLESRC(ASSETS)",
                "read HLINVDEV/QRPGLESRC(ASSETS) lock=true",
                "unlock HLINVDEV/QRPGLESRC(ASSETS)",
            ]
        );
        assert_eq!(r.outcome, Outcome::Unchanged);
        assert_eq!(r.changed, Some(1_000));
    }

    #[test]
    fn a_newer_timestamp_is_a_conflict_before_anything_is_locked_or_written() {
        let mut m = Mock {
            entry: Some(entry(5_000)),
            read: lines(),
            ..Mock::default()
        };
        let e = member(&mut m, &params(&["x"], Some(1_000))).unwrap_err();
        assert_eq!(e.code, codes::CONFLICT);
        assert_eq!(e.data, Some(json!({ "changed": 5_000 })));
        assert_eq!(m.steps, vec!["list HLINVDEV/QRPGLESRC(ASSETS)"]);
        // The same timestamp, an older one, or none asked for: no conflict.
        for expect in [Some(5_000), Some(9_000), None] {
            let mut m = Mock {
                entry: Some(entry(5_000)),
                read: lines(),
                ty: "RPGLE".into(),
                ..Mock::default()
            };
            assert!(
                member(&mut m, &params(&["x"], expect)).is_ok(),
                "{expect:?}"
            );
        }
    }

    #[test]
    fn a_write_refused_ends_the_lock_and_passes_the_error() {
        let mut m = Mock {
            entry: Some(entry(1_000)),
            read: lines(),
            ty: "RPGLE".into(),
            fail_write: true,
            ..Mock::default()
        };
        let e = member(&mut m, &params(&["changed"], None)).unwrap_err();
        assert_eq!(e.message, "TCP1A5A: not converted");
        assert_eq!(
            m.steps[1..],
            [
                "read HLINVDEV/QRPGLESRC(ASSETS) lock=true",
                "write HLINVDEV/QRPGLESRC(ASSETS) renumber=false",
                "unlock HLINVDEV/QRPGLESRC(ASSETS)",
            ]
        );
    }

    #[test]
    fn a_member_of_another_type_gets_the_local_files_type() {
        let mut m = Mock {
            entry: Some(entry(1_000)),
            read: lines(),
            ty: "RPGLE".into(),
            ..Mock::default()
        };
        let mut p = params(&["**free"], None);
        p.ty = "sqlrpgle".into();
        member(&mut m, &p).unwrap();
        assert!(
            m.steps
                .contains(&"change HLINVDEV/QRPGLESRC(ASSETS) SQLRPGLE".to_owned())
        );
    }

    fn path_params(path: &str, expect: Option<&str>) -> PathParams {
        PathParams {
            name: "QSHQ400".into(),
            from: "C:/w/app/src/a.sql".into(),
            path: path.into(),
            ccsid: Some(1208),
            expect: expect.map(str::to_owned),
            transfer: Some("d1".into()),
        }
    }

    #[test]
    fn a_new_stream_file_makes_its_directory_then_uploads_replace_with_the_ccsid() {
        let mut m = Mock::default();
        let r = path(&mut m, &path_params("/home/CWELLMAN/app/src/a.sql", None)).unwrap();
        assert_eq!(
            m.steps,
            vec![
                "info /home/CWELLMAN/app/src/a.sql",
                "info /home/CWELLMAN/app/src",
                "mkdir /home/CWELLMAN/app/src",
                "upload C:/w/app/src/a.sql /home/CWELLMAN/app/src/a.sql",
                "info /home/CWELLMAN/app/src/a.sql",
            ]
        );
        assert_eq!(
            m.uploads,
            vec![(
                "C:/w/app/src/a.sql".into(),
                "/home/CWELLMAN/app/src/a.sql".into(),
                Some(1208)
            )]
        );
        assert_eq!(
            r,
            PathDeployed {
                outcome: Outcome::Created,
                size: 3,
                change: Some("1".into())
            }
        );
    }

    #[test]
    fn an_existing_stream_file_is_checked_against_its_change_and_replaced() {
        let mut m = Mock::default();
        m.files
            .insert("/app/a.sql".into(), (KindDto::File, "7".into()));
        let e = path(&mut m, &path_params("/app/a.sql", Some("6"))).unwrap_err();
        assert_eq!(e.code, codes::CONFLICT);
        assert_eq!(e.data, Some(json!({ "change": "7" })));
        assert_eq!(
            m.steps,
            vec!["info /app/a.sql"],
            "nothing sent after the check"
        );
        let mut m = Mock::default();
        m.files
            .insert("/app/a.sql".into(), (KindDto::File, "7".into()));
        let r = path(&mut m, &path_params("/app/a.sql", Some("7"))).unwrap();
        assert_eq!(r.outcome, Outcome::Written);
        assert_eq!(r.change, Some("8".into()));
        assert_eq!(
            m.steps,
            vec![
                "info /app/a.sql",
                "upload C:/w/app/src/a.sql /app/a.sql",
                "info /app/a.sql"
            ],
            "no directory made for a file that is there"
        );
        let mut m = Mock::default();
        m.files
            .insert("/app/d".into(), (KindDto::Directory, "1".into()));
        assert_eq!(
            path(&mut m, &path_params("/app/d", None)).unwrap_err().code,
            host_rpc::codes::INVALID_PARAMS
        );
    }
}
