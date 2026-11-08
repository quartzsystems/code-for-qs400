// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { HostRpcError } from '../host/client';
import { LibraryList, SessionStatus } from '../host/protocol';
import { ConnectionNode, DetailItem, LibraryListSource, isSignedOn } from '../views/connections';
import { libraryName, sameName } from './config';
import { errorText, showError } from './prompts';
import { SessionManager } from './sessions';
import { ConnectionStore } from './store';

/** What the Library list node knows of a session's list. */
interface Known {
  list?: LibraryList;
  /** Why there is no list: the host's error text. */
  error?: string;
}

/** The library list after an edit: the current library and the user part. */
export interface LibraryListEdit {
  current: string | null;
  user: string[];
}

/** Moves `user[index]` by `by` places; the list unchanged at either end. */
export function moved(list: LibraryList, index: number, by: -1 | 1): LibraryListEdit {
  const user = [...list.user];
  const to = index + by;
  if (index >= 0 && index < user.length && to >= 0 && to < user.length) {
    [user[index], user[to]] = [user[to], user[index]];
  }
  return { current: list.current, user };
}

/** `lib` as the current library; it leaves the user part. */
export function withCurrent(list: LibraryList, lib: string): LibraryListEdit {
  return { current: lib, user: list.user.filter((l) => l !== lib) };
}

/** `lib` added at the end of the user part, once. */
export function withAdded(list: LibraryList, lib: string): LibraryListEdit {
  return { current: list.current, user: list.user.includes(lib) ? [...list.user] : [...list.user, lib] };
}

/** Without `lib`: from the user part, or as the current library. */
export function withRemoved(list: LibraryList, lib: string, isCurrent: boolean): LibraryListEdit {
  return isCurrent
    ? { current: null, user: [...list.user] }
    : { current: list.current, user: list.user.filter((l) => l !== lib) };
}

/** The items under Library list: the current library first, marked `*CURLIB`, then the user part in order. */
export function libraryItems(name: string, list: LibraryList): DetailItem[] {
  const out: DetailItem[] = [];
  if (list.current) {
    const i = new vscode.TreeItem(list.current, vscode.TreeItemCollapsibleState.None);
    i.description = '*CURLIB';
    i.iconPath = new vscode.ThemeIcon('star-full');
    i.contextValue = 'library.current';
    out.push(new DetailItem('library', name, i, -1, list.current));
  }
  list.user.forEach((lib, index) => {
    const i = new vscode.TreeItem(lib, vscode.TreeItemCollapsibleState.None);
    i.iconPath = new vscode.ThemeIcon('library');
    i.contextValue = `library.user${index === 0 ? '.first' : ''}${index === list.user.length - 1 ? '.last' : ''}`;
    out.push(new DetailItem('library', name, i, index, lib));
  });
  return out;
}

/**
 * The Library list node and its commands. The node shows what the server
 * answered; the setting is only what is applied when a session starts, and
 * is saved after the server took an edit.
 */
