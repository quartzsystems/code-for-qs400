// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `member.*`: source members, each a thin layer over one `Develop`
//! operation in the named connection's session.
//!
//! - Over JSON-RPC a record is `{ seq, date, text }`: `seq` the sequence
//!   number as a decimal string with two decimals (`"0001.00"`), `date`
//!   `YYMMDD` (`"000000"` for none). They become the spec's `u32`s
//!   (hundredths; `yymmdd`) in [`codec`] and nowhere else.
//! - `member.write` hands the whole record list to `qap-client`, which
//!   splits it into `WriteMember` pieces itself; `renumber` goes through
//!   `WriteOptions`, `srctype` and `text` stay `None`.
//! - Text is UTF-8 as the server sends and takes it. Nothing here converts
//!   or substitutes a character; the server's refusals (`CPF1002`,
//!   `TCP1A5A`, `TCP1A61`, ...) pass through as they came.

use std::sync::Arc;

use host_rpc::{Context, Registry, RpcError};
use qap_client::develop::WriteOptions;
use qap_client::proto::ops::develop::ListMembers;
use qap_client::proto::types::{MemberName, ObjectName, SourceRecord};
use serde::{Deserialize, Serialize};

use crate::objects::{drain, required};
use crate::session::Sessions;

/// `seq` and `date` between their JSON strings and the spec's `u32`s.
pub mod codec {
    use host_rpc::RpcError;

    /// The largest sequence number: `9999.99`.
    pub const MAX_SEQ: u32 = 999_999;

    /// `"0001.00"` as hundredths (`100`). One to four digits, a point, two
    /// digits; at most `9999.99`.
    pub fn seq_to_wire(s: &str) -> Result<u32, RpcError> {
        let bad = || RpcError::invalid_params(format!("not a sequence number: {s:?}"));
        let (whole, frac) = s.split_once('.').ok_or_else(bad)?;
        let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
        if !digits(whole) || whole.len() > 4 || !digits(frac) || frac.len() != 2 {
            return Err(bad());
        }
        let whole: u32 = whole.parse().map_err(|_| bad())?;
        let frac: u32 = frac.parse().map_err(|_| bad())?;
        Ok(whole * 100 + frac)
    }

    /// Hundredths as `"0001.00"`.
    pub fn seq_from_wire(n: u32) -> String {
        format!("{:04}.{:02}", n / 100, n % 100)
    }

    /// `"YYMMDD"` as `yymmdd`; `"000000"` is 0, no date.
    pub fn date_to_wire(s: &str) -> Result<u32, RpcError> {
        if s.len() != 6 || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(RpcError::invalid_params(format!(
                "not a YYMMDD date: {s:?}"
            )));
        }
        s.parse()
            .map_err(|_| RpcError::invalid_params(format!("not a YYMMDD date: {s:?}")))
    }

    /// `yymmdd` as `"YYMMDD"`; 0 is `"000000"`.
    pub fn date_from_wire(n: u32) -> String {
        format!("{n:06}")
    }
}

/// A record over JSON-RPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineDto {
    pub seq: String,
    pub date: String,
    pub text: String,
}

impl LineDto {
    fn from_wire(r: SourceRecord) -> LineDto {
        LineDto {
            seq: codec::seq_from_wire(r.seq),
            date: codec::date_from_wire(r.date),
            text: r.data,
        }
    }

    fn to_wire(&self) -> Result<SourceRecord, RpcError> {
        Ok(SourceRecord {
            seq: codec::seq_to_wire(&self.seq)?,
            date: codec::date_to_wire(&self.date)?,
            data: self.text.clone(),
        })
    }
}

/// A member's name over JSON-RPC.
#[derive(Debug, Clone, Deserialize)]
pub struct MemberRefDto {
    /// A library, or `*LIBL` or `*CURLIB`.
    pub library: String,
    pub file: String,
    pub member: String,
}

impl MemberRefDto {
    fn to_wire(&self) -> Result<MemberName, RpcError> {
        Ok(MemberName {
            file: ObjectName {
                library: required("library", &self.library)?,
                name: required("file", &self.file)?,
            },
            member: required("member", &self.member)?,
        })
    }
}

/// Params of `member.unlock` and `member.delete`.
#[derive(Debug, Deserialize)]
pub struct MemberParams {
    pub name: String,
    #[serde(flatten)]
    pub member: MemberRefDto,
}

/// Params of `member.list`.
#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub name: String,
    pub library: String,
    pub file: String,
    #[serde(default)]
    pub pattern: Option<String>,
}

/// A `member.list` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberDto {
    pub member: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub text: String,
    pub records: u32,
    /// Milliseconds since 1970-01-01 UTC.
    pub created: i64,
    pub changed: i64,
}

