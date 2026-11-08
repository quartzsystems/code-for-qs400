// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import type { ExtensionApi } from '../src/extension';
import { HostClient, HostRpcError } from '../src/host/client';
import { SessionErrorCodes, SqlErrorCodes, SqlRunResult } from '../src/host/protocol';
import { SQL_STATEMENTS, SqlStatementRange } from '../src/languages/protocol';
import { commitLabel, outcomeText, rowCount, statusText, typeLabel } from '../src/sql/format';
import { Exporter, exportName } from '../src/sql/export';
import { ResultPanel } from '../src/sql/results';
import { HISTORY_CAP, HistoryEntry, SqlHistory, added, entryDescription, entryOf } from '../src/sql/history';
import { SqlRun, SqlRunner } from '../src/sql/run';
import { SqlSessions } from '../src/sql/session';
import { Span, splitStatements, statementAt } from '../src/sql/statements';
import { callText, insertText, parametersQuery, qualified, quoteName, selectText, viewDataText } from '../src/sql/generate';
import { SqlNode, SqlProvider, SqlViewActions, columnTooltip, sqlTreeItem, sqlViewActions } from '../src/views/sql';
import { FakeHost, Memento } from './members.test';

/** Scripts whose strings and comments hold `;`. */
export const FIXTURES: Record<string, string> = {
  strings: "SELECT 'a;b' AS \"x;y\" FROM T;\nUPDATE T SET A = 'it''s; ok' WHERE B = 1;\nVALUES 1",
  comments: '-- one; two\nSELECT 1 FROM T; /* three; four */ SELECT 2 FROM T;\n/* a\n;\nb */\nVALUES 3;\n-- trailing;',
  blank: '\n\n  SELECT *\n    FROM HLINV.ASSETS\n   WHERE COST > 0  ;  \n\n',
  error: 'SELECT * FORM T;\nSELECT 1 FROM T;',
};

function texts(text: string, spans: Span[]): string[] {
  return spans.map((s) => text.slice(s.start, s.end));
}

