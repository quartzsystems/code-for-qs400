// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { LibraryListController } from '../connections/libraryList';
import { errorText } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { HostRpcError } from '../host/client';
import { LibraryList, MemberEntry, ObjectEntry, SessionErrorCodes } from '../host/protocol';
import { FilterConfig, LIBRARY_TYPES, SOURCE_FILE_ATTRIBUTE, typesFor } from '../objects/filters';
import { isSignedOn } from './connections';

/** The QAP version the Objects view needs: `Develop`. */
export const QAP_DEVELOP = 8;

export const QAP_UNAVAILABLE_TEXT = 'QAP version 8 not available on this server';

/** What a node stands for. Every node carries the connection it belongs to. */
export type ObjectsNode =
  | { kind: 'message'; connection: string; text: string; detail?: string }
  | { kind: 'library'; connection: string; library: string; current: boolean }
  | { kind: 'filters'; connection: string }
  | { kind: 'filter'; connection: string; filter: FilterConfig }
  | { kind: 'type'; connection: string; library: string; type: string }
  | { kind: 'object'; connection: string; entry: ObjectEntry }
  | { kind: 'member'; connection: string; library: string; file: string; entry: MemberEntry };

export type MemberNode = Extract<ObjectsNode, { kind: 'member' }>;
export type ObjectNode = Extract<ObjectsNode, { kind: 'object' }>;

/** Whether an object is a source physical file, which expands to its members. */
export function isSourceFile(o: ObjectEntry): boolean {
  return o.type.toUpperCase() === '*FILE' && o.attribute.toUpperCase() === SOURCE_FILE_ATTRIBUTE;
}

/** The roots for a library list: the current library first, then the user part, in order. */
export function libraryNodes(connection: string, list: LibraryList): ObjectsNode[] {
  const out: ObjectsNode[] = [];
  if (list.current) {
    out.push({ kind: 'library', connection, library: list.current, current: true });
  }
  for (const library of list.user) {
    if (library !== list.current) {
      out.push({ kind: 'library', connection, library, current: false });
    }
  }
  return out;
}

/** The type nodes of a library, in the order the view shows them; **All** last. */
export function typeNodes(connection: string, library: string): ObjectsNode[] {
  return [...LIBRARY_TYPES, '*ALL'].map((type) => ({ kind: 'type' as const, connection, library, type }));
}

/** The context value of an object node: `object.<type>`, `.srcpf` for a source file. */
export function objectContext(o: ObjectEntry): string {
  const type = o.type.replace(/^\*/, '').toLowerCase();
  return `object.${type}${isSourceFile(o) ? '.srcpf' : ''}`;
}

/** A node as the tree shows it. */
export function objectsTreeItem(n: ObjectsNode): vscode.TreeItem {
  const None = vscode.TreeItemCollapsibleState.None;
  const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
  switch (n.kind) {
    case 'message': {
      const i = new vscode.TreeItem(n.text, None);
      i.description = n.detail;
      i.tooltip = n.detail ? `${n.text} (${n.detail})` : n.text;
      i.iconPath = new vscode.ThemeIcon('info');
      i.contextValue = 'objects.message';
      return i;
    }
    case 'library': {
      const i = new vscode.TreeItem(n.library, Collapsed);
      i.description = n.current ? '*CURLIB' : undefined;
      i.iconPath = new vscode.ThemeIcon(n.current ? 'star-full' : 'library');
      i.contextValue = 'objects.library';
      i.id = `${n.connection}/lib/${n.library}`;
      return i;
    }
    case 'filters': {
      const i = new vscode.TreeItem('Filters', Collapsed);
      i.iconPath = new vscode.ThemeIcon('filter');
      i.contextValue = 'objects.filters';
      i.id = `${n.connection}/filters`;
      return i;
    }
    case 'filter': {
      const f = n.filter;
      const i = new vscode.TreeItem(f.name, Collapsed);
      i.description = `${f.library}/${f.object} ${f.type}${f.attribute ? ` ${f.attribute}` : ''}`;
      i.iconPath = new vscode.ThemeIcon('filter');
      i.contextValue = 'objects.filter';
      i.id = `${n.connection}/filter/${f.name}`;
      return i;
    }
    case 'type': {
      const i = new vscode.TreeItem(n.type === '*ALL' ? 'All' : n.type, Collapsed);
      i.iconPath = new vscode.ThemeIcon(n.type === '*ALL' ? 'list-flat' : 'symbol-folder');
      i.contextValue = 'objects.type';
      i.id = `${n.connection}/lib/${n.library}/${n.type}`;
      return i;
    }
    case 'object': {
      const o = n.entry;
      const i = new vscode.TreeItem(o.object, isSourceFile(o) ? Collapsed : None);
      i.description = [o.attribute, o.text].filter((s) => s.trim() !== '').join(' ');
      const tip = new vscode.MarkdownString(undefined, true);
      tip.appendMarkdown(`**${o.library}/${o.object}** ${o.type}${o.attribute ? ` ${o.attribute}` : ''}\n\n`);
      if (o.text) {
        tip.appendText(`${o.text}\n\n`);
      }
      tip.appendMarkdown(`Owner ${o.owner} · ${o.size.toLocaleString()} bytes`);
      i.tooltip = tip;
      i.iconPath = new vscode.ThemeIcon(isSourceFile(o) ? 'file-submodule' : o.type === '*PGM' ? 'gear' : 'symbol-file');
      i.contextValue = objectContext(o);
      return i;
    }
    case 'member': {
      const m = n.entry;
      const i = new vscode.TreeItem(m.member, None);
      i.description = m.type;
      i.tooltip = m.text || `${n.library}/${n.file}(${m.member})`;
      i.iconPath = new vscode.ThemeIcon('file-code');
      i.contextValue = 'objects.member';
      return i;
    }
  }
}

