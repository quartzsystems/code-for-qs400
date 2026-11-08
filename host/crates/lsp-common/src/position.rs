// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! Between the front-ends' places and LSP's. A front end's
//! [`Span`] has byte offsets and lines and columns from 1, columns
//! counting characters (as fixed-form columns do); a [`Diagnostic`] has
//! lines and columns from 1, 0 unknown, its end column the last one it
//! covers. LSP has lines from 0 and columns in UTF-16 code units.

use compdiag::Diagnostic;
use compdiag::front::Span;
use lsp_types::{Position, Range};

/// Where each line of a text starts, for turning places into positions.
#[derive(Clone, Debug)]
pub struct TextIndex {
    text: String,
    /// Each line's first byte; never empty.
    starts: Vec<usize>,
}

impl Default for TextIndex {
    fn default() -> Self {
        Self::new("")
    }
}

impl TextIndex {
    /// The lines of `text`, split at `\n` (a `\r` before it is the line
    /// end's, not the line's), as `compdiag::front::Lines` splits them.
    #[must_use]
    pub fn new(text: &str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        Self {
            text: text.to_string(),
            starts,
        }
    }

    /// The text indexed.
    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    /// How many lines (a text ending in `\n` has an empty last line).
    #[must_use]
    pub fn line_count(&self) -> usize {
        self.starts.len()
    }

    /// Line `line` (from 0) without its line end; empty past the end.
    #[must_use]
    pub fn line(&self, line: usize) -> &str {
        let Some(&start) = self.starts.get(line) else {
            return "";
        };
        let end = self
            .starts
            .get(line + 1)
            .map_or(self.text.len(), |&n| n - 1);
        let body = &self.text[start..end.max(start)];
        body.strip_suffix('\r').unwrap_or(body)
    }

    /// The position of byte `byte`, held to the text and to the end of
    /// its line, and moved back to a character boundary.
    #[must_use]
    pub fn position(&self, byte: usize) -> Position {
        let mut byte = byte.min(self.text.len());
        while !self.text.is_char_boundary(byte) {
            byte -= 1;
        }
        let line = self.starts.partition_point(|&s| s <= byte) - 1;
        let start = self.starts[line];
        let body = self.line(line);
        let upto = (byte - start).min(body.len());
        Position::new(to_u32(line), utf16_len(&body[..upto]))
    }

    /// The byte of position `pos`, held to its line's end.
    #[must_use]
    pub fn offset(&self, pos: Position) -> usize {
        let line = usize::try_from(pos.line).unwrap_or(usize::MAX);
        let Some(&start) = self.starts.get(line) else {
            return self.text.len();
        };
        let body = self.line(line);
        let mut units = 0u32;
        for (i, c) in body.char_indices() {
            if units >= pos.character {
                return start + i;
            }
            units += to_u32(c.len_utf16());
        }
        start + body.len()
    }

    /// Column `column` (from 1, counting characters) of line `line`
    /// (from 1), held to the line's end.
    #[must_use]
    pub fn column(&self, line: u32, column: u32) -> Position {
        let l = line.saturating_sub(1);
        let body = self.line(usize::try_from(l).unwrap_or(usize::MAX));
        let skip = usize::try_from(column.saturating_sub(1)).unwrap_or(usize::MAX);
        let units = body.chars().take(skip).map(char::len_utf16).sum::<usize>();
        Position::new(l, to_u32(units))
    }

    /// The end of line `line` (from 1).
    #[must_use]
    pub fn line_end(&self, line: u32) -> Position {
        let l = line.saturating_sub(1);
        let body = self.line(usize::try_from(l).unwrap_or(usize::MAX));
        Position::new(l, utf16_len(body))
    }

    /// A span's range, from its byte offsets.
    #[must_use]
    pub fn span(&self, s: &Span) -> Range {
        Range::new(self.position(s.start), self.position(s.end.max(s.start)))
    }

    /// Whether position `pos` is inside span `s` (its end included, so
    /// a cursor just after a name is on it).
    #[must_use]
    pub fn contains(&self, s: &Span, pos: Position) -> bool {
        let at = self.offset(pos);
        s.start <= at && at <= s.end && s.end > s.start
    }

    /// A diagnostic's range, by the rules of the Problems panel's
    /// compile diagnostics: line 0 is line 1; column 0 is the whole
    /// line; end line 0 is the line; the end column is the last column
    /// covered, 0 running to the end of the line; an empty range on one
    /// line covers one character.
    #[must_use]
    pub fn diagnostic(&self, d: &Diagnostic) -> Range {
        let line = d.line.max(1);
        let end_line = if d.end_line == 0 { line } else { d.end_line }.max(line);
        if d.column == 0 {
            return Range::new(Position::new(line - 1, 0), self.line_end(end_line));
        }
        let start = self.column(line, u32::from(d.column));
        let mut end = if d.end_column == 0 {
            self.line_end(end_line)
        } else {
            self.column(end_line, u32::from(d.end_column) + 1)
        };
        if end.line == start.line && end.character <= start.character {
            end = self.column(line, u32::from(d.column) + 1);
            if end.character <= start.character {
                end.character = start.character + 1;
            }
        }
        Range::new(start, end)
    }
}