suite('SQL: statements', () => {
  test('split on ; outside strings and comments, trimmed of blanks and comments', () => {
    assert.deepEqual(texts(FIXTURES.strings, splitStatements(FIXTURES.strings)), [
      "SELECT 'a;b' AS \"x;y\" FROM T",
      "UPDATE T SET A = 'it''s; ok' WHERE B = 1",
      'VALUES 1',
    ]);
    assert.deepEqual(texts(FIXTURES.comments, splitStatements(FIXTURES.comments)), ['SELECT 1 FROM T', 'SELECT 2 FROM T', 'VALUES 3']);
    assert.deepEqual(texts(FIXTURES.blank, splitStatements(FIXTURES.blank)), ['SELECT *\n    FROM HLINV.ASSETS\n   WHERE COST > 0']);
    assert.deepEqual(splitStatements(''), []);
    assert.deepEqual(splitStatements(' ; ;\n-- x'), []);
  });

  test('the statement under the cursor: inside it, or after it on its last line', () => {
    const t = 'SELECT 1 FROM T;   -- note\n\nSELECT 2 FROM T;\n';
    const s = splitStatements(t);
    assert.equal(statementAt(t, s, 0), s[0]);
    assert.equal(statementAt(t, s, 8), s[0]);
    assert.equal(statementAt(t, s, t.indexOf('-- note') + 3), s[0], 'after its ; on the same line');
    assert.equal(statementAt(t, s, t.indexOf('\n\n') + 1), undefined, 'on the blank line between');
    assert.equal(statementAt(t, s, t.indexOf('SELECT 2') + 3), s[1]);
    assert.equal(statementAt(t, s, t.length), undefined);
  });

  test('the SQL server splits every fixture as the editor does', async () => {
    const ext = vscode.extensions.getExtension<ExtensionApi>('quartzsystems.code-for-qs400');
    assert.ok(ext);
    const api = await ext.activate();
    for (const [name, text] of Object.entries(FIXTURES)) {
      const doc = await vscode.workspace.openTextDocument({ language: 'qs400-sql', content: text });
      await vscode.window.showTextDocument(doc);
      let ranges: SqlStatementRange[] | null | undefined = null;
      for (let i = 0; i < 100 && !ranges; i++) {
        ranges = await api.languages.request<SqlStatementRange[] | null>('qs400-sql', SQL_STATEMENTS, { textDocument: { uri: doc.uri.toString() } });
        if (!ranges) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.ok(ranges, `${name}: the server answered`);
      const server = ranges.map((r) => ({
        start: doc.offsetAt(new vscode.Position(r.range.start.line, r.range.start.character)),
        end: doc.offsetAt(new vscode.Position(r.range.end.line, r.range.end.character)),
      }));
      assert.deepEqual(texts(text, server), texts(text, splitStatements(text)), name);
      // And the runner takes the server's.
      assert.deepEqual(await api.sqlRunner.spans(doc), server, name);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });
});

suite('SQL: labels', () => {
  test('types with length and scale, commit levels, the status text, outcomes', () => {
    assert.equal(typeLabel({ type: 'DECIMAL', length: 11, scale: 2 }), 'DECIMAL(11,2)');
    assert.equal(typeLabel({ type: 'VARCHAR', length: 50, scale: 0 }), 'VARCHAR(50)');
    assert.equal(typeLabel({ type: 'TIMESTAMP', length: 26, scale: 6 }), 'TIMESTAMP(6)');
    assert.equal(typeLabel({ type: 'INTEGER', length: 4, scale: 0 }), 'INTEGER');
    assert.equal(commitLabel('readUncommitted'), '*CHG');
    assert.equal(commitLabel('serializable'), '*RR');
    assert.equal(statusText('QSHQ400', { commit: 'none', naming: 'sql', uncommitted: false }), '$(database) QSHQ400 · *SQL · *NONE');
    assert.equal(statusText('QSHQ400', { commit: 'readUncommitted', naming: 'system', uncommitted: true }), '$(database) QSHQ400 · *SYS · *CHG ●');
    assert.equal(rowCount(500, false), '500 of more');
    assert.equal(rowCount(1, true), '1 row');
    const upd: SqlRunResult = { kind: 'update', updated: 0, messages: [], uncommitted: false };
    assert.equal(outcomeText(upd), '0 rows updated');
    assert.equal(outcomeText({ kind: 'ddl', messages: [], uncommitted: false }), 'Statement ran');
  });
});

const SQL0104 = new HostRpcError(SessionErrorCodes.Server, 'SQL0104: Token FORM was not valid. Valid tokens: FROM INTO.', {
  status: 'SqlError',
  messageId: 'SQL0104',
  text: 'Token FORM was not valid. Valid tokens: FROM INTO.',
  secondLevel: 'Cause . . . . . :   A syntax error was detected at token FORM.',
  sqlstate: '42601',
  sqlcode: -104,
});

suite('SQL: Run Statement', () => {
  let parts: vscode.Disposable[] = [];
  let host: FakeHost;
  let runner: SqlRunner;

  setup(async () => {
    await vscode.workspace.getConfiguration('code-for-qs400').update('connections', [{ name: 'QSHQ400', host: 'qshq400.example', user: 'CWELLMAN' }], true);
    const output = vscode.window.createOutputChannel('sql test', { log: true });
    host = new FakeHost((method, params) => {
      if (method === 'sql.options.get') {
        return { commit: 'none', naming: 'sql', uncommitted: false };
      }
      if (method === 'sql.run') {
        const sql = String(params.sql);
        if (sql.includes('FORM')) {
          throw SQL0104;
        }
        return sql.startsWith('UPDATE')
          ? { kind: 'update', updated: 0, messages: [], uncommitted: false }
          : { kind: 'query', columns: [], rows: [[1]], end: true, cursor: 1, messages: [], uncommitted: false };
      }
      return null;
    });
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    sessions.update({ name: 'QSHQ400', state: 'connected', user: 'CWELLMAN' });
    await sessions.setActive('QSHQ400');
    const sql = new SqlSessions(host as unknown as HostClient, store, sessions);
    runner = new SqlRunner(host as unknown as HostClient, store, sessions, sql, async () => null);
    parts = [runner, sql, sessions, store, output, host];
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    parts.forEach((p) => p.dispose());
    await vscode.workspace.getConfiguration('code-for-qs400').update('connections', undefined, true);
  });

  async function editor(text: string, at: number): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument({ language: 'qs400-sql', content: text });
    const e = await vscode.window.showTextDocument(doc);
    e.selection = new vscode.Selection(doc.positionAt(at), doc.positionAt(at));
    return e;
  }

  const sent = () => host.sent.filter((s) => s.method === 'sql.run').map((s) => s.params.sql);

  test('the statement under the cursor, on the active connection', async () => {
    const t = 'SELECT 1 FROM T;\nUPDATE HLINV.ASSETS SET NOTES = NOTES WHERE 1 = 0;\n';
    const e = await editor(t, t.indexOf('UPDATE') + 4);
    const runs = await runner.runEditor(e);
    assert.deepEqual(sent(), ['UPDATE HLINV.ASSETS SET NOTES = NOTES WHERE 1 = 0']);
    assert.equal(runs[0].connection, 'QSHQ400');
    assert.equal(runs[0].line, 1);
    assert.equal(outcomeText(runs[0].result!), '0 rows updated');
    assert.equal(host.sent.find((s) => s.method === 'sql.run')?.params.maxRows, 500);
  });

  test('the selection, split into its statements', async () => {
    const t = 'SELECT 1 FROM T; SELECT 2 FROM T; SELECT 3 FROM T;';
    const e = await editor(t, 0);
    e.selection = new vscode.Selection(e.document.positionAt(t.indexOf('SELECT 2')), e.document.positionAt(t.length));
    await runner.runEditor(e);
    assert.deepEqual(sent(), ['SELECT 2 FROM T', 'SELECT 3 FROM T']);
  });

  test('the whole document from a blank line, stopping at the first error, with a Problems entry on its first line; cleared at the next run', async () => {
    const t = 'SELECT 1 FROM T;\n\nSELECT *\n  FORM T;\n\nSELECT 3 FROM T;';
    const e = await editor(t, t.indexOf('\n\n') + 1);
    const runs = await runner.runEditor(e);
    assert.deepEqual(sent(), ['SELECT 1 FROM T', 'SELECT *\n  FORM T']);
    assert.equal(runs[1].error?.data?.messageId, 'SQL0104');
    const d = runner.diagnostics.get(e.document.uri) ?? [];
    assert.equal(d.length, 1);
    assert.equal(d[0].range.start.line, 2);
    assert.equal(d[0].code, 'SQL0104');
    assert.equal(d[0].message, 'Token FORM was not valid. Valid tokens: FROM INTO.');
    assert.match(d[0].relatedInformation?.[0]?.message ?? '', /syntax error was detected/);
    e.selection = new vscode.Selection(0, 3, 0, 3);
    await runner.runEditor(e);
    assert.equal((runner.diagnostics.get(e.document.uri) ?? []).length, 0);
  });
});

suite('SQL: results', () => {
  let parts: vscode.Disposable[] = [];
  let host: FakeHost;
  let runner: SqlRunner;
  let panel: ResultPanel;
  let sql: SqlSessions;
  let fetched = 0;

  const COLUMNS = [
    { name: 'ASSET_ID', label: 'ASSET_ID', type: 'INTEGER', length: 4, scale: 0, nullable: false, ccsid: 0 },
    { name: 'COST', label: 'Cost', type: 'DECIMAL', length: 11, scale: 2, nullable: true, ccsid: 0 },
  ];
  const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => [from + i, i % 5 === 0 ? null : `${from + i}.50`]);

  setup(async () => {
    await vscode.workspace.getConfiguration('code-for-qs400').update('connections', [{ name: 'QSHQ400', host: 'qshq400.example', user: 'CWELLMAN' }], true);
    const output = vscode.window.createOutputChannel('sql results test', { log: true });
    let cursor = 0;
    fetched = 0;
    host = new FakeHost((method) => {
      switch (method) {
        case 'sql.options.get':
          return { commit: 'none', naming: 'sql', uncommitted: false };
        case 'sql.run':
          return { kind: 'query', columns: COLUMNS, rows: rows(1, 500), end: false, cursor: ++cursor, messages: [], uncommitted: false };
        case 'sql.fetch':
          fetched++;
          return fetched === 1 ? { rows: rows(501, 500), end: false } : { rows: rows(1001, 7), end: true };
        default:
          return null;
      }
    });
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    sessions.update({ name: 'QSHQ400', state: 'connected', user: 'CWELLMAN' });
    await sessions.setActive('QSHQ400');
    sql = new SqlSessions(host as unknown as HostClient, store, sessions);
    runner = new SqlRunner(host as unknown as HostClient, store, sessions, sql, async () => null);
    panel = new ResultPanel(sessions, runner, sql);
    parts = [panel, runner, sql, sessions, store, output, host];
  });

  teardown(async () => {
    parts.forEach((p) => p.dispose());
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.getConfiguration('code-for-qs400').update('connections', undefined, true);
  });

  const closed = () => host.sent.filter((s) => s.method === 'sql.close').map((s) => s.params.cursor);

  test('a tab per run: the header types, 500 of more, Load more to the end', async () => {
    await runner.run('QSHQ400', 'SELECT * FROM HLINV.ASSETS');
    const t = panel.activeTab!;
    const p = panel.page(t);
    assert.deepEqual(p.columns?.map((c) => [c.name, c.type, c.nullable, c.numeric]), [
      ['ASSET_ID', 'INTEGER', false, true],
      ['COST', 'DECIMAL(11,2)', true, true],
    ]);
    assert.equal(p.summary, '500 of more');
    assert.equal(p.more, true);
    assert.deepEqual(p.rows?.[0], [1, null]);
    assert.equal(await panel.loadMore(t.id), 500);
    assert.equal(panel.page(t).summary, '1000 of more');
    assert.equal(await panel.loadMore(t.id), 7);
    const end = panel.page(t);
    assert.equal(end.summary, '1007 rows');
    assert.equal(end.more, false);
    assert.equal(await panel.loadMore(t.id), 0, 'nothing past the end');
    assert.deepEqual(
      host.sent.filter((s) => s.method === 'sql.fetch').map((s) => s.params),
      [
        { name: 'QSHQ400', cursor: 1, maxRows: 500 },
        { name: 'QSHQ400', cursor: 1, maxRows: 500 },
      ],
    );
  });

  test('the last 20 tabs kept; closing a tab or the panel closes cursors', async () => {
    for (let i = 0; i < 21; i++) {
      await runner.run('QSHQ400', `SELECT ${i} FROM T`);
    }
    assert.equal(panel.tabs.length, 20);
    assert.deepEqual(closed(), [1], 'the oldest went');
    await panel.closeTab(panel.tabs[0].id);
    assert.deepEqual(closed(), [1, 2]);
    panel.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed().length, 21);
    assert.equal(panel.tabs.length, 0);
  });

  test('an update has no grid; an error shows its message ID and text', async () => {
    host.answer = (method) =>
      method === 'sql.run' ? { kind: 'update', updated: 0, messages: [], uncommitted: false } : { commit: 'none', naming: 'sql', uncommitted: false };
    await runner.run('QSHQ400', 'UPDATE HLINV.ASSETS SET NOTES = NOTES WHERE 1 = 0');
    const u = panel.page(panel.activeTab!);
    assert.equal(u.kind, 'update');
    assert.equal(u.summary, '0 rows updated');
    assert.deepEqual(u.columns, []);
    host.answer = (method) => {
      if (method === 'sql.run') {
        throw SQL0104;
      }
      return null;
    };
    await runner.run('QSHQ400', 'SELECT * FORM T');
    const e = panel.page(panel.activeTab!);
    assert.equal(e.kind, 'error');
    assert.equal(e.summary, 'SQL0104');
    assert.deepEqual(e.error, {
      messageId: 'SQL0104',
      text: 'Token FORM was not valid. Valid tokens: FROM INTO.',
      secondLevel: 'Cause . . . . . :   A syntax error was detected at token FORM.',
      sqlstate: '42601',
      sqlcode: -104,
    });
  });

  test('Export CSV: the cursor to a file through sql.export; past the rows shown the tab loads no more', async () => {
    assert.equal(exportName('SELECT * FROM HLINV.ASSETS WHERE 1 = 1'), 'ASSETS.csv');
    assert.equal(exportName('select * from hlinv/assets'), 'ASSETS.csv');
    assert.equal(exportName('VALUES 1'), 'result.csv');
    const exporter = new Exporter(host as unknown as HostClient, (panel as unknown as { sessions: SessionManager }).sessions, panel);
    const before = host.answer;
    host.answer = (method, params) => (method === 'sql.export' ? { rows: 1203 } : before(method, params));
    await runner.run('QSHQ400', 'SELECT * FROM HLINV.ASSETS');
    const t = panel.activeTab!;
    assert.equal(panel.page(t).exportable, true);
    assert.equal(await exporter.export(t, panel, '/tmp/assets.csv'), 1203);
    const sent = host.sent.find((s) => s.method === 'sql.export')!.params;
    assert.deepEqual({ ...sent, export: undefined }, { name: 'QSHQ400', cursor: t.cursor, to: '/tmp/assets.csv', format: 'csv', export: undefined });
    const p = panel.page(t);
    assert.equal(p.more, false);
    assert.equal(p.summary, '500 rows');
    assert.match(p.note ?? '', /1203 rows exported to assets\.csv; the 500 shown are kept/);
  });

  test('a cancelled export: no file, and no more rows', async () => {
    const exporter = new Exporter(host as unknown as HostClient, (panel as unknown as { sessions: SessionManager }).sessions, panel);
    const before = host.answer;
    host.answer = (method, params) => {
      if (method === 'sql.export') {
        throw new HostRpcError(SqlErrorCodes.Cancelled, 'x1 cancelled', { id: 'x1', rows: 501 });
      }
      return before(method, params);
    };
    await runner.run('QSHQ400', 'SELECT * FROM HLINV.ASSETS');
    const t = panel.activeTab!;
    assert.equal(await exporter.export(t, panel, '/tmp/a.csv'), undefined);
    assert.equal(panel.page(t).more, false);
    assert.match(panel.page(t).note ?? '', /cancelled/);
  });

  test('a lost SQL connection stops Load more on its tabs', async () => {
    await runner.run('QSHQ400', 'SELECT * FROM HLINV.ASSETS');
    host.sqlLost.fire({ name: 'QSHQ400', message: 'QSHQ400: the SQL connection was lost' });
    const p = panel.page(panel.activeTab!);
    assert.equal(p.more, false);
    assert.match(p.note ?? '', /lost/);
  });
});