/// Params of `member.read`.
#[derive(Debug, Deserialize)]
pub struct ReadParams {
    pub name: String,
    #[serde(flatten)]
    pub member: MemberRefDto,
    pub lock: bool,
}

/// Result of `member.read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadResult {
    #[serde(rename = "type")]
    pub ty: String,
    pub text: String,
    /// The record's data length in the file's bytes.
    pub width: u16,
    /// The file's CCSID.
    pub ccsid: u16,
    pub lines: Vec<LineDto>,
}

/// Params of `member.write`.
#[derive(Debug, Deserialize)]
pub struct WriteParams {
    pub name: String,
    #[serde(flatten)]
    pub member: MemberRefDto,
    pub lines: Vec<LineDto>,
    #[serde(default)]
    pub renumber: bool,
}

/// Result of `member.write`: the member's records as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriteResult {
    pub lines: u32,
}

/// Params of `member.create`.
#[derive(Debug, Deserialize)]
pub struct CreateParams {
    pub name: String,
    #[serde(flatten)]
    pub member: MemberRefDto,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default)]
    pub text: String,
}

/// Params of `member.copy`.
#[derive(Debug, Deserialize)]
pub struct CopyParams {
    pub name: String,
    pub from: MemberRefDto,
    pub to: MemberRefDto,
    #[serde(default)]
    pub replace: bool,
}

/// Params of `member.rename`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameParams {
    pub name: String,
    #[serde(flatten)]
    pub member: MemberRefDto,
    pub new_name: String,
}

/// Params of `member.changeText`: `type` and `text` absent leave each as
/// it is.
#[derive(Debug, Deserialize)]
pub struct ChangeParams {
    pub name: String,
    #[serde(flatten)]
    pub member: MemberRefDto,
    #[serde(default, rename = "type")]
    pub ty: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

impl Sessions {
    /// `member.list`: `ListMembers`, every page.
    pub fn members(&self, p: ListParams) -> Result<Vec<MemberDto>, RpcError> {
        let file = ObjectName {
            library: required("library", &p.library)?,
            name: required("file", &p.file)?,
        };
        let pattern = p.pattern.unwrap_or_default();
        let all = self.develop(&p.name, |d| {
            drain(|start, max| {
                let page = d.list_members(&ListMembers {
                    file: file.clone(),
                    pattern: pattern.clone(),
                    start,
                    max,
                })?;
                Ok((page.total, page.members))
            })
        })?;
        Ok(all
            .into_iter()
            .map(|m| MemberDto {
                member: m.name,
                ty: m.srctype,
                text: m.text,
                records: m.records,
                created: m.created,
                changed: m.changed,
            })
            .collect())
    }

    /// `member.read`: `ReadMember`, the whole member.
    pub fn read_member(&self, p: ReadParams) -> Result<ReadResult, RpcError> {
        let member = p.member.to_wire()?;
        let data = self.develop(&p.name, |d| d.read_member(&member, p.lock))?;
        Ok(ReadResult {
            ty: data.srctype,
            text: data.text,
            width: data.width,
            ccsid: data.ccsid,
            lines: data.records.into_iter().map(LineDto::from_wire).collect(),
        })
    }

    /// `member.write`: `WriteMember` with every record; `qap-client`
    /// sends the pieces.
    pub fn write_member(&self, p: WriteParams) -> Result<WriteResult, RpcError> {
        let member = p.member.to_wire()?;
        let records = p
            .lines
            .iter()
            .map(LineDto::to_wire)
            .collect::<Result<Vec<_>, _>>()?;
        let options = WriteOptions {
            renumber: p.renumber,
            srctype: None,
            text: None,
        };
        let lines = self.develop(&p.name, |d| d.write_member(&member, &records, &options))?;
        Ok(WriteResult { lines })
    }

    /// `member.unlock`: `UnlockMember`.
    pub fn unlock_member(&self, p: MemberParams) -> Result<(), RpcError> {
        let member = p.member.to_wire()?;
        self.develop(&p.name, |d| d.unlock_member(&member))
    }

    /// `member.create`: `CreateMember` (`ADDPFM`).
    pub fn create_member(&self, p: CreateParams) -> Result<(), RpcError> {
        let member = p.member.to_wire()?;
        let ty = required("type", &p.ty)?;
        self.develop(&p.name, |d| d.create_member(&member, &ty, &p.text))
    }

    /// `member.copy`: `CopyMember` (`CPYSRCF` of one member).
    pub fn copy_member(&self, p: CopyParams) -> Result<(), RpcError> {
        let from = p.from.to_wire()?;
        let to = p.to.to_wire()?;
        self.develop(&p.name, |d| d.copy_member(&from, &to, p.replace))
    }

