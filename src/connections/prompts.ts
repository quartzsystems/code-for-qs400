// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { HostRpcError } from '../host/client';
import { ServerMessageData, SessionErrorCodes } from '../host/protocol';
import { ConnectionConfig, profileName, sameName } from './config';

/**
 * Add and Edit: one input box per field. Undefined when cancelled. `taken`
 * holds the names of the other connections.
 */
export async function promptConnection(
  existing: ConnectionConfig | undefined,
  taken: string[],
): Promise<ConnectionConfig | undefined> {
  const title = existing ? `Edit Connection ${existing.name}` : 'Add Connection';
  const steps = 5;
  const box = (step: number, options: vscode.InputBoxOptions) =>
    vscode.window.showInputBox({ title: `${title} (${step}/${steps})`, ignoreFocusOut: true, ...options });

  const name = await box(1, {
    prompt: 'Connection name. It is the key for the password and the library list.',
    placeHolder: 'QSHQ400',
    value: existing?.name,
    validateInput: (v) => {
      if (v.trim() === '') {
        return 'Enter a name.';
      }
      return taken.some((t) => sameName(t, v)) ? `A connection named ${v.trim()} exists.` : undefined;
    },
  });
  if (name === undefined) {
    return undefined;
  }
  const host = await box(2, {
    prompt: 'Host name or address of the QS/400 system. The server certificate must carry this name.',
    placeHolder: 'qshq400.example.com',
    value: existing?.host,
    validateInput: (v) => (v.trim() === '' || /\s/.test(v.trim()) ? 'Enter a host name or address.' : undefined),
  });
  if (host === undefined) {
    return undefined;
  }
  const port = await box(3, {
    prompt: 'QAP port. Leave empty for the default port.',
    placeHolder: 'default',
    value: existing?.port?.toString(),
    validateInput: (v) => {
      if (v.trim() === '') {
        return undefined;
      }
      const n = Number(v.trim());
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : 'Enter a port from 1 to 65535, or leave it empty.';
    },
  });
  if (port === undefined) {
    return undefined;
  }
  const user = await box(4, {
    prompt: 'User profile.',
    placeHolder: 'CWELLMAN',
    value: existing?.user,
    validateInput: (v) => (profileName(v) ? undefined : 'Enter a user profile name: up to 10 characters.'),
  });
  if (user === undefined) {
    return undefined;
  }
  const caFile = await box(5, {
    prompt:
      'PEM file with certificates to trust beyond the system store (a CA, or the server certificate itself). Leave empty to use the system store only.',
    placeHolder: 'none',
    value: existing?.tls?.caFile,
  });
  if (caFile === undefined) {
    return undefined;
  }

  const c: ConnectionConfig = { name: name.trim(), host: host.trim(), user: profileName(user) ?? user.trim().toUpperCase() };
  if (port.trim() !== '') {
    c.port = Number(port.trim());
  }
  const tls = { ...existing?.tls };
  if (caFile.trim() !== '') {
    tls.caFile = caFile.trim();
  } else {
    delete tls.caFile;
  }
  if (Object.keys(tls).length > 0) {
    c.tls = tls;
  }
  if (existing?.libraryList) {
    c.libraryList = existing.libraryList;
  }
  if (existing?.filters) {
    c.filters = existing.filters;
  }
  if (existing?.ifsRoots) {
    c.ifsRoots = existing.ifsRoots;
  }
  if (existing?.actions) {
    c.actions = existing.actions;
  }
  if (existing?.variables) {
    c.variables = existing.variables;
  }
  return c;
}

export interface PasswordAnswer {
  password: string;
  save: boolean;
}

/**
 * The password, and whether to keep it in secret storage. `reason` is
 * shown above the box, e.g. the server's message when it refused.
 */
export async function promptPassword(c: ConnectionConfig, reason?: string): Promise<PasswordAnswer | undefined> {
  const password = await vscode.window.showInputBox({
    title: `Sign on to ${c.name} as ${c.user}`,
    prompt: reason ?? `Password for ${c.user} on ${c.host}.`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v === '' ? 'Enter the password.' : undefined),
  });
  if (password === undefined) {
    return undefined;
  }
  const save = await vscode.window.showQuickPick(
    [
      { label: '$(lock) Save password', description: 'in VS Code secret storage', save: true },
      { label: '$(circle-slash) Ask every time', description: 'kept only while connected', save: false },
    ],
    { title: `Sign on to ${c.name}`, placeHolder: 'Save the password?', ignoreFocusOut: true },
  );
  return save ? { password, save: save.save } : undefined;
}

/** A new password, asked twice. */
export async function promptNewPassword(c: ConnectionConfig): Promise<string | undefined> {
  const first = await vscode.window.showInputBox({
    title: `Change password for ${c.user} on ${c.name} (1/2)`,
    prompt: 'New password.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v === '' ? 'Enter the new password.' : undefined),
  });
  if (first === undefined) {
    return undefined;
  }
  const second = await vscode.window.showInputBox({
    title: `Change password for ${c.user} on ${c.name} (2/2)`,
    prompt: 'New password again.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v === first ? undefined : 'The passwords differ.'),
  });
  return second === undefined ? undefined : first;
}

/** The server's message of a host error, when the server sent one. */
export function serverMessage(err: unknown): ServerMessageData | undefined {
  if (!(err instanceof HostRpcError)) {
    return undefined;
  }
  if (err.code !== SessionErrorCodes.Server && err.code !== SessionErrorCodes.NeedsPassword) {
    return undefined;
  }
  const d = err.data as ServerMessageData | undefined;
  return d && typeof d.status === 'string' ? d : undefined;
}

/**
 * How an error is shown: a server message as `messageId: text`, exactly as
 * QAP returned it; anything else as the host's text after the connection
 * name.
 */
export function errorText(err: unknown, name?: string): string {
  const m = serverMessage(err);
  if (m?.messageId) {
    return `${m.messageId}: ${m.text ?? ''}`;
  }
  const text = err instanceof Error ? err.message : String(err);
  return name ? `${name}: ${text}` : text;
}

/**
 * Shows an error as `errorText` does, with `actions` as buttons and a
 * Details button for the server's second-level text. The action picked,
 * if any.
 */
export async function showError(err: unknown, name?: string, ...actions: string[]): Promise<string | undefined> {
  const m = serverMessage(err);
  const details = m?.secondLevel ? 'Details' : undefined;
  const picked = await vscode.window.showErrorMessage(errorText(err, name), ...actions, ...(details ? [details] : []));
  if (picked && picked === details && m?.secondLevel) {
    void vscode.window.showInformationMessage(errorText(err, name), { modal: true, detail: m.secondLevel });
    return undefined;
  }
  return picked;
}
