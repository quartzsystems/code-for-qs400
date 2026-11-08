// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * Fixed-form RPG columns: which specification a line is, which field a
 * column is in, and where each field starts. The table is the RPG
 * server's `qs400/specForms`, which is `rpgspecs`, the one `rpgfront`
 * reads records by. No `vscode` import.
 */

export interface SpecField {
  name: string;
  /** First column, from 1. */
  from: number;
  /** Last column. */
  to: number;
  /** What SEU's format line shows over it; empty for a field that overlaps others. */
  ruler: string;
}

export interface SpecForm {
  /** `H`, `F`, `D`, `I`, `IX`, `IR`, `IF`, `C`, `CX`, `O`, `OF`, `P`. */
  id: string;
  /** The letter in column 6. */
  letter: string;
  title: string;
  fields: SpecField[];
}

/** The calculation operation codes that take an extended factor 2. */
const EXTENDED = /^(EVAL|EVALR|EVAL-CORR|IF|ELSEIF|DOW|DOU|WHEN|FOR|CALLP|RETURN|ON-ERROR|ON-EXIT|SORTA|XML-INTO|XML-SAX|DATA-INTO|DATA-GEN)(\(|\s|$)/i;

/** Whether a member is `**FREE`: its first line says so. */
export function isFree(firstLine: string): boolean {
  return /^\*\*free\b/i.test(firstLine);
}

/** Columns `from` to `to` (from 1) of a line, blank past its end. */
function cut(line: string, from: number, to: number): string {
  return Array.from(line).slice(from - 1, to).join('');
}

const blank = (s: string) => s.trim() === '';

/**
 * The specification a fixed-form line is, or undefined for a comment, a
 * directive, a free-form line, compile-time data or a line too short.
 */
export function formOf(line: string, forms: readonly SpecForm[]): SpecForm | undefined {
  const chars = Array.from(line);
  if (chars.length < 6 || line.startsWith('**')) {
    return undefined;
  }
  const letter = chars[5].toUpperCase();
  const col7 = chars[6] ?? ' ';
  if (letter === ' ' || col7 === '*' || col7 === '/' || chars[5] === '/') {
    return undefined;
  }
  const byId = (id: string) => forms.find((f) => f.id === id);
  const of = forms.filter((f) => f.letter.toUpperCase() === letter);
  if (of.length === 0) {
    return undefined;
  }
  switch (letter) {
    case 'C': {
      if (chars[6] === '+' || chars[6] === '/') {
        return undefined;
      }
      const op = cut(line, 26, 35).trim();
      const extended = EXTENDED.test(op) || (op === '' && blank(cut(line, 12, 25)) && !blank(cut(line, 36, 80)));
      return byId(extended ? 'CX' : 'C') ?? of[0];
    }
    case 'I':
      if (blank(cut(line, 7, 16))) {
        return byId(!blank(cut(line, 21, 30)) && blank(cut(line, 37, 46)) ? 'IF' : 'IX') ?? of[0];
      }
      return byId(blank(cut(line, 17, 18)) ? 'IR' : 'I') ?? of[0];
    case 'O':
      return byId(blank(cut(line, 7, 17)) ? 'OF' : 'O') ?? of[0];
    default:
      return of[0];
  }
}

/** The field column `column` (from 1) is in. */
export function fieldAt(form: SpecForm, column: number): SpecField | undefined {
  return form.fields.find((f) => f.ruler !== '' && f.from <= column && column <= f.to);
}

/**
 * Where a form's boundaries are: the specification letter (6), column 7,
 * each field with a ruler of its own, and the comments (81). Sorted, each
 * once.
 */
export function boundaries(form: SpecForm): number[] {
  const cols = new Set<number>([6, 7, 81]);
  for (const f of form.fields) {
    if (f.ruler !== '' && f.from <= 81) {
      cols.add(f.from);
      if (f.to + 1 <= 81) {
        cols.add(f.to + 1);
      }
    }
  }
  return [...cols].sort((a, b) => a - b);
}

/** The column (from 1, counting characters) of a UTF-16 offset in a line. */
export function columnOf(line: string, character: number): number {
  return Array.from(line.slice(0, character)).length + 1;
}

/** The UTF-16 offset of column `column` (from 1) in a line, or undefined past its end. */
export function offsetOf(line: string, column: number): number | undefined {
  const chars = Array.from(line);
  if (column - 1 >= chars.length) {
    return undefined;
  }
  return chars.slice(0, column - 1).join('').length;
}

/** What the status bar shows: `D · Name 7–21 · col 12`. */
export function describe(form: SpecForm | undefined, column: number): string {
  if (!form) {
    return `col ${column}`;
  }
  const f = fieldAt(form, column);
  const letter = form.letter.toUpperCase();
  if (column <= 5) {
    return `${letter} · Sequence 1–5 · col ${column}`;
  }
  if (column === 6) {
    return `${letter} · Form type 6 · col 6`;
  }
  if (!f) {
    return `${letter} · col ${column}`;
  }
  const span = f.from === f.to ? `${f.from}` : `${f.from}–${f.to}`;
  return `${letter} · ${f.ruler} ${span} · col ${column}`;
}