    /// `member.rename`: `RenameMember` (`RNMM`).
    pub fn rename_member(&self, p: RenameParams) -> Result<(), RpcError> {
        let member = p.member.to_wire()?;
        let new_name = required("newName", &p.new_name)?;
        self.develop(&p.name, |d| d.rename_member(&member, &new_name))
    }

    /// `member.delete`: `DeleteMember` (`RMVM`).
    pub fn delete_member(&self, p: MemberParams) -> Result<(), RpcError> {
        let member = p.member.to_wire()?;
        self.develop(&p.name, |d| d.delete_member(&member))
    }

    /// `member.changeText`: `ChangeMember` (`CHGPFM`).
    pub fn change_member(&self, p: ChangeParams) -> Result<(), RpcError> {
        let member = p.member.to_wire()?;
        self.develop(&p.name, |d| {
            d.change_member(&member, p.ty.as_deref(), p.text.as_deref())
        })
    }
}

/// Registers `member.*`.
pub fn register(r: &mut Registry, sessions: &Arc<Sessions>) {
    let s = Arc::clone(sessions);
    r.register("member.list", move |p: ListParams, _: &Context| {
        s.members(p)
    });
    let s = Arc::clone(sessions);
    r.register("member.read", move |p: ReadParams, _: &Context| {
        s.read_member(p)
    });
    let s = Arc::clone(sessions);
    r.register("member.write", move |p: WriteParams, _: &Context| {
        s.write_member(p)
    });
    let s = Arc::clone(sessions);
    r.register("member.unlock", move |p: MemberParams, _: &Context| {
        s.unlock_member(p)
    });
    let s = Arc::clone(sessions);
    r.register("member.create", move |p: CreateParams, _: &Context| {
        s.create_member(p)
    });
    let s = Arc::clone(sessions);
    r.register("member.copy", move |p: CopyParams, _: &Context| {
        s.copy_member(p)
    });
    let s = Arc::clone(sessions);
    r.register("member.rename", move |p: RenameParams, _: &Context| {
        s.rename_member(p)
    });
    let s = Arc::clone(sessions);
    r.register("member.delete", move |p: MemberParams, _: &Context| {
        s.delete_member(p)
    });
    let s = Arc::clone(sessions);
    r.register("member.changeText", move |p: ChangeParams, _: &Context| {
        s.change_member(p)
    });
}

#[cfg(test)]
mod tests {
    use super::codec::*;

    #[test]
    fn seq_at_its_edges() {
        assert_eq!(seq_to_wire("0000.01").unwrap(), 1);
        assert_eq!(seq_to_wire("0001.00").unwrap(), 100);
        assert_eq!(seq_to_wire("9999.99").unwrap(), MAX_SEQ);
        assert_eq!(seq_to_wire("0000.00").unwrap(), 0);
        assert_eq!(seq_to_wire("1.50").unwrap(), 150);
        assert_eq!(seq_from_wire(1), "0000.01");
        assert_eq!(seq_from_wire(100), "0001.00");
        assert_eq!(seq_from_wire(MAX_SEQ), "9999.99");
        assert_eq!(seq_from_wire(0), "0000.00");
        for n in [0, 1, 99, 100, 101, 4250, 123_456, MAX_SEQ] {
            assert_eq!(seq_to_wire(&seq_from_wire(n)).unwrap(), n);
        }
    }

    #[test]
    fn seq_refuses_anything_else() {
        for s in [
            "", "1", "0001", "0001.0", "0001.000", "10000.00", ".00", "1.", "-001.00", "+001.00",
            "0001,00", "00a1.00", " 001.00", "0001.00 ", "１.00",
        ] {
            let e = seq_to_wire(s).unwrap_err();
            assert_eq!(e.code, host_rpc::codes::INVALID_PARAMS, "{s:?}");
        }
    }

    #[test]
    fn date_at_its_edges() {
        assert_eq!(date_to_wire("000000").unwrap(), 0);
        assert_eq!(date_from_wire(0), "000000");
        assert_eq!(date_to_wire("260105").unwrap(), 260_105);
        assert_eq!(date_from_wire(260_105), "260105");
        // A year 2000 to 2009 date has leading zeros.
        assert_eq!(date_from_wire(10_105), "010105");
        assert_eq!(date_to_wire("010105").unwrap(), 10_105);
        assert_eq!(date_to_wire("999999").unwrap(), 999_999);
        for s in ["", "0", "26015", "2601050", "26-1-5", "abcdef", " 60105"] {
            assert_eq!(
                date_to_wire(s).unwrap_err().code,
                host_rpc::codes::INVALID_PARAMS,
                "{s:?}"
            );
        }
    }
}
