// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The SQL view: the active connection's schemas (filtered by a pattern
 * saved per connection, default `%`), each with Tables, Views, Aliases,
 * Physical files, Logical files, Procedures and Functions; a table, view,
 * alias or file has Columns and Indexes. Every list is read from the host
 * when its node opens; nothing is cached. The context menus run View
 * data, Generate SELECT and INSERT, and copy names and `CALL`s.
 */

import * as vscode from 'vscode';
import { errorText, showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import type { SqlColumn, SqlIndex, SqlRoutine, SqlTable, SqlTableKind } from '../host/protocol';
import { typeLabel } from '../sql/format';
import { callText, insertText, parametersQuery, qualified, selectText, viewDataText } from '../sql/generate';
import type { SqlRunner } from '../sql/run';
import type { SqlSessions } from '../sql/session';
import { isSignedOn } from './connections';

/** Workspace state key of each connection's schema pattern. */
export const SCHEMA_FILTER_KEY = 'code-for-qs400.sql.schemaFilter';

/** The QAP version the view needs: `Sql`. */
export const QAP_SQL = 4;

/** A schema's groups, in order. */
export const GROUPS: readonly { group: Group; label: string; icon: string }[] = [
  { group: 'table', label: 'Tables', icon: 'table' },
  { group: 'view', label: 'Views', icon: 'eye' },
  { group: 'alias', label: 'Aliases', icon: 'link' },
  { group: 'physicalFile', label: 'Physical files', icon: 'file-binary' },
  { group: 'logicalFile', label: 'Logical files', icon: 'references' },
  { group: 'procedure', label: 'Procedures', icon: 'symbol-method' },
  { group: 'function', label: 'Functions', icon: 'symbol-function' },
];

type Group = SqlTableKind | 'procedure' | 'function';

export type SqlNode =
  | { kind: 'message'; connection: string; text: string }
  | { kind: 'schema'; connection: string; schema: string; text: string }
  | { kind: 'group'; connection: string; schema: string; group: Group }
  | { kind: 'table'; connection: string; table: SqlTable }
  | { kind: 'routine'; connection: string; routine: SqlRoutine }
  | { kind: 'columns' | 'indexes'; connection: string; table: SqlTable }
  | { kind: 'column'; connection: string; table: SqlTable; column: SqlColumn }
  | { kind: 'index'; connection: string; index: SqlIndex };

/** A column's tooltip: type, length, scale, nullable and CCSID, as the spec's `Column`. */
export function columnTooltip(c: SqlColumn): string {
  return [
    `${c.name}${c.label && c.label.trim() !== c.name ? ` — ${c.label.trim().replace(/\s{2,}/g, ' ')}` : ''}`,
    `Type: ${c.type}`,
    `Length: ${c.length}`,
    `Scale: ${c.scale}`,
    `Nullable: ${c.nullable ? 'yes' : 'no'}`,
    `CCSID: ${c.ccsid}`,
  ].join('\n');
}

export function sqlTreeItem(n: SqlNode): vscode.TreeItem {
  const C = vscode.TreeItemCollapsibleState.Collapsed;
  const N = vscode.TreeItemCollapsibleState.None;
  switch (n.kind) {
    case 'message': {
      const i = new vscode.TreeItem(n.text, N);
      i.contextValue = 'sql.message';
      i.iconPath = new vscode.ThemeIcon('info');
      return i;
    }
    case 'schema': {
      const i = new vscode.TreeItem(n.schema, C);
      i.description = n.text;
      i.tooltip = n.text ? `${n.schema} — ${n.text}` : n.schema;
      i.iconPath = new vscode.ThemeIcon('database');
      i.contextValue = 'sql.schema';
      return i;
    }
    case 'group': {
      const g = GROUPS.find((x) => x.group === n.group)!;
      const i = new vscode.TreeItem(g.label, C);
      i.iconPath = new vscode.ThemeIcon('folder');
      i.contextValue = `sql.group.${n.group}`;
      i.id = `${n.connection}/${n.schema}/${n.group}`;
      return i;
    }
    case 'table': {
      const g = GROUPS.find((x) => x.group === n.table.kind);
      const i = new vscode.TreeItem(n.table.name, C);
      i.description = n.table.text;
      i.tooltip = `${n.table.schema}.${n.table.name}${n.table.text ? ` — ${n.table.text}` : ''}`;
      i.iconPath = new vscode.ThemeIcon(g?.icon ?? 'table');
      i.contextValue = `sql.table.${n.table.kind}`;
      return i;
    }
    case 'routine': {
      const i = new vscode.TreeItem(n.routine.name, N);
      i.description = n.routine.text;
      i.tooltip = `${n.routine.schema}.${n.routine.name} (specific ${n.routine.specific})${n.routine.text ? ` — ${n.routine.text}` : ''}`;
      i.iconPath = new vscode.ThemeIcon(n.routine.kind === 'function' ? 'symbol-function' : 'symbol-method');
      i.contextValue = `sql.routine.${n.routine.kind}`;
      return i;
    }
    case 'columns':
    case 'indexes': {
      const i = new vscode.TreeItem(n.kind === 'columns' ? 'Columns' : 'Indexes', C);
      i.iconPath = new vscode.ThemeIcon(n.kind === 'columns' ? 'symbol-field' : 'key');
      i.contextValue = `sql.${n.kind}`;
      return i;
    }
    case 'column': {
      const c = n.column;
      const i = new vscode.TreeItem(c.name, N);
      i.description = `${typeLabel(c)}${c.nullable ? '' : ' not null'}`;
      i.tooltip = columnTooltip(c);
      i.iconPath = new vscode.ThemeIcon('symbol-field');
      i.contextValue = 'sql.column';
      return i;
    }
    case 'index': {
      const x = n.index;
      const i = new vscode.TreeItem(x.name, N);
      i.description = `${x.unique ? 'unique · ' : ''}(${x.columns.join(', ')})`;
      i.tooltip = `${x.schema}.${x.name}${x.unique ? ', unique' : ''}\nKey: ${x.columns.join(', ')}`;
      i.iconPath = new vscode.ThemeIcon('key');
      i.contextValue = 'sql.index';
      return i;
    }
  }
}

export class SqlProvider implements vscode.TreeDataProvider<SqlNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SqlNode | undefined>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly workspaceState: vscode.Memento,
  ) {
    this.subscriptions = [
      sessions.onDidChange((s) => {
        if (!s || s.name === this.connection()) {
          this.refresh();
        }
      }),
      store.onDidChange(() => this.refresh()),
    ];
  }

  /** The active connection when it is signed on. */
  connection(): string | undefined {
    const name = this.sessions.active;
    return name && isSignedOn(this.sessions.status(name)) ? name : undefined;
  }

  refresh(node?: SqlNode): void {
    this.changed.fire(node);
  }

  /** The schema pattern saved for `name`; `%` when none. */
  pattern(name: string): string {
    const all = this.workspaceState.get<Record<string, string>>(SCHEMA_FILTER_KEY) ?? {};
    return all[name.toUpperCase()] ?? '%';
  }

  async setPattern(name: string, pattern: string): Promise<void> {
    const all = { ...(this.workspaceState.get<Record<string, string>>(SCHEMA_FILTER_KEY) ?? {}) };
    const p = pattern.trim();
    if (p === '' || p === '%') {
      delete all[name.toUpperCase()];
    } else {
      all[name.toUpperCase()] = p;
    }
    await this.workspaceState.update(SCHEMA_FILTER_KEY, all);
    this.refresh();
  }

  getTreeItem(n: SqlNode): vscode.TreeItem {
    return sqlTreeItem(n);
  }

  async getChildren(n?: SqlNode): Promise<SqlNode[]> {
    try {
      return await (n ? this.children(n) : this.roots());
    } catch (err) {
      return [{ kind: 'message', connection: n?.connection ?? '', text: errorText(err) }];
    }
  }

  private async roots(): Promise<SqlNode[]> {
    const name = this.connection();
    if (!name) {
      return [{ kind: 'message', connection: '', text: 'Connect to see schemas' }];
    }
    const qap = this.sessions.status(name).system?.qap;
    if (qap !== undefined && qap < QAP_SQL) {
      return [{ kind: 'message', connection: name, text: 'QAP version 4 not available on this server' }];
    }
    const schemas = await this.sessions.call(name, 'sql.schemas', { name, pattern: this.pattern(name) });
    if (schemas.length === 0) {
      return [{ kind: 'message', connection: name, text: `No schemas match ${this.pattern(name)}` }];
    }
    return schemas.map((s) => ({ kind: 'schema' as const, connection: name, schema: s.name, text: s.text }));
  }

  private async children(n: SqlNode): Promise<SqlNode[]> {
    const connection = n.connection;
    const none = (what: string): SqlNode[] => [{ kind: 'message', connection, text: `No ${what}` }];
    switch (n.kind) {
      case 'schema':
        return GROUPS.map((g) => ({ kind: 'group' as const, connection, schema: n.schema, group: g.group }));
      case 'group': {
        if (n.group === 'procedure' || n.group === 'function') {
          const r = await this.sessions.call(connection, 'sql.routines', { name: connection, schema: n.schema, kinds: [n.group] });
          return r.length ? r.map((routine) => ({ kind: 'routine' as const, connection, routine })) : none(n.group === 'function' ? 'functions' : 'procedures');
        }
        const t = await this.sessions.call(connection, 'sql.tables', { name: connection, schema: n.schema, kinds: [n.group] });
        const label = GROUPS.find((g) => g.group === n.group)!.label.toLowerCase();
        return t.length ? t.map((table) => ({ kind: 'table' as const, connection, table })) : none(label);
      }
      case 'table':
        return [
          { kind: 'columns', connection, table: n.table },
          { kind: 'indexes', connection, table: n.table },
        ];
      case 'columns': {
        const c = await this.sessions.call(connection, 'sql.columns', { name: connection, schema: n.table.schema, table: n.table.name });
        return c.map((column) => ({ kind: 'column' as const, connection, table: n.table, column }));
      }
      case 'indexes': {
        const x = await this.sessions.call(connection, 'sql.indexes', { name: connection, schema: n.table.schema, table: n.table.name });
        return x.length ? x.map((index) => ({ kind: 'index' as const, connection, index })) : none('indexes');
      }
      default:
        return [];
    }
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.changed.dispose();
  }
}

