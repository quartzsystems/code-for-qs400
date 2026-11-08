// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! Included sources fetched from the client, kept for every document
//! of the window until the client says one changed.
//!
//! `analyze` asks for an include synchronously, and the server must not
//! wait inside it for the client. So an analysis answers from what is
//! cached, notes what is missing, and the server asks the client for
//! those and analyzes again when the answers are in. A missing source
//! is cached too (`None`), so a `/COPY` of a member that does not exist
//! costs one request.

use crate::protocol::{At, Fetched, Request};
use compdiag::Where;
use compdiag::front::{IncludeRequest, Source};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// How long the client has to answer a fetch; after that the include
/// counts as not found (until the next change asks again).
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// What a fetch is cached under: the origin of the document asking
/// (its system) and the request, names in upper case.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Key {
    /// The document's origin (`qs400mbr://qshq400`), empty for a local
    /// file.
    pub origin: String,
    /// The request.
    pub request: Request,
}

impl Key {
    /// For `request` from a document of `origin`.
    #[must_use]
    pub fn new(origin: &str, r: &IncludeRequest) -> Self {
        Self {
            origin: origin.to_string(),
            request: Request {
                library: r.library.trim().to_ascii_uppercase(),
                file: if r.path.is_some() {
                    r.file.clone()
                } else {
                    r.file.trim().to_ascii_uppercase()
                },
                member: r.member.trim().to_ascii_uppercase(),
                path: r.path.clone(),
            },
        }
    }
}

/// A fetched source and the URI it opens at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// The source.
    pub source: Source,
    /// Its URI.
    pub uri: String,
}

/// The cache, and the fetches asked for and not yet answered.
#[derive(Debug, Default)]
pub struct Includes {
    cached: HashMap<Key, Option<Entry>>,
    asked: HashMap<Key, Instant>,
}

impl Includes {
    /// What is cached for `key`: `Some(None)` is "not found".
    #[must_use]
    pub fn get(&self, key: &Key) -> Option<&Option<Entry>> {
        self.cached.get(key)
    }

    /// The URI of what `key` brought in.
    #[must_use]
    pub fn uri(&self, key: &Key) -> Option<&str> {
        self.cached.get(key)?.as_ref().map(|e| e.uri.as_str())
    }

    /// Whether `key` was asked for and not answered.
    #[must_use]
    pub fn asked(&self, key: &Key) -> bool {
        self.asked.contains_key(key)
    }

    /// `key` is being asked for at `now`.
    pub fn ask(&mut self, key: Key, now: Instant) {
        self.asked.insert(key, now);
    }

    /// The client answered `key`.
    pub fn answer(&mut self, key: Key, fetched: Option<Fetched>) {
        self.asked.remove(&key);
        let entry = fetched.map(|f| Entry {
            source: Source {
                at: Where::from(&f.at),
                text: f.text,
            },
            uri: f.uri,
        });
        self.cached.insert(key, entry);
    }

    /// Fetches not answered by `now - FETCH_TIMEOUT`, counted as not
    /// found; returns their keys.
    pub fn expire(&mut self, now: Instant) -> Vec<Key> {
        let late: Vec<Key> = self
            .asked
            .iter()
            .filter(|(_, at)| now.duration_since(**at) >= FETCH_TIMEOUT)
            .map(|(k, _)| k.clone())
            .collect();
        for k in &late {
            self.answer(k.clone(), None);
        }
        late
    }

    /// When the first unanswered fetch times out.
    #[must_use]
    pub fn next_timeout(&self) -> Option<Instant> {
        self.asked.values().min().map(|t| *t + FETCH_TIMEOUT)
    }

    /// Drop what a save of `member` on `connection` changes: every
    /// cached request for that file and member, whatever its library
    /// (a `*LIBL` request may have found it), or for that path; or
    /// everything when neither is given. Returns whether anything went.
    pub fn invalidate(&mut self, connection: Option<&str>, member: Option<&At>) -> bool {
        let conn = connection.map(str::to_ascii_lowercase);
        let before = self.cached.len();
        self.cached.retain(|k, v| {
            let same_system = conn.as_ref().is_none_or(|c| {
                k.origin.is_empty() || k.origin.rsplit("://").next() == Some(c.as_str())
            });
            if !same_system {
                return true;
            }
            let hit = match member {
                None => true,
                Some(At::Member { file, member, .. }) => {
                    (k.request.path.is_none()
                        && k.request.file.eq_ignore_ascii_case(file)
                        && k.request.member.eq_ignore_ascii_case(member))
                        || v.as_ref().is_some_and(|e| {
                            matches!(&e.source.at, Where::Member(m)
                                if m.file.eq_ignore_ascii_case(file)
                                    && m.member.eq_ignore_ascii_case(member))
                        })
                }
                Some(At::Path { path }) => {
                    k.request.path.as_deref() == Some(path.as_str())
                        || v.as_ref()
                            .is_some_and(|e| e.source.at == Where::Path(path.clone()))
                }
                Some(At::None) => false,
            };
            !hit
        });
        self.cached.len() != before
    }
}

/// One analysis's view of the cache: it answers from it and notes what
/// it lacks, in the order asked.
pub struct Lookup<'a> {
    includes: &'a Includes,
    origin: &'a str,
    missing: RefCell<Vec<Key>>,
    used: RefCell<HashSet<Key>>,
}

