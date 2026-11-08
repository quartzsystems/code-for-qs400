// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * IFS paths, entries and roots as the IFS view and the `qs400ifs`
 * provider handle them. No `vscode` import. Paths are passed to the host
 * as typed; the server resolves them.
 */

import type { IfsEntry } from '../host/protocol';

/** `dir` and `name` as one path. */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** The directory above `path`: `/` for a path just under it, and for `/`. */
export function parentPath(path: string): string {
  const p = path.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** The last component of `path`; `/` for the root. */
export function baseName(path: string): string {
  const p = path.replace(/\/+$/, '');
  return p.slice(p.lastIndexOf('/') + 1) || '/';
}

/** Whether `path` is `ancestor` or inside it. */
export function isWithin(path: string, ancestor: string): boolean {
  const a = ancestor.replace(/\/+$/, '');
  return path === ancestor || path === a || path.startsWith(`${a}/`);
}

/** A leading `.`: hidden unless the view shows hidden entries. */
export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/** A path typed in a box: an absolute path, or undefined. Surrounding blanks go; trailing slashes go except the root's. */
export function typedPath(s: string): string | undefined {
  const t = s.trim();
  if (!t.startsWith('/')) {
    return undefined;
  }
  return t === '/' ? t : t.replace(/\/+$/, '') || '/';
}

/** The roots a connection gets when it names none: the user's home directory, then `/`. */
export function defaultRoots(user: string): string[] {
  return [`/home/${user}`, '/'];
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Directories first, then everything else; each by name, without case, then exactly. */
export function sortEntries<T extends Pick<IfsEntry, 'name' | 'kind'>>(entries: readonly T[]): T[] {
  const rank = (e: T) => (e.kind === 'directory' ? 0 : 1);
  return [...entries].sort(
    (a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/** Bytes as the tree shows them: `512 B`, `1.5 KB`, `20.0 MB`. */
export function formatSize(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

/** A file's description in the tree: its size and CCSID. */
export function entryDescription(e: Pick<IfsEntry, 'kind' | 'size' | 'ccsid' | 'target'>): string | undefined {
  switch (e.kind) {
    case 'file':
      return `${formatSize(e.size)} · ${e.ccsid}`;
    case 'symlink':
      return e.target !== undefined ? `→ ${e.target}` : undefined;
    default:
      return undefined;
  }
}
