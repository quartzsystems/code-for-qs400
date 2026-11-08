// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * SQL statements in a text, and the one under the cursor. The SQL
 * language server's `qs400/sqlStatements` is the authority (its parser
 * splits the script); `splitStatements` is the same rule for when there
 * is no server answer (a local `.sql` file in VS Code's own SQL language,
 * or a script that does not lex): split on `;` outside strings
 * (`'...'`, `"..."`, quotes doubled) and comments (`--` to the line's
 * end, `/* ... *\/`), each statement from its first character to its
 * last, blanks and comments around it left out. No `vscode` import.
 */

/** A statement's text, by UTF-16 offsets into the document. */
export interface Span {
  start: number;
  /** The offset after its last character. */
  end: number;
}

/** Each statement of `text`. */
export function splitStatements(text: string): Span[] {
  const out: Span[] = [];
  let first = -1;
  let last = 0;
  const push = () => {
    if (first >= 0) {
      out.push({ start: first, end: last });
    }
    first = -1;
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"') {
      if (first < 0) {
        first = i;
      }
      i++;
      while (i < n) {
        if (text[i] === c) {
          if (text[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i = Math.min(i + 1, n);
      last = i;
    } else if (c === '-' && text[i + 1] === '-') {
      while (i < n && text[i] !== '\n') {
        i++;
      }
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i = Math.min(i + 2, n);
    } else if (c === ';') {
      push();
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      if (first < 0) {
        first = i;
      }
      i++;
      last = i;
    }
  }
  push();
  return out;
}

/**
 * The statement the cursor at `offset` is in: from its first character
 * to the `;` that ends it, or anywhere on its last line after it. When the
 * cursor is in none, undefined.
 */
export function statementAt(text: string, spans: readonly Span[], offset: number): Span | undefined {
  for (const s of spans) {
    if (offset >= s.start && offset <= s.end) {
      return s;
    }
  }
  // After a statement on its last line (past its `;`, a comment, blanks).
  for (let k = spans.length - 1; k >= 0; k--) {
    const s = spans[k];
    if (s.end <= offset) {
      const between = text.slice(s.end, offset);
      const next = spans[k + 1];
      const lineEnd = text.indexOf('\n', s.end);
      const sameLine = !between.includes('\n');
      if (sameLine && (!next || next.start > offset) && (lineEnd < 0 || offset <= lineEnd)) {
        return s;
      }
      return undefined;
    }
  }
  return undefined;
}

/** Spans of `inner`, relative to it, moved to start at `base`. */
export function shifted(spans: readonly Span[], base: number): Span[] {
  return spans.map((s) => ({ start: s.start + base, end: s.end + base }));
}