suite('SQL: generators', () => {
  test('SELECT, INSERT, CALL and View data, in either naming, odd names delimited', () => {
    assert.equal(quoteName('ASSETS'), 'ASSETS');
    assert.equal(quoteName('Mixed case'), '"Mixed case"');
    assert.equal(quoteName('SAY"HI'), '"SAY""HI"');
    assert.equal(quoteName('1ST'), '"1ST"');
    assert.equal(qualified('HLINV', 'ASSETS'), 'HLINV.ASSETS');
    assert.equal(qualified('HLINV', 'ASSETS', 'system'), 'HLINV/ASSETS');
    assert.equal(selectText('HLINV', 'ASSETS', ['ASSET_ID', 'COST', 'site name']), 'SELECT ASSET_ID,\n       COST,\n       "site name"\n  FROM HLINV.ASSETS');
    assert.equal(insertText('HLINV', 'ASSETS', ['ASSET_ID', 'COST']), 'INSERT INTO HLINV.ASSETS (ASSET_ID, COST)\n  VALUES (?, ?)');
    assert.equal(insertText('HLINV', 'ASSETS', ['A'], 'system'), 'INSERT INTO HLINV/ASSETS (A)\n  VALUES (?)');
    assert.equal(callText('HLINV', 'RETIRE_ASSET', ['ASSET_ID', 'REASON'], 'procedure'), 'CALL HLINV.RETIRE_ASSET(? /* ASSET_ID */, ? /* REASON */)');
    assert.equal(callText('HLINV', 'AGE', ['D'], 'function'), 'VALUES HLINV.AGE(? /* D */)');
    assert.equal(callText('HLINV', 'NOW', [], 'procedure'), 'CALL HLINV.NOW()');
    assert.equal(viewDataText('HLINV', 'ASSETS_BY_SITE'), 'SELECT * FROM HLINV.ASSETS_BY_SITE FETCH FIRST 500 ROWS ONLY');
    assert.equal(
      parametersQuery('HLINV', "O'K"),
      "SELECT * FROM QSYS2.SYSPARMS WHERE SPECIFIC_SCHEMA = 'HLINV' AND SPECIFIC_NAME = 'O''K' AND ROW_TYPE = 'P' ORDER BY 3",
    );
  });
});

