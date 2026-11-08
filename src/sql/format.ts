// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * How SQL things are named on screen: commit levels and naming as the
 * system's parameter values, column types with their length and scale,
 * the status bar's text, a run's one-line outcome. No `vscode` import.
 */

import type { SqlColumn, SqlCommit, SqlNaming, SqlOptions, SqlRunResult } from '../host/protocol';

/** Each commit level, in the spec's order, with its parameter value. */
export const COMMIT_LEVELS: readonly { commit: SqlCommit; label: string; detail: string }[] = [
  { commit: 'none', label: '*NONE', detail: 'No commitment control' },
  { commit: 'readUncommitted', label: '*CHG', detail: 'Read uncommitted' },
  { commit: 'readCommitted', label: '*CS', detail: 'Read committed (cursor stability)' },
  { commit: 'repeatableRead', label: '*ALL', detail: 'Repeatable read' },
  { commit: 'serializable', label: '*RR', detail: 'Serializable' },
];

export function commitLabel(c: SqlCommit): string {
  return COMMIT_LEVELS.find((l) => l.commit === c)?.label ?? c;
}

export function namingLabel(n: SqlNaming): string {
  return n === 'system' ? '*SYS' : '*SQL';
}

/** `$(database) QSHQ400 · *SQL · *CHG ●`, the dot while changes are uncommitted. */
export function statusText(connection: string, o: SqlOptions | undefined): string {
  if (!o) {
    return `$(database) ${connection}`;
  }
  return `$(database) ${connection} · ${namingLabel(o.naming)} · ${commitLabel(o.commit)}${o.uncommitted ? ' ●' : ''}`;
}

const SIZED = new Set(['CHAR', 'VARCHAR', 'GRAPHIC', 'VARGRAPHIC', 'BINARY', 'VARBINARY', 'CLOB', 'BLOB', 'DBCLOB', 'CHARACTER', 'NCHAR', 'NVARCHAR']);
const SCALED = new Set(['DECIMAL', 'NUMERIC']);

/** A column's type as SQL writes it: `DECIMAL(11,2)`, `VARCHAR(50)`, `TIMESTAMP(6)`, `INTEGER`. */
export function typeLabel(c: Pick<SqlColumn, 'type' | 'length' | 'scale'>): string {
  const t = c.type.toUpperCase();
  if (SCALED.has(t)) {
    return `${t}(${c.length},${c.scale})`;
  }
  if (SIZED.has(t) && c.length > 0) {
    return `${t}(${c.length})`;
  }
  if (t === 'TIMESTAMP') {
    return `${t}(${c.scale})`;
  }
  if (t === 'DECFLOAT' && c.length > 0) {
    return `${t}(${c.length})`;
  }
  return t;
}

/** `12 rows`, `1 row`, `500 of more`. */
export function rowCount(rows: number, end: boolean): string {
  if (!end) {
    return `${rows} of more`;
  }
  return `${rows} ${rows === 1 ? 'row' : 'rows'}`;
}

/** A run's outcome in a line: `12 rows`, `0 rows updated`, `Statement ran`. */
export function outcomeText(r: SqlRunResult, shown?: number): string {
  if (r.kind === 'query') {
    return rowCount(shown ?? r.rows?.length ?? 0, r.end !== false);
  }
  if (r.kind === 'update') {
    const n = r.updated ?? 0;
    return `${n} ${n === 1 ? 'row' : 'rows'} updated`;
  }
  return 'Statement ran';
}

/** The first line of a statement, cut to `max` characters. */
export function firstLine(sql: string, max = 80): string {
  const line = sql.trim().split(/\r?\n/)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