/** What the SQL view's node commands do, by command suffix. */
export type SqlViewActions = Record<'viewData' | 'generateSelect' | 'generateInsert' | 'copyName' | 'copyCall', (n: SqlNode) => Promise<unknown>>;

export function sqlViewActions(sql: SqlSessions, runner: SqlRunner, sessions: SessionManager): SqlViewActions {
  const naming = (name: string) => sql.cached(name)?.naming ?? 'sql';
  const columnsOf = async (n: Extract<SqlNode, { kind: 'table' }>) =>
    (await sessions.call(n.connection, 'sql.columns', { name: n.connection, schema: n.table.schema, table: n.table.name })).map((c) => c.name);
  return {
    viewData: async (n) => (n.kind === 'table' ? runner.run(n.connection, viewDataText(n.table.schema, n.table.name, naming(n.connection))) : undefined),
    generateSelect: async (n) => {
      if (n.kind !== 'table') {
        return undefined;
      }
      const text = selectText(n.table.schema, n.table.name, await columnsOf(n), naming(n.connection));
      await runner.newEditor(`${text};
`, n.connection);
      return text;
    },
    generateInsert: async (n) => {
      if (n.kind !== 'table') {
        return undefined;
      }
      const text = insertText(n.table.schema, n.table.name, await columnsOf(n), naming(n.connection));
      await runner.newEditor(`${text};
`, n.connection);
      return text;
    },
    copyName: async (n) => {
      const text =
        n.kind === 'table'
          ? qualified(n.table.schema, n.table.name, naming(n.connection))
          : n.kind === 'column'
            ? n.column.name
            : n.kind === 'schema'
              ? n.schema
              : undefined;
      if (text !== undefined) {
        await vscode.env.clipboard.writeText(text);
      }
      return text;
    },
    copyCall: async (n) => {
      if (n.kind !== 'routine') {
        return undefined;
      }
      const r = n.routine;
      const parameters = await routineParameters(sessions, n.connection, r);
      const text = callText(r.schema, r.name, parameters ?? [], r.kind, naming(n.connection));
      await vscode.env.clipboard.writeText(text);
      if (parameters === undefined) {
        void vscode.window.showWarningMessage(`Code for QS/400: the parameters of ${r.schema}.${r.name} could not be read; the CALL copied has none.`);
      }
      return text;
    },
  };
}

