// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension';
import type { SessionStatus } from '../src/host/protocol';
import { connectionTreeItem, qualifiedJob, systemLines, systemTreeItem } from '../src/views/connections';
import { shownConnection, statusBarText, statusBarTooltip } from '../src/views/sessionStatusBar';

const C = { name: 'QSHQ400', host: 'qshq400.example.com', user: 'CWELLMAN' };

const CONNECTED: SessionStatus = {
  name: 'QSHQ400',
  state: 'connected',
  user: 'CWELLMAN',
  system: { name: 'QSHQ400', product: 'QS00SS1', version: 'V1R0M0', serial: '1234567', qap: 6 },
  job: { number: '123456', user: 'CWELLMAN', name: 'QAPSRV' },
};

const marks = { isDefault: false, isActive: true };

function tooltip(item: { tooltip?: string | vscode.MarkdownString }): string {
  return typeof item.tooltip === 'string' ? item.tooltip : (item.tooltip?.value ?? '');
}

suite('Connections view: items from a status', () => {
  test('a disconnected connection: user@host, no children, click connects', () => {
    const item = connectionTreeItem(C, { name: 'QSHQ400', state: 'disconnected' }, marks);
    assert.equal(item.label, 'QSHQ400');
    assert.equal(item.description, 'CWELLMAN@qshq400.example.com');
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.equal(item.contextValue, 'connection.disconnected');
    assert.equal((item.iconPath as vscode.ThemeIcon).id, 'vm-outline');
    assert.equal(item.command?.command, 'code-for-qs400.connection.connect');
  });

  test('a connected connection opens, shows its job and marks the default', () => {
    const item = connectionTreeItem(C, CONNECTED, { isDefault: true, isActive: true });
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.equal(item.contextValue, 'connection.connected.default');
    assert.equal((item.iconPath as vscode.ThemeIcon).id, 'vm-running');
    assert.equal(item.command, undefined);
    assert.match(tooltip(item), /Session job 123456\/CWELLMAN\/QAPSRV/);
    assert.match(tooltip(item), /\(default\)/);
  });

  test('each state has its icon', () => {
    const icon = (state: SessionStatus['state']) =>
      (connectionTreeItem(C, { ...CONNECTED, state }, marks).iconPath as vscode.ThemeIcon).id;
    assert.equal(icon('connecting'), 'loading~spin');
    assert.equal(icon('stale'), 'debug-disconnect');
  });

  test('System: product and version, serial, session job', () => {
    assert.equal(systemTreeItem(CONNECTED).description, 'QS00SS1 V1R0M0');
    const lines = systemLines(CONNECTED).map((i) => `${String(i.label)}=${String(i.description)}`);
    assert.deepEqual(lines, [
      'Name=QSHQ400',
      'Product=QS00SS1',
      'Version=V1R0M0',
      'Serial=1234567',
      'Session job=123456/CWELLMAN/QAPSRV',
      'QAP=version 6',
    ]);
    const noSerial = { ...CONNECTED, system: { ...CONNECTED.system!, serial: undefined } };
    assert.ok(!systemLines(noSerial).some((i) => i.label === 'Serial'));
  });

  test('a qualified job name', () => {
    assert.equal(qualifiedJob({ number: '000042', user: 'QSECOFR', name: 'QAPSRV' }), '000042/QSECOFR/QAPSRV');
  });
});

suite('Status bar: from a status', () => {
  test('connected, stale, otherwise hidden', () => {
    assert.equal(statusBarText('QSHQ400', CONNECTED), '$(plug) QSHQ400 · CWELLMAN');
    assert.equal(statusBarText('QSHQ400', { ...CONNECTED, state: 'stale' }), '$(debug-disconnect) QSHQ400');
    assert.equal(statusBarText('QSHQ400', { name: 'QSHQ400', state: 'disconnected' }), undefined);
    assert.equal(statusBarText('QSHQ400', { name: 'QSHQ400', state: 'connecting' }), undefined);
  });

  test('the tooltip has the host, the session job and the system version', () => {
    const t = statusBarTooltip(C, CONNECTED).value;
    assert.match(t, /qshq400\.example\.com/);
    assert.match(t, /123456\/CWELLMAN\/QAPSRV/);
    assert.match(t, /V1R0M0/);
  });

  test('the active connection is shown when signed on, else the first signed on', () => {
    const other: SessionStatus = { ...CONNECTED, name: 'DEV' };
    assert.equal(shownConnection('DEV', [CONNECTED, other])?.name, 'DEV');
    assert.equal(shownConnection('GONE', [CONNECTED, other])?.name, 'QSHQ400');
    assert.equal(shownConnection('QSHQ400', []), undefined);
  });
});

suite('Connections view and status bar in the extension', () => {
  let api: ExtensionApi;
  const config = () => vscode.workspace.getConfiguration('code-for-qs400');

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<ExtensionApi>('quartzsystems.code-for-qs400');
    assert.ok(ext);
    api = await ext.activate();
    await config().update('connections', [{ name: 'QSHQ400', host: 'qshq400.example.com', user: 'cwellman' }], true);
  });

  suiteTeardown(async () => {
    api.sessions.update({ name: 'QSHQ400', state: 'disconnected' });
    await config().update('connections', undefined, true);
  });

  test('the root lists the saved connection, disconnected', async () => {
    const roots = await api.connections.getChildren();
    assert.equal(roots.length, 1);
    assert.equal(roots[0].label, 'QSHQ400');
    assert.equal(roots[0].description, 'CWELLMAN@qshq400.example.com');
    assert.deepEqual(await api.connections.getChildren(roots[0]), []);
    assert.equal(api.statusBar.text, undefined);
  });

  test('a connected session gets a System node and the status bar item', async () => {
    api.sessions.update(CONNECTED);
    await api.sessions.setActive('QSHQ400');
    const [root] = await api.connections.getChildren();
    const children = await api.connections.getChildren(root);
    const system = children.find((c) => c.label === 'System');
    assert.ok(system, 'System node');
    const lines = await api.connections.getChildren(system);
    assert.ok(lines.some((l) => l.label === 'Session job' && l.description === '123456/CWELLMAN/QAPSRV'));
    assert.equal(api.statusBar.text, '$(plug) QSHQ400 · CWELLMAN');

    api.sessions.update({ ...CONNECTED, state: 'stale' });
    assert.equal(api.statusBar.text, '$(debug-disconnect) QSHQ400');
    api.sessions.update({ name: 'QSHQ400', state: 'disconnected' });
    assert.equal(api.statusBar.text, undefined);
  });

  test('a refused connection is the host transport error and leaves it disconnected', async () => {
    const e = await api.host
      .request('session.connect', { name: 'QSHQ400', host: '127.0.0.1', port: 1, user: 'CWELLMAN', password: 'x' })
      .then(
        () => undefined,
        (err: unknown) => err as { code: number },
      );
    assert.equal(e?.code, -32011);
    assert.equal(api.sessions.status('QSHQ400').state, 'disconnected');
  });
});
