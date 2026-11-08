// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * SQL per connection: which connection each SQL document runs on, the
 * session's options (commit level, naming, default schema) as the host
 * holds them, whether changes wait for a commit, the status bar item and
 * its quick pick, Commit and Rollback, the question before a disconnect
 * with uncommitted work, and the warning when the host says the SQL
 * connection was lost.
 */

import * as vscode from 'vscode';
import { sameName } from '../connections/config';
import { showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { HostClient } from '../host/client';
import type { SqlCommit, SqlNaming, SqlOptions } from '../host/protocol';
import { parseIfsUri } from '../ifs/uri';
import { parseMemberUri } from '../members/uri';
import { COMMIT_LEVELS, commitLabel, namingLabel, statusText } from './format';

/** The languages Run Statement takes: QS/400's SQL, and VS Code's for local `.sql` files. */
export const SQL_LANGUAGES: ReadonlySet<string> = new Set(['qs400-sql', 'sql']);

export function isSqlDocument(doc: vscode.TextDocument): boolean {
  return SQL_LANGUAGES.has(doc.languageId);
}

/** A member's or stream file's own connection; undefined for any other document. */
export function ownConnection(uri: vscode.Uri): string | undefined {
  return parseMemberUri(uri)?.connection ?? parseIfsUri(uri)?.connection;
}

export class SqlSessions implements vscode.Disposable {
  /** The connection each document runs on, by URI, when it is not its own or the active one. */
  private readonly bindings = new Map<string, string>();
  private readonly options = new Map<string, SqlOptions>();
  private readonly changed = new vscode.EventEmitter<string>();
  private readonly lostEmitter = new vscode.EventEmitter<string>();
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[];

  /** Fires with a connection's name when its options or uncommitted state change. */
  readonly onDidChange = this.changed.event;
  /** Fires with a connection's name when its SQL connection, and every open cursor, was lost. */
  readonly onDidLose = this.lostEmitter.event;

  constructor(
    private readonly host: HostClient,
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {
    this.item = vscode.window.createStatusBarItem('code-for-qs400.sql', vscode.StatusBarAlignment.Left, 0.5);
    this.item.name = 'QS/400 SQL';
    this.item.command = 'code-for-qs400.sql.options';
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      vscode.workspace.onDidOpenTextDocument(() => this.render()),
      sessions.onDidChange((s) => {
        if (s && s.state === 'disconnected') {
          this.options.delete(s.name);
        }
        this.render();
      }),
      this.changed.event(() => this.render()),
      host.onDidLoseSql((l) => this.lost(l.name, l.message)),
      sessions.addDisconnectGuard((name) => this.confirmDisconnect(name)),
      vscode.workspace.onDidCloseTextDocument((d) => this.bindings.delete(d.uri.toString())),
    ];
    this.render();
  }

  /** The connection `doc` runs on: its binding, else its own, else the active connection. */
  connectionOf(doc: vscode.TextDocument | vscode.Uri): string | undefined {
    const uri = doc instanceof vscode.Uri ? doc : doc.uri;
    const bound = this.bindings.get(uri.toString());
    const own = ownConnection(uri);
    const name = bound ?? own ?? this.sessions.active;
    return name ? (this.store.get(name)?.name ?? name) : undefined;
  }

  bind(doc: vscode.TextDocument | vscode.Uri, connection: string): void {
    const uri = doc instanceof vscode.Uri ? doc : doc.uri;
    this.bindings.set(uri.toString(), connection);
    this.render();
  }

  /** The options last read for `name`, if any. */
  cached(name: string): SqlOptions | undefined {
    return this.options.get(name);
  }

  /** `sql.options.get`, kept. */
  async read(name: string): Promise<SqlOptions> {
    const o = await this.host.request('sql.options.get', { name });
    this.remember(name, o);
    return o;
  }

  /** A result's `uncommitted`, kept beside the options. */
  noteUncommitted(name: string, uncommitted: boolean): void {
    const o = this.options.get(name);
    if (o && o.uncommitted !== uncommitted) {
      this.remember(name, { ...o, uncommitted });
    } else if (!o) {
      void this.read(name).catch(() => undefined);
    }
  }

  private remember(name: string, o: SqlOptions): void {
    this.options.set(name, o);
    this.changed.fire(name);
  }

  async set(name: string, change: { commit?: SqlCommit; naming?: SqlNaming; defaultSchema?: string }): Promise<SqlOptions> {
    const o = await this.sessions.call(name, 'sql.options.set', { name, ...change });
    this.remember(name, o);
    return o;
  }

  async commit(name: string): Promise<SqlOptions> {
    const o = await this.sessions.call(name, 'sql.commit', { name });
    this.remember(name, o);
    return o;
  }

  async rollback(name: string): Promise<SqlOptions> {
    const o = await this.sessions.call(name, 'sql.rollback', { name });
    this.remember(name, o);
    return o;
  }

  private lost(name: string, message: string): void {
    const o = this.options.get(name);
    if (o) {
      this.remember(name, { ...o, uncommitted: false });
    }
    this.lostEmitter.fire(name);
    void vscode.window.showWarningMessage(`Code for QS/400: ${message}.`);
  }

  /** Before a disconnect: with uncommitted changes, commit, roll back, or stay. */
  private async confirmDisconnect(name: string): Promise<boolean> {
    let o: SqlOptions;
    try {
      o = await this.read(name);
    } catch {
      return true;
    }
    if (!o.uncommitted) {
      return true;
    }
    const COMMIT = 'Commit and Disconnect';
    const ROLLBACK = 'Roll Back and Disconnect';
    const picked = await vscode.window.showWarningMessage(
      `${name} has uncommitted SQL changes. Disconnecting rolls them back.`,
      { modal: true },
      COMMIT,
      ROLLBACK,
    );
    if (picked === COMMIT) {
      try {
        await this.commit(name);
      } catch (err) {
        void showError(err, name);
        return false;
      }
      return true;
    }
    return picked === ROLLBACK;
  }

  /** The SQL document in the active editor, and the connection it runs on. */
  private activeSql(): { doc: vscode.TextDocument; name: string | undefined } | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    return doc && isSqlDocument(doc) ? { doc, name: this.connectionOf(doc) } : undefined;
  }

  render(): void {
    const a = this.activeSql();
    if (!a) {
      this.item.hide();
      return;
    }
    if (!a.name) {
      this.item.text = '$(database) No connection';
      this.item.tooltip = 'Click to pick the connection this SQL runs on.';
      this.item.show();
      return;
    }
    const o = this.options.get(a.name);
    const st = this.sessions.status(a.name).state;
    if (!o && (st === 'connected' || st === 'stale')) {
      void this.read(a.name).catch(() => undefined);
    }
    this.item.text = statusText(a.name, o);
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`SQL runs on **${a.name}**`);
    if (o) {
      tip.appendMarkdown(`\n\nNaming ${namingLabel(o.naming)} · commit level ${commitLabel(o.commit)}`);
      tip.appendMarkdown(`\n\nDefault schema: ${o.defaultSchema ?? 'none'}`);
      if (o.uncommitted) {
        tip.appendMarkdown('\n\nChanges are uncommitted: commit or roll back.');
      }
    }
    tip.appendMarkdown('\n\nClick for the connection, commit level, naming and default schema.');
    this.item.tooltip = tip;
    this.item.show();
  }

  /** What the status bar item shows now, for tests. */
  get text(): string | undefined {
    return this.item.text === '' ? undefined : this.item.text;
  }

  /** The status bar's quick pick. Returns what was done, for tests. */
  async pickOptions(): Promise<string | undefined> {
    const a = this.activeSql();
    const name = a?.name ?? this.sessions.active;
    type Item = vscode.QuickPickItem & { act: string };
    const items: Item[] = [];
    if (a) {
      items.push({ label: '$(plug) Connection', description: name ?? 'none', act: 'connection' });
    }
    let o: SqlOptions | undefined;
    if (name) {
      try {
        o = await this.read(name);
      } catch {
        o = this.options.get(name);
      }
      items.push(
        { label: '$(lock) Commit level', description: o ? commitLabel(o.commit) : '', act: 'commit' },
        { label: '$(symbol-namespace) Naming', description: o ? namingLabel(o.naming) : '', act: 'naming' },
        { label: '$(database) Default schema', description: o?.defaultSchema ?? 'none', act: 'schema' },
      );
      if (o && o.commit !== 'none') {
        items.push(
          { label: '$(check) Commit', description: o.uncommitted ? 'changes are uncommitted' : '', act: 'doCommit' },
          { label: '$(discard) Rollback', act: 'doRollback' },
        );
      }
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: name ? `SQL on ${name}` : 'SQL' });
    if (!picked) {
      return undefined;
    }
    try {
      switch (picked.act) {
        case 'connection':
          return a ? await this.pickConnection(a.doc) : undefined;
        case 'commit':
          return name ? await this.pickCommit(name) : undefined;
        case 'naming':
          return name ? await this.pickNaming(name, o) : undefined;
        case 'schema':
          return name ? await this.askSchema(name, o) : undefined;
        case 'doCommit':
          if (name) {
            await this.commit(name);
          }
          return 'commit';
        case 'doRollback':
          if (name) {
            await this.rollback(name);
          }
          return 'rollback';
      }
    } catch (err) {
      void showError(err, name ?? '');
    }
    return undefined;
  }

  async pickConnection(doc: vscode.TextDocument | vscode.Uri): Promise<string | undefined> {
    const current = this.connectionOf(doc);
    const items = this.store.list().map((c) => ({
      label: c.name,
      description: `${c.user}@${c.host}${current && sameName(current, c.name) ? ' · current' : ''}`,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Connection this SQL runs on' });
    if (!picked) {
      return undefined;
    }
    this.bind(doc, picked.label);
    return picked.label;
  }

  private async pickCommit(name: string): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(
      COMMIT_LEVELS.map((l) => ({ label: l.label, description: l.detail, commit: l.commit })),
      { placeHolder: `Commit level on ${name}` },
    );
    if (!picked) {
      return undefined;
    }
    await this.set(name, { commit: picked.commit });
    return picked.commit;
  }

  private async pickNaming(name: string, o: SqlOptions | undefined): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(
      [
        { label: '*SQL', description: 'schema.table', naming: 'sql' as const, picked: o?.naming === 'sql' },
        { label: '*SYS', description: 'library/file', naming: 'system' as const, picked: o?.naming === 'system' },
      ],
      { placeHolder: `Naming on ${name}` },
    );
    if (!picked) {
      return undefined;
    }
    await this.set(name, { naming: picked.naming });
    return picked.naming;
  }

  private async askSchema(name: string, o: SqlOptions | undefined): Promise<string | undefined> {
    const v = await vscode.window.showInputBox({
      prompt: `Default schema on ${name}: unqualified names are found there. Empty for none.`,
      value: o?.defaultSchema ?? '',
    });
    if (v === undefined) {
      return undefined;
    }
    await this.set(name, { defaultSchema: v.trim().toUpperCase() });
    return v.trim().toUpperCase();
  }

  register(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('code-for-qs400.sql.options', () => this.pickOptions()),
      vscode.commands.registerCommand('code-for-qs400.sql.commit', async () => this.unit(true)),
      vscode.commands.registerCommand('code-for-qs400.sql.rollback', async () => this.unit(false)),
      vscode.commands.registerCommand('code-for-qs400.sql.changeConnection', async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        return target ? this.pickConnection(target) : undefined;
      }),
    ];
  }

  private async unit(commit: boolean): Promise<SqlOptions | undefined> {
    const name = this.activeSql()?.name ?? this.sessions.active;
    if (!name) {
      void vscode.window.showErrorMessage('Code for QS/400: no connection to commit or roll back.');
      return undefined;
    }
    try {
      const o = await (commit ? this.commit(name) : this.rollback(name));
      vscode.window.setStatusBarMessage(`${name}: ${commit ? 'committed' : 'rolled back'}`, 4000);
      return o;
    } catch (err) {
      void showError(err, name);
      return undefined;
    }
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.item.dispose();
    this.changed.dispose();
    this.lostEmitter.dispose();
  }
}