/** The SQL view's commands. */
export function registerSqlViewCommands(provider: SqlProvider, sql: SqlSessions, runner: SqlRunner, sessions: SessionManager): vscode.Disposable[] {
  const actions = sqlViewActions(sql, runner, sessions);
  const node = Object.entries(actions).map(([id, f]) =>
    vscode.commands.registerCommand(`code-for-qs400.sql.${id}`, async (n: SqlNode) => {
      try {
        return await f(n);
      } catch (err) {
        void showError(err, n?.connection ?? '');
        return undefined;
      }
    }),
  );
  return [
    ...node,
    vscode.commands.registerCommand('code-for-qs400.sql.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('code-for-qs400.sql.filterSchemas', async () => {
      const name = provider.connection();
      if (!name) {
        return undefined;
      }
      const v = await vscode.window.showInputBox({
        prompt: `Schemas to show on ${name}: an SQL LIKE pattern (% any characters, _ one). Empty for all.`,
        value: provider.pattern(name),
      });
      if (v !== undefined) {
        await provider.setPattern(name, v.toUpperCase());
      }
      return v;
    }),
  ];
}

/** A routine's parameter names from `QSYS2.SYSPARMS`; undefined when they could not be read. */
async function routineParameters(sessions: SessionManager, name: string, r: SqlRoutine): Promise<string[] | undefined> {
  try {
    const res = await sessions.call(name, 'sql.run', { name, sql: parametersQuery(r.schema, r.specific), maxRows: 1000 });
    if (res.cursor !== undefined) {
      await sessions.call(name, 'sql.close', { name, cursor: res.cursor }).catch(() => undefined);
    }
    const at = (res.columns ?? []).findIndex((c) => c.name === 'PARAMETER_NAME');
    if (at < 0) {
      return undefined;
    }
    return (res.rows ?? []).map((row) => (typeof row[at] === 'string' ? row[at] : ''));
  } catch {
    return undefined;
  }
}
