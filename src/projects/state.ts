// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * `.qs400/state.json`, the project's only local state: for each local
 * file, its hash and the remote change timestamp at the last deploy or
 * pull. What each file's state is follows from it. No `vscode` import.
 *
 * - **Changed**: the content hash differs from the one recorded.
 * - **New**: nothing recorded.
 * - **Conflict**: the system's change timestamp (`member.list`'s
 *   `changed`, `ifs.info`'s `change`) is not the one recorded: someone
 *   changed it since. Milliseconds compare as newer; an IFS change
 *   counter compares as different.
 */

/** What is recorded for one local file. */
export interface FileRecord {
  hash: string;
  /** The member's `changed` (milliseconds) or the stream file's `change`, as the system gave it. */
  remote: number | string;
  /** Where it went: `QRPGLESRC/ASSETS` or `/home/CWELLMAN/app/x.sql`. */
  at: string;
}

export interface ProjectState {
  version: 1;
  /** By path relative to the folder, `/`-separated, as on disk. */
  files: Record<string, FileRecord>;
}

export function emptyState(): ProjectState {
  return { version: 1, files: {} };
}

/** Reads `state.json`; anything that is not a record is dropped, so a damaged file starts again rather than failing. */
export function parseState(text: string | undefined): ProjectState {
  if (!text) {
    return emptyState();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyState();
  }
  const out = emptyState();
  const files = (raw as { files?: unknown } | null)?.files;
  if (typeof files !== 'object' || files === null) {
    return out;
  }
  for (const [rel, r] of Object.entries(files as Record<string, unknown>)) {
    const f = r as Partial<FileRecord> | null;
    if (
      f &&
      typeof f.hash === 'string' &&
      (typeof f.remote === 'number' || typeof f.remote === 'string') &&
      typeof f.at === 'string'
    ) {
      out.files[rel] = { hash: f.hash, remote: f.remote, at: f.at };
    }
  }
  return out;
}

/** `state.json`'s text, paths sorted, so it reads the same each time. */
export function stateText(state: ProjectState): string {
  const files: Record<string, FileRecord> = {};
  for (const k of Object.keys(state.files).sort()) {
    files[k] = state.files[k];
  }
  return `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
}

export type FileStatus = 'deployed' | 'changed' | 'new' | 'conflict' | 'ignored';

/**
 * Whether the system's timestamp says the file changed there since it was
 * recorded. A member's milliseconds are newer or not; a stream file's
 * change counter (or `m<ms>` before QAP 6) is only compared.
 */
export function remoteChanged(recorded: number | string | undefined, now: number | string | undefined): boolean {
  if (recorded === undefined || now === undefined) {
    return false;
  }
  if (typeof recorded === 'number' && typeof now === 'number') {
    return now > recorded;
  }
  return String(recorded) !== String(now);
}

/** A file's state from its hash, what is recorded, and the system's timestamp when it was read. */
export function fileStatus(hash: string, record: FileRecord | undefined, remote?: number | string): FileStatus {
  if (record && remoteChanged(record.remote, remote)) {
    return 'conflict';
  }
  if (!record) {
    return 'new';
  }
  return record.hash === hash ? 'deployed' : 'changed';
}
