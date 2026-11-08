// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { ConnectionConfig, sameName } from '../connections/config';
import { promptConnection, showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';

/** What a command may be given: a tree node with a connection, a name, or nothing. */
export type ConnectionArg = { connectionName: string } | string | undefined;

/** The connection a command acts on; asks when none is given. */
export async function pickConnection(
  store: ConnectionStore,
  sessions: SessionManager,
  arg: ConnectionArg,
  placeHolder: string,
  filter: (c: ConnectionConfig) => boolean = () => true,
): Promise<ConnectionConfig | undefined> {
  const name = typeof arg === 'string' ? arg : arg?.connectionName;
  if (name !== undefined) {
    const c = store.get(name);
    if (!c) {
      void vscode.window.showErrorMessage(`No connection named ${name}.`);
    }
    return c;
  }
  const list = store.list().filter(filter);
  if (list.length === 0) {
    void vscode.window.showInformationMessage('No connection to choose from.');
    return undefined;
  }
  const first = sessions.active ?? store.defaultName();
  list.sort((a, b) => Number(first !== undefined && sameName(b.name, first)) - Number(first !== undefined && sameName(a.name, first)));
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({
      label: c.name,
      description: `${c.user}@${c.host}`,
      detail: sessions.status(c.name).state,
      c,
    })),
    { placeHolder },
  );
  return picked?.c;
}

const signedOn = (sessions: SessionManager) => (c: ConnectionConfig) =>
  ['connected', 'stale', 'connecting'].includes(sessions.status(c.name).state);

/** Registers `code-for-qs400.connection.*`. */
export function registerConnectionCommands(store: ConnectionStore, sessions: SessionManager): vscode.Disposable[] {
  const reg = (id: string, fn: (arg: ConnectionArg) => Promise<unknown>) =>
    vscode.commands.registerCommand(`code-for-qs400.connection.${id}`, async (arg: ConnectionArg) => {
      try {
        return await fn(arg);
      } catch (err) {
        void showError(err);
        return undefined;
      }
    });

  return [
    reg('add', async () => {
      const c = await promptConnection(
        undefined,
        store.list().map((x) => x.name),
      );
      if (!c) {
        return undefined;
      }
      await store.add(c);
      return c.name;
    }),

    reg('edit', async (arg) => {
      const existing = await pickConnection(store, sessions, arg, 'Connection to edit');
      if (!existing) {
        return undefined;
      }
      const c = await promptConnection(
        existing,
        store
          .list()
          .map((x) => x.name)
          .filter((n) => !sameName(n, existing.name)),
      );
      if (!c) {
        return undefined;
      }
      const wasActive = sessions.active !== undefined && sameName(sessions.active, existing.name);
      await store.replace(existing.name, c);
      if (wasActive) {
        await sessions.setActive(c.name);
      }
      if (signedOn(sessions)(existing)) {
        void vscode.window.showInformationMessage(`${c.name}: the changes apply the next time it connects.`);
      }
      return c.name;
    }),

    reg('remove', async (arg) => {
      const c = await pickConnection(store, sessions, arg, 'Connection to remove');
      if (!c) {
        return undefined;
      }
      const ok = await vscode.window.showWarningMessage(
        `Remove the connection ${c.name}?`,
        { modal: true, detail: `${c.user}@${c.host}. Its saved password is deleted from secret storage as well.` },
        'Remove',
      );
      if (ok !== 'Remove') {
        return false;
      }
      if (sessions.status(c.name).state !== 'disconnected') {
        if (!(await sessions.confirmDisconnect(c.name))) {
          return false;
        }
        await sessions.disconnect(c.name);
      }
      await store.remove(c.name);
      if (sessions.active !== undefined && sameName(sessions.active, c.name)) {
        await sessions.setActive(sessions.signedOn()[0]?.name);
      }
      return true;
    }),

    reg('connect', async (arg) => {
      const c = await pickConnection(store, sessions, arg, 'Connection to connect');
      return c ? sessions.connect(c.name) : undefined;
    }),

    reg('disconnect', async (arg) => {
      const c = await pickConnection(store, sessions, arg, 'Connection to disconnect', signedOn(sessions));
      if (c) {
        if (!(await sessions.confirmDisconnect(c.name))) {
          return undefined;
        }
        await sessions.disconnect(c.name);
      }
      return c?.name;
    }),

    reg('setDefault', async (arg) => {
      const c = await pickConnection(store, sessions, arg, 'Default connection');
      if (c) {
        await store.setDefault(c.name);
      }
      return c?.name;
    }),

    reg('forgetPassword', async (arg) => {
      const c = await pickConnection(store, sessions, arg, 'Connection whose saved password to forget');
      if (!c) {
        return undefined;
      }
      const had = (await store.password(c.name)) !== undefined;
      await store.forgetPassword(c.name);
      void vscode.window.showInformationMessage(
        had ? `${c.name}: the saved password was deleted.` : `${c.name}: no password was saved.`,
      );
      return had;
    }),
  ];
}
