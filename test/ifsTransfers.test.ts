// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient, HostRpcError } from '../src/host/client';
import { IfsErrorCodes } from '../src/host/protocol';
import { IfsFsProvider } from '../src/ifs/provider';
import { Transfers, localTree, uploadCcsid } from '../src/ifs/transfers';
import { IfsProvider } from '../src/views/ifs';
import { FakeHost, Memento } from './members.test';

function scratch(name: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `qs400-transfer-${name}-`));
  return d;
}

suite('IFS: transfers', () => {
  const config = () => vscode.workspace.getConfiguration('code-for-qs400');
  let output: vscode.LogOutputChannel;
  const parts: vscode.Disposable[] = [];

  function transfers(answer: (method: string, params: Record<string, unknown>) => unknown) {
    const host = new FakeHost(answer);
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    const view = new IfsProvider(store, sessions, new Memento());
    const files = new IfsFsProvider(sessions, store, output);
    sessions.update({ name: 'IFS', state: 'connected', user: 'CWELLMAN' });
    parts.push(view, files, sessions, store, host);
    return { host, view, t: new Transfers(host as unknown as HostClient, sessions, view, files) };
  }

  suiteSetup(async () => {
    output = vscode.window.createOutputChannel('ifs transfers test', { log: true });
    await config().update('connections', [{ name: 'IFS', host: 'h.example', user: 'CWELLMAN' }], true);
  });
  teardown(() => {
    for (const p of parts.splice(0)) {
      p.dispose();
    }
  });
  suiteTeardown(async () => {
    await config().update('connections', undefined, true);
    output.dispose();
  });

  test('an upload is tagged 1208, a known binary 65535', () => {
    assert.equal(uploadCcsid('/a/b.txt'), 1208);
    assert.equal(uploadCcsid('/a/b.rpgle'), 1208);
    assert.equal(uploadCcsid('/a/b.savf'), 65535);
    assert.equal(uploadCcsid('/a/b.PNG'), 65535);
  });

  test('a local folder: its folders parents first, then its files', async () => {
    const d = scratch('tree');
    fs.mkdirSync(path.join(d, 'sub', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(d, 'a.txt'), 'aa');
    fs.writeFileSync(path.join(d, 'sub', 'b.txt'), 'bbb');
    fs.writeFileSync(path.join(d, 'sub', 'deeper', 'c.bin'), 'c');
    const tree = await localTree(d, '/home/CWELLMAN/up');
    assert.deepEqual(tree.dirs, ['/home/CWELLMAN/up', '/home/CWELLMAN/up/sub', '/home/CWELLMAN/up/sub/deeper']);
    assert.deepEqual(
      tree.files.map((f) => [f.path, f.size]),
      [
        ['/home/CWELLMAN/up/a.txt', 2],
        ['/home/CWELLMAN/up/sub/b.txt', 3],
        ['/home/CWELLMAN/up/sub/deeper/c.bin', 1],
      ],
    );
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('a folder upload makes its folders, then sends each file with its own transfer ID', async () => {
    const { host, t } = transfers((m, p) => {
      if (m === 'ifs.upload') {
        host.progress.fire({ transfer: String(p.transfer), path: String(p.path), done: 1, total: 2 });
        return { size: 2 };
      }
      return null;
    });
    const d = scratch('folder');
    fs.writeFileSync(path.join(d, 'a.txt'), 'aa');
    fs.writeFileSync(path.join(d, 'b.txt'), 'bb');
    const tree = await localTree(d, '/home/CWELLMAN/f');
    const size = await t.upload('IFS', tree.files, 'create', tree.dirs);
    assert.equal(size, 4);
    assert.deepEqual(
      host.sent.map((s) => [s.method, s.params.path, s.params.mode, s.params.parents]),
      [
        ['ifs.mkdir', '/home/CWELLMAN/f', undefined, true],
        ['ifs.upload', '/home/CWELLMAN/f/a.txt', 'create', undefined],
        ['ifs.upload', '/home/CWELLMAN/f/b.txt', 'create', undefined],
      ],
    );
    const ids = host.sent.filter((s) => s.method === 'ifs.upload').map((s) => s.params.transfer);
    assert.equal(new Set(ids).size, 2);
    assert.equal(host.sent[1].params.ccsid, 1208);
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('a cancelled upload stops the rest and marks the file partial in the tree', async () => {
    const { host, view, t } = transfers((m, p) => {
      if (m === 'ifs.upload') {
        throw new HostRpcError(IfsErrorCodes.Cancelled, 'cancelled', { transfer: p.transfer, offset: 10 * 1024 * 1024 });
      }
      return null;
    });
    const items = [
      { from: '/local/twenty.dat', path: '/home/CWELLMAN/twenty.dat', size: 20 * 1024 * 1024 },
      { from: '/local/next.dat', path: '/home/CWELLMAN/next.dat', size: 5 },
    ];
    assert.equal(await t.upload('IFS', items), undefined);
    assert.equal(host.sent.filter((s) => s.method === 'ifs.upload').length, 1);
    assert.equal(view.notes.get('IFS|/home/CWELLMAN/twenty.dat'), 'partial upload: 10.0 MB of 20.0 MB');
  });

  test('a resumed upload clears the partial mark', async () => {
    const { host, view, t } = transfers(() => ({ size: 20 }));
    view.notes.set('IFS|/home/CWELLMAN/twenty.dat', 'partial upload: 10 B of 20 B');
    await t.upload('IFS', [{ from: '/local/twenty.dat', path: '/home/CWELLMAN/twenty.dat', size: 20 }], 'resume');
    assert.equal(host.sent[0].params.mode, 'resume');
    assert.equal(view.notes.has('IFS|/home/CWELLMAN/twenty.dat'), false);
  });

  test('a folder download makes the local folders and fetches each file', async () => {
    const { host, t } = transfers((m, p) => {
      if (m === 'ifs.download') {
        fs.writeFileSync(String(p.to), 'x');
        return { size: 1 };
      }
      return null;
    });
    const d = scratch('down');
    const to = path.join(d, 'f');
    const size = await t.download('IFS', [{ path: '/home/CWELLMAN/f/sub/a.txt', to: path.join(to, 'sub', 'a.txt'), size: 1 }], [to, path.join(to, 'sub')]);
    assert.equal(size, 1);
    assert.ok(fs.existsSync(path.join(to, 'sub', 'a.txt')));
    assert.equal(host.sent[0].method, 'ifs.download');
    fs.rmSync(d, { recursive: true, force: true });
  });
});