impl<'a> Lookup<'a> {
    /// Over `includes`, for a document of `origin`.
    #[must_use]
    pub fn new(includes: &'a Includes, origin: &'a str) -> Self {
        Self {
            includes,
            origin,
            missing: RefCell::new(Vec::new()),
            used: RefCell::new(HashSet::new()),
        }
    }

    /// What `analyze`'s fetch answers.
    #[must_use]
    pub fn fetch(&self, r: &IncludeRequest) -> Option<Source> {
        let key = Key::new(self.origin, r);
        self.used.borrow_mut().insert(key.clone());
        match self.includes.get(&key) {
            Some(Some(e)) => Some(e.source.clone()),
            Some(None) => None,
            None => {
                let mut m = self.missing.borrow_mut();
                if !m.contains(&key) {
                    m.push(key);
                }
                None
            }
        }
    }

    /// What it asked for and the cache lacked.
    #[must_use]
    pub fn missing(&self) -> Vec<Key> {
        self.missing.borrow().clone()
    }

    /// Every key it asked for.
    #[must_use]
    pub fn used(&self) -> HashSet<Key> {
        self.used.borrow().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(lib: &str, file: &str, mbr: &str) -> IncludeRequest {
        IncludeRequest {
            library: lib.into(),
            file: file.into(),
            member: mbr.into(),
            path: None,
        }
    }

    fn fetched(lib: &str, mbr: &str) -> Fetched {
        Fetched {
            uri: format!("qs400mbr://qshq400/{lib}/QRPGLESRC/{mbr}.rpgle?readonly"),
            at: At::Member {
                library: lib.into(),
                file: "QRPGLESRC".into(),
                member: mbr.into(),
            },
            text: "x\n".into(),
        }
    }

    #[test]
    fn a_miss_is_noted_once_then_answered_from_the_cache() {
        let mut inc = Includes::default();
        let origin = "qs400mbr://qshq400";
        let l = Lookup::new(&inc, origin);
        assert!(l.fetch(&req("*LIBL", "QRPGLESRC", "cp")).is_none());
        assert!(l.fetch(&req("*LIBL", "qrpglesrc", "CP")).is_none());
        let missing = l.missing();
        assert_eq!(missing.len(), 1);
        inc.ask(missing[0].clone(), Instant::now());
        assert!(inc.asked(&missing[0]));
        inc.answer(missing[0].clone(), Some(fetched("HLINV", "CP")));
        let l = Lookup::new(&inc, origin);
        let s = l.fetch(&req("*LIBL", "QRPGLESRC", "CP")).unwrap();
        assert_eq!(crate::uri::display(&s.at), "HLINV/QRPGLESRC(CP)");
        assert!(l.missing().is_empty());
    }

    #[test]
    fn not_found_is_cached() {
        let mut inc = Includes::default();
        let k = Key::new("", &req("*LIBL", "QRPGLESRC", "NOPE"));
        inc.answer(k.clone(), None);
        let l = Lookup::new(&inc, "");
        assert!(l.fetch(&req("*LIBL", "QRPGLESRC", "NOPE")).is_none());
        assert!(l.missing().is_empty());
    }

    #[test]
    fn systems_are_cached_apart() {
        let mut inc = Includes::default();
        inc.answer(
            Key::new("qs400mbr://a", &req("*LIBL", "QRPGLESRC", "CP")),
            Some(fetched("A", "CP")),
        );
        let l = Lookup::new(&inc, "qs400mbr://b");
        assert!(l.fetch(&req("*LIBL", "QRPGLESRC", "CP")).is_none());
        assert_eq!(l.missing().len(), 1);
    }

    #[test]
    fn a_save_drops_the_member_whatever_library_found_it() {
        let mut inc = Includes::default();
        let o = "qs400mbr://qshq400";
        inc.answer(
            Key::new(o, &req("*LIBL", "QRPGLESRC", "CP")),
            Some(fetched("HLINV", "CP")),
        );
        inc.answer(
            Key::new(o, &req("HLINV", "QRPGLESRC", "OTHER")),
            Some(fetched("HLINV", "OTHER")),
        );
        let saved = At::Member {
            library: "HLINV".into(),
            file: "QRPGLESRC".into(),
            member: "CP".into(),
        };
        assert!(inc.invalidate(Some("QSHQ400"), Some(&saved)));
        assert!(
            inc.get(&Key::new(o, &req("*LIBL", "QRPGLESRC", "CP")))
                .is_none()
        );
        assert!(
            inc.get(&Key::new(o, &req("HLINV", "QRPGLESRC", "OTHER")))
                .is_some()
        );
        // Another system's save leaves it.
        assert!(!inc.invalidate(Some("OTHER"), None));
        assert!(inc.invalidate(None, None));
        assert!(
            inc.get(&Key::new(o, &req("HLINV", "QRPGLESRC", "OTHER")))
                .is_none()
        );
    }

    #[test]
    fn an_unanswered_fetch_times_out_as_not_found() {
        let mut inc = Includes::default();
        let t0 = Instant::now();
        let k = Key::new("", &req("*LIBL", "QRPGLESRC", "SLOW"));
        inc.ask(k.clone(), t0);
        assert_eq!(inc.next_timeout(), Some(t0 + FETCH_TIMEOUT));
        assert!(inc.expire(t0 + FETCH_TIMEOUT / 2).is_empty());
        assert_eq!(inc.expire(t0 + FETCH_TIMEOUT), vec![k.clone()]);
        assert_eq!(inc.get(&k), Some(&None));
        assert!(!inc.asked(&k));
    }
}
