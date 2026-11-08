// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `SqlValue` as JSON and as CSV text: the one place a value the server
//! sent is turned into something else. Numbers are never reformatted, so
//! what the grid shows and what the CSV holds is what the server said.
//!
//! - `Null` → `null` (an empty CSV field).
//! - `Integer` → a JSON number from −(2⁵³ − 1) to 2⁵³ − 1, the integers
//!   a JavaScript number holds exactly; beyond that its decimal text, as
//!   a string.
//! - `Decimal`, `Float` → their text, as strings, unchanged (`DECFLOAT`'s
//!   `1.5E-30`, `Infinity` and `NaN` included).
//! - `Text` → the string.
//! - `Binary` → `{ "hex": "C1C2" }`, upper case; in CSV the hex digits.
//! - `Date` → `YYYY-MM-DD`; `Time` → `HH:MM:SS`, with `.mmm` only when the
//!   milliseconds are not 0; `Timestamp` → `YYYY-MM-DDTHH:MM:SS` with as
//!   many fraction digits as the column's `scale` (0 to 12), cut from the
//!   picoseconds. ISO 8601, no zone: the spec sends them "as if UTC".
//! - `Boolean` → `true` / `false`; in CSV `TRUE` / `FALSE`, SQL's own
//!   literals.

use qap_client::proto::ops::sql::SqlValue;
use serde_json::{Value, json};

/// The largest integer a JSON number carries exactly in JavaScript
/// (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE: i64 = (1 << 53) - 1;

const MS_PER_DAY: i64 = 86_400_000;

/// `v` as JSON. `scale` is the column's, for a timestamp's fraction; `None`
/// keeps every non-zero digit.
#[must_use]
pub fn to_json(v: &SqlValue, scale: Option<u16>) -> Value {
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer { value } if (-MAX_SAFE..=MAX_SAFE).contains(value) => json!(value),
        SqlValue::Integer { value } => json!(value.to_string()),
        SqlValue::Boolean { value } => json!(value),
        SqlValue::Binary { data } => json!({ "hex": hex(data) }),
        other => json!(text(other, scale).unwrap_or_default()),
    }
}

/// `v` as one CSV field's text, before quoting; `None` for `Null`.
#[must_use]
pub fn to_csv(v: &SqlValue, scale: Option<u16>) -> Option<String> {
    match v {
        SqlValue::Null => None,
        SqlValue::Integer { value } => Some(value.to_string()),
        SqlValue::Boolean { value } => Some(if *value { "TRUE" } else { "FALSE" }.to_owned()),
        SqlValue::Binary { data } => Some(hex(data)),
        other => text(other, scale),
    }
}

/// The text of a value that is text in both forms.
fn text(v: &SqlValue, scale: Option<u16>) -> Option<String> {
    Some(match v {
        SqlValue::Decimal { text } | SqlValue::Float { text } | SqlValue::Text { text } => {
            text.clone()
        }
        SqlValue::Date { ms } => date(ms.div_euclid(MS_PER_DAY)),
        SqlValue::Time { ms } => time(*ms),
        SqlValue::Timestamp { ms, picos } => timestamp(*ms, *picos, scale),
        SqlValue::Null => return None,
        SqlValue::Integer { value } => value.to_string(),
        SqlValue::Boolean { value } => value.to_string(),
        SqlValue::Binary { data } => hex(data),
    })
}

/// Bytes as upper-case hex.
#[must_use]
pub fn hex(data: &[u8]) -> String {
    use std::fmt::Write;
    data.iter()
        .fold(String::with_capacity(data.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02X}");
            s
        })
}

/// The civil date of a day number (days since 1970-01-01), proleptic
/// Gregorian.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn date(days: i64) -> String {
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn hms(ms: i64) -> String {
    let s = ms.div_euclid(1000);
    format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
}

fn time(ms: i64) -> String {
    let frac = ms.rem_euclid(1000);
    if frac == 0 {
        hms(ms)
    } else {
        format!("{}.{frac:03}", hms(ms))
    }
}

fn timestamp(ms: i64, picos: u32, scale: Option<u16>) -> String {
    let days = ms.div_euclid(MS_PER_DAY);
    let in_day = ms.rem_euclid(MS_PER_DAY);
    // Twelve digits of the second: its milliseconds, then the picoseconds
    // past them.
    let digits = format!("{:03}{:09}", in_day % 1000, picos.min(999_999_999));
    let n = match scale {
        Some(s) => usize::from(s.min(12)),
        None => digits.trim_end_matches('0').len(),
    };
    let base = format!("{}T{}", date(days), hms(in_day));
    if n == 0 {
        base
    } else {
        format!("{base}.{}", &digits[..n])
    }
}
