// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The one place `jobs.*`, `spool.*` and `messages.*` turn QAP's values
//! into JSON and back, as `members::codec` is for `seq` and `date`.
//!
//! - A message key (4 bytes) is 8 upper-case hexadecimal characters, as
//!   the system shows it (`000001A2`); reading one takes either case.
//! - A `JobId` is `{ number, user, name }` ([`JobDto`]) and is written
//!   `nnnnnn/USER/NAME` ([`job_text`]). Names are trimmed and refused when
//!   empty, the number must be six digits; no case is folded (the server
//!   does), as Phase 2 decision 6 passes names.
//! - An `ObjectName` is `{ library, name }`.
//! - A `Queue` is `"own"`, `"sysopr"` or `{ library, queue }`; a
//!   `Recipient` `{ profile }` or `{ queue }`; a `SpoolTarget` `{ outq }`
//!   or `{ profile }`.
//! - Enums are their spec names in lower camel case: `onJobQueue`,
//!   `held`, `senderCopy`, `controlled`.

use host_rpc::RpcError;
use qap_client::proto::ops::jobs::JobState;
use qap_client::proto::ops::messages::{Key, MessageType, Queue, Recipient};
use qap_client::proto::ops::spool::{
    DeviceType, SpoolChange, SpoolStatus, SpoolTarget, SpooledFileId,
};
use qap_client::proto::types::{EndHow, JobId, ObjectName};
use serde::{Deserialize, Serialize};

pub use crate::session::JobDto;

/// `key` as 8 upper-case hexadecimal characters.
pub fn key_text(key: &Key) -> String {
    qap_client::messages::key_text(key)
}

/// A key from its 8 hexadecimal characters, either case.
pub fn parse_key(s: &str) -> Result<Key, RpcError> {
    let t = s.trim();
    if t.len() != 8 || !t.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(RpcError::invalid_params(format!(
            "not a message key: {s:?} (8 hexadecimal characters)"
        )));
    }
    let n = u32::from_str_radix(t, 16).map_err(|e| RpcError::invalid_params(e.to_string()))?;
    Ok(n.to_be_bytes())
}

/// `field`, trimmed; refused when empty.
pub fn name_param(field: &str, v: &str) -> Result<String, RpcError> {
    let t = v.trim();
    if t.is_empty() {
        return Err(RpcError::invalid_params(format!("{field} is empty")));
    }
    Ok(t.to_owned())
}

/// The job a [`JobDto`] names, checked.
pub fn job_id(j: &JobDto) -> Result<JobId, RpcError> {
    let number = name_param("job.number", &j.number)?;
    if number.len() != 6 || !number.chars().all(|c| c.is_ascii_digit()) {
        return Err(RpcError::invalid_params(format!(
            "job.number must be six digits: {:?}",
            j.number
        )));
    }
    Ok(JobId {
        number,
        user: name_param("job.user", &j.user)?,
        name: name_param("job.name", &j.name)?,
    })
}

/// A job as JSON.
pub fn job_dto(j: &JobId) -> JobDto {
    JobDto {
        number: j.number.clone(),
        user: j.user.clone(),
        name: j.name.clone(),
    }
}

/// `nnnnnn/USER/NAME`.
pub fn job_text(j: &JobId) -> String {
    format!("{}/{}/{}", j.number, j.user, j.name)
}

/// The job `nnnnnn/USER/NAME` names.
pub fn parse_job_text(s: &str) -> Result<JobId, RpcError> {
    let parts: Vec<&str> = s.trim().split('/').collect();
    let [number, user, name] = parts[..] else {
        return Err(RpcError::invalid_params(format!(
            "not a qualified job name: {s:?} (nnnnnn/USER/NAME)"
        )));
    };
    job_id(&JobDto {
        number: number.into(),
        user: user.into(),
        name: name.into(),
    })
}

/// An object name as JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectDto {
    pub library: String,
    pub name: String,
}

