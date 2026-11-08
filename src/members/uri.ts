// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { memberType } from './types';

/** The scheme members open on. */
export const MEMBER_SCHEME = 'qs400mbr';

/** The query of a URI opened read-only: no lock, no save. */
export const READONLY_QUERY = 'readonly';

/** What a `qs400mbr` URI names: a library, a source file in it, or a member of that. */
export type MemberPath =
  | { kind: 'root'; connection: string }
  | { kind: 'library'; connection: string; library: string }
  | { kind: 'file'; connection: string; library: string; file: string }
  | { kind: 'member'; connection: string; library: string; file: string; member: string; ext: string };

/** `qs400mbr://<connection>/<LIBRARY>/<FILE>/<MEMBER>.<ext>`, names upper case, the extension from the type. */
export function memberUri(
  connection: string,
  library: string,
  file: string,
  member: string,
  type: string,
  readonly = false,
): vscode.Uri {
  const path = `/${library.toUpperCase()}/${file.toUpperCase()}/${member.toUpperCase()}.${memberType(type).ext}`;
  return vscode.Uri.from({ scheme: MEMBER_SCHEME, authority: connection, path, query: readonly ? READONLY_QUERY : '' });
}

/** The URI without the read-only query. */
export function writableUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ query: '' });
}

/** Whether the URI was opened read-only. */
export function isReadonlyUri(uri: vscode.Uri): boolean {
  return uri.query === READONLY_QUERY;
}

/** What the URI names; undefined when it is not a `qs400mbr` path. */
export function parseMemberUri(uri: vscode.Uri): MemberPath | undefined {
  if (uri.scheme !== MEMBER_SCHEME || !uri.authority) {
    return undefined;
  }
  const connection = uri.authority;
  const parts = uri.path.split('/').filter((p) => p !== '');
  switch (parts.length) {
    case 0:
      return { kind: 'root', connection };
    case 1:
      return { kind: 'library', connection, library: parts[0].toUpperCase() };
    case 2:
      return { kind: 'file', connection, library: parts[0].toUpperCase(), file: parts[1].toUpperCase() };
    case 3: {
      const dot = parts[2].lastIndexOf('.');
      if (dot <= 0) {
        return undefined;
      }
      return {
        kind: 'member',
        connection,
        library: parts[0].toUpperCase(),
        file: parts[1].toUpperCase(),
        member: parts[2].slice(0, dot).toUpperCase(),
        ext: parts[2].slice(dot + 1).toLowerCase(),
      };
    }
    default:
      return undefined;
  }
}

/** `LIB/FILE(MEMBER)`, as the system names a member. */
export function qualifiedMember(p: { library: string; file: string; member: string }): string {
  return `${p.library}/${p.file}(${p.member})`;
}
