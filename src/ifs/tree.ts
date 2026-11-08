// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * Walking a directory tree with `ifs.list`, for the operations QAP does on
 * one entry at a time: delete (an empty directory only) and copy (a file
 * only). No `vscode` import. Symbolic links are entries: never followed,
 * deleted as links, copied as the server copies them.
 */

import type { IfsEntry, IfsKind } from '../host/protocol';
import { joinPath } from './paths';

/** One entry of a walk. */
export interface Walked {
  path: string;
  kind: IfsKind;
}

export type Lister = (dir: string) => Promise<IfsEntry[]>;

/**
 * Every entry under `root`, each directory's entries before the directory
 * itself, and `root` last: the order a delete must go in.
 */
export async function walkBottomUp(root: string, list: Lister): Promise<Walked[]> {
  const out: Walked[] = [];
  const visit = async (dir: string) => {
    for (const e of await list(dir)) {
      const path = joinPath(dir, e.name);
      if (e.kind === 'directory') {
        await visit(path);
      }
      out.push({ path, kind: e.kind });
    }
  };
  await visit(root);
  out.push({ path: root, kind: 'directory' });
  return out;
}

/** What a walk holds below its root, in words: `3 files and 2 folders`. */
export function countText(walked: readonly Walked[]): string {
  const below = walked.slice(0, -1);
  const folders = below.filter((w) => w.kind === 'directory').length;
  const files = below.length - folders;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (folders === 0) {
    return n(files, 'file', 'files');
  }
  if (files === 0) {
    return n(folders, 'folder', 'folders');
  }
  return `${n(files, 'file', 'files')} and ${n(folders, 'folder', 'folders')}`;
}

/** Deletes a walk in its order, one `ifs.delete` each; `done` after each. */
export async function deleteWalked(walked: readonly Walked[], del: (path: string) => Promise<void>, done?: (n: number) => void): Promise<void> {
  let n = 0;
  for (const w of walked) {
    await del(w.path);
    done?.(++n);
  }
}

/**
 * Copies the directory `from` to `to` (which must not exist): each
 * directory made, then its files copied on the system, then its
 * directories. Entries of kind `other` are skipped and returned.
 */
export async function copyTree(
  from: string,
  to: string,
  ops: {
    list: Lister;
    mkdir: (path: string) => Promise<void>;
    copy: (from: string, to: string) => Promise<void>;
  },
): Promise<string[]> {
  const skipped: string[] = [];
  const visit = async (src: string, dst: string) => {
    await ops.mkdir(dst);
    const entries = await ops.list(src);
    for (const e of entries.filter((x) => x.kind !== 'directory')) {
      if (e.kind === 'other') {
        skipped.push(joinPath(src, e.name));
      } else {
        await ops.copy(joinPath(src, e.name), joinPath(dst, e.name));
      }
    }
    for (const e of entries.filter((x) => x.kind === 'directory')) {
      await visit(joinPath(src, e.name), joinPath(dst, e.name));
    }
  };
  await visit(from, to);
  return skipped;
}
