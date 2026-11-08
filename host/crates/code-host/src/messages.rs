// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `messages.*`: `qap-client`'s `Messages` (version 6, the spec's
//! "Service 7 `Messages`"), thin, through [`Sessions::work`].
//!
//! - `messages.list` drains a queue in pages of [`PAGE`], newest first or
//!   oldest first by arrival, as the server orders them.
//! - `messages.reply`, `messages.remove` and `messages.send` are one call
//!   each. A reply is passed as typed: an empty one is the message's
//!   default, as the spec has it; one the message does not take is the
//!   server's `CPF2420`, one already answered `CPF2422`.
//! - `messages.canRead` is `may_read_queue`: `ListMessages` of one
//!   message, `false` for `NotAuthorized`. It is the one place authority
//!   is asked before it is used.
//! - `messages.watch` and `messages.unwatch` are the extension's watch of
//!   a queue, counted in [`Watches`]; what arrives goes out as
//!   `messages.arrived`.
//!
//! Keys travel as 8 hexadecimal characters ([`crate::codec`]).

use std::sync::Arc;

use host_rpc::{Context, Registry, RpcError};
use qap_client::Watch;
use qap_client::proto::ops::messages::QueuedMessage;
use serde::{Deserialize, Serialize};

use crate::codec::{JobDto, MessageTypeDto, QueueDto, RecipientDto, job_dto, key_text, parse_key};
use crate::session::{QAP_WATCH, Sessions};
use crate::watches::Watches;

/// Messages asked for in one `ListMessages`.
pub const PAGE: u32 = 500;

/// Params of `messages.list`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    pub name: String,
    pub queue: QueueDto,
    #[serde(default)]
    pub newest_first: bool,
}

/// Params of `messages.reply`.
#[derive(Debug, Deserialize)]
pub struct ReplyParams {
    pub name: String,
    pub queue: QueueDto,
    pub key: String,
    /// Empty for the message's default reply.
    pub reply: String,
}

/// Params of `messages.remove`.
#[derive(Debug, Deserialize)]
pub struct RemoveParams {
    pub name: String,
    pub queue: QueueDto,
    pub keys: Vec<String>,
}

/// Params of `messages.send`.
#[derive(Debug, Deserialize)]
pub struct SendParams {
    pub name: String,
    pub to: RecipientDto,
    pub text: String,
    #[serde(default)]
    pub inquiry: bool,
}

/// Result of `messages.send`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SentDto {
    /// An inquiry's: the key its reply's `answers` will name on the
    /// sender's own queue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// Params of `messages.canRead`, `messages.watch` and `messages.unwatch`.
#[derive(Debug, Deserialize)]
pub struct QueueParams {
    pub name: String,
    pub queue: QueueDto,
}

/// Result of `messages.canRead`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanReadDto {
    pub ok: bool,
}

/// A message on a queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessageDto {
    /// 8 hexadecimal characters.
    pub key: String,
    /// Empty for an impromptu message.
    pub id: String,
    pub kind: MessageTypeDto,
    pub severity: u8,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub second_level: Option<String>,
    /// Milliseconds since 1970-01-01 UTC.
    pub sent: i64,
    pub from_user: String,
    pub from_job: JobDto,
    /// An inquiry waiting for its reply.
    pub needs_reply: bool,
    /// An inquiry's or a sender's copy's reply, once it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    /// A reply's: the key of the message it answers on the same queue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<String>,
}

impl From<QueuedMessage> for QueuedMessageDto {
    fn from(m: QueuedMessage) -> QueuedMessageDto {
        QueuedMessageDto {
            key: key_text(&m.key),
            id: m.id,
            kind: m.kind.into(),
            severity: m.severity,
            text: m.text,
            second_level: (!m.help.trim().is_empty()).then_some(m.help),
            sent: m.sent,
            from_user: m.from_user,
            from_job: job_dto(&m.from_job),
            needs_reply: m.needs_reply,
            reply: m.reply,
            answers: m.answers.as_ref().map(key_text),
        }
    }
}

/// `messages.list`: the whole queue.
pub fn list(s: &Sessions, p: &ListParams) -> Result<Vec<QueuedMessageDto>, RpcError> {
    let queue = p.queue.queue()?;
    let mut out: Vec<QueuedMessageDto> = Vec::new();
    loop {
        let start = u32::try_from(out.len()).unwrap_or(u32::MAX);
        let page = s.work(&p.name, QAP_WATCH, |w| {
            w.list_messages(&queue, p.newest_first, start, PAGE)
        })?;
        let n = page.messages.len();
        out.extend(page.messages.into_iter().map(QueuedMessageDto::from));
        if n == 0 || out.len() >= page.total as usize {
            return Ok(out);
        }
    }
}

/// `messages.reply`.
pub fn reply(s: &Sessions, p: &ReplyParams) -> Result<(), RpcError> {
    let queue = p.queue.queue()?;
    let key = parse_key(&p.key)?;
    s.work(&p.name, QAP_WATCH, |w| {
        w.reply_message(&queue, key, &p.reply)
    })
}

/// `messages.remove`: all of `keys`, or none.
pub fn remove(s: &Sessions, p: &RemoveParams) -> Result<(), RpcError> {
    let queue = p.queue.queue()?;
    if p.keys.is_empty() {
        return Err(RpcError::invalid_params("keys is empty"));
    }
    let keys = p
        .keys
        .iter()
        .map(|k| parse_key(k))
        .collect::<Result<Vec<_>, _>>()?;
    s.work(&p.name, QAP_WATCH, |w| w.remove_messages(&queue, &keys))
}

/// `messages.send`.
pub fn send(s: &Sessions, p: &SendParams) -> Result<SentDto, RpcError> {
    let to = p.to.recipient()?;
    let key = s.work(&p.name, QAP_WATCH, |w| {
        w.send_message(&to, &p.text, p.inquiry)
    })?;
    Ok(SentDto {
        key: key.as_ref().map(key_text),
    })
}

/// `messages.canRead`.
pub fn can_read(s: &Sessions, p: &QueueParams) -> Result<CanReadDto, RpcError> {
    let queue = p.queue.queue()?;
    let ok = s.work(&p.name, QAP_WATCH, |w| w.may_read_queue(&queue))?;
    Ok(CanReadDto { ok })
}

/// Registers `messages.*`.
pub fn register(r: &mut Registry, sessions: &Arc<Sessions>, watches: &Arc<Watches>) {
    let s = Arc::clone(sessions);
    r.register("messages.list", move |p: ListParams, _: &Context| {
        list(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("messages.reply", move |p: ReplyParams, _: &Context| {
        reply(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("messages.remove", move |p: RemoveParams, _: &Context| {
        remove(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("messages.send", move |p: SendParams, _: &Context| {
        send(&s, &p)
    });
    let s = Arc::clone(sessions);
    r.register("messages.canRead", move |p: QueueParams, _: &Context| {
        can_read(&s, &p)
    });
    let w = Arc::clone(watches);
    r.register("messages.watch", move |p: QueueParams, _: &Context| {
        w.watch(&p.name, Watch::Queue(p.queue.queue()?))
    });
    let w = Arc::clone(watches);
    r.register("messages.unwatch", move |p: QueueParams, _: &Context| {
        w.unwatch(&p.name, Watch::Queue(p.queue.queue()?))
    });
}