suite('SQL: the SQL view', () => {
  let parts: vscode.Disposable[] = [];
  let host: FakeHost;
  let tree: SqlProvider;
  let sessions: SessionManager;
  let actions: SqlViewActions;

  const COLS = [
    { name: 'ASSET_ID', label: 'Asset ID', type: 'INTEGER', length: 4, scale: 0, nullable: false, ccsid: 0 },
    { name: 'SITE', label: 'SITE', type: 'CHAR', length: 10, scale: 0, nullable: true, ccsid: 37 },
  ];
  const SYSTEM = { name: 'QSHQ400', product: 'QS00SS1', version: 'V1R0M0', qap: 9 };

  setup(async () => {
    await vscode.workspace.getConfiguration('code-for-qs400').update('connections', [{ name: 'QSHQ400', host: 'qshq400.example', user: 'CWELLMAN' }], true);
    const output = vscode.window.createOutputChannel('sql view test', { log: true });
    host = new FakeHost((method, params) => {
      switch (method) {
        case 'sql.schemas':
          return [{ name: 'HLINV', text: 'Inventory' }];
        case 'sql.tables':
          return (params.kinds as string[])[0] === 'view' ? [{ schema: 'HLINV', name: 'ASSETS_BY_SITE', kind: 'view', text: 'Assets by site' }] : [];
        case 'sql.columns':
          return COLS;
        case 'sql.indexes':
          return [{ schema: 'HLINV', name: 'ASSETS_PK', unique: true, columns: ['ASSET_ID'] }];
        case 'sql.routines':
          return [{ schema: 'HLINV', name: 'RETIRE_ASSET', specific: 'RETIRE00001', kind: 'procedure', text: '' }];
        case 'sql.run':
          return String(params.sql).includes('SYSPARMS')
            ? {
                kind: 'query',
                columns: [
                  { name: 'SPECIFIC_SCHEMA', label: '', type: 'VARCHAR', length: 128, scale: 0, nullable: false, ccsid: 37 },
                  { name: 'PARAMETER_NAME', label: '', type: 'VARCHAR', length: 128, scale: 0, nullable: true, ccsid: 37 },
                ],
                rows: [
                  ['HLINV', 'ASSET_ID'],
                  ['HLINV', 'REASON'],
                ],
                end: true,
                cursor: 9,
                messages: [],
                uncommitted: false,
              }
            : { kind: 'query', columns: COLS, rows: [], end: true, cursor: 1, messages: [], uncommitted: false };
        case 'sql.options.get':
          return { commit: 'none', naming: 'sql', uncommitted: false };
        default:
          return null;
      }
    });
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const memento = new Memento();
    sessions = new SessionManager(host as unknown as HostClient, store, memento, output);
    sessions.update({ name: 'QSHQ400', state: 'connected', user: 'CWELLMAN', system: SYSTEM });
    await sessions.setActive('QSHQ400');
    tree = new SqlProvider(store, sessions, memento);
    const sql = new SqlSessions(host as unknown as HostClient, store, sessions);
    const runner = new SqlRunner(host as unknown as HostClient, store, sessions, sql, async () => null);
    actions = sqlViewActions(sql, runner, sessions);
    parts = [runner, sql, tree, sessions, store, output, host];
  });

  teardown(async () => {
    parts.forEach((p) => p.dispose());
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.getConfiguration('code-for-qs400').update('connections', undefined, true);
  });

  const labels = (ns: SqlNode[]) => ns.map((n) => String(sqlTreeItem(n).label));

  test('schemas by the saved pattern, their groups, a view, its columns and indexes', async () => {
    const roots = await tree.getChildren();
    assert.deepEqual(labels(roots), ['HLINV']);
    assert.equal(sqlTreeItem(roots[0]).description, 'Inventory');
    assert.equal(host.sent[0].params.pattern, '%');
    await tree.setPattern('QSHQ400', 'HL%');
    await tree.getChildren();
    assert.equal(host.sent.at(-1)?.params.pattern, 'HL%');
    const groups = await tree.getChildren(roots[0]);
    assert.deepEqual(labels(groups), ['Tables', 'Views', 'Aliases', 'Physical files', 'Logical files', 'Procedures', 'Functions']);
    assert.deepEqual(labels(await tree.getChildren(groups[0])), ['No tables']);
    const views = await tree.getChildren(groups[1]);
    assert.deepEqual(host.sent.at(-1)?.params, { name: 'QSHQ400', schema: 'HLINV', kinds: ['view'] });
    assert.equal(sqlTreeItem(views[0]).contextValue, 'sql.table.view');
    assert.equal(sqlTreeItem(views[0]).description, 'Assets by site');
    const [columns, indexes] = await tree.getChildren(views[0]);
    const cols = await tree.getChildren(columns);
    assert.deepEqual(labels(cols), ['ASSET_ID', 'SITE']);
    assert.equal(sqlTreeItem(cols[0]).description, 'INTEGER not null');
    assert.equal(sqlTreeItem(cols[1]).description, 'CHAR(10)');
    assert.equal(sqlTreeItem(cols[1]).tooltip, 'SITE\nType: CHAR\nLength: 10\nScale: 0\nNullable: yes\nCCSID: 37');
    assert.equal(columnTooltip(COLS[0]).split('\n')[0], 'ASSET_ID — Asset ID');
    const idx = await tree.getChildren(indexes);
    assert.equal(sqlTreeItem(idx[0]).description, 'unique · (ASSET_ID)');
    const procs = await tree.getChildren(groups[5]);
    assert.equal(sqlTreeItem(procs[0]).contextValue, 'sql.routine.procedure');
  });

  test('without a session: one line; a QAP 3 server: the version line', async () => {
    sessions.update({ name: 'QSHQ400', state: 'disconnected' });
    assert.deepEqual(labels(await tree.getChildren()), ['Connect to see schemas']);
    sessions.update({ name: 'QSHQ400', state: 'connected', system: { ...SYSTEM, qap: 3 } });
    assert.deepEqual(labels(await tree.getChildren()), ['QAP version 4 not available on this server']);
  });

  test('Copy CALL reads the parameters from SYSPARMS and closes the cursor; View data and Generate SELECT', async () => {
    const node: SqlNode = { kind: 'routine', connection: 'QSHQ400', routine: { schema: 'HLINV', name: 'RETIRE_ASSET', specific: 'RETIRE00001', kind: 'procedure', text: '' } };
    const text = (await actions.copyCall(node)) as string;
    assert.equal(text, 'CALL HLINV.RETIRE_ASSET(? /* ASSET_ID */, ? /* REASON */)');
    assert.equal(await vscode.env.clipboard.readText(), text);
    assert.match(String(host.sent.find((s) => s.method === 'sql.run')?.params.sql), /SPECIFIC_NAME = 'RETIRE00001'/);
    assert.deepEqual(host.sent.find((s) => s.method === 'sql.close')?.params, { name: 'QSHQ400', cursor: 9 });
    const table: SqlNode = { kind: 'table', connection: 'QSHQ400', table: { schema: 'HLINV', name: 'ASSETS', kind: 'table', text: '' } };
    const run = (await actions.viewData(table)) as { sql: string };
    assert.equal(run.sql, 'SELECT * FROM HLINV.ASSETS FETCH FIRST 500 ROWS ONLY');
    const sel = (await actions.generateSelect(table)) as string;
    assert.equal(sel, 'SELECT ASSET_ID,\n       SITE\n  FROM HLINV.ASSETS');
    const doc = vscode.window.activeTextEditor?.document;
    assert.equal(doc?.languageId, 'qs400-sql');
    assert.equal(doc?.getText(), `${sel};\n`);
  });
});

