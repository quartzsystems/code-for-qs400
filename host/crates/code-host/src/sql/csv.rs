// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! CSV as RFC 4180 has it: UTF-8 with no byte order mark, CRLF after every
//! record, a header record of the column names, a field quoted when it
//! holds a quote, a comma, a CR or an LF, quotes doubled. `NULL` is an
//! empty field; an empty string is `""`, so the two stay apart. Values are
//! [`super::values::to_csv`]'s text.

use std::io::{self, Write};

use qap_client::proto::ops::sql::{Column, SqlValue};

use super::values;

/// One field, quoted when it must be.
#[must_use]
pub fn field(text: &str) -> String {
    if text.is_empty() {
        return "\"\"".to_owned();
    }
    if text.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_owned()
    }
}

/// Writes records to `out`.
pub struct Writer<W: Write> {
    out: W,
    scales: Vec<Option<u16>>,
}

impl<W: Write> Writer<W> {
    /// A writer for rows of `columns`; the header goes first.
    pub fn new(mut out: W, columns: &[Column]) -> io::Result<Writer<W>> {
        let header: Vec<String> = columns.iter().map(|c| field(&c.name)).collect();
        out.write_all(header.join(",").as_bytes())?;
        out.write_all(b"\r\n")?;
        let scales = columns
            .iter()
            .map(|c| {
                c.sql_type
                    .to_ascii_uppercase()
                    .starts_with("TIMESTAMP")
                    .then_some(c.scale)
            })
            .collect();
        Ok(Writer { out, scales })
    }

    /// One record.
    pub fn row(&mut self, row: &[SqlValue]) -> io::Result<()> {
        let mut line = String::new();
        for (i, v) in row.iter().enumerate() {
            if i > 0 {
                line.push(',');
            }
            if let Some(t) = values::to_csv(v, self.scales.get(i).copied().flatten()) {
                line.push_str(&field(&t));
            }
        }
        line.push_str("\r\n");
        self.out.write_all(line.as_bytes())
    }

    /// Flushes and gives the output back.
    pub fn finish(mut self) -> io::Result<W> {
        self.out.flush()?;
        Ok(self.out)
    }
}
