// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CCSID_CHOICES, ifsPropertiesText } from '../src/commands/ifsFiles';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient } from '../src/host/client';
import { IfsEntry } from '../src/host/protocol';
import { joinPath } from '../src/ifs/paths';
import { IfsFsProvider } from '../src/ifs/provider';
import { copyTree, countText, deleteWalked, walkBottomUp } from '../src/ifs/tree';
import { ifsUri } from '../src/ifs/uri';
import { entry } from './ifsView.test';
import { FakeHost, Memento } from './members.test';

/**
 * /t
 *   a.txt
 *   src/
 *     x.rpgle
 *     deep/
 *       y.clle
 *       z/          (empty)
 *   link -> src     (a link: deleted as itself, never walked)
 *   docs/
 *     readme
 */
const FIXTURE: Record<string, IfsEntry[]> = {
  '/t': [entry('a.txt'), entry('src', 'directory'), entry('link', 'symlink', { target: 'src' }), entry('docs', 'directory')],
  '/t/src': [entry('x.rpgle'), entry('deep', 'directory')],
  '/t/src/deep': [entry('y.clle'), entry('z', 'directory')],
  '/t/src/deep/z': [],
  '/t/docs': [entry('readme')],
};

const list = async (dir: string) => {
  const e = FIXTURE[dir];
  if (!e) {
    throw new Error(`listed ${dir}, which is no directory of the fixture`);
  }
  return e;
};

/** Every directory comes after everything below it. */
function childrenBeforeParents(order: string[]) {
  order.forEach((p, i) => {
    for (const q of order.slice(i + 1)) {
      assert.ok(!q.startsWith(`${p}/`), `${q} is deleted after its parent ${p}`);
    }
  });
}

suite('IFS: walking a tree to delete and copy', () => {
  test('a non-empty directory: children before parents, the root last, links not followed', async () => {
    const walked = await walkBottomUp('/t', list);
    const order = walked.map((w) => w.path);
    assert.deepEqual(order, [
      '/t/a.txt',
      '/t/src/x.rpgle',
      '/t/src/deep/y.clle',
      '/t/src/deep/z',
      '/t/src/deep',
      '/t/src',
      '/t/link',
      '/t/docs/readme',
      '/t/docs',
      '/t',
    ]);
    childrenBeforeParents(order);
    assert.equal(walked.find((w) => w.path === '/t/link')?.kind, 'symlink');
    assert.equal(countText(walked), '5 files and 4 folders');
  });

  test('deleted in that order, one ifs.delete each', async () => {
    const deleted: string[] = [];
    const walked = await walkBottomUp('/t', list);
    let n = 0;
    await deleteWalked(walked, async (p) => void deleted.push(p), (k) => (n = k));
    assert.deepEqual(deleted, walked.map((w) => w.path));
    assert.equal(n, 10);
    childrenBeforeParents(deleted);
  });

  test('counts in words', async () => {
    assert.equal(countText(await walkBottomUp('/t/src/deep/z', list)), '0 files');
    assert.equal(countText(await walkBottomUp('/t/docs', list)), '1 file');
    assert.equal(countText([{ path: '/a/b', kind: 'directory' }, { path: '/a', kind: 'directory' }]), '1 folder');
  });

  test('a copy makes each directory before what goes in it', async () => {
    const ops: string[] = [];
    const skipped = await copyTree('/t', '/u', {
      list: async (dir) => (dir === '/t' ? [...FIXTURE['/t'], entry('fifo', 'other')] : list(dir)),
      mkdir: async (p) => void ops.push(`mkdir ${p}`),
      copy: async (f, t) => void ops.push(`copy ${f} ${t}`),
    });
    assert.deepEqual(ops, [
      'mkdir /u',
      'copy /t/a.txt /u/a.txt',
      'copy /t/link /u/link',
      'mkdir /u/src',
      'copy /t/src/x.rpgle /u/src/x.rpgle',
      'mkdir /u/src/deep',
      'copy /t/src/deep/y.clle /u/src/deep/y.clle',
      'mkdir /u/src/deep/z',
      'mkdir /u/docs',
      'copy /t/docs/readme /u/docs/readme',
    ]);
    assert.deepEqual(skipped, ['/t/fifo']);
  });
});

