// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  LibraryListController,
  libraryItems,
  moved,
  withAdded,
  withCurrent,
  withRemoved,
} from '../src/connections/libraryList';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient, HostRpcError } from '../src/host/client';
import { LibraryList, SessionErrorCodes, SessionStatus } from '../src/host/protocol';

const LIST: LibraryList = { current: 'CWELLMAN', system: ['QSYS', 'QSYS2'], user: ['QGPL', 'QTEMP', 'TOOLS'] };

suite('Library list: edits', () => {
  test('move up and down, unchanged at either end', () => {
    assert.deepEqual(moved(LIST, 2, -1).user, ['QGPL', 'TOOLS', 'QTEMP']);
    assert.deepEqual(moved(LIST, 0, 1).user, ['QTEMP', 'QGPL', 'TOOLS']);
    assert.deepEqual(moved(LIST, 0, -1).user, LIST.user);
    assert.deepEqual(moved(LIST, 2, 1).user, LIST.user);
    assert.equal(moved(LIST, 1, 1).current, 'CWELLMAN');
  });

  test('add, remove, set current', () => {
    assert.deepEqual(withAdded(LIST, 'NEWLIB'), { current: 'CWELLMAN', user: ['QGPL', 'QTEMP', 'TOOLS', 'NEWLIB'] });
    assert.deepEqual(withAdded(LIST, 'QGPL').user, LIST.user);
    assert.deepEqual(withRemoved(LIST, 'QTEMP', false), { current: 'CWELLMAN', user: ['QGPL', 'TOOLS'] });
    assert.deepEqual(withRemoved(LIST, 'CWELLMAN', true), { current: null, user: LIST.user });
    assert.deepEqual(withCurrent(LIST, 'TOOLS'), { current: 'TOOLS', user: ['QGPL', 'QTEMP'] });
  });

  test('items: the current library first as *CURLIB, then the user part in order', () => {
    const items = libraryItems('QSHQ400', LIST);
    assert.deepEqual(
      items.map((i) => [i.label, i.description, i.contextValue, i.index]),
      [
        ['CWELLMAN', '*CURLIB', 'library.current', -1],
        ['QGPL', undefined, 'library.user.first', 0],
        ['QTEMP', undefined, 'library.user', 1],
        ['TOOLS', undefined, 'library.user.last', 2],
      ],
    );
    assert.equal(libraryItems('X', { current: null, system: [], user: ['ONLY'] })[0].contextValue, 'library.user.first.last');
  });
});

/** A host answering library list calls from a function. */
class FakeHost {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  private readonly session = new vscode.EventEmitter<SessionStatus>();
  private readonly state = new vscode.EventEmitter<string>();
  readonly onDidChangeSession = this.session.event;
  readonly onDidChangeState = this.state.event;
  constructor(private readonly answer: (method: string, params: Record<string, unknown>) => unknown) {}
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    return this.answer(method, params);
  }
  dispose(): void {
    this.session.dispose();
    this.state.dispose();
  }
}

class Memento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();
  keys() {
    return [...this.map.keys()];
  }
  get<T>(key: string, fallback?: T): T | undefined {
    return (this.map.has(key) ? this.map.get(key) : fallback) as T | undefined;
  }
  update(key: string, value: unknown) {
    this.map.set(key, value);
    return Promise.resolve();
  }
}

const job = (n: string): SessionStatus => ({
  name: 'LIBL',
  state: 'connected',
  user: 'CWELLMAN',
  job: { number: n, user: 'CWELLMAN', name: 'QAPSRV' },
});

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}

suite('Library list: the node and saving', () => {
  const config = () => vscode.workspace.getConfiguration('code-for-qs400');
  let output: vscode.LogOutputChannel;
  const parts: vscode.Disposable[] = [];

  function controller(host: FakeHost) {
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    const libl = new LibraryListController(store, sessions, output);
    parts.push(libl, sessions, store, host);
    return { store, sessions, libl };
  }

  suiteSetup(() => {
    output = vscode.window.createOutputChannel('library list test', { log: true });
  });

  setup(async () => {
    await config().update('connections', [{ name: 'LIBL', host: 'h.example', user: 'CWELLMAN' }], true);
  });

  teardown(async () => {
    for (const p of parts.splice(0)) {
      p.dispose();
    }
    await config().update('connections', undefined, true);
  });

  suiteTeardown(() => output.dispose());

  test('a server without library_list: the node says so and nothing is saved', async () => {
    const host = new FakeHost(() => {
      throw new HostRpcError(SessionErrorCodes.LibraryListUnavailable, 'library_list not available on this server');
    });
    const { store, sessions, libl } = controller(host);
    sessions.update(job('100001'));
    await settle();
    const node = libl.node('LIBL');
    assert.equal(node.description, 'library_list not available on this server');
    assert.equal(node.contextValue, 'libraryList.unavailable');
    assert.equal(node.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.deepEqual(await libl.children('LIBL'), []);
    assert.equal(await libl.apply('LIBL', { current: 'X', user: ['A'] }), undefined);
    assert.equal(store.get('LIBL')?.libraryList, undefined);
  });

  test('an edit the server took is saved, and a new session job gets it applied', async () => {
    let list: LibraryList = { current: null, system: ['QSYS'], user: ['QGPL'] };
    const host = new FakeHost((method, params) => {
      if (method === 'libl.set') {
        list = { current: (params.current as string | null) ?? null, system: ['QSYS'], user: params.user as string[] };
      }
      return list;
    });
    const { store, sessions, libl } = controller(host);
    sessions.update(job('100001'));
    await settle();
    assert.deepEqual(
      host.sent.map((s) => s.method),
      ['libl.get'],
      'nothing saved yet: only read',
    );

    // Add NEWLIB, move it to the top, set a current library.
    await libl.apply('LIBL', withAdded(list, 'NEWLIB'));
    await libl.apply('LIBL', moved(list, 1, -1));
    await libl.apply('LIBL', { current: 'CWELLMAN', user: list.user });
    assert.deepEqual(store.get('LIBL')?.libraryList, { current: 'CWELLMAN', user: ['NEWLIB', 'QGPL'] });
    assert.equal(libl.node('LIBL').description, '*CURLIB CWELLMAN');

    // Disconnect, connect again: a new job, and the saved list is applied to it.
    sessions.update({ name: 'LIBL', state: 'disconnected' });
    list = { current: null, system: ['QSYS'], user: ['QGPL'] };
    host.sent.length = 0;
    sessions.update(job('100002'));
    await settle();
    assert.deepEqual(host.sent, [
      { method: 'libl.set', params: { name: 'LIBL', current: 'CWELLMAN', user: ['NEWLIB', 'QGPL'] } },
    ]);
    const items = await libl.children('LIBL');
    assert.deepEqual(
      items.map((i) => i.label),
      ['CWELLMAN', 'NEWLIB', 'QGPL'],
    );
  });
});
