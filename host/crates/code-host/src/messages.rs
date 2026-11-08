// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `messages.*`: `qap-client`'s `Messages` (version 6, the spec's
//! "Service 7 `Messages`"), and the message as JSON.

use qap_client::proto::ops::messages::QueuedMessage;
use serde::{Deserialize, Serialize};

use crate::codec::{JobDto, MessageTypeDto, job_dto, key_text};

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