suite('IFS: Properties and New File', () => {
  test('label: value lines, aligned', () => {
    const text = ifsPropertiesText('/home/CWELLMAN/a.txt', { ...entry('a.txt', 'file', { size: 1536, ccsid: 37 }), modified: Date.UTC(2026, 10, 7, 21, 5, 9), change: '42' });
    assert.equal(
      text,
      [
        'Path:           /home/CWELLMAN/a.txt',
        'Type:           Stream file',
        'Size:           1,536 bytes (1.5 KB)',
        'CCSID:          37',
        'Owner:          CWELLMAN',
        'Last changed:   2026-11-07 21:05:09 UTC',
        'Change counter: 42',
        '',
      ].join('\n'),
    );
    const link = ifsPropertiesText('/l', { ...entry('l', 'symlink', { target: 'src' }), change: 'm1' }, '/home/src');
    assert.match(link, /^Link target: {4}src$/m);
    assert.match(link, /^Resolves to: {4}\/home\/src$/m);
    assert.match(link, /^Change counter: not available before QAP version 6$/m);
  });

  test('the CCSIDs New File offers, in order', () => {
    assert.deepEqual(
      CCSID_CHOICES.map((c) => c.ccsid),
      [1208, 37, 500, 819],
    );
  });
});

suite('IFS: the provider deletes and copies directories', () => {
  const config = () => vscode.workspace.getConfiguration('code-for-qs400');
  let output: vscode.LogOutputChannel;
  const parts: vscode.Disposable[] = [];

  function provider() {
    const host = new FakeHost((m, p) => {
      if (m === 'ifs.list') {
        return list(String(p.path));
      }
      if (m === 'ifs.info') {
        const path = String(p.path);
        return { ...entry('x', FIXTURE[path] ? 'directory' : 'file'), change: '1' };
      }
      return null;
    });
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    const fs = new IfsFsProvider(sessions, store, output);
    sessions.update({ name: 'IFS', state: 'connected', user: 'CWELLMAN' });
    parts.push(fs, sessions, store, host);
    return { host, fs };
  }

  suiteSetup(async () => {
    output = vscode.window.createOutputChannel('ifs commands test', { log: true });
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

  test('a recursive delete sends ifs.delete children first', async () => {
    const { host, fs } = provider();
    await fs.delete(ifsUri('IFS', '/t'), { recursive: true });
    const deleted = host.sent.filter((s) => s.method === 'ifs.delete').map((s) => String(s.params.path));
    assert.equal(deleted.length, 10);
    assert.equal(deleted[deleted.length - 1], '/t');
    childrenBeforeParents(deleted);
  });

  test('a delete that is not recursive is one ifs.delete', async () => {
    const { host, fs } = provider();
    await fs.delete(ifsUri('IFS', '/t/a.txt'), { recursive: false });
    assert.deepEqual(
      host.sent.map((s) => s.method),
      ['ifs.delete'],
    );
  });

  test('a directory copies entry by entry; into itself is refused', async () => {
    const { host, fs } = provider();
    await fs.copy(ifsUri('IFS', '/t/src'), ifsUri('IFS', '/v'), { overwrite: false });
    const sent = host.sent.filter((s) => s.method !== 'ifs.list' && s.method !== 'ifs.info').map((s) => `${s.method} ${s.params.path ?? `${s.params.from} ${s.params.to}`}`);
    assert.deepEqual(sent, [
      'ifs.mkdir /v',
      'ifs.copy /t/src/x.rpgle /v/x.rpgle',
      'ifs.mkdir /v/deep',
      'ifs.copy /t/src/deep/y.clle /v/deep/y.clle',
      'ifs.mkdir /v/deep/z',
    ]);
    await assert.rejects(fs.copy(ifsUri('IFS', '/t'), ifsUri('IFS', joinPath('/t', 'inner')), { overwrite: false }), /into itself/);
  });
});
