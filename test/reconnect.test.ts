// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { secretKey } from '../src/connections/config';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient, HostRpcError } from '../src/host/client';
import { SessionErrorCodes, SessionStatus } from '../src/host/protocol';

/** A host that answers from a script and records what it was sent. */
class FakeHost {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  private readonly session = new vscode.EventEmitter<SessionStatus>();
  private readonly state = new vscode.EventEmitter<string>();
  readonly onDidChangeSession = this.session.event;
  readonly onDidChangeState = this.state.event;

  constructor(private readonly answer: (method: string, params: Record<string, unknown>, n: number) => unknown) {}

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    const n = this.sent.filter((s) => s.method === method).length;
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(this.answer(method, params, n));
        } catch (err) {
          reject(err);
        }
      }, 5),
    );
  }

  dispose(): void {
    this.session.dispose();
    this.state.dispose();
  }
}

const CONNECTED: SessionStatus = {
  name: 'LIVE',
  state: 'connected',
  user: 'CWELLMAN',
  job: { number: '200002', user: 'CWELLMAN', name: 'QAPSRV' },
};

/** In-memory secret storage. */
class Secrets implements vscode.SecretStorage {
  readonly map = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  readonly onDidChange = this.changed.event;
  get(key: string) {
    return Promise.resolve(this.map.get(key));
  }
  store(key: string, value: string) {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string) {
    this.map.delete(key);
    return Promise.resolve();
  }
  keys() {
    return Promise.resolve([...this.map.keys()]);
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

suite('Reconnect and needs_password', () => {
  const config = () => vscode.workspace.getConfiguration('code-for-qs400');
  let output: vscode.LogOutputChannel;

  suiteSetup(async () => {
    output = vscode.window.createOutputChannel('reconnect test', { log: true });
    await config().update('connections', [{ name: 'LIVE', host: 'h.example', user: 'CWELLMAN' }], true);
  });

  suiteTeardown(async () => {
    output.dispose();
    await config().update('connections', undefined, true);
  });

  test('one sign-on with the saved password, then each waiting call again', async () => {
    const host = new FakeHost((method, _params, n) => {
      if (method === 'libl.get' && n <= 3) {
        throw new HostRpcError(SessionErrorCodes.NeedsPassword, 'needs_password');
      }
      if (method === 'libl.get') {
        return { current: null, system: ['QSYS'], user: [] };
      }
      if (method === 'session.connect') {
        return CONNECTED;
      }
      throw new Error(`unexpected ${method}`);
    });
    const secrets = new Secrets();
    secrets.map.set(secretKey('LIVE'), 'saved-pw');
    const store = new ConnectionStore(secrets, output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    try {
      const results = await Promise.all([1, 2, 3].map(() => sessions.call('LIVE', 'libl.get', { name: 'LIVE' })));
      assert.equal(results.length, 3);
      const connects = host.sent.filter((s) => s.method === 'session.connect');
      assert.equal(connects.length, 1, 'one sign-on for all three');
      assert.equal(connects[0].params.password, 'saved-pw');
      assert.equal(host.sent.filter((s) => s.method === 'libl.get').length, 6);
      assert.equal(sessions.status('LIVE').job?.number, '200002');
      assert.equal(sessions.active, 'LIVE');
    } finally {
      sessions.dispose();
      store.dispose();
      host.dispose();
    }
  });

  test('other errors pass straight through, with no sign-on', async () => {
    const host = new FakeHost(() => {
      throw new HostRpcError(SessionErrorCodes.LibraryListUnavailable, 'library_list not available on this server');
    });
    const store = new ConnectionStore(new Secrets(), output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    try {
      await assert.rejects(sessions.call('LIVE', 'libl.get', { name: 'LIVE' }), (e: HostRpcError) => e.code === -32001);
      assert.deepEqual(
        host.sent.map((s) => s.method),
        ['libl.get'],
      );
    } finally {
      sessions.dispose();
      store.dispose();
      host.dispose();
    }
  });

  test('connect on a stale session resumes without a password', async () => {
    const host = new FakeHost((method) => (method === 'session.connect' ? CONNECTED : undefined));
    const store = new ConnectionStore(new Secrets(), output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    try {
      sessions.update({ ...CONNECTED, state: 'stale' });
      const s = await sessions.connect('LIVE');
      assert.equal(s?.state, 'connected');
      assert.equal(host.sent.length, 1);
      assert.equal('password' in host.sent[0].params, false);
    } finally {
      sessions.dispose();
      store.dispose();
      host.dispose();
    }
  });
});
