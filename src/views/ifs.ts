// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { errorText } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { HostRpcError } from '../host/client';
import { IfsEntry, SessionErrorCodes } from '../host/protocol';
import { defaultRoots, entryDescription, formatSize, isHidden, joinPath, sortEntries } from '../ifs/paths';
import { ifsUri } from '../ifs/uri';
import { isSignedOn } from './connections';

/** The QAP version the IFS view needs: `Ifs`. */
export const QAP_IFS = 5;

export const QAP_IFS_UNAVAILABLE_TEXT = 'QAP version 5 not available on this server';

/** Workspace state key of the hidden-entries toggle. */
export const SHOW_HIDDEN_KEY = 'code-for-qs400.ifs.showHidden';

/** Context key the view title's eye buttons look at. */
export const SHOW_HIDDEN_CONTEXT = 'code-for-qs400.ifs.showHidden';

/**
 * What a node stands for. Every node carries its connection and the root
 * it is under, which keeps a path shown under two roots two nodes.
 */
export type IfsNode =
  | { kind: 'message'; connection: string; root: string; text: string; detail?: string }
  | { kind: 'root'; connection: string; root: string; path: string; home: boolean; transient: boolean }
  | { kind: 'entry'; connection: string; root: string; path: string; entry: IfsEntry };

export type IfsRootNode = Extract<IfsNode, { kind: 'root' }>;
export type IfsEntryNode = Extract<IfsNode, { kind: 'entry' }>;

/** Whether a node lists children like a directory (a root, or a directory entry). */
export function isDirectoryNode(n: IfsNode | undefined): n is IfsRootNode | IfsEntryNode {
  return n?.kind === 'root' || (n?.kind === 'entry' && n.entry.kind === 'directory');
}

/** The path a node names; undefined for a message. */
export function nodePath(n: IfsNode | undefined): string | undefined {
  return n && n.kind !== 'message' ? n.path : undefined;
}

/** The context value of a node: `ifs.root[.home][.transient]`, `ifs.directory`, `ifs.file`, `ifs.symlink`, `ifs.other`. */
export function ifsContext(n: IfsNode): string {
  switch (n.kind) {
    case 'message':
      return 'ifs.message';
    case 'root':
      return `ifs.root${n.home ? '.home' : ''}${n.transient ? '.transient' : ''}`;
    case 'entry':
      return `ifs.${n.entry.kind}`;
  }
}

/** The roots of a connection: its saved ones (default `/home/<user>`, `/`), then those Go to Path added. */
export function rootNodes(connection: string, saved: string[], transient: string[]): IfsRootNode[] {
  const nodes: IfsRootNode[] = saved.map((path, i) => ({
    kind: 'root',
    connection,
    root: path,
    path,
    home: i === 0,
    transient: false,
  }));
  for (const path of transient) {
    if (!saved.includes(path)) {
      nodes.push({ kind: 'root', connection, root: path, path, home: false, transient: true });
    }
  }
  return nodes;
}

/** The children of a directory as the view lists them: sorted, hidden entries only when asked. */
export function childNodes(parent: IfsRootNode | IfsEntryNode, entries: IfsEntry[], showHidden: boolean): IfsEntryNode[] {
  return sortEntries(entries.filter((e) => showHidden || !isHidden(e.name))).map((entry) => ({
    kind: 'entry',
    connection: parent.connection,
    root: parent.root,
    path: joinPath(parent.path, entry.name),
    entry,
  }));
}

