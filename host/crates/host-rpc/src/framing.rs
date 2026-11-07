// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `Content-Length` framing, as used by the Language Server Protocol.
//!
//! A frame is a header block of `Name: value` lines ended by `\r\n`, an
//! empty line, then exactly `Content-Length` bytes of body.

use std::io::{self, BufRead, Write};

/// Largest body accepted, to bound memory on a corrupt stream.
pub const MAX_BODY: usize = 64 * 1024 * 1024;

/// Reads one frame. Returns `Ok(None)` on a clean end of stream before any
/// header byte.
pub fn read_frame<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut content_length: Option<usize> = None;
    let mut line = String::new();
    let mut first = true;
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            if first {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "stream ended inside a frame header",
            ));
        }
        first = false;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        let Some((name, value)) = trimmed.split_once(':') else {
            return Err(invalid(format!("malformed header line: {trimmed:?}")));
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            let len = value
                .trim()
                .parse::<usize>()
                .map_err(|_| invalid(format!("bad Content-Length: {:?}", value.trim())))?;
            if len > MAX_BODY {
                return Err(invalid(format!("frame of {len} bytes exceeds {MAX_BODY}")));
            }
            content_length = Some(len);
        }
        // Other headers (Content-Type) are accepted and ignored.
    }
    let len = content_length.ok_or_else(|| invalid("frame has no Content-Length".into()))?;
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Writes one frame and flushes.
pub fn write_frame<W: Write>(writer: &mut W, body: &[u8]) -> io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(body)?;
    writer.flush()
}

fn invalid(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trip_one() {
        let mut buf = Vec::new();
        write_frame(&mut buf, br#"{"a":1}"#).unwrap();
        assert_eq!(buf, b"Content-Length: 7\r\n\r\n{\"a\":1}");
        let mut r = Cursor::new(buf);
        assert_eq!(read_frame(&mut r).unwrap().unwrap(), br#"{"a":1}"#);
        assert!(read_frame(&mut r).unwrap().is_none());
    }

    #[test]
    fn round_trip_many_and_utf8() {
        let bodies: [&[u8]; 3] = [b"{}", "{\"s\":\"\u{00e9}\u{4e2d}\"}".as_bytes(), b"[]"];
        let mut buf = Vec::new();
        for b in bodies {
            write_frame(&mut buf, b).unwrap();
        }
        let mut r = Cursor::new(buf);
        for b in bodies {
            assert_eq!(read_frame(&mut r).unwrap().unwrap(), b);
        }
        assert!(read_frame(&mut r).unwrap().is_none());
    }

    #[test]
    fn extra_headers_and_case() {
        let raw = b"content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}";
        let mut r = Cursor::new(&raw[..]);
        assert_eq!(read_frame(&mut r).unwrap().unwrap(), b"{}");
    }

    #[test]
    fn missing_length_is_error() {
        let mut r = Cursor::new(&b"Content-Type: x\r\n\r\n{}"[..]);
        assert_eq!(
            read_frame(&mut r).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn truncated_body_is_error() {
        let mut r = Cursor::new(&b"Content-Length: 10\r\n\r\n{}"[..]);
        assert_eq!(
            read_frame(&mut r).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn truncated_header_is_error() {
        let mut r = Cursor::new(&b"Content-Length: 2\r\n"[..]);
        assert_eq!(
            read_frame(&mut r).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn oversized_is_error() {
        let raw = format!("Content-Length: {}\r\n\r\n", MAX_BODY + 1);
        let mut r = Cursor::new(raw.into_bytes());
        assert_eq!(
            read_frame(&mut r).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