impl ObjectDto {
    /// The object it names, checked.
    pub fn object(&self) -> Result<ObjectName, RpcError> {
        Ok(ObjectName {
            library: name_param("library", &self.library)?,
            name: name_param("name", &self.name)?,
        })
    }
}

impl From<&ObjectName> for ObjectDto {
    fn from(o: &ObjectName) -> ObjectDto {
        ObjectDto {
            library: o.library.clone(),
            name: o.name.clone(),
        }
    }
}

/// A spooled file's identity as JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpooledFileIdDto {
    pub job: JobDto,
    pub file: String,
    pub number: u32,
}

impl SpooledFileIdDto {
    /// The file it names, checked.
    pub fn id(&self) -> Result<SpooledFileId, RpcError> {
        if self.number == 0 {
            return Err(RpcError::invalid_params("number must be 1 or more"));
        }
        Ok(SpooledFileId {
            job: job_id(&self.job)?,
            file: name_param("file", &self.file)?,
            number: self.number,
        })
    }
}

impl From<&SpooledFileId> for SpooledFileIdDto {
    fn from(i: &SpooledFileId) -> SpooledFileIdDto {
        SpooledFileIdDto {
            job: job_dto(&i.job),
            file: i.file.clone(),
            number: i.number,
        }
    }
}

/// `FILE(number) nnnnnn/USER/NAME`, as the viewer's title names a file.
pub fn spooled_file_text(i: &SpooledFileId) -> String {
    format!("{}({}) {}", i.file, i.number, job_text(&i.job))
}

/// A message queue as JSON: `"own"`, `"sysopr"` or `{ library, queue }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum QueueDto {
    Word(String),
    Named { library: String, queue: String },
}

impl QueueDto {
    /// The queue it names, checked.
    pub fn queue(&self) -> Result<Queue, RpcError> {
        match self {
            QueueDto::Word(w) if w == "own" => Ok(Queue::Own),
            QueueDto::Word(w) if w == "sysopr" => Ok(Queue::SystemOperator),
            QueueDto::Word(w) => Err(RpcError::invalid_params(format!(
                "queue must be \"own\", \"sysopr\" or {{ library, queue }}: {w:?}"
            ))),
            QueueDto::Named { library, queue } => Ok(Queue::Named {
                queue: ObjectName {
                    library: name_param("queue.library", library)?,
                    name: name_param("queue.queue", queue)?,
                },
            }),
        }
    }
}

impl From<&Queue> for QueueDto {
    fn from(q: &Queue) -> QueueDto {
        match q {
            Queue::Own => QueueDto::Word("own".into()),
            Queue::SystemOperator => QueueDto::Word("sysopr".into()),
            Queue::Named { queue } => QueueDto::Named {
                library: queue.library.clone(),
                queue: queue.name.clone(),
            },
        }
    }
}

/// Where a message goes: `{ profile }` or `{ queue }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RecipientDto {
    Profile { profile: String },
    Queue { queue: QueueDto },
}

impl RecipientDto {
    pub fn recipient(&self) -> Result<Recipient, RpcError> {
        Ok(match self {
            RecipientDto::Profile { profile } => Recipient::User {
                profile: name_param("to.profile", profile)?,
            },
            RecipientDto::Queue { queue } => Recipient::Queue {
                queue: queue.queue()?,
            },
        })
    }
}

/// A spool watch's target: `{ outq }` or `{ profile }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SpoolTargetDto {
    Queue { outq: ObjectDto },
    User { profile: String },
}

impl SpoolTargetDto {
    pub fn target(&self) -> Result<SpoolTarget, RpcError> {
        Ok(match self {
            SpoolTargetDto::Queue { outq } => SpoolTarget::Queue {
                outq: outq.object()?,
            },
            SpoolTargetDto::User { profile } => {
                let profile = name_param("target.profile", profile)?;
                if profile.eq_ignore_ascii_case("*ALL") {
                    // The spec: a profile of `*ALL` is `InvalidRequest`.
                    return Err(RpcError::invalid_params(
                        "a spool watch cannot be of *ALL: name a profile or *CURRENT",
                    ));
                }
                SpoolTarget::User { profile }
            }
        })
    }
}