/// The UTF-16 length of `s`.
#[must_use]
pub fn utf16_len(s: &str) -> u32 {
    to_u32(s.encode_utf16().count())
}

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use compdiag::front::Lines;

    fn d(line: u32, column: u16, end_line: u32, end_column: u16) -> Diagnostic {
        Diagnostic {
            line,
            column,
            end_line,
            end_column,
            ..Diagnostic::default()
        }
    }

    #[test]
    fn bytes_to_utf16_positions() {
        // "é" is 2 bytes and 1 unit; "😀" is 4 bytes and 2 units.
        let t = TextIndex::new("ab\r\n é😀 name\nlast");
        assert_eq!(t.line_count(), 3);
        assert_eq!(t.line(0), "ab");
        assert_eq!(t.line(1), " é😀 name");
        let name = t.text().find("name").unwrap();
        assert_eq!(t.position(name), Position::new(1, 5));
        assert_eq!(t.offset(Position::new(1, 5)), name);
        // Past the end of a line, held to it; the CR is not the line's.
        assert_eq!(t.offset(Position::new(0, 9)), 2);
        assert_eq!(t.position(3), Position::new(0, 2));
        // Inside a character, moved back to its start.
        let e = t.text().find('é').unwrap();
        assert_eq!(t.position(e + 1), Position::new(1, 1));
    }

    #[test]
    fn spans_from_the_front_end_land_on_the_name() {
        let text =
            "     D é😀       S             10A\n     C                   EVAL      NAME = 1\n";
        let lines = Lines::new(text);
        let t = TextIndex::new(text);
        let s = lines.find(2, 36, "NAME");
        assert_eq!(&text[s.start..s.end], "NAME");
        let r = t.span(&s);
        assert_eq!(r, Range::new(Position::new(1, 35), Position::new(1, 39)));
        // On line 1 the emoji (column 9) is one column but two units:
        // it starts at unit 8 and the column after it is unit 10.
        let s = lines.span(1, 9, 1);
        assert_eq!(
            t.span(&s),
            Range::new(Position::new(0, 8), Position::new(0, 10))
        );
        assert_eq!(t.column(1, 9), Position::new(0, 8));
        assert_eq!(t.column(1, 10), Position::new(0, 10));
    }

    #[test]
    fn fixed_form_columns_are_characters() {
        // A D spec: name in 7-21, type in 24-25, length 33-39.
        let text = "     DCUSTNO           S              7P 0\n";
        let t = TextIndex::new(text);
        assert_eq!(t.column(1, 7), Position::new(0, 6));
        assert_eq!(t.column(1, 24), Position::new(0, 23));
        // Past the line, held to its end.
        assert_eq!(t.column(1, 80), Position::new(0, 42));
    }

    #[test]
    fn diagnostic_ranges_follow_the_problems_panel() {
        let t = TextIndex::new("one\n  two three\nfour\n");
        // Columns 3 to 5, inclusive.
        assert_eq!(
            t.diagnostic(&d(2, 3, 0, 5)),
            Range::new(Position::new(1, 2), Position::new(1, 5))
        );
        // Column 0 is the whole line.
        assert_eq!(
            t.diagnostic(&d(2, 0, 0, 0)),
            Range::new(Position::new(1, 0), Position::new(1, 11))
        );
        // Line 0 is line 1.
        assert_eq!(
            t.diagnostic(&d(0, 0, 0, 0)),
            Range::new(Position::new(0, 0), Position::new(0, 3))
        );
        // End column 0 runs to the end of the line.
        assert_eq!(
            t.diagnostic(&d(2, 3, 0, 0)),
            Range::new(Position::new(1, 2), Position::new(1, 11))
        );
        // Over two lines.
        assert_eq!(
            t.diagnostic(&d(2, 9, 3, 2)),
            Range::new(Position::new(1, 8), Position::new(2, 2))
        );
        // An end before the start on one line is one character.
        assert_eq!(
            t.diagnostic(&d(2, 5, 0, 2)),
            Range::new(Position::new(1, 4), Position::new(1, 5))
        );
    }

    #[test]
    fn diagnostic_columns_count_characters_not_units() {
        let t = TextIndex::new("😀😀 X\n");
        assert_eq!(
            t.diagnostic(&d(1, 4, 0, 4)),
            Range::new(Position::new(0, 5), Position::new(0, 6))
        );
    }
}