export class LibraryListController implements LibraryListSource, vscode.Disposable {
  private readonly known = new Map<string, Known>();
  /** The job the saved list was last applied to, by connection. */
  private readonly appliedTo = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.subscriptions = [sessions.onDidChange((s) => (s ? this.sessionChanged(s) : this.resetGone()))];
  }

  private sessionChanged(s: SessionStatus): void {
    if (!isSignedOn(s)) {
      this.known.delete(s.name);
      this.appliedTo.delete(s.name);
      return;
    }
    const job = s.job ? `${s.job.number}/${s.job.user}/${s.job.name}` : 'session';
    if (s.state === 'connected' && this.appliedTo.get(s.name) !== job) {
      this.appliedTo.set(s.name, job);
      void this.applySaved(s.name);
    }
  }

  private resetGone(): void {
    for (const name of [...this.known.keys()]) {
      if (!isSignedOn(this.sessions.status(name))) {
        this.known.delete(name);
        this.appliedTo.delete(name);
      }
    }
  }

  /** A new session job: the saved list applied, then read back. */
  private async applySaved(name: string): Promise<void> {
    const saved = this.store.get(name)?.libraryList;
    try {
      const list =
        saved && (saved.current || saved.user?.length)
          ? await this.sessions.call(name, 'libl.set', { name, current: saved.current ?? null, user: saved.user ?? [] })
          : await this.sessions.call(name, 'libl.get', { name });
      this.known.set(name, { list });
    } catch (err) {
      this.known.set(name, { error: errorText(err) });
      this.output.warn(`${name}: library list: ${errorText(err)}`);
    }
    this.changed.fire(name);
  }

  node(name: string): vscode.TreeItem {
    const k = this.known.get(name);
    const item = new vscode.TreeItem(
      'Library list',
      k?.error ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.iconPath = new vscode.ThemeIcon('list-ordered');
    item.contextValue = k?.error ? 'libraryList.unavailable' : 'libraryList';
    if (k?.error) {
      item.description = k.error;
      item.tooltip = k.error;
    } else if (k?.list) {
      item.description = k.list.current ? `*CURLIB ${k.list.current}` : undefined;
    }
    return item;
  }

  async children(name: string): Promise<ConnectionNode[]> {
    let k = this.known.get(name);
    if (!k) {
      try {
        k = { list: await this.sessions.call(name, 'libl.get', { name }) };
      } catch (err) {
        k = { error: errorText(err) };
      }
      this.known.set(name, k);
      if (k.error) {
        this.changed.fire(name);
      }
    }
    return k.list ? libraryItems(name, k.list) : [];
  }

  /** Sends an edit; on success shows the server's list and saves it for the next connect. */
  async apply(name: string, edit: LibraryListEdit): Promise<LibraryList | undefined> {
    try {
      const list = await this.sessions.call(name, 'libl.set', { name, current: edit.current, user: edit.user });
      this.known.set(name, { list });
      await this.store.setLibraryList(name, { current: list.current ?? undefined, user: list.user });
      this.changed.fire(name);
      return list;
    } catch (err) {
      if (err instanceof HostRpcError) {
        this.known.set(name, { ...this.known.get(name), error: errorText(err) });
        this.changed.fire(name);
      }
      void showError(err, name);
      return undefined;
    }
  }

  /**
   * The session job's list, for the Objects view: the one known, else read
   * now. `fresh` reads it again. Errors are thrown as the host sent them.
   */
  async list(name: string, fresh = false): Promise<LibraryList> {
    const k = this.known.get(name);
    if (k?.list && !fresh) {
      return k.list;
    }
    const list = await this.sessions.call(name, 'libl.get', { name });
    this.known.set(name, { list });
    if (fresh || k?.error) {
      this.changed.fire(name);
    }
    return list;
  }

  /** The list an edit starts from: the server's, read now when not known. */
  private async current(name: string): Promise<LibraryList | undefined> {
    const k = this.known.get(name);
    if (k?.list) {
      return k.list;
    }
    try {
      const list = await this.sessions.call(name, 'libl.get', { name });
      this.known.set(name, { list });
      return list;
    } catch (err) {
      void showError(err, name);
      return undefined;
    }
  }

  /** Registers `code-for-qs400.libl.*`; once per window. */
  registerCommands(): vscode.Disposable[] {
    const reg = (id: string, fn: (arg: DetailItem | undefined) => Promise<unknown>) =>
      vscode.commands.registerCommand(`code-for-qs400.libl.${id}`, async (arg?: DetailItem) => {
        try {
          return await fn(arg);
        } catch (err) {
          void showError(err);
          return undefined;
        }
      });
    /** The connection: the node's, else the active one when signed on. */
    const target = (arg: DetailItem | undefined): string | undefined => {
      const name = arg?.connectionName ?? this.sessions.active;
      if (!name || !isSignedOn(this.sessions.status(name))) {
        void vscode.window.showInformationMessage('Connect first: the library list belongs to a session.');
        return undefined;
      }
      return name;
    };
    const library = (arg: DetailItem | undefined) => (arg?.kind === 'library' ? arg : undefined);

    return [
      reg('add', async (arg) => {
        const name = target(arg);
        const list = name ? await this.current(name) : undefined;
        if (!name || !list) {
          return undefined;
        }
        const input = await vscode.window.showInputBox({
          title: `Add to the library list of ${name}`,
          prompt: 'Library name. It goes at the end of the user part.',
          validateInput: (v) => {
            const n = libraryName(v);
            if (!n) {
              return 'Enter a library name: up to 10 characters, starting with a letter, $, # or @.';
            }
            return list.user.includes(n) || (list.current && sameName(list.current, n)) ? `${n} is in the list.` : undefined;
          },
        });
        const lib = input === undefined ? undefined : libraryName(input);
        return lib ? this.apply(name, withAdded(list, lib)) : undefined;
      }),
      reg('remove', async (arg) => {
        const item = library(arg);
        const list = item ? await this.current(item.connectionName) : undefined;
        if (!item?.library || !list) {
          return undefined;
        }
        return this.apply(item.connectionName, withRemoved(list, item.library, item.index < 0));
      }),
      reg('moveUp', async (arg) => {
        const item = library(arg);
        const list = item ? await this.current(item.connectionName) : undefined;
        return item && list && item.index > 0 ? this.apply(item.connectionName, moved(list, item.index, -1)) : undefined;
      }),
      reg('moveDown', async (arg) => {
        const item = library(arg);
        const list = item ? await this.current(item.connectionName) : undefined;
        return item && list && item.index >= 0 && item.index < list.user.length - 1
          ? this.apply(item.connectionName, moved(list, item.index, 1))
          : undefined;
      }),
      reg('setCurrent', async (arg) => {
        const item = library(arg);
        const list = item ? await this.current(item.connectionName) : undefined;
        return item?.library && list ? this.apply(item.connectionName, withCurrent(list, item.library)) : undefined;
      }),
    ];
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.changed.dispose();
  }
}
