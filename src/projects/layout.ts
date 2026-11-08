// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The `sourceFiles` layout: a directory per source physical file, a file
 * per member named `MEMBER.ext`, the extension from the member's source
 * type by Phase 2's table and back. Names are upper-cased on deploy; two
 * local files naming one member (differing by case, or by an extension
 * of the same name) are a clash. For an IFS target the layout is the
 * folder's own tree. No `vscode` import.
 */

import { createHash } from 'node:crypto';
import { joinPath } from '../ifs/paths';
import { memberType, typeForExtension, NO_TYPE_EXT } from '../members/types';

/** A system name: a library, a file or a member (10 characters, `A-Z 0-9 $ # @ _ .`, not starting with a digit, `_` or `.`). */
const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

/** A local file of a library project, as the member it is deployed to. */
export interface LocalMember {
  /** The path relative to the folder, `/`-separated, as on disk. */
  rel: string;
  file: string;
  member: string;
  /** The extension, lower case. */
  ext: string;
  /** The source type the extension stands for. */
  type: string;
}

/** Why a path is not a member of the layout. */
export interface NotAMember {
  rel: string;
  reason: string;
}

/** The member a relative path is, or why it is not one. */
export function memberOf(rel: string): LocalMember | NotAMember {
  const p = rel.replace(/\\/g, '/');
  const parts = p.split('/').filter((s) => s !== '');
  if (parts.length !== 2) {
    return { rel: p, reason: parts.length < 2 ? 'not in a source file directory' : 'more than one directory deep' };
  }
  const [dir, name] = parts;
  const file = dir.toUpperCase();
  if (!NAME.test(file)) {
    return { rel: p, reason: `${dir} is not a source file name` };
  }
  const dot = name.lastIndexOf('.');
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? NO_TYPE_EXT : name.slice(dot + 1).toLowerCase();
  const member = stem.toUpperCase();
  if (!NAME.test(member)) {
    return { rel: p, reason: `${stem} is not a member name` };
  }
  return { rel: p, file, member, ext, type: typeForExtension(ext) };
}

export function isMember(m: LocalMember | NotAMember): m is LocalMember {
  return 'member' in m;
}

/** Where a member goes in the layout: `QRPGLESRC/ASSETS.rpgle`. */
export function localPathOf(file: string, member: string, type: string): string {
  return `${file.toUpperCase()}/${member.toUpperCase()}.${memberType(type).ext}`;
}

/** The key a member is known by: `QRPGLESRC/ASSETS`. */
export function memberKey(file: string, member: string): string {
  return `${file.toUpperCase()}/${member.toUpperCase()}`;
}

/** Groups of local paths naming the same member: each group is an error, and none of its files is deployed. */
export function clashes(members: readonly LocalMember[]): LocalMember[][] {
  const by = new Map<string, LocalMember[]>();
  for (const m of members) {
    const k = memberKey(m.file, m.member);
    by.set(k, [...(by.get(k) ?? []), m]);
  }
  return [...by.values()].filter((g) => g.length > 1);
}

/** The stream file a relative path is deployed to under `target`. */
export function remotePathOf(target: string, rel: string): string {
  return rel
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '')
    .reduce((acc, part) => joinPath(acc, part), target);
}

/** The relative path a stream file under `target` is, or undefined when it is not under it. */
export function relativeToTarget(target: string, path: string): string | undefined {
  const t = target.replace(/\/+$/, '');
  if (t === '') {
    return path.replace(/^\/+/, '') || undefined;
  }
  return path.startsWith(`${t}/`) ? path.slice(t.length + 1) : undefined;
}

/**
 * A local file's text as a member's lines: CRLF read as LF, trailing
 * blanks removed (as the save diff reads a document), and the newline
 * that ends the last line not counted as a line of its own.
 */
export function memberLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const lines = text.split(/\r?\n/).map((l) => l.replace(/ +$/, ''));
  if (lines.length > 0 && lines[lines.length - 1] === '' && /\n$/.test(text)) {
    lines.pop();
  }
  return lines;
}

/** A member's lines as the local file pull writes: `\n` after every line, so git sees a final newline. */
export function memberFileText(lines: readonly string[]): string {
  return lines.map((l) => `${l}\n`).join('');
}

/**
 * The hash a local file is compared by. A member's is of its lines as
 * `memberLines` reads them, so line endings and trailing blanks, which a
 * member cannot hold, are not changes; a stream file's is of its bytes.
 */
export function contentHash(bytes: Uint8Array, kind: 'member' | 'path'): string {
  const h = createHash('sha256');
  if (kind === 'member') {
    h.update(memberLines(new TextDecoder().decode(bytes)).join('\n'), 'utf8');
  } else {
    h.update(bytes);
  }
  return h.digest('hex');
}
