// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The watches the extension asks for, on top of the ones `qap-client`'s
//! `Client` keeps, and what they report, as notifications.
//!
//! The client keeps one watch per `Queue` or `SpoolTarget` value, watches
//! it again after every resume and sign-on, and catches a queue up; an
//! `unwatch` forgets it whoever else wanted it. So the host counts who
//! wants each watch: the extension (`spool.watch`, `messages.watch`, at
//! most once each) and every one-shot wait (`spool.awaitFile`). The client
//! is told to unwatch only when nobody does. A session's end (disconnect,
//! or a new sign-on, whose client starts with no watches) forgets them all
//! and answers the one-shot waits of that session with `null`.
//!
//! What the client reports goes out as it comes, from
//! [`Sessions::on_events`]:
//!
//! - `Arrived` is `messages.arrived { name, queue, message, caughtUp }`;
//! - `SpoolChanged` is `spool.changed { name, target, change, id, file? }`,
//!   `change` `added`, `changed` or `removed`;
//! - `SpoolRewatched` is `spool.changed { name, target, change:
//!   "rewatched" }` with no `id`: what changed meanwhile was not reported,
//!   so the view reads its list again;
//! - `Watching`, `CaughtUp` and `Failed` go to the host log; a `Failed`
//!   that is `NotAuthorized` has taken the watch away.

use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use host_rpc::{Outbound, RpcError};
use qap_client::proto::ops::spool::{SpoolStatus, SpoolTarget, SpooledFile};
use qap_client::proto::types::JobId;
use qap_client::{Watch, WatchEvent};
use serde::Serialize;

use crate::codec::{QueueDto, SpoolChangeDto, SpoolTargetDto, SpooledFileIdDto};
use crate::messages::QueuedMessageDto;
use crate::session::{QAP_WATCH, Sessions, codes};
use crate::spool::SpooledFileDto;
use crate::{LogLevel, log};

/// Who wants one watch.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Owners {
    /// The extension, through `spool.watch` or `messages.watch`.
    client: bool,
    /// One-shot waits.
    once: usize,
}

impl Owners {
    fn none(&self) -> bool {
        !self.client && self.once == 0
    }
}

/// What a one-shot wait is told.
#[derive(Debug, Clone)]
pub enum Told {
    /// A file of its job, closed.
    Found(Box<SpooledFile>),
    /// The target was watched again: list it once more.
    Recheck,
    /// The session ended.
    Closed,
}

/// A one-shot wait for a job's spooled file.
struct Waiter {
    id: u64,
    name: String,
    job: JobId,
    file: Option<String>,
    tx: Sender<Told>,
}

/// Whether `f` is what a wait for `job`'s `file` (any file when `None`)
/// wants: of that job, by that name, and no longer being written.
pub fn wanted(f: &SpooledFile, job: &JobId, file: Option<&str>) -> bool {
    let j = &f.id.job;
    j.number == job.number
        && j.user.eq_ignore_ascii_case(&job.user)
        && j.name.eq_ignore_ascii_case(&job.name)
        && file.is_none_or(|n| f.id.file.eq_ignore_ascii_case(n))
        && !matches!(f.status, SpoolStatus::Open | SpoolStatus::Writing)
}

/// `spool.changed`.
#[derive(Serialize)]
struct SpoolChanged<'a> {
    name: &'a str,
    target: SpoolTargetDto,
    change: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<SpooledFileIdDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<SpooledFileDto>,
}

/// `messages.arrived`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Arrived<'a> {
    name: &'a str,
    queue: QueueDto,
    message: QueuedMessageDto,
    caught_up: bool,
}

/// The host's watches, per session.
pub struct Watches {
    sessions: Weak<Sessions>,
    outbound: Outbound,
    owners: Mutex<HashMap<(String, Watch), Owners>>,
    waiters: Mutex<Vec<Waiter>>,
    made: Mutex<u64>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The spool watch of the signed-on profile's own files.
pub fn current_user() -> Watch {
    Watch::Spool(SpoolTarget::User {
        profile: "*CURRENT".into(),
    })
}

impl Watches {
    /// The watches of `sessions`, told of their events and their ends.
    pub fn new(sessions: &Arc<Sessions>) -> Arc<Watches> {
        let w = Arc::new(Watches {
            sessions: Arc::downgrade(sessions),
            outbound: sessions.outbound().clone(),
            owners: Mutex::new(HashMap::new()),
            waiters: Mutex::new(Vec::new()),
            made: Mutex::new(0),
        });
        let me = Arc::downgrade(&w);
        sessions.on_events(Arc::new(move |name, events| {
            if let Some(me) = me.upgrade() {
                me.reported(name, events);
            }
        }));
        let me = Arc::downgrade(&w);
        sessions.on_close(Arc::new(move |name| {
            if let Some(me) = me.upgrade() {
                me.closed(name);
            }
        }));
        w
    }

