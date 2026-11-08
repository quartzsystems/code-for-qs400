// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parseConnections, toSetting } from '../src/connections/config';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient, HostRpcError } from '../src/host/client';
import { IfsEntry, SessionErrorCodes } from '../src/host/protocol';
import {
  baseName,
  defaultRoots,
  entryDescription,
  formatSize,
  isWithin,
  joinPath,
  parentPath,
  sortEntries,
  typedPath,
} from '../src/ifs/paths';
import { IfsNode, IfsProvider, ifsContext } from '../src/views/ifs';
import { FakeHost, Memento } from './members.test';

export function entry(name: string, kind: IfsEntry['kind'] = 'file', extra: Partial<IfsEntry> = {}): IfsEntry {
  return { name, kind, size: kind === 'file' ? 2048 : 0, modified: 1_760_000_000_000, owner: 'CWELLMAN', ccsid: 1208, ...extra };
}

suite('IFS: paths and entries', () => {
  test('join, parent, base name, within', () => {
    assert.equal(joinPath('/', 'home'), '/home');
    assert.equal(joinPath('/home/CWELLMAN', 'a.txt'), '/home/CWELLMAN/a.txt');
    assert.equal(parentPath('/home/CWELLMAN/a.txt'), '/home/CWELLMAN');
    assert.equal(parentPath('/home'), '/');
    assert.equal(parentPath('/'), '/');
    assert.equal(baseName('/home/CWELLMAN/'), 'CWELLMAN');
    assert.equal(baseName('/'), '/');
    assert.ok(isWithin('/home/CWELLMAN/src/a', '/home/CWELLMAN'));
    assert.ok(isWithin('/home/CWELLMAN', '/home/CWELLMAN/'));
    assert.ok(!isWithin('/home/CWELLMANX', '/home/CWELLMAN'));
  });

  test('a typed path must be absolute; trailing slashes go', () => {
    assert.equal(typedPath('  /home/CWELLMAN/ '), '/home/CWELLMAN');
    assert.equal(typedPath('/'), '/');
    assert.equal(typedPath('//'), '/');
    assert.equal(typedPath('home'), undefined);
    assert.equal(typedPath(''), undefined);
  });

  test('directories first, then by name without case, numbers in order', () => {
    const sorted = sortEntries([
      entry('b.txt'),
      entry('Zeta', 'directory'),
      entry('a10.txt'),
      entry('alpha', 'directory'),
      entry('a2.txt'),
      entry('link', 'symlink'),
      entry('B.txt'),
    ]);
    assert.deepEqual(
      sorted.map((e) => e.name),
      ['alpha', 'Zeta', 'a2.txt', 'a10.txt', 'B.txt', 'b.txt', 'link'],
    );
  });

  test('a file shows its size and CCSID; a link its target', () => {
    assert.equal(formatSize(0), '0 B');
    assert.equal(formatSize(1023), '1023 B');
    assert.equal(formatSize(1536), '1.5 KB');
    assert.equal(formatSize(20 * 1024 * 1024), '20.0 MB');
    assert.equal(entryDescription(entry('a.txt', 'file', { size: 1536, ccsid: 37 })), '1.5 KB · 37');
    assert.equal(entryDescription(entry('l', 'symlink', { target: '../src' })), '→ ../src');
    assert.equal(entryDescription(entry('d', 'directory')), undefined);
  });

  test('roots default to the home directory and /; ifsRoots round-trips and bad entries are reported', () => {
    assert.deepEqual(defaultRoots('CWELLMAN'), ['/home/CWELLMAN', '/']);
    const { connections, problems } = parseConnections([
      { name: 'A', host: 'h', user: 'u', ifsRoots: ['/src', 'relative', '/src', 7, '/tmp'] },
      { name: 'B', host: 'h', user: 'u', ifsRoots: 'nope' },
    ]);
    assert.deepEqual(connections[0].ifsRoots, ['/src', '/tmp']);
    assert.equal(connections[1].ifsRoots, undefined);
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.deepEqual(toSetting(connections[0]).ifsRoots, ['/src', '/tmp']);
    assert.equal(toSetting(connections[1]).ifsRoots, undefined);
  });
});

