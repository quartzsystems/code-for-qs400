// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * **SQL results**: one webview panel per window, a tab per run, the last
 * 20 kept. Load more is `sql.fetch` of 500 more. Closing a tab closes its
 * cursor (`sql.close`); closing the panel closes every tab's. A tab whose
 * connection lost its SQL connection keeps its rows and loads no more.
 */

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import type { SqlCell, SqlColumn } from '../host/protocol';
import { firstLine, outcomeText, rowCount, typeLabel } from './format';
import { type FromPage, type PageTab, type ToPage, resultsHtml } from './resultsHtml';
import type { SqlRun, SqlRunner } from './run';
import type { SqlSessions } from './session';

/** Tabs kept; the oldest goes past it. */
export const MAX_TABS = 20;
/** Rows Load more asks for. */
export const PAGE = 500;

const NUMERIC = new Set(['SMALLINT', 'INTEGER', 'INT', 'BIGINT', 'DECIMAL', 'NUMERIC', 'DECFLOAT', 'REAL', 'DOUBLE', 'FLOAT']);

export function isNumeric(c: Pick<SqlColumn, 'type'>): boolean {
  return NUMERIC.has(c.type.toUpperCase());
}

/** One run's tab. */
export interface ResultTab {
  id: string;
  n: number;
  run: SqlRun;
  columns: SqlColumn[];
  rows: SqlCell[][];
  /** The cursor has no more rows. */
  end: boolean;
  /** The host's result ID, for `sql.fetch`, `sql.export`, `sql.close`. */
  cursor?: number;
  busy: boolean;
  note?: string;
}

