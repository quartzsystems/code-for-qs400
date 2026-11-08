// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';

/** The scheme stream files open on. */
export const IFS_SCHEME = 'qs400ifs';

/** `qs400ifs://<connection>/<path>`: the path as the system names it. */
export function ifsUri(connection: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: IFS_SCHEME, authority: connection, path: path.startsWith('/') ? path : `/${path}` });
}

/** The connection (as the URI spells it) and path of a `qs400ifs` URI. */
export function parseIfsUri(uri: vscode.Uri): { connection: string; path: string } | undefined {
  if (uri.scheme !== IFS_SCHEME || !uri.authority) {
    return undefined;
  }
  return { connection: uri.authority, path: uri.path === '' ? '/' : uri.path };
}