suite('IFS: the view against a host', () => {
  const config = () => vscode.workspace.getConfiguration('code-for-qs400');
  let output: vscode.LogOutputChannel;
  const parts: vscode.Disposable[] = [];

  async function view(answer: (method: string, params: Record<string, unknown>) => unknown, qap = 9) {
    const host = new FakeHost(answer);
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    const ifs = new IfsProvider(store, sessions, new Memento());
    parts.push(ifs, sessions, store, host);
    sessions.update({
      name: 'IFS',
      state: 'connected',
      user: 'CWELLMAN',
      system: { name: 'QSHQ400', product: 'QS00SS1', version: 'V1R0M0', qap },
    });
    await sessions.setActive('IFS');
    return { host, store, sessions, ifs };
  }

  const label = (ifs: IfsProvider, n: IfsNode) => ifs.getTreeItem(n).label;
  const labels = (ifs: IfsProvider, nodes: IfsNode[]) => nodes.map((n) => label(ifs, n));

  suiteSetup(() => {
    output = vscode.window.createOutputChannel('ifs test', { log: true });
  });
  setup(async () => {
    await config().update('connections', [{ name: 'IFS', host: 'h.example', user: 'CWELLMAN' }], true);
  });
  teardown(async () => {
    for (const p of parts.splice(0)) {
      p.dispose();
    }
    await config().update('connections', undefined, true);
  });
  suiteTeardown(() => output.dispose());

  test('roots: home and / by default, home first; Go to Path adds one for the window', async () => {
    const { ifs } = await view(() => []);
    const roots = await ifs.getChildren();
    assert.deepEqual(labels(ifs, roots), ['/home/CWELLMAN', '/']);
    assert.equal(ifsContext(roots[0]), 'ifs.root.home');
    assert.equal(ifsContext(roots[1]), 'ifs.root');
    ifs.addTransientRoot('IFS', '/QSYS.LIB');
    const after = await ifs.getChildren();
    assert.deepEqual(labels(ifs, after), ['/home/CWELLMAN', '/', '/QSYS.LIB']);
    assert.equal(ifsContext(after[2]), 'ifs.root.transient');
  });

  test('saved roots replace the defaults', async () => {
    await config().update('connections', [{ name: 'IFS', host: 'h.example', user: 'CWELLMAN', ifsRoots: ['/src', '/home/CWELLMAN'] }], true);
    const { ifs } = await view(() => []);
    assert.deepEqual(labels(ifs, await ifs.getChildren()), ['/src', '/home/CWELLMAN']);
  });

  test('a directory lists sorted, hidden entries only with the toggle; files show size and CCSID', async () => {
    const { ifs, host } = await view((m) => {
      assert.equal(m, 'ifs.list');
      return [entry('b.txt', 'file', { ccsid: 37 }), entry('.profile'), entry('src', 'directory'), entry('a.txt')];
    });
    const [home] = await ifs.getChildren();
    let kids = await ifs.getChildren(home);
    assert.deepEqual(labels(ifs, kids), ['src', 'a.txt', 'b.txt']);
    assert.deepEqual(host.sent[0], { method: 'ifs.list', params: { name: 'IFS', path: '/home/CWELLMAN' } });
    const b = ifs.getTreeItem(kids[2]);
    assert.equal(b.description, '2.0 KB · 37');
    assert.equal(b.command?.command, 'code-for-qs400.ifs.open');
    assert.equal(b.resourceUri?.toString(), 'qs400ifs://ifs/home/CWELLMAN/b.txt');
    assert.equal(ifs.getTreeItem(kids[0]).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.equal(ifs.getParent(kids[0]), home);
    await ifs.setShowHidden(true);
    kids = await ifs.getChildren(home);
    assert.deepEqual(labels(ifs, kids), ['src', '.profile', 'a.txt', 'b.txt']);
  });

  test('the same path under two roots is two nodes with two ids', async () => {
    const { ifs } = await view((_, p) => (p.path === '/' ? [entry('home', 'directory')] : [entry('CWELLMAN', 'directory')]));
    const [, slash] = await ifs.getChildren();
    const [home] = await ifs.getChildren(slash);
    const [me] = await ifs.getChildren(home);
    const [homeRoot] = await ifs.getChildren();
    assert.notEqual(ifs.getTreeItem(me).id, ifs.getTreeItem(homeRoot).id);
  });

  test('a link to a directory lists under its own path; a link to a file becomes openable', async () => {
    const { ifs, host } = await view((m, p) => {
      if (m === 'ifs.list' && p.path === '/home/CWELLMAN') {
        return [entry('latest', 'symlink', { target: 'src' }), entry('notes', 'symlink', { target: '/tmp/n.txt' })];
      }
      if (m === 'ifs.list') {
        return [entry('x.rpgle')];
      }
      if (m === 'ifs.resolve') {
        return { path: p.path === '/home/CWELLMAN/latest' ? '/home/CWELLMAN/src' : '/tmp/n.txt' };
      }
      if (m === 'ifs.info') {
        return { ...entry('t', p.path === '/home/CWELLMAN/src' ? 'directory' : 'file'), change: '1' };
      }
      throw new Error(m);
    });
    const [home] = await ifs.getChildren();
    const [latest, notes] = await ifs.getChildren(home);
    assert.equal(ifs.getTreeItem(latest).description, '→ src');
    assert.equal(ifs.getTreeItem(notes).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    const inLink = await ifs.getChildren(latest);
    assert.deepEqual(labels(ifs, inLink), ['x.rpgle']);
    assert.equal((inLink[0] as Extract<IfsNode, { kind: 'entry' }>).path, '/home/CWELLMAN/latest/x.rpgle');
    assert.deepEqual(await ifs.getChildren(notes), []);
    const item = ifs.getTreeItem(notes);
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.equal(item.command?.command, 'code-for-qs400.ifs.open');
    assert.ok(host.sent.some((s) => s.method === 'ifs.resolve' && s.params.path === '/home/CWELLMAN/notes'));
  });

  test('an empty directory and one of only hidden entries say so; an error is one line', async () => {
    let answer: unknown = [];
    const { ifs } = await view(() => {
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    });
    const [home] = await ifs.getChildren();
    assert.deepEqual(labels(ifs, await ifs.getChildren(home)), ['Empty']);
    answer = [entry('.a'), entry('.b')];
    assert.deepEqual(labels(ifs, await ifs.getChildren(home)), ['2 hidden entries']);
    answer = new HostRpcError(SessionErrorCodes.Server, 'CPFA09C: Not authorized to object.', {
      status: 'NotAuthorized',
      messageId: 'CPFA09C',
      text: 'Not authorized to object.',
    });
    assert.deepEqual(labels(ifs, await ifs.getChildren(home)), ['CPFA09C: Not authorized to object.']);
  });

  test('below QAP version 5 the view says so and asks nothing', async () => {
    const { ifs, host } = await view(() => [], 4);
    const roots = await ifs.getChildren();
    assert.deepEqual(labels(ifs, roots), ['QAP version 5 not available on this server']);
    assert.equal(ifs.getTreeItem(roots[0]).description, 'QAP v4');
    assert.equal(host.sent.length, 0);
  });

  test('not signed on: one line, nothing asked', async () => {
    const { ifs, host, sessions } = await view(() => []);
    sessions.update({ name: 'IFS', state: 'disconnected' });
    assert.deepEqual(labels(ifs, await ifs.getChildren()), ['Connect to browse the IFS']);
    assert.equal(host.sent.length, 0);
  });

  test('saved roots are kept in order: the first is Home', async () => {
    const { ifs, store } = await view(() => []);
    await store.setIfsRoots('IFS', ['/home/CWELLMAN', '/', '/src']);
    assert.deepEqual(ifs.savedRoots('IFS'), ['/home/CWELLMAN', '/', '/src']);
    await store.setIfsRoots('IFS', ['/src', '/home/CWELLMAN', '/']);
    const roots = await ifs.getChildren();
    assert.deepEqual(labels(ifs, roots), ['/src', '/home/CWELLMAN', '/']);
    assert.equal(ifs.getTreeItem(roots[0]).description, 'Home');
  });
});
