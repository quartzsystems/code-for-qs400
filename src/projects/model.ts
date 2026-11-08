// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * What the Project view shows of a project's files: each file's state,
 * grouped by directory, and the status bar's count. No `vscode` import.
 */

import { qualifiedMember } from '../members/uri';
import type { ProjectTarget } from './config';
import { isMember, memberOf, remotePathOf } from './layout';
import { FileStatus, ProjectState, fileStatus } from './state';

export interface FileRow {
  rel: string;
  /** The last component. */
  name: string;
  status: FileStatus;
  /** The member or stream file it deploys to; undefined when it is no member of the layout. */
  at?: string;
}

export interface DirGroup {
  /** `''` for the folder's own files. */
  dir: string;
  rows: FileRow[];
}

/** Where a local path deploys to, as state records it. */
export function deployedAt(target: ProjectTarget, rel: string): string | undefined {
  if (target.kind === 'path') {
    return remotePathOf(target.path, rel);
  }
  const m = memberOf(rel);
  return isMember(m) ? qualifiedMember({ library: target.library, file: m.file, member: m.member }) : undefined;
}

/**
 * Each file's state: by its hash against the record, a conflict when the
 * system's timestamp read last (`remote`) is newer than the record's for
 * the same place, or when the last deploy found one (`conflicts`).
 */
export function fileRows(
  target: ProjectTarget,
  files: readonly string[],
  ignored: readonly string[],
  hashes: ReadonlyMap<string, string>,
  state: ProjectState,
  remote: ReadonlyMap<string, number | string>,
  conflicts: ReadonlySet<string>,
): FileRow[] {
  const rows: FileRow[] = files.map((rel) => {
    const at = deployedAt(target, rel);
    const record = state.files[rel];
    let status = fileStatus(hashes.get(rel) ?? '', record, remote.get(rel), at);
    if (conflicts.has(rel)) {
      status = 'conflict';
    }
    return { rel, name: rel.slice(rel.lastIndexOf('/') + 1), status, at };
  });
  for (const rel of ignored) {
    rows.push({ rel, name: rel.slice(rel.lastIndexOf('/') + 1), status: 'ignored' });
  }
  return rows;
}

/** Rows by directory, the folder's own files first, then directories in order; ignored files are left to their own group. */
export function groupByDir(rows: readonly FileRow[]): DirGroup[] {
  const by = new Map<string, FileRow[]>();
  for (const r of rows.filter((x) => x.status !== 'ignored')) {
    const i = r.rel.lastIndexOf('/');
    const dir = i < 0 ? '' : r.rel.slice(0, i);
    by.set(dir, [...(by.get(dir) ?? []), r]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([dir, list]) => ({ dir, rows: list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }));
}

/** The state's word, as the view and its tooltips show it. */
export const STATUS_LABEL: Readonly<Record<FileStatus, string>> = {
  deployed: 'Deployed',
  changed: 'Changed',
  new: 'New',
  conflict: 'Conflict',
  ignored: 'Ignored',
};

/** The codicon of each state. */
export const STATUS_ICON: Readonly<Record<FileStatus, string>> = {
  deployed: 'pass',
  changed: 'circle-filled',
  new: 'diff-added',
  conflict: 'warning',
  ignored: 'circle-slash',
};

/** Files a **Deploy changed** would take: changed, new or in conflict. */
export function pendingCount(rows: readonly FileRow[]): number {
  return rows.filter((r) => r.status === 'changed' || r.status === 'new' || r.status === 'conflict').length;
}

/** The status bar's text for a project. */
export function statusBarText(rows: readonly FileRow[]): string {
  return `$(cloud-upload) ${pendingCount(rows)} changed`;
}
