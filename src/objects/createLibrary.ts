// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * **Create Library…**: `CRTLIB` run in the session's command lane, as a
 * deploy runs `CRTSRCPF`.
 */

import * as vscode from 'vscode';
import { libraryName } from '../connections/config';
import { errorText } from '../connections/prompts';
import type { SessionManager } from '../connections/sessions';

/** A CL character literal: in quotes, each quote doubled. */
export function clString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The `CRTLIB` command for a library and its text. */
export function crtlibCommand(library: string, text: string): string {
  const t = text.trim();
  return t === '' ? `CRTLIB LIB(${library})` : `CRTLIB LIB(${library}) TEXT(${clString(t)})`;
}

/**
 * Asks for the library (offered `suggested`) and its text, and runs
 * `CRTLIB`. The library's name when it was created; errors are shown here.
 */
export async function createLibrary(sessions: SessionManager, connection: string, suggested?: string): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    title: `Create Library on ${connection} (1/2)`,
    prompt: 'Library name.',
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (v) => (libraryName(v) ? undefined : 'Enter a library name: up to 10 characters, starting with a letter, $, # or @.'),
  });
  const library = input === undefined ? undefined : libraryName(input);
  if (!library) {
    return undefined;
  }
  const text = await vscode.window.showInputBox({
    title: `Create Library ${library} (2/2)`,
    prompt: 'Text describing the library. Leave it empty for none.',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length > 50 ? 'Up to 50 characters.' : undefined),
  });
  if (text === undefined) {
    return undefined;
  }
  const command = crtlibCommand(library, text);
  try {
    const o = await sessions.call(connection, 'action.run', { name: connection, command, kind: 'command' });
    if (o.status !== 'Ok') {
      void vscode.window.showErrorMessage(o.escape ? `${o.escape.id}: ${o.escape.text}` : `${command}: ${o.status}`);
      return undefined;
    }
  } catch (err) {
    void vscode.window.showErrorMessage(errorText(err, connection));
    return undefined;
  }
  void vscode.commands.executeCommand('code-for-qs400.objects.refresh');
  return library;
}