/** Whether the host said the server is below version 8. */
function qapUnavailable(err: unknown): number | undefined {
  if (err instanceof HostRpcError && err.code === SessionErrorCodes.QapUnavailable) {
    const v = (err.data as { version?: unknown } | undefined)?.version;
    return typeof v === 'number' ? v : 0;
  }
  return undefined;
}

/** One line in place of children: the error as `errorText` shows it, or the version line. */
export function errorNode(connection: string, err: unknown): ObjectsNode {
  const v = qapUnavailable(err);
  if (v !== undefined) {
    return { kind: 'message', connection, text: QAP_UNAVAILABLE_TEXT, detail: `QAP v${v}` };
  }
  return { kind: 'message', connection, text: errorText(err) };
}

/**
 * The Objects view: the active connection's library list libraries, then
 * Filters. Lists are read from the host each time a node opens or is
 * refreshed; nothing is cached here.
 */
export class ObjectsProvider implements vscode.TreeDataProvider<ObjectsNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ObjectsNode | undefined>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly libraryList: LibraryListController,
  ) {
    this.subscriptions = [
      sessions.onDidChange((s) => {
        if (!s || s.name === this.connection()) {
          this.refresh();
        }
      }),
      store.onDidChange(() => this.refresh()),
      libraryList.onDidChange((name) => {
        if (!name || name === this.connection()) {
          this.refresh();
        }
      }),
    ];
  }

  /** The active connection when it is signed on. */
  connection(): string | undefined {
    const name = this.sessions.active;
    return name && isSignedOn(this.sessions.status(name)) ? name : undefined;
  }

  /** Refreshes a node, or the whole view. */
  refresh(node?: ObjectsNode): void {
    this.changed.fire(node);
  }

  /** Reads the library list again and refreshes the view. */
  async refreshLibraryList(): Promise<void> {
    const name = this.connection();
    if (name) {
      await this.libraryList.list(name, true).catch(() => undefined);
    }
    this.refresh();
  }

  getTreeItem(n: ObjectsNode): vscode.TreeItem {
    return objectsTreeItem(n);
  }

  async getChildren(n?: ObjectsNode): Promise<ObjectsNode[]> {
    if (!n) {
      return this.roots();
    }
    try {
      return await this.children(n);
    } catch (err) {
      return [errorNode(n.connection, err)];
    }
  }

  private async roots(): Promise<ObjectsNode[]> {
    const name = this.connection();
    if (!name) {
      return [{ kind: 'message', connection: '', text: 'Connect to see objects' }];
    }
    const qap = this.sessions.status(name).system?.qap;
    if (qap !== undefined && qap < QAP_DEVELOP) {
      return [{ kind: 'message', connection: name, text: QAP_UNAVAILABLE_TEXT, detail: `QAP v${qap}` }];
    }
    let libraries: ObjectsNode[];
    try {
      libraries = libraryNodes(name, await this.libraryList.list(name));
    } catch (err) {
      const line = errorNode(name, err);
      if (qapUnavailable(err) !== undefined) {
        return [line];
      }
      libraries = [line];
    }
    return [...libraries, { kind: 'filters', connection: name }];
  }

  private async children(n: ObjectsNode): Promise<ObjectsNode[]> {
    const connection = n.connection;
    switch (n.kind) {
      case 'library':
        return typeNodes(connection, n.library);
      case 'filters':
        return (this.store.get(connection)?.filters ?? []).map((filter) => ({ kind: 'filter' as const, connection, filter }));
      case 'filter': {
        const f = n.filter;
        return this.objects(connection, f.library, f.object, typesFor(f.type), f.attribute);
      }
      case 'type':
        return this.objects(connection, n.library, '*ALL', typesFor(n.type));
      case 'object': {
        if (!isSourceFile(n.entry)) {
          return [];
        }
        const { library, object: file } = n.entry;
        const members = await this.sessions.call(connection, 'member.list', { name: connection, library, file });
        return members.map((entry) => ({ kind: 'member' as const, connection, library, file, entry }));
      }
      default:
        return [];
    }
  }

  private async objects(
    connection: string,
    library: string,
    pattern: string,
    types: string[],
    attribute?: string,
  ): Promise<ObjectsNode[]> {
    const params = { name: connection, library, pattern, types, ...(attribute ? { attribute } : {}) };
    const entries = await this.sessions.call(connection, 'object.list', params);
    if (entries.length === 0) {
      return [{ kind: 'message', connection, text: 'No objects' }];
    }
    return entries.map((entry) => ({ kind: 'object' as const, connection, entry }));
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.changed.dispose();
  }
}
