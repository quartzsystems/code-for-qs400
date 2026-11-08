// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The one table from a compiler message's severity (0 to 99) to an
//! editor's. The table is `severity.json` beside this crate's manifest;
//! the extension's `src/actions/severity.ts` imports the same file, so
//! the Problems panel and the language servers cannot disagree.

use serde::Deserialize;
use std::sync::OnceLock;

/// An editor's severity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Below 10.
    Information,
    /// 10 to 19.
    Warning,
    /// 20 and above.
    Error,
}

#[derive(Deserialize)]
struct Row {
    /// The row covers severities below this, from the previous row's;
    /// `null` is no bound.
    below: Option<u8>,
    severity: Severity,
}

/// The table as written.
pub const TABLE_JSON: &str = include_str!("../severity.json");

fn table() -> &'static [Row] {
    static T: OnceLock<Vec<Row>> = OnceLock::new();
    T.get_or_init(|| serde_json::from_str(TABLE_JSON).expect("severity.json parses"))
}

/// The editor's severity for a compiler message's.
#[must_use]
pub fn of(severity: u8) -> Severity {
    let t = table();
    t.iter()
        .find(|r| r.below.is_none_or(|b| severity < b))
        .or(t.last())
        .map_or(Severity::Error, |r| r.severity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bands() {
        assert_eq!(of(0), Severity::Information);
        assert_eq!(of(9), Severity::Information);
        assert_eq!(of(10), Severity::Warning);
        assert_eq!(of(19), Severity::Warning);
        assert_eq!(of(20), Severity::Error);
        assert_eq!(of(30), Severity::Error);
        assert_eq!(of(99), Severity::Error);
    }

    #[test]
    fn the_last_row_has_no_bound() {
        assert!(table().last().is_some_and(|r| r.below.is_none()));
    }
}