    fn sessions(&self) -> Result<Arc<Sessions>, RpcError> {
        self.sessions
            .upgrade()
            .ok_or_else(|| RpcError::new(codes::NOT_CONNECTED, "the host is ending"))
    }

    /// The extension wants `w` on `name`.
    pub fn watch(&self, name: &str, w: Watch) -> Result<(), RpcError> {
        let s = self.sessions()?;
        s.work(name, QAP_WATCH, |b| b.watch(w.clone()))?;
        lock(&self.owners)
            .entry((name.to_owned(), w))
            .or_default()
            .client = true;
        Ok(())
    }

    /// The extension no longer wants `w` on `name`; the client is told
    /// when no wait wants it either.
    pub fn unwatch(&self, name: &str, w: Watch) -> Result<(), RpcError> {
        let key = (name.to_owned(), w);
        let drop_it = {
            let mut owners = lock(&self.owners);
            let o = owners.entry(key.clone()).or_default();
            o.client = false;
            let none = o.none();
            if none {
                owners.remove(&key);
            }
            none
        };
        if drop_it {
            self.client_unwatch(name, &key.1)?;
        }
        Ok(())
    }

    fn client_unwatch(&self, name: &str, w: &Watch) -> Result<(), RpcError> {
        let s = self.sessions()?;
        match s.work(name, QAP_WATCH, |b| b.unwatch(w)) {
            // Gone with its session: nothing to stop.
            Err(e) if e.code == codes::NOT_CONNECTED => Ok(()),
            other => other,
        }
    }

    /// A one-shot wait wants `w` on `name`.
    fn hold_once(&self, name: &str, w: &Watch) -> Result<(), RpcError> {
        let s = self.sessions()?;
        s.work(name, QAP_WATCH, |b| b.watch(w.clone()))?;
        lock(&self.owners)
            .entry((name.to_owned(), w.clone()))
            .or_default()
            .once += 1;
        Ok(())
    }

    /// A one-shot wait is done with `w` on `name`.
    fn release_once(&self, name: &str, w: &Watch) {
        let key = (name.to_owned(), w.clone());
        let drop_it = {
            let mut owners = lock(&self.owners);
            let Some(o) = owners.get_mut(&key) else {
                return;
            };
            o.once = o.once.saturating_sub(1);
            let none = o.none();
            if none {
                owners.remove(&key);
            }
            none
        };
        if drop_it && let Err(e) = self.client_unwatch(name, w) {
            log(
                &self.outbound,
                LogLevel::Warn,
                format!("{name}: unwatching after a wait: {}", e.message),
            );
        }
    }

    /// How many want `w` on `name`: the extension (0 or 1) and the waits.
    pub fn owners(&self, name: &str, w: &Watch) -> (bool, usize) {
        lock(&self.owners)
            .get(&(name.to_owned(), w.clone()))
            .map_or((false, 0), |o| (o.client, o.once))
    }

    /// Starts a one-shot wait for `job`'s `file` on `name`: the receiver
    /// is told of each match, of a rewatch and of the session's end. The
    /// signed-on profile's files are watched until [`Watches::end_wait`].
    pub fn begin_wait(
        &self,
        name: &str,
        job: JobId,
        file: Option<String>,
    ) -> Result<(u64, std::sync::mpsc::Receiver<Told>), RpcError> {
        let (tx, rx) = std::sync::mpsc::channel();
        let id = {
            let mut m = lock(&self.made);
            *m += 1;
            *m
        };
        // Told before the watch is sent, so nothing between is missed.
        lock(&self.waiters).push(Waiter {
            id,
            name: name.to_owned(),
            job,
            file,
            tx,
        });
        if let Err(e) = self.hold_once(name, &current_user()) {
            lock(&self.waiters).retain(|w| w.id != id);
            return Err(e);
        }
        Ok((id, rx))
    }

