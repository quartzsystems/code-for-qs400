// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * SQL the SQL tree writes: qualified names in the connection's naming,
 * `SELECT` of every column, `INSERT` with `?` placeholders, `CALL` (or
 * `VALUES` for a function) with one placeholder per parameter, and View
 * data's query. A name that is not a plain identifier (upper case
 * letters, digits, `_`, `#`, `@`, `$`, not starting with a digit) is
 * delimited, its quotes doubled. No `vscode` import.
 */

import type { SqlNaming } from '../host/protocol';

/** A name as SQL writes it. */
export function quoteName(name: string): string {
  return /^[A-Z_#@$][A-Z0-9_#@$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** `SCHEMA.TABLE`, or `LIBRARY/FILE` under system naming. */
export function qualified(schema: string, name: string, naming: SqlNaming = 'sql'): string {
  return `${quoteName(schema)}${naming === 'system' ? '/' : '.'}${quoteName(name)}`;
}

/** Every column by name, one a line. */
export function selectText(schema: string, table: string, columns: readonly string[], naming: SqlNaming = 'sql'): string {
  const cols = columns.length > 0 ? columns.map(quoteName).join(',\n       ') : '*';
  return `SELECT ${cols}\n  FROM ${qualified(schema, table, naming)}`;
}

/** Every column, a `?` for each value. */
export function insertText(schema: string, table: string, columns: readonly string[], naming: SqlNaming = 'sql'): string {
  const names = columns.map(quoteName).join(', ');
  const marks = columns.map(() => '?').join(', ');
  return `INSERT INTO ${qualified(schema, table, naming)} (${names})\n  VALUES (${marks})`;
}

/** `CALL` of a procedure, `VALUES` of a function, a `?` per parameter with its name beside it. */
export function callText(schema: string, name: string, parameters: readonly string[], kind: 'procedure' | 'function', naming: SqlNaming = 'sql'): string {
  const args = parameters.map((p) => (p ? `? /* ${p.replace(/\*\//g, '* /')} */` : '?')).join(', ');
  return `${kind === 'function' ? 'VALUES' : 'CALL'} ${qualified(schema, name, naming)}(${args})`;
}

/** View data: the first 500 rows. */
export function viewDataText(schema: string, table: string, naming: SqlNaming = 'sql'): string {
  return `SELECT * FROM ${qualified(schema, table, naming)} FETCH FIRST 500 ROWS ONLY`;
}

/** A string literal. */
export function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * A routine's parameters from the catalog, in order: `QSYS2.SYSPARMS`'s
 * third column is a parameter's position, so the rows are sorted by it.
 * The caller reads `PARAMETER_NAME` from the result's columns.
 */
export function parametersQuery(schema: string, specific: string): string {
  return `SELECT * FROM QSYS2.SYSPARMS WHERE SPECIFIC_SCHEMA = ${literal(schema)} AND SPECIFIC_NAME = ${literal(specific)} AND ROW_TYPE = 'P' ORDER BY 3`;
}
