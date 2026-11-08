// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! A document is analyzed once its changes stop for a while: each
//! change moves its deadline on. The clock is passed in, so the tests
//! need no sleeping.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// The wait after a change.
pub const DELAY: Duration = Duration::from_millis(300);

/// Documents waiting to be analyzed, by URI.
#[derive(Debug, Default)]
pub struct Debounce {
    due: BTreeMap<String, Instant>,
    delay: Duration,
}

impl Debounce {
    /// With the given wait.
    #[must_use]
    pub fn new(delay: Duration) -> Self {
        Self {
            due: BTreeMap::new(),
            delay,
        }
    }

    /// `uri` changed at `now`.
    pub fn touch(&mut self, uri: &str, now: Instant) {
        self.due.insert(uri.to_string(), now + self.delay);
    }

    /// `uri` no longer waits (it closed, or was analyzed now).
    pub fn cancel(&mut self, uri: &str) {
        self.due.remove(uri);
    }

    /// The URIs due at `now`, taken out.
    pub fn take_due(&mut self, now: Instant) -> Vec<String> {
        let due: Vec<String> = self
            .due
            .iter()
            .filter(|(_, at)| **at <= now)
            .map(|(u, _)| u.clone())
            .collect();
        for u in &due {
            self.due.remove(u);
        }
        due
    }

    /// The first deadline, if any waits.
    #[must_use]
    pub fn next(&self) -> Option<Instant> {
        self.due.values().min().copied()
    }

    /// Whether `uri` waits.
    #[must_use]
    pub fn waiting(&self, uri: &str) -> bool {
        self.due.contains_key(uri)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    #[test]
    fn a_change_waits_for_the_delay() {
        let t0 = Instant::now();
        let mut d = Debounce::new(300 * MS);
        d.touch("a", t0);
        assert!(d.take_due(t0 + 299 * MS).is_empty());
        assert_eq!(d.take_due(t0 + 300 * MS), vec!["a".to_string()]);
        assert!(d.take_due(t0 + 900 * MS).is_empty());
        assert_eq!(d.next(), None);
    }

    #[test]
    fn typing_moves_the_deadline_on() {
        let t0 = Instant::now();
        let mut d = Debounce::new(300 * MS);
        for i in 0..10 {
            d.touch("a", t0 + i * 100 * MS);
            assert!(d.take_due(t0 + i * 100 * MS + 299 * MS).is_empty());
        }
        assert_eq!(d.next(), Some(t0 + 1200 * MS));
        assert_eq!(d.take_due(t0 + 1200 * MS), vec!["a".to_string()]);
    }

    #[test]
    fn documents_wait_apart() {
        let t0 = Instant::now();
        let mut d = Debounce::new(300 * MS);
        d.touch("a", t0);
        d.touch("b", t0 + 200 * MS);
        assert_eq!(d.next(), Some(t0 + 300 * MS));
        assert_eq!(d.take_due(t0 + 300 * MS), vec!["a".to_string()]);
        assert!(d.waiting("b"));
        d.cancel("b");
        assert!(d.take_due(t0 + 600 * MS).is_empty());
    }
}
