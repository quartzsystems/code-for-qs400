// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * Which files are source physical files. `ListObjects` gives a file's
 * attribute as `WRKOBJ` shows it, `PF` for a source file as for a data
 * file (IBM i does the same; only PDM shows `PF-SRC`). The catalog tells
 * them apart: `QSYS2.SYSTABLES.FILE_TYPE` is `S` for source. A file found
 * there gets the attribute `PF-SRC` here, so the rest of the extension
 * keeps one test.
 */

import type { SessionManager } from '../connections/sessions';
import type { ObjectEntry } from '../host/protocol';
import { SOURCE_FILE_ATTRIBUTE } from './filters';

/** The attributes PDM shows that `ListObjects` does not filter on: they are applied here. */
const PDM_ATTRIBUTES = [SOURCE_FILE_ATTRIBUTE, 'PF-DTA'];

function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The catalog query for the source files of `libraries`. */
export function sourceFilesQuery(libraries: readonly string[]): string {
  const libs = [...new Set(libraries.map((l) => l.trim().toUpperCase()))].map(literal).join(', ');
  return `SELECT SYSTEM_TABLE_SCHEMA, SYSTEM_TABLE_NAME FROM QSYS2.SYSTABLES WHERE FILE_TYPE = 'S' AND SYSTEM_TABLE_SCHEMA IN (${libs})`;
}

/** `LIB/FILE` of each source file of `libraries`; undefined when the catalog could not be read. */
export async function sourceFileNames(sessions: SessionManager, connection: string, libraries: readonly string[]): Promise<Set<string> | undefined> {
  if (libraries.length === 0) {
    return new Set();
  }
  try {
    const res = await sessions.call(connection, 'sql.run', { name: connection, sql: sourceFilesQuery(libraries), maxRows: 100_000 });
    if (res.cursor !== undefined) {
      await sessions.call(connection, 'sql.close', { name: connection, cursor: res.cursor }).catch(() => undefined);
    }
    const cols = res.columns ?? [];
    const lib = cols.findIndex((c) => c.name === 'SYSTEM_TABLE_SCHEMA');
    const file = cols.findIndex((c) => c.name === 'SYSTEM_TABLE_NAME');
    if (lib < 0 || file < 0) {
      return undefined;
    }
    const text = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : '');
    return new Set((res.rows ?? []).map((r) => `${text(r[lib])}/${text(r[file])}`));
  } catch {
    return undefined;
  }
}

/** Whether an entry is a file `ListObjects` may list as `PF`, source or data. */
function isPhysical(o: ObjectEntry): boolean {
  return o.type.toUpperCase() === '*FILE' && o.attribute.toUpperCase() === 'PF';
}

/**
 * `entries` with each source file's attribute `PF-SRC` and each other
 * physical file's `PF-DTA`, as PDM shows them. Unchanged when the catalog
 * could not be read.
 */
export async function markSourceFiles(sessions: SessionManager, connection: string, entries: ObjectEntry[]): Promise<ObjectEntry[]> {
  const physical = entries.filter(isPhysical);
  if (physical.length === 0) {
    return entries;
  }
  const names = await sourceFileNames(sessions, connection, physical.map((o) => o.library));
  if (!names) {
    return entries;
  }
  return entries.map((o) =>
    isPhysical(o) ? { ...o, attribute: names.has(`${o.library.toUpperCase()}/${o.object.toUpperCase()}`) ? SOURCE_FILE_ATTRIBUTE : 'PF-DTA' } : o,
  );
}

/**
 * `object.list` with the attribute filter applied here when it is one only
 * PDM shows (`PF-SRC`, `PF-DTA`), and source files marked.
 */
export async function listObjects(
  sessions: SessionManager,
  connection: string,
  params: { library: string; pattern: string; types: string[]; attribute?: string },
): Promise<ObjectEntry[]> {
  const want = params.attribute?.trim().toUpperCase();
  const pdm = want !== undefined && PDM_ATTRIBUTES.includes(want);
  const ask = { name: connection, library: params.library, pattern: params.pattern, types: params.types, ...(want && !pdm ? { attribute: want } : {}) };
  const entries = await markSourceFiles(sessions, connection, await sessions.call(connection, 'object.list', ask));
  return pdm ? entries.filter((o) => o.attribute.toUpperCase() === want) : entries;
}

/** The source files of `library`, marked `PF-SRC`, with their text. */
export function listSourceFiles(sessions: SessionManager, connection: string, library: string): Promise<ObjectEntry[]> {
  return listObjects(sessions, connection, { library, pattern: '*ALL', types: ['*FILE'], attribute: SOURCE_FILE_ATTRIBUTE });
}
