// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * Statement history: per connection, in workspace state, the last 50
 * runs, newest first, each with its statement, time, kind, row or updated
 * count and outcome. Never a result's rows. **SQL History** picks one to
 * run again, open in a new SQL editor, or save to a local file.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SessionManager } from '../connections/sessions';
import { firstLine } from './format';
import type { SqlRun, SqlRunner } from './run';
import type { SqlSessions } from './session';

/** Workspace state key: connection name (upper case) → entries, newest first. */
export const HISTORY_KEY = 'code-for-qs400.sqlHistory';
export const HISTORY_CAP = 50;

export interface HistoryEntry {
  sql: string;
  /** Milliseconds since 1970. */
  time: number;
  kind: 'query' | 'update' | 'ddl' | 'error';
  /** A query's rows shown, or an update's rows changed. */
  count?: number;
  /** A query had more rows than shown. */
  more?: boolean;
  outcome: 'ok' | 'error' | 'cancelled';
  /** The error's message ID. */
  messageId?: string;
}

/** What a run leaves in the history. */
export function entryOf(run: SqlRun): HistoryEntry {
  const r = run.result;
  if (!r) {
    return { sql: run.sql, time: run.started, kind: 'error', outcome: 'error', messageId: run.error?.data?.messageId };
  }
  const e: HistoryEntry = { sql: run.sql, time: run.started, kind: r.kind, outcome: r.cancelled ? 'cancelled' : 'ok' };
  if (r.kind === 'query') {
    e.count = r.rows?.length ?? 0;
    e.more = r.end === false;
  } else if (r.kind === 'update') {
    e.count = r.updated ?? 0;
  }
  return e;
}

/** `entries` with `e` first, at most `cap`. */
export function added(entries: readonly HistoryEntry[], e: HistoryEntry, cap = HISTORY_CAP): HistoryEntry[] {
  return [e, ...entries].slice(0, cap);
}

/** `2026-11-08 12:34:56 · 12 rows`, `· 0 rows updated`, `· SQL0104`. */
export function entryDescription(e: HistoryEntry): string {
  const d = new Date(e.time);
  const p = (n: number) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  let what: string;
  if (e.outcome === 'error') {
    what = e.messageId ?? 'failed';
  } else if (e.kind === 'query') {
    what = `${e.count ?? 0}${e.more ? '+' : ''} ${e.count === 1 && !e.more ? 'row' : 'rows'}`;
  } else if (e.kind === 'update') {
    what = `${e.count ?? 0} ${e.count === 1 ? 'row' : 'rows'} updated`;
  } else {
    what = 'ran';
  }
  return `${when} · ${what}${e.outcome === 'cancelled' ? ' · cancelled' : ''}`;
}

export class SqlHistory implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly runner: SqlRunner,
    private readonly sql: SqlSessions,
    private readonly sessions: SessionManager,
  ) {
    this.subscription = runner.onDidRun((r) => void this.add(r.connection, entryOf(r)));
  }

  private all(): Record<string, HistoryEntry[]> {
    return this.workspaceState.get<Record<string, HistoryEntry[]>>(HISTORY_KEY) ?? {};
  }

  /** `name`'s entries, newest first. */
  entries(name: string): HistoryEntry[] {
    return this.all()[name.toUpperCase()] ?? [];
  }

  async add(name: string, e: HistoryEntry): Promise<void> {
    const all = { ...this.all() };
    all[name.toUpperCase()] = added(all[name.toUpperCase()] ?? [], e);
    await this.workspaceState.update(HISTORY_KEY, all);
  }

  /** The connection History is for: the active SQL editor's, else the active one. */
  private connection(): string | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    return (doc && this.sql.connectionOf(doc)) ?? this.sessions.active;
  }

  /** Runs `e` again on `name`. */
  rerun(name: string, e: HistoryEntry): Promise<SqlRun> {
    return this.runner.run(name, e.sql);
  }

  /** Opens `e` in a new SQL editor on `name`. */
  async open(name: string, e: HistoryEntry): Promise<vscode.TextEditor> {
    return this.runner.newEditor(`${e.sql};\n`, name);
  }

  /** Writes `e` to `file`. */
  async save(e: HistoryEntry, file: string): Promise<void> {
    await fs.writeFile(file, `${e.sql};\n`, 'utf8');
  }

  /** SQL History: pick an entry, then what to do with it. */
  async pick(): Promise<unknown> {
    const name = this.connection();
    if (!name) {
      void vscode.window.showInformationMessage('Code for QS/400: no connection for SQL History.');
      return undefined;
    }
    const entries = this.entries(name);
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(`Code for QS/400: no SQL has run on ${name} in this workspace yet.`);
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      entries.map((e) => ({ label: firstLine(e.sql), description: entryDescription(e), detail: e.sql.includes('\n') ? e.sql.replace(/\s+/g, ' ') : undefined, e })),
      { placeHolder: `SQL History on ${name}`, matchOnDescription: true, matchOnDetail: true },
    );
    if (!picked) {
      return undefined;
    }
    const act = await vscode.window.showQuickPick(
      [
        { label: '$(play) Run Again', act: 'rerun' },
        { label: '$(new-file) Open in Editor', act: 'open' },
        { label: '$(save) Save to File…', act: 'save' },
      ],
      { placeHolder: firstLine(picked.e.sql) },
    );
    switch (act?.act) {
      case 'rerun':
        return this.rerun(name, picked.e);
      case 'open':
        return this.open(name, picked.e);
      case 'save': {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const to = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(folder, 'statement.sql')), filters: { SQL: ['sql'] } });
        if (to) {
          await this.save(picked.e, to.fsPath);
        }
        return to?.fsPath;
      }
    }
    return undefined;
  }

  register(): vscode.Disposable[] {
    return [vscode.commands.registerCommand('code-for-qs400.sql.history', () => this.pick())];
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