export class ResultPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly tabsList: ResultTab[] = [];
  private active: string | undefined;
  private n = 0;
  private readonly subscriptions: vscode.Disposable[];
  private readonly shown = new vscode.EventEmitter<ResultTab>();
  /** Fires when a tab is added or changes, for tests. */
  readonly onDidChange = this.shown.event;
  /** Export CSV of a tab; set by the export. */
  exporter: ((tab: ResultTab) => Promise<void>) | undefined;

  constructor(
    private readonly sessions: SessionManager,
    runner: SqlRunner,
    sql: SqlSessions,
  ) {
    this.subscriptions = [runner.onDidRun((r) => this.add(r)), sql.onDidLose((name) => this.lost(name))];
  }

  get tabs(): readonly ResultTab[] {
    return this.tabsList;
  }

  get activeTab(): ResultTab | undefined {
    return this.tabsList.find((t) => t.id === this.active);
  }

  /** A tab for `run`, shown. */
  add(run: SqlRun): ResultTab {
    const r = run.result;
    const tab: ResultTab = {
      id: run.id,
      n: ++this.n,
      run,
      columns: r?.columns ?? [],
      rows: r?.rows ?? [],
      end: r?.kind !== 'query' || r.end !== false,
      cursor: r?.cursor,
      busy: false,
    };
    this.tabsList.push(tab);
    while (this.tabsList.length > MAX_TABS) {
      const old = this.tabsList.shift()!;
      void this.closeCursor(old);
    }
    this.active = tab.id;
    this.show();
    this.shown.fire(tab);
    return tab;
  }

  private show(): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'code-for-qs400.sqlResults',
        'SQL results',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
      );
      const nonce = crypto.randomBytes(16).toString('base64');
      this.panel.webview.html = resultsHtml(nonce, this.panel.webview.cspSource);
      this.panel.webview.onDidReceiveMessage((m: FromPage) => void this.receive(m));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        void this.closeAll();
      });
    } else if (!this.panel.visible) {
      this.panel.reveal(undefined, true);
    }
    this.post();
  }

  private post(): void {
    const t = this.activeTab;
    const msg: ToPage = {
      type: 'tabs',
      tabs: this.tabsList.map((x) => ({ id: x.id, title: this.title(x), kind: this.kind(x) })),
      active: t ? this.page(t) : undefined,
    };
    void this.panel?.webview.postMessage(msg);
  }

  private kind(t: ResultTab): PageTab['kind'] {
    return t.run.error ? 'error' : (t.run.result?.kind ?? 'ddl');
  }

  private title(t: ResultTab): string {
    return `${t.n} · ${firstLine(t.run.sql, 40)}`;
  }

  private summary(t: ResultTab): string {
    if (t.run.error) {
      return t.run.error.data?.messageId ?? 'failed';
    }
    const r = t.run.result!;
    return r.kind === 'query' ? rowCount(t.rows.length, t.end) : outcomeText(r);
  }

  /** What the page draws of `t`. */
  page(t: ResultTab): PageTab {
    const r = t.run.result;
    const e = t.run.error;
    return {
      id: t.id,
      title: this.title(t),
      connection: t.run.connection,
      sql: t.run.sql,
      kind: this.kind(t),
      summary: this.summary(t),
      columns: t.columns.map((c) => ({ name: c.name, label: c.label, type: typeLabel(c), nullable: c.nullable, numeric: isNumeric(c) })),
      rows: t.rows,
      more: !t.end && t.cursor !== undefined && !t.note,
      busy: t.busy,
      exportable: this.exporter !== undefined && r?.kind === 'query' && t.cursor !== undefined,
      note: t.note ?? (r?.cancelled ? 'Cancelled' : undefined),
      elapsed: t.run.elapsed,
      messages: (r?.messages ?? []).map((m) => ({ id: m.id, text: m.text, secondLevel: m.secondLevel })),
      error: e
        ? { messageId: e.data?.messageId, text: e.data?.text ?? e.message, secondLevel: e.data?.secondLevel, sqlstate: e.data?.sqlstate, sqlcode: e.data?.sqlcode }
        : undefined,
    };
  }

  /** Changed rows or state of `t`, to the page. */
  refresh(t: ResultTab, added: SqlCell[][] = []): void {
    if (t.id === this.active) {
      const p = this.page(t);
      const msg: ToPage = { type: 'rows', id: t.id, rows: added, more: p.more, summary: p.summary, note: p.note, busy: t.busy };
      void this.panel?.webview.postMessage(msg);
    }
    this.shown.fire(t);
  }

  private async receive(m: FromPage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.post();
        return;
      case 'select':
        this.active = m.id;
        this.post();
        return;
      case 'close':
        await this.closeTab(m.id);
        return;
      case 'more':
        await this.loadMore(m.id);
        return;
      case 'export': {
        const t = this.tabsList.find((x) => x.id === m.id);
        if (t && this.exporter) {
          await this.exporter(t);
        }
        return;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        return;
    }
  }

  /** Load more: 500 more rows of `id`'s cursor. */
  async loadMore(id: string): Promise<number> {
    const t = this.tabsList.find((x) => x.id === id);
    if (!t || t.end || t.cursor === undefined || t.busy || t.note) {
      return 0;
    }
    t.busy = true;
    this.refresh(t);
    try {
      const f = await this.sessions.call(t.run.connection, 'sql.fetch', { name: t.run.connection, cursor: t.cursor, maxRows: PAGE });
      t.rows.push(...f.rows);
      t.end = f.end;
      t.busy = false;
      this.refresh(t, f.rows);
      return f.rows.length;
    } catch (err) {
      t.busy = false;
      t.note = err instanceof Error ? err.message : String(err);
      this.refresh(t);
      void showError(err, t.run.connection);
      return 0;
    }
  }

  async closeTab(id: string): Promise<void> {
    const i = this.tabsList.findIndex((x) => x.id === id);
    if (i < 0) {
      return;
    }
    const [t] = this.tabsList.splice(i, 1);
    if (this.active === id) {
      this.active = this.tabsList[Math.min(i, this.tabsList.length - 1)]?.id;
    }
    this.post();
    await this.closeCursor(t);
  }

  private async closeCursor(t: ResultTab): Promise<void> {
    if (t.cursor === undefined) {
      return;
    }
    const cursor = t.cursor;
    t.cursor = undefined;
    try {
      await this.sessions.call(t.run.connection, 'sql.close', { name: t.run.connection, cursor });
    } catch {
      // The session or its connection is gone, and the cursor with it.
    }
  }

  private async closeAll(): Promise<void> {
    const all = this.tabsList.splice(0);
    this.active = undefined;
    await Promise.all(all.map((t) => this.closeCursor(t)));
  }

  private lost(name: string): void {
    for (const t of this.tabsList) {
      if (t.run.connection === name && !t.end) {
        t.note = 'The SQL connection was lost: no more rows. Run the statement again.';
        this.refresh(t);
      }
    }
  }

  /** Closes the panel, which closes every cursor. */
  close(): void {
    this.panel?.dispose();
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.panel?.dispose();
    this.shown.dispose();
  }
}
