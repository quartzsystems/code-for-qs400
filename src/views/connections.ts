// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { ConnectionConfig, sameName } from '../connections/config';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { SessionJob, SessionStatus } from '../host/protocol';

/** `nnnnnn/USER/NAME`. */
export function qualifiedJob(job: SessionJob): string {
  return `${job.number}/${job.user}/${job.name}`;
}

/** Whether the session is signed on: connected, or stale until the next call. */
export function isSignedOn(s: SessionStatus): boolean {
  return s.state === 'connected' || s.state === 'stale';
}

const STATE_ICON: Record<SessionStatus['state'], vscode.ThemeIcon> = {
  connected: new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('testing.iconPassed')),
  connecting: new vscode.ThemeIcon('loading~spin'),
  stale: new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('list.warningForeground')),
  disconnected: new vscode.ThemeIcon('vm-outline'),
};

const STATE_TEXT: Record<SessionStatus['state'], string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  stale: 'Connection closed by the server; it reconnects on the next request',
  disconnected: 'Not connected',
};

/** A connection at the root of the view. */
export class ConnectionItem extends vscode.TreeItem {
  readonly kind = 'connection';

  constructor(
    readonly connectionName: string,
    item: vscode.TreeItem,
  ) {
    super(item.label ?? connectionName, item.collapsibleState);
    Object.assign(this, item);
  }
}

/** A child of a signed-on connection, or a line under one. */
export class DetailItem extends vscode.TreeItem {
  constructor(
    readonly kind: 'libraryList' | 'library' | 'system' | 'info',
    readonly connectionName: string,
    item: vscode.TreeItem,
    /** For a library: its place in the user part, or -1 for the current library. */
    readonly index = 0,
    readonly library?: string,
  ) {
    super(item.label ?? '', item.collapsibleState);
    Object.assign(this, item);
  }
}

export type ConnectionNode = ConnectionItem | DetailItem;

export interface ConnectionMarks {
  isDefault: boolean;
  isActive: boolean;
}

/** The root item of a connection, from its settings and its session's status. */
export function connectionTreeItem(c: ConnectionConfig, s: SessionStatus, marks: ConnectionMarks): vscode.TreeItem {
  const signedOn = isSignedOn(s);
  const item = new vscode.TreeItem(
    c.name,
    signedOn ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
  );
  // The id changes with signed-on, so the node opens when a session starts.
  item.id = `connection:${c.name}:${signedOn ? 'on' : 'off'}`;
  item.description = `${c.user}@${c.host}`;
  item.iconPath = STATE_ICON[s.state];
  item.contextValue = `connection.${s.state}${marks.isDefault ? '.default' : ''}`;
  const tip = new vscode.MarkdownString(undefined, true);
  tip.appendMarkdown(`**${c.name}**${marks.isDefault ? ' (default)' : ''}${marks.isActive ? ' · active' : ''}\n\n`);
  tip.appendMarkdown(`${c.user}@${c.host}${c.port !== undefined ? `:${c.port}` : ''}\n\n`);
  tip.appendMarkdown(`${STATE_TEXT[s.state]}`);
  if (signedOn && s.job) {
    tip.appendMarkdown(`\n\nSession job ${qualifiedJob(s.job)}`);
  }
  if (signedOn && s.system) {
    tip.appendMarkdown(`\n\n${s.system.name} ${s.system.version}`);
  }
  item.tooltip = tip;
  if (s.state === 'disconnected') {
    item.command = { command: 'code-for-qs400.connection.connect', title: 'Connect', arguments: [c.name] };
  }
  return item;
}

/** The System node of a signed-on session. */
export function systemTreeItem(s: SessionStatus): vscode.TreeItem {
  const item = new vscode.TreeItem('System', vscode.TreeItemCollapsibleState.Collapsed);
  item.iconPath = new vscode.ThemeIcon('server');
  item.contextValue = 'system';
  if (s.system) {
    item.description = `${s.system.product} ${s.system.version}`;
  }
  return item;
}

/** The lines under System: product and version, serial if present, session job. */
export function systemLines(s: SessionStatus): vscode.TreeItem[] {
  const line = (label: string, value: string, icon: string) => {
    const i = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    i.description = value;
    i.tooltip = `${label}: ${value}`;
    i.iconPath = new vscode.ThemeIcon(icon);
    i.contextValue = 'info';
    return i;
  };
  const out: vscode.TreeItem[] = [];
  if (s.system) {
    out.push(line('Name', s.system.name, 'device-desktop'));
    out.push(line('Product', s.system.product, 'package'));
    out.push(line('Version', s.system.version, 'versions'));
    if (s.system.serial) {
      out.push(line('Serial', s.system.serial, 'symbol-number'));
    }
    if (s.system.model) {
      out.push(line('Model', s.system.model, 'chip'));
    }
  }
  if (s.job) {
    out.push(line('Session job', qualifiedJob(s.job), 'gear'));
  }
  if (s.system) {
    out.push(line('QAP', `version ${s.system.qap}`, 'plug'));
  }
  return out;
}

/** What the Library list node shows, supplied by the library list code. */
export interface LibraryListSource {
  /** The node itself. */
  node(name: string): vscode.TreeItem;
  /** Its children. */
  children(name: string): Promise<ConnectionNode[]>;
  readonly onDidChange: vscode.Event<string | undefined>;
}

/** The Connections view. */
export class ConnectionsProvider implements vscode.TreeDataProvider<ConnectionNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ConnectionNode | undefined>();
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly libraryList?: LibraryListSource,
  ) {
    this.subscriptions.push(
      store.onDidChange(() => this.refresh()),
      sessions.onDidChange(() => this.refresh()),
    );
    if (libraryList) {
      this.subscriptions.push(libraryList.onDidChange(() => this.refresh()));
    }
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: ConnectionNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ConnectionNode): Promise<ConnectionNode[]> {
    if (!element) {
      const active = this.sessions.active;
      const def = this.store.defaultName();
      return this.store.list().map(
        (c) =>
          new ConnectionItem(
            c.name,
            connectionTreeItem(c, this.sessions.status(c.name), {
              isDefault: def !== undefined && sameName(def, c.name),
              isActive: active !== undefined && sameName(active, c.name),
            }),
          ),
      );
    }
    const s = this.sessions.status(element.connectionName);
    if (element.kind === 'connection') {
      if (!isSignedOn(s)) {
        return [];
      }
      const out: ConnectionNode[] = [];
      if (this.libraryList) {
        out.push(new DetailItem('libraryList', element.connectionName, this.libraryList.node(element.connectionName)));
      }
      out.push(new DetailItem('system', element.connectionName, systemTreeItem(s)));
      return out;
    }
    if (element.kind === 'system') {
      return systemLines(s).map((i) => new DetailItem('info', element.connectionName, i));
    }
    if (element.kind === 'libraryList' && this.libraryList) {
      return this.libraryList.children(element.connectionName);
    }
    return [];
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.changed.dispose();
  }
}