    /// Ends wait `id` on `name`, and its hold on the watch.
    pub fn end_wait(&self, name: &str, id: u64) {
        let had = {
            let mut w = lock(&self.waiters);
            let n = w.len();
            w.retain(|x| x.id != id);
            n != w.len()
        };
        if had {
            self.release_once(name, &current_user());
        }
    }

    /// What `name`'s watches reported.
    fn reported(&self, name: &str, events: Vec<WatchEvent>) {
        for ev in events {
            match ev {
                WatchEvent::Arrived {
                    queue,
                    message,
                    caught_up,
                } => {
                    let _ = self.outbound.notify(
                        "messages.arrived",
                        &Arrived {
                            name,
                            queue: QueueDto::from(&queue),
                            message: message.into(),
                            caught_up,
                        },
                    );
                }
                WatchEvent::SpoolChanged(c) => {
                    if let Some(f) = &c.file {
                        self.tell(name, |w| {
                            wanted(f, &w.job, w.file.as_deref())
                                .then(|| Told::Found(Box::new(f.clone())))
                        });
                    }
                    let change = SpoolChangeDto::from(c.change);
                    let _ = self.outbound.notify(
                        "spool.changed",
                        &SpoolChanged {
                            name,
                            target: SpoolTargetDto::from(&c.target),
                            change: match change {
                                SpoolChangeDto::Added => "added",
                                SpoolChangeDto::Changed => "changed",
                                SpoolChangeDto::Removed => "removed",
                            },
                            id: Some(SpooledFileIdDto::from(&c.id)),
                            file: c.file.map(SpooledFileDto::from),
                        },
                    );
                }
                WatchEvent::SpoolRewatched(t) => {
                    self.tell(name, |_| Some(Told::Recheck));
                    let _ = self.outbound.notify(
                        "spool.changed",
                        &SpoolChanged {
                            name,
                            target: SpoolTargetDto::from(&t),
                            change: "rewatched",
                            id: None,
                            file: None,
                        },
                    );
                }
                WatchEvent::Watching(w) => {
                    log(
                        &self.outbound,
                        LogLevel::Info,
                        format!("{name}: watching {}", watch_text(&w)),
                    );
                }
                WatchEvent::CaughtUp { queue, count } => {
                    log(
                        &self.outbound,
                        LogLevel::Info,
                        format!(
                            "{name}: {} caught up, {count} message(s)",
                            watch_text(&Watch::Queue(queue))
                        ),
                    );
                }
                WatchEvent::Failed { watch, failure } => {
                    if failure.not_authorized() {
                        lock(&self.owners).remove(&(name.to_owned(), watch.clone()));
                    }
                    log(
                        &self.outbound,
                        LogLevel::Warn,
                        format!(
                            "{name}: watching {} failed: {}",
                            watch_text(&watch),
                            failure.text
                        ),
                    );
                }
            }
        }
    }

    /// Tells each wait of `name` what `f` makes of it.
    fn tell(&self, name: &str, f: impl Fn(&Waiter) -> Option<Told>) {
        for w in lock(&self.waiters).iter().filter(|w| w.name == name) {
            if let Some(t) = f(w) {
                let _ = w.tx.send(t);
            }
        }
    }

    /// `name`'s session ended: its client watches nothing any more.
    fn closed(&self, name: &str) {
        lock(&self.owners).retain(|(n, _), _| n != name);
        self.tell(name, |_| Some(Told::Closed));
    }
}

/// A watch in one line, for the log.
fn watch_text(w: &Watch) -> String {
    use qap_client::proto::ops::messages::Queue;
    match w {
        Watch::Queue(Queue::Own) => "own message queue".into(),
        Watch::Queue(Queue::SystemOperator) => "QSYSOPR".into(),
        Watch::Queue(Queue::Named { queue }) => {
            format!("message queue {}/{}", queue.library, queue.name)
        }
        Watch::Spool(SpoolTarget::User { profile }) => format!("spooled files of {profile}"),
        Watch::Spool(SpoolTarget::Queue { outq }) => {
            format!("output queue {}/{}", outq.library, outq.name)
        }
    }
}