impl From<&SpoolTarget> for SpoolTargetDto {
    fn from(t: &SpoolTarget) -> SpoolTargetDto {
        match t {
            SpoolTarget::Queue { outq } => SpoolTargetDto::Queue { outq: outq.into() },
            SpoolTarget::User { profile } => SpoolTargetDto::User {
                profile: profile.clone(),
            },
        }
    }
}

/// Generates a JSON twin of a `qap-proto` enum and the conversions both
/// ways, its values the spec's names in lower camel case.
macro_rules! named {
    ($dto:ident, $qap:ident { $($v:ident),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub enum $dto {
            $($v),+
        }

        impl From<$qap> for $dto {
            fn from(v: $qap) -> $dto {
                match v {
                    $($qap::$v => $dto::$v),+
                }
            }
        }

        impl From<$dto> for $qap {
            fn from(v: $dto) -> $qap {
                match v {
                    $($dto::$v => $qap::$v),+
                }
            }
        }
    };
}

named!(
    JobStateDto,
    JobState {
        Active,
        OnJobQueue,
        OnOutputQueue
    }
);
named!(
    SpoolStatusDto,
    SpoolStatus {
        Ready,
        Held,
        Open,
        Closed,
        Writing,
        Printing,
        Message,
        Pending,
        Saved,
    }
);
named!(
    DeviceTypeDto,
    DeviceType {
        Scs,
        Afp,
        Ascii,
        Line
    }
);
named!(
    MessageTypeDto,
    MessageType {
        Informational,
        Inquiry,
        Reply,
        Completion,
        Diagnostic,
        Escape,
        Notify,
        SenderCopy,
    }
);
named!(
    SpoolChangeDto,
    SpoolChange {
        Added,
        Changed,
        Removed
    }
);
named!(
    EndHowDto,
    EndHow {
        Controlled,
        Immediate
    }
);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_are_eight_hex_digits() {
        assert_eq!(key_text(&[0, 0, 0x01, 0xA2]), "000001A2");
        assert_eq!(key_text(&[0xFF, 0xFF, 0xFF, 0xFF]), "FFFFFFFF");
        assert_eq!(parse_key("000001a2").unwrap(), [0, 0, 1, 0xA2]);
        assert_eq!(parse_key(" FFFFFFFF ").unwrap(), [0xFF; 4]);
        for bad in ["", "1A2", "000001A2F", "0000G1A2", "-00001A2"] {
            assert!(parse_key(bad).is_err(), "{bad:?}");
        }
        for k in [[0, 0, 0, 1], [0x12, 0x34, 0xAB, 0xCD], [0xFF; 4]] {
            assert_eq!(parse_key(&key_text(&k)).unwrap(), k);
        }
    }

    #[test]
    fn job_ids_round_trip_and_are_checked() {
        let j = parse_job_text("654321/CWELLMAN/CODETEST").unwrap();
        assert_eq!(
            (j.number.as_str(), j.user.as_str(), j.name.as_str()),
            ("654321", "CWELLMAN", "CODETEST")
        );
        assert_eq!(job_text(&j), "654321/CWELLMAN/CODETEST");
        assert_eq!(job_id(&job_dto(&j)).unwrap(), j);
        assert_eq!(
            serde_json::to_value(job_dto(&j)).unwrap(),
            json!({"number":"654321","user":"CWELLMAN","name":"CODETEST"})
        );
        // Trimmed, never case-folded.
        let k = job_id(&JobDto {
            number: " 000001 ".into(),
            user: "qsys".into(),
            name: " SCPF".into(),
        })
        .unwrap();
        assert_eq!(job_text(&k), "000001/qsys/SCPF");
        for bad in [
            "12345/QUSER/QAPCNN",
            "1234567/QUSER/QAPCNN",
            "12345a/QUSER/QAPCNN",
            "123456//QAPCNN",
            "123456/QUSER",
            "123456/QUSER/QAPCNN/X",
        ] {
            assert!(parse_job_text(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn queues_recipients_and_targets() {
        let q = |v| serde_json::from_value::<QueueDto>(v).unwrap().queue();
        assert_eq!(q(json!("own")).unwrap(), Queue::Own);
        assert_eq!(q(json!("sysopr")).unwrap(), Queue::SystemOperator);
        assert_eq!(
            q(json!({"library":"QGPL","queue":"TEAMQ"})).unwrap(),
            Queue::Named {
                queue: ObjectName {
                    library: "QGPL".into(),
                    name: "TEAMQ".into()
                }
            }
        );
        assert!(q(json!("QSYSOPR")).is_err());
        assert!(q(json!({"library":"","queue":"X"})).is_err());
        for queue in [
            Queue::Own,
            Queue::SystemOperator,
            Queue::Named {
                queue: ObjectName {
                    library: "QGPL".into(),
                    name: "TEAMQ".into(),
                },
            },
        ] {
            assert_eq!(QueueDto::from(&queue).queue().unwrap(), queue);
        }
        let r = |v| {
            serde_json::from_value::<RecipientDto>(v)
                .unwrap()
                .recipient()
        };
        assert_eq!(
            r(json!({"profile":"CWELLMAN"})).unwrap(),
            Recipient::User {
                profile: "CWELLMAN".into()
            }
        );
        assert_eq!(
            r(json!({"queue":"sysopr"})).unwrap(),
            Recipient::Queue {
                queue: Queue::SystemOperator
            }
        );
        let t = |v| {
            serde_json::from_value::<SpoolTargetDto>(v)
                .unwrap()
                .target()
        };
        assert_eq!(
            t(json!({"profile":"*CURRENT"})).unwrap(),
            SpoolTarget::User {
                profile: "*CURRENT".into()
            }
        );
        assert!(t(json!({"profile":"*all"})).is_err());
        let outq = t(json!({"outq":{"library":"QUSRSYS","name":"PRT01"}})).unwrap();
        assert_eq!(
            serde_json::to_value(SpoolTargetDto::from(&outq)).unwrap(),
            json!({"outq":{"library":"QUSRSYS","name":"PRT01"}})
        );
    }

    #[test]
    fn enums_are_the_spec_names_in_lower_camel_case() {
        let s = |v: serde_json::Value| v.as_str().unwrap().to_owned();
        let names: Vec<String> = JobState::ALL
            .iter()
            .map(|v| s(serde_json::to_value(JobStateDto::from(*v)).unwrap()))
            .collect();
        assert_eq!(names, ["active", "onJobQueue", "onOutputQueue"]);
        let names: Vec<String> = SpoolStatus::ALL
            .iter()
            .map(|v| s(serde_json::to_value(SpoolStatusDto::from(*v)).unwrap()))
            .collect();
        assert_eq!(
            names,
            [
                "ready", "held", "open", "closed", "writing", "printing", "message", "pending",
                "saved"
            ]
        );
        let names: Vec<String> = MessageType::ALL
            .iter()
            .map(|v| s(serde_json::to_value(MessageTypeDto::from(*v)).unwrap()))
            .collect();
        assert_eq!(
            names,
            [
                "informational",
                "inquiry",
                "reply",
                "completion",
                "diagnostic",
                "escape",
                "notify",
                "senderCopy"
            ]
        );
        assert_eq!(
            EndHow::from(serde_json::from_value::<EndHowDto>(json!("immediate")).unwrap()),
            EndHow::Immediate
        );
        assert_eq!(
            EndHow::from(serde_json::from_value::<EndHowDto>(json!("controlled")).unwrap()),
            EndHow::Controlled
        );
        assert!(serde_json::from_value::<EndHowDto>(json!("*IMMED")).is_err());
    }
}
