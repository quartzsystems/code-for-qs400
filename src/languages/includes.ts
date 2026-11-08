// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The extension's side of `qs400/fetchInclude` and `qs400/listMembers`:
 * the language servers never read the network, so an include's text
 * comes through the host here.
 *
 * - A member: `member.read` with `lock: false`. A library starting with
 *   `*` (`*LIBL`, `*CURLIB`) is looked up first with `object.list` of the
 *   source file, and the first library in that order holding the member
 *   answers, so the answer names the library the compiler would find.
 * - A stream file: `ifs.readText`; a relative path is joined to the
 *   including stream file's directory (`request.file`), else to `/`.
 * - Not found, or no connection: `null`.
 */

import * as vscode from 'vscode';
import type { MethodName, ParamsOf, ResultOf } from '../host/protocol';
import { ifsUri, parseIfsUri } from '../ifs/uri';
import { memberUri, parseMemberUri } from '../members/uri';
import type { FetchIncludeParams, FetchedInclude, ListMembersParams, MemberItem } from './protocol';

export interface IncludeDeps {
  call<M extends MethodName>(name: string, method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
  /** The saved connection's name for a lower-case or differently cased one. */
  canonical(name: string): string;
  /** The connection a local file's includes come from. */
  active(): string | undefined;
  log(line: string): void;
}

/** The connection whose system a document's includes come from. */
export function connectionOf(deps: IncludeDeps, uri: string): string | undefined {
  let u: vscode.Uri;
  try {
    u = vscode.Uri.parse(uri, true);
  } catch {
    return undefined;
  }
  const m = parseMemberUri(u);
  if (m) {
    return deps.canonical(m.connection);
  }
  const i = parseIfsUri(u);
  if (i) {
    return deps.canonical(i.connection);
  }
  return deps.active();
}

/** The path a stream-file include names. */
export function includePath(path: string, dir: string): string {
  if (path.startsWith('/')) {
    return path;
  }
  const base = dir === '' ? '' : dir.replace(/\/+$/, '');
  return `${base}/${path}`;
}

export async function fetchInclude(deps: IncludeDeps, p: FetchIncludeParams): Promise<FetchedInclude | null> {
  const name = connectionOf(deps, p.uri);
  if (!name) {
    return null;
  }
  const r = p.request;
  if (r.path !== undefined && r.path !== null) {
    const path = includePath(r.path, r.file);
    try {
      const t = await deps.call(name, 'ifs.readText', { name, path });
      return { uri: ifsUri(name, path).toString(), at: { kind: 'path', path }, text: t.text };
    } catch (err) {
      deps.log(`include ${path} on ${name}: ${message(err)}`);
      return null;
    }
  }
  const file = r.file.trim().toUpperCase();
  const member = r.member.trim().toUpperCase();
  const library = r.library.trim().toUpperCase() || '*LIBL';
  let libraries = [library];
  if (library.startsWith('*')) {
    try {
      const objects = await deps.call(name, 'object.list', { name, library, pattern: file, types: ['*FILE'] });
      libraries = objects.filter((o) => o.object.toUpperCase() === file).map((o) => o.library.toUpperCase());
    } catch (err) {
      deps.log(`include ${library}/${file}(${member}) on ${name}: ${message(err)}`);
      return null;
    }
  }
  for (const lib of libraries) {
    try {
      const m = await deps.call(name, 'member.read', { name, library: lib, file, member, lock: false });
      return {
        uri: memberUri(name, lib, file, member, m.type, true).toString(),
        at: { kind: 'member', library: lib, file, member },
        text: m.text,
      };
    } catch (err) {
      deps.log(`include ${lib}/${file}(${member}) on ${name}: ${message(err)}`);
    }
  }
  return null;
}

export async function listMembers(deps: IncludeDeps, p: ListMembersParams): Promise<MemberItem[]> {
  const name = connectionOf(deps, p.uri);
  if (!name) {
    return [];
  }
  try {
    const library = p.library.trim().toUpperCase() || '*LIBL';
    const entries = await deps.call(name, 'member.list', { name, library, file: p.file.trim().toUpperCase() });
    return entries.map((e) => ({ member: e.member, type: e.type, text: e.text }));
  } catch (err) {
    deps.log(`members of ${p.library}/${p.file} on ${name}: ${message(err)}`);
    return [];
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