suite('SQL: history', () => {
  const run = (i: number, over: Partial<SqlRun> = {}): SqlRun => ({
    id: `s${i}`,
    connection: 'QSHQ400',
    sql: `SELECT ${i} FROM T`,
    started: Date.UTC(2026, 10, 8, 12, 0, i),
    elapsed: 5,
    result: { kind: 'query', rows: [[i]], end: true, cursor: i, messages: [], uncommitted: false },
    ...over,
  });

  test('an entry per run, newest first, never more than 50, never the rows', () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < 60; i++) {
      list = added(list, entryOf(run(i)));
    }
    assert.equal(list.length, HISTORY_CAP);
    assert.equal(HISTORY_CAP, 50);
    assert.equal(list[0].sql, 'SELECT 59 FROM T');
    assert.equal(list[49].sql, 'SELECT 10 FROM T');
    assert.deepEqual(Object.keys(list[0]).sort(), ['count', 'kind', 'more', 'outcome', 'sql', 'time']);
    const upd = entryOf(run(1, { result: { kind: 'update', updated: 3, messages: [], uncommitted: true } }));
    assert.deepEqual(upd, { sql: 'SELECT 1 FROM T', time: Date.UTC(2026, 10, 8, 12, 0, 1), kind: 'update', outcome: 'ok', count: 3 });
    const err = entryOf(run(2, { result: undefined, error: { message: 'x', data: { messageId: 'SQL0104' } } }));
    assert.equal(err.outcome, 'error');
    assert.equal(entryDescription(err).split(' · ')[1], 'SQL0104');
    assert.equal(entryDescription(entryOf(run(3, { result: { kind: 'query', rows: new Array(500).fill([1]), end: false, messages: [], uncommitted: false } }))).split(' · ')[1], '500+ rows');
    assert.equal(entryDescription(upd).split(' · ')[1], '3 rows updated');
  });

  test('three runs kept per connection with their times and counts; the first runs again', async () => {
    const output = vscode.window.createOutputChannel('sql history test', { log: true });
    await vscode.workspace.getConfiguration('code-for-qs400').update('connections', [{ name: 'QSHQ400', host: 'qshq400.example', user: 'CWELLMAN' }], true);
    const host = new FakeHost((method, params) =>
      method === 'sql.run'
        ? { kind: 'query', columns: [], rows: [[String(params.sql)]], end: true, cursor: 1, messages: [], uncommitted: false }
        : { commit: 'none', naming: 'sql', uncommitted: false },
    );
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const memento = new Memento();
    const sessions = new SessionManager(host as unknown as HostClient, store, memento, output);
    sessions.update({ name: 'QSHQ400', state: 'connected', user: 'CWELLMAN' });
    const sql = new SqlSessions(host as unknown as HostClient, store, sessions);
    const runner = new SqlRunner(host as unknown as HostClient, store, sessions, sql, async () => null);
    const history = new SqlHistory(memento, runner, sql, sessions);
    try {
      for (const s of ['SELECT 1 FROM T', 'SELECT 2 FROM T', 'SELECT 3 FROM T']) {
        await runner.run('QSHQ400', s);
      }
      await new Promise((r) => setTimeout(r, 10));
      const e = history.entries('qshq400');
      assert.deepEqual(e.map((x) => x.sql), ['SELECT 3 FROM T', 'SELECT 2 FROM T', 'SELECT 1 FROM T']);
      assert.ok(e.every((x) => x.count === 1 && typeof x.time === 'number'));
      const again = await history.rerun('QSHQ400', e[2]);
      assert.equal(again.sql, 'SELECT 1 FROM T');
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(history.entries('QSHQ400').length, 4);
      assert.equal(history.entries('OTHER').length, 0);
    } finally {
      [history, runner, sql, sessions, store, output, host].forEach((d) => d.dispose());
      await vscode.workspace.getConfiguration('code-for-qs400').update('connections', undefined, true);
    }
  });
});
