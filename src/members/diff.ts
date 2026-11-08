// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The save diff: which records a saved document becomes. A line diff
 * (longest common subsequence) between the lines last read and the
 * document's lines decides only the sequence numbers:
 *
 * - an unchanged line keeps its `seq` and `date`;
 * - a changed line (a deleted line paired, in order, with an inserted one
 *   in the same run of differences) keeps the old `seq` and `date`; the
 *   server dates it today, because its data differs;
 * - an inserted line gets a `seq` between its neighbours and date
 *   `000000`; the server dates it today;
 * - when a gap has no room (neighbours `0000.01` apart, or past
 *   `9999.99`) the write asks the server to renumber. Kept and changed
 *   lines still carry their old `seq`, so the server keeps their dates;
 *   inserted lines carry `0000.00`, which matches no record.
 *
 * Dates are never computed here. No `vscode` import.
 */

import type { SourceLine } from '../host/protocol';

/** The largest sequence number, in hundredths: `9999.99`. */
export const MAX_SEQ = 999_999;

/** The step after the last line, as SEU numbers: `0001.00`. */
export const STEP = 100;

/** Past this many cells the diff of the changed middle is not computed; the middle counts as changed line by line. */
const MAX_CELLS = 8_000_000;

export const NO_DATE = '000000';

/** `"0001.00"` as hundredths. */
export function seqValue(seq: string): number {
  const m = /^(\d{1,4})\.(\d{2})$/.exec(seq);
  if (!m) {
    throw new Error(`not a sequence number: ${seq}`);
  }
  return Number(m[1]) * 100 + Number(m[2]);
}

/** Hundredths as `"0001.00"`. */
export function seqText(n: number): string {
  return `${String(Math.floor(n / 100)).padStart(4, '0')}.${String(n % 100).padStart(2, '0')}`;
}

/** A document's text as lines, the way a member holds them: trailing blanks removed. */
export function documentLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/ +$/, ''));
}

export type Edit = { kind: 'same'; a: number; b: number } | { kind: 'delete'; a: number } | { kind: 'insert'; b: number };

/** A longest-common-subsequence line diff of `a` to `b`, as edits in order. */
export function diffLines(a: string[], b: string[]): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: Edit[] = [];
  for (let i = 0; i < start; i++) {
    out.push({ kind: 'same', a: i, b: i });
  }
  const n = endA - start;
  const m = endB - start;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    for (let i = 0; i < n; i++) {
      out.push({ kind: 'delete', a: start + i });
    }
    for (let j = 0; j < m; j++) {
      out.push({ kind: 'insert', b: start + j });
    }
  } else if (n > 0 || m > 0) {
    // len[i][j]: the LCS of a[start+i..endA) and b[start+j..endB).
    const w = m + 1;
    const len = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        len[i * w + j] =
          a[start + i] === b[start + j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        out.push({ kind: 'same', a: start + i, b: start + j });
        i++;
        j++;
      } else if (j < m && (i === n || len[i * w + j + 1] >= len[(i + 1) * w + j])) {
        out.push({ kind: 'insert', b: start + j });
        j++;
      } else {
        out.push({ kind: 'delete', a: start + i });
        i++;
      }
    }
  }
  for (let k = 0; k < a.length - endA; k++) {
    out.push({ kind: 'same', a: endA + k, b: endB + k });
  }
  return out;
}

/**
 * `k` sequence numbers strictly between `lo` and `hi` (`undefined`: no line
 * after), or undefined when there is no room. After the last line they
 * step by `0001.00` while that fits.
 */
export function gapSeqs(lo: number, hi: number | undefined, k: number): number[] | undefined {
  if (hi === undefined) {
    if (lo + STEP * k <= MAX_SEQ) {
      return Array.from({ length: k }, (_, j) => lo + STEP * (j + 1));
    }
    hi = MAX_SEQ + 1;
  }
  if (hi - lo - 1 < k) {
    return undefined;
  }
  return Array.from({ length: k }, (_, j) => lo + Math.floor(((hi - lo) * (j + 1)) / (k + 1)));
}

export interface WritePlan {
  lines: SourceLine[];
  /** No room was left for an insert, or a renumber was asked for. */
  renumber: boolean;
}

/**
 * What to send for a document whose lines are `text`, last read as `old`.
 * Undefined when nothing changed, unless `renumber` is asked for.
 */
export function planWrite(old: SourceLine[], text: string[], renumber = false): WritePlan | undefined {
  const a = old.map((l) => l.text);
  if (!renumber && a.length === text.length && a.every((t, i) => t === text[i])) {
    return undefined;
  }
  const edits = diffLines(a, text);
  // What each new line is: an old line kept or changed, or an insert.
  const from: (number | undefined)[] = new Array<number | undefined>(text.length);
  let k = 0;
  while (k < edits.length) {
    const e = edits[k];
    if (e.kind === 'same') {
      from[e.b] = e.a;
      k++;
      continue;
    }
    const deletes: number[] = [];
    const inserts: number[] = [];
    while (k < edits.length && edits[k].kind !== 'same') {
      const d = edits[k];
      if (d.kind === 'delete') {
        deletes.push(d.a);
      } else if (d.kind === 'insert') {
        inserts.push(d.b);
      }
      k++;
    }
    inserts.forEach((b, i) => {
      from[b] = i < deletes.length ? deletes[i] : undefined;
    });
  }

  const seqs: (number | undefined)[] = from.map((o) => (o === undefined ? undefined : seqValue(old[o].seq)));
  let room = true;
  let i = 0;
  while (i < text.length) {
    if (seqs[i] !== undefined) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && seqs[j] === undefined) {
      j++;
    }
    const lo = i > 0 ? (seqs[i - 1] as number) : 0;
    const hi = j < text.length ? (seqs[j] as number) : undefined;
    const got = gapSeqs(lo, hi, j - i);
    if (!got) {
      room = false;
      break;
    }
    got.forEach((s, x) => (seqs[i + x] = s));
    i = j;
  }

  if (room && !renumber) {
    return {
      renumber: false,
      lines: text.map((t, x) => {
        const o = from[x];
        return o === undefined
          ? { seq: seqText(seqs[x] as number), date: NO_DATE, text: t }
          : { seq: old[o].seq, date: old[o].date, text: t };
      }),
    };
  }
  return {
    renumber: true,
    lines: text.map((t, x) => {
      const o = from[x];
      return o === undefined ? { seq: seqText(0), date: NO_DATE, text: t } : { seq: old[o].seq, date: old[o].date, text: t };
    }),
  };
}