function modifiedText(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** A node as the tree shows it. `linkTargets` holds what each link resolved to, once it has. */
export function ifsTreeItem(n: IfsNode, linkTargets: ReadonlyMap<string, 'file' | 'directory'>, note?: string): vscode.TreeItem {
  const None = vscode.TreeItemCollapsibleState.None;
  const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
  switch (n.kind) {
    case 'message': {
      const i = new vscode.TreeItem(n.text, None);
      i.description = n.detail;
      i.tooltip = n.detail ? `${n.text} (${n.detail})` : n.text;
      i.iconPath = new vscode.ThemeIcon('info');
      i.contextValue = ifsContext(n);
      return i;
    }
    case 'root': {
      const i = new vscode.TreeItem(n.path, Collapsed);
      i.description = n.home ? 'Home' : n.transient ? 'Go to' : undefined;
      i.tooltip = n.path;
      i.iconPath = new vscode.ThemeIcon(n.home ? 'home' : n.transient ? 'location' : 'root-folder');
      i.contextValue = ifsContext(n);
      i.id = `${n.connection}|${n.root}`;
      return i;
    }
    case 'entry': {
      const e = n.entry;
      const link = e.kind === 'symlink' ? linkTargets.get(`${n.connection}|${n.path}`) : undefined;
      const expands = e.kind === 'directory' || (e.kind === 'symlink' && link !== 'file');
      const i = new vscode.TreeItem(e.name, expands ? Collapsed : None);
      i.id = `${n.connection}|${n.root}|${n.path}`;
      i.resourceUri = ifsUri(n.connection, n.path);
      i.description = [entryDescription(e), note].filter((s) => s).join(' · ') || undefined;
      const tip = new vscode.MarkdownString(undefined, true);
      tip.appendText(n.path);
      tip.appendMarkdown('\n\n');
      if (e.kind === 'file') {
        tip.appendText(`${formatSize(e.size)} (${e.size.toLocaleString()} bytes) · CCSID ${e.ccsid}\n`);
      }
      if (e.kind === 'symlink' && e.target !== undefined) {
        tip.appendText(`Symbolic link to ${e.target}\n`);
      }
      tip.appendText(`Owner ${e.owner} · changed ${modifiedText(e.modified)}`);
      if (note) {
        tip.appendText(`\n${note}`);
      }
      i.tooltip = tip;
      if (e.kind === 'directory') {
        i.iconPath = vscode.ThemeIcon.Folder;
      } else if (e.kind === 'symlink') {
        i.iconPath = new vscode.ThemeIcon(link === 'file' ? 'file-symlink-file' : 'file-symlink-directory');
      } else if (e.kind === 'other') {
        i.iconPath = new vscode.ThemeIcon('question');
      } else {
        i.iconPath = vscode.ThemeIcon.File;
      }
      i.contextValue = ifsContext(n);
      if (e.kind === 'file' || (e.kind === 'symlink' && link === 'file')) {
        i.command = { command: 'code-for-qs400.ifs.open', title: 'Open', arguments: [n] };
      }
      return i;
    }
  }
}

/** Whether the host said the server is below version 5. */
function qapUnavailable(err: unknown): number | undefined {
  if (err instanceof HostRpcError && err.code === SessionErrorCodes.QapUnavailable) {
    const v = (err.data as { version?: unknown } | undefined)?.version;
    return typeof v === 'number' ? v : 0;
  }
  return undefined;
}

/** One line in place of children. */
export function ifsErrorNode(connection: string, root: string, err: unknown): IfsNode {
  const v = qapUnavailable(err);
  if (v !== undefined) {
    return { kind: 'message', connection, root, text: QAP_IFS_UNAVAILABLE_TEXT, detail: `QAP v${v}` };
  }
  return { kind: 'message', connection, root, text: errorText(err) };
}

/**
 * The IFS view: the active connection's roots, each directory listed when
 * it opens or is refreshed; nothing is cached but what a link resolved to.
 */
export class IfsProvider implements vscode.TreeDataProvider<IfsNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<IfsNode | undefined>();
  private readonly subscriptions: vscode.Disposable[];
  private readonly parents = new WeakMap<IfsNode, IfsNode>();
  /** Go to Path roots, per connection, for this window only. */
  private readonly transient = new Map<string, string[]>();
  /** What each symbolic link resolved to, by `connection|path`. */
  readonly linkTargets = new Map<string, 'file' | 'directory'>();
  /** A line added to a file's description, by `connection|path` (an upload that stopped part way). */
  readonly notes = new Map<string, string>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly state: vscode.Memento,
  ) {
    this.subscriptions = [
      sessions.onDidChange((s) => {
        if (!s || s.name === this.connection()) {
          this.refresh();
        }
      }),
      store.onDidChange(() => this.refresh()),
    ];
    void vscode.commands.executeCommand('setContext', SHOW_HIDDEN_CONTEXT, this.showHidden);
  }

  /** The active connection when it is signed on. */
  connection(): string | undefined {
    const name = this.sessions.active;
    return name && isSignedOn(this.sessions.status(name)) ? name : undefined;
  }

  get showHidden(): boolean {
    return this.state.get<boolean>(SHOW_HIDDEN_KEY, false);
  }

  async setShowHidden(show: boolean): Promise<void> {
    await this.state.update(SHOW_HIDDEN_KEY, show);
    await vscode.commands.executeCommand('setContext', SHOW_HIDDEN_CONTEXT, show);
    this.refresh();
  }

  /** The saved roots of a connection, or the defaults. */
  savedRoots(connection: string): string[] {
    const c = this.store.get(connection);
    return c?.ifsRoots ?? (c ? defaultRoots(c.user) : []);
  }

  transientRoots(connection: string): string[] {
    return this.transient.get(connection.toLowerCase()) ?? [];
  }

  /** Shows `path` as a root for this window (Go to Path). */
  addTransientRoot(connection: string, path: string): IfsRootNode {
    const key = connection.toLowerCase();
    const list = this.transient.get(key) ?? [];
    if (!list.includes(path)) {
      this.transient.set(key, [...list, path]);
    }
    this.refresh();
    return { kind: 'root', connection, root: path, path, home: false, transient: true };
  }

  removeTransientRoot(connection: string, path: string): void {
    const key = connection.toLowerCase();
    this.transient.set(
      key,
      (this.transient.get(key) ?? []).filter((p) => p !== path),
    );
    this.refresh();
  }

  /** Refreshes a node, or the whole view. */
  refresh(node?: IfsNode): void {
    this.changed.fire(node);
  }

  getTreeItem(n: IfsNode): vscode.TreeItem {
    const note = n.kind === 'entry' ? this.notes.get(`${n.connection}|${n.path}`) : undefined;
    return ifsTreeItem(n, this.linkTargets, note);
  }

  getParent(n: IfsNode): IfsNode | undefined {
    return this.parents.get(n);
  }

  async getChildren(n?: IfsNode): Promise<IfsNode[]> {
    if (!n) {
      return this.roots();
    }
    let out: IfsNode[];
    try {
      out = await this.children(n);
    } catch (err) {
      out = [ifsErrorNode(n.connection, n.root, err)];
    }
    for (const c of out) {
      this.parents.set(c, n);
    }
    return out;
  }

  private roots(): IfsNode[] {
    const name = this.connection();
    if (!name) {
      return [{ kind: 'message', connection: '', root: '', text: 'Connect to browse the IFS' }];
    }
    const qap = this.sessions.status(name).system?.qap;
    if (qap !== undefined && qap < QAP_IFS) {
      return [{ kind: 'message', connection: name, root: '', text: QAP_IFS_UNAVAILABLE_TEXT, detail: `QAP v${qap}` }];
    }
    return rootNodes(name, this.savedRoots(name), this.transientRoots(name));
  }

  private async children(n: IfsNode): Promise<IfsNode[]> {
    if (n.kind === 'message') {
      return [];
    }
    if (n.kind === 'entry' && n.entry.kind === 'symlink') {
      return this.linkChildren(n);
    }
    if (!isDirectoryNode(n)) {
      return [];
    }
    return this.list(n, n.path);
  }

  private async list(n: IfsRootNode | IfsEntryNode, path: string): Promise<IfsNode[]> {
    const entries = await this.sessions.call(n.connection, 'ifs.list', { name: n.connection, path });
    const nodes = childNodes(n, entries, this.showHidden);
    if (nodes.length === 0) {
      const hidden = entries.length - nodes.length;
      return [
        {
          kind: 'message',
          connection: n.connection,
          root: n.root,
          text: hidden > 0 ? `${hidden} hidden ${hidden === 1 ? 'entry' : 'entries'}` : 'Empty',
        },
      ];
    }
    return nodes;
  }

  /** A link expands as its target: listed when that is a directory; a link to a file gets no children and becomes openable. */
  private async linkChildren(n: IfsEntryNode): Promise<IfsNode[]> {
    const { path } = await this.sessions.call(n.connection, 'ifs.resolve', { name: n.connection, path: n.path });
    const target = await this.sessions.call(n.connection, 'ifs.info', { name: n.connection, path });
    const key = `${n.connection}|${n.path}`;
    const kind = target.kind === 'directory' ? 'directory' : 'file';
    const before = this.linkTargets.get(key);
    this.linkTargets.set(key, kind);
    if (kind === 'file') {
      if (before !== 'file') {
        this.refresh(n);
      }
      return [];
    }
    // Listed under the link's own path: the server resolves it.
    return this.list(n, n.path);
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.changed.dispose();
  }
}
