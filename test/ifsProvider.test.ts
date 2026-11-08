// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient, HostRpcError } from '../src/host/client';
import { IfsErrorCodes, SessionErrorCodes } from '../src/host/protocol';
import { IfsFsProvider, OVERWRITE, RELOAD, tooLargeText } from '../src/ifs/provider';
import { BINARY_EXTENSIONS, DOCUMENT_LIMIT, extensionOf, isBinaryPath, languageForPath } from '../src/ifs/types';
import { ifsUri, parseIfsUri } from '../src/ifs/uri';
import { FakeHost, Memento } from './members.test';

suite('IFS: how a stream file opens', () => {
  test('the binary-extension table: these are read as bytes, any case', () => {
    assert.deepEqual(
      [...BINARY_EXTENSIONS],
      ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'pdf', 'zip', 'savf', 'jar', 'class', 'so', 'a'],
    );
    for (const ext of BINARY_EXTENSIONS) {
      assert.ok(isBinaryPath(`/home/CWELLMAN/x.${ext}`), ext);
      assert.ok(isBinaryPath(`/home/CWELLMAN/X.${ext.toUpperCase()}`), ext.toUpperCase());
    }
    for (const p of ['/a.txt', '/a.rpgle', '/.profile', '/archive.zip.txt', '/dir.png/readme', '/noext', '/lib.so.1']) {
      assert.ok(!isBinaryPath(p), p);
    }
    assert.equal(extensionOf('/home/x/.profile'), '');
    assert.equal(extensionOf('/home/x/libc.a'), 'a');
    assert.equal(extensionOf('/home/x.d/readme'), '');
  });

  test('source extensions get the same qs400-* languages as members; others are left to VS Code', () => {
    const table: [string, string | undefined][] = [
      ['/s/a.rpgle', 'qs400-rpgle'],
      ['/s/a.SQLRPGLE', 'qs400-rpgle'],
      ['/s/a.rpg', 'qs400-rpgle'],
      ['/s/a.clle', 'qs400-cl'],
      ['/s/a.clp', 'qs400-cl'],
      ['/s/a.pf', 'qs400-dds'],
      ['/s/a.lf', 'qs400-dds'],
      ['/s/a.dspf', 'qs400-dds'],
      ['/s/a.prtf', 'qs400-dds'],
      ['/s/a.sql', 'qs400-sql'],
      ['/s/a.cmd', 'qs400-cmd'],
      ['/s/a.txt', undefined],
      ['/s/a.c', undefined],
      ['/s/a.json', undefined],
      ['/s/Makefile', undefined],
    ];
    for (const [path, language] of table) {
      assert.equal(languageForPath(path), language, path);
    }
  });

  test('qs400ifs://<connection>/<path>, round trip', () => {
    const uri = ifsUri('QSHQ400', '/home/CWELLMAN/a b#1.txt');
    assert.equal(uri.scheme, 'qs400ifs');
    assert.deepEqual(parseIfsUri(vscode.Uri.parse(uri.toString())), { connection: 'qshq400', path: '/home/CWELLMAN/a b#1.txt' });
    assert.equal(parseIfsUri(vscode.Uri.parse('file:///a')), undefined);
  });

  test('the refusal names the size and the limit', () => {
    assert.equal(
      tooLargeText('/home/CWELLMAN/big.log', 52_428_800),
      'big.log is 50.0 MB (52,428,800 bytes); files open up to 10.0 MB (10,485,760 bytes). Download it instead.',
    );
  });
});

const NOT_FOUND = new HostRpcError(SessionErrorCodes.Server, 'CPFA0A9: Object not found.', {
  status: 'NotFound',
  messageId: 'CPFA0A9',
  text: 'Object not found.',
});

const TCP1A5A = new HostRpcError(SessionErrorCodes.Server, 'TCP1A5A: Data cannot be converted to or from CCSID.', {
  status: 'Error',
  messageId: 'TCP1A5A',
  text: 'Data cannot be converted to or from CCSID.',
  secondLevel: 'Cause . . . . . :   A character has no encoding in CCSID 37.',
});

const CHANGED = new HostRpcError(IfsErrorCodes.Changed, 'changed on the system', { change: '99' });

function info(kind: 'file' | 'directory', size = 10) {
  return { name: 'x', kind, size, modified: 1_760_000_000_000, owner: 'CWELLMAN', ccsid: 1208, change: '1' };
}

suite('IFS: the qs400ifs provider', () => {
  const config = () => vscode.workspace.getConfiguration('code-for-qs400');
  let output: vscode.LogOutputChannel;
  const parts: vscode.Disposable[] = [];
  const FILE = ifsUri('IFS', '/home/CWELLMAN/utf8.txt');
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function provider(answer: (method: string, params: Record<string, unknown>) => unknown) {
    const host = new FakeHost(answer);
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    const p = new IfsFsProvider(sessions, store, output);
    sessions.update({ name: 'IFS', state: 'connected', user: 'CWELLMAN' });
    parts.push(p, sessions, store, host);
    return { host, p };
  }

  const methods = (host: FakeHost) => host.sent.map((s) => s.method);

  suiteSetup(async () => {
    output = vscode.window.createOutputChannel('ifs provider test', { log: true });
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

  test('text is read through ifs.readText and kept with its change; an unchanged save writes nothing', async () => {
    const { host, p } = provider((m) => (m === 'ifs.readText' ? { text: 'é — ok\n', ccsid: 1208, size: 9, change: '41' } : info('file')));
    // The authority as Uri.toString leaves it: lower case.
    const uri = vscode.Uri.parse(FILE.toString());
    assert.equal(dec.decode(await p.readFile(uri)), 'é — ok\n');
    assert.deepEqual(host.sent[0], { method: 'ifs.readText', params: { name: 'IFS', path: '/home/CWELLMAN/utf8.txt' } });
    assert.equal(p.text(uri)?.change, '41');
    const s1 = await p.stat(uri);
    const s2 = await p.stat(uri);
    assert.equal(s1.mtime, s2.mtime);
    assert.equal(s1.size, enc.encode('é — ok\n').byteLength);
    await p.writeFile(uri, enc.encode('é — ok\n'), { create: true, overwrite: true });
    assert.ok(!methods(host).includes('ifs.writeText'));
  });

  test('a save sends the change it read as expect, and keeps the new one', async () => {
    const { host, p } = provider((m) => {
      if (m === 'ifs.readText') {
        return { text: 'old\n', ccsid: 37, size: 4, change: '41' };
      }
      if (m === 'ifs.writeText') {
        return { size: 4, change: '42' };
      }
      return info('file');
    });
    await p.readFile(FILE);
    await p.writeFile(FILE, enc.encode('new\n'), { create: true, overwrite: true });
    const w = host.sent.find((s) => s.method === 'ifs.writeText');
    assert.deepEqual(w?.params, { name: 'IFS', path: '/home/CWELLMAN/utf8.txt', text: 'new\n', mode: 'replace', expect: '41' });
    assert.equal(p.text(FILE)?.change, '42');
    assert.equal(p.text(FILE)?.text, 'new\n');
    assert.equal(p.text(FILE)?.ccsid, 37);
  });

  test('changed on the system: Overwrite writes again without expect', async () => {
    let writes = 0;
    const { host, p } = provider((m) => {
      if (m === 'ifs.readText') {
        return { text: 'old\n', ccsid: 1208, size: 4, change: '41' };
      }
      if (m === 'ifs.writeText' && writes++ === 0) {
        throw CHANGED;
      }
      if (m === 'ifs.writeText') {
        return { size: 5, change: '100' };
      }
      return info('file');
    });
    const asked: string[] = [];
    p.conflictPrompt = async (c, path) => {
      asked.push(`${c} ${path}`);
      return OVERWRITE;
    };
    await p.readFile(FILE);
    await p.writeFile(FILE, enc.encode('mine\n'), { create: true, overwrite: true });
    assert.deepEqual(asked, ['IFS /home/CWELLMAN/utf8.txt']);
    const ws = host.sent.filter((s) => s.method === 'ifs.writeText').map((s) => s.params);
    assert.equal(ws.length, 2);
    assert.equal(ws[0].expect, '41');
    assert.equal(ws[1].expect, undefined);
    assert.equal(ws[1].mode, 'replace');
    assert.equal(p.text(FILE)?.change, '100');
  });

  test('changed on the system: Reload writes nothing and reads the system text again', async () => {
    let reads = 0;
    const { host, p } = provider((m) => {
      if (m === 'ifs.readText') {
        return reads++ === 0
          ? { text: 'old\n', ccsid: 1208, size: 4, change: '41' }
          : { text: 'theirs\n', ccsid: 1208, size: 7, change: '99' };
      }
      if (m === 'ifs.writeText') {
        throw CHANGED;
      }
      return info('file');
    });
    p.conflictPrompt = async () => RELOAD;
    await p.readFile(FILE);
    const before = (await p.stat(FILE)).mtime;
    const changed = new Promise<vscode.Uri>((resolve) => p.onDidChangeFile((e) => resolve(e[0].uri)));
    await p.writeFile(FILE, enc.encode('mine\n'), { create: true, overwrite: true });
    assert.equal((await changed).toString(), FILE.toString());
    assert.equal(host.sent.filter((s) => s.method === 'ifs.writeText').length, 1);
    assert.equal(p.text(FILE)?.text, 'theirs\n');
    assert.equal(p.text(FILE)?.change, '99');
    assert.ok((await p.stat(FILE)).mtime > before, 'a newer time, so the editor reloads');
  });

  test('changed on the system, the question dismissed: not saved', async () => {
    const { p } = provider((m) => {
      if (m === 'ifs.readText') {
        return { text: 'old\n', ccsid: 1208, size: 4, change: '41' };
      }
      if (m === 'ifs.writeText') {
        throw CHANGED;
      }
      return info('file');
    });
    p.conflictPrompt = async () => undefined;
    await p.readFile(FILE);
    await assert.rejects(p.writeFile(FILE, enc.encode('mine\n'), { create: true, overwrite: true }), /not saved/);
    assert.equal(p.text(FILE)?.change, '41');
  });

  test('a new file is created as 1208 with no expect', async () => {
    const { host, p } = provider((m) => {
      if (m === 'ifs.info') {
        throw NOT_FOUND;
      }
      return { size: 2, change: '1' };
    });
    await p.writeFile(FILE, enc.encode('a\n'), { create: true, overwrite: true });
    const w = host.sent.find((s) => s.method === 'ifs.writeText');
    assert.deepEqual(w?.params, { name: 'IFS', path: '/home/CWELLMAN/utf8.txt', text: 'a\n', mode: 'create' });
    await assert.rejects(p.writeFile(ifsUri('IFS', '/x'), enc.encode(''), { create: false, overwrite: true }), (e: vscode.FileSystemError) => e.code === 'FileNotFound');
  });

  test('a character the CCSID lacks: the save fails with TCP1A5A and what is kept stays', async () => {
    const { p } = provider((m) => {
      if (m === 'ifs.readText') {
        return { text: 'as typed\n', ccsid: 37, size: 9, change: '41' };
      }
      if (m === 'ifs.writeText') {
        throw TCP1A5A;
      }
      return info('file');
    });
    await p.readFile(FILE);
    await assert.rejects(p.writeFile(FILE, enc.encode('as typed 😀\n'), { create: true, overwrite: true }), /TCP1A5A: Data cannot be converted/);
    assert.equal(p.text(FILE)?.text, 'as typed\n');
    assert.equal(p.text(FILE)?.change, '41');
  });

  test('text over 10 MiB: refused naming the size and the limit', async () => {
    const { p } = provider(() => {
      throw new HostRpcError(IfsErrorCodes.TooLarge, 'too large', { size: 52_428_800, limit: DOCUMENT_LIMIT });
    });
    await assert.rejects(p.readFile(ifsUri('IFS', '/home/CWELLMAN/big.log')), /50\.0 MB \(52,428,800 bytes\); files open up to 10\.0 MB/);
  });

  test('an image is read as bytes through a temporary file, which is removed', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    let local = '';
    const { host, p } = provider((m, params) => {
      if (m === 'ifs.info') {
        return info('file', png.length);
      }
      if (m === 'ifs.download') {
        local = String(params.to);
        fs.writeFileSync(local, png);
        return { size: png.length };
      }
      throw new Error(m);
    });
    const bytes = await p.readFile(ifsUri('IFS', '/home/CWELLMAN/logo.PNG'));
    assert.deepEqual([...bytes], [...png]);
    assert.deepEqual(methods(host), ['ifs.info', 'ifs.download']);
    assert.equal(host.sent[1].params.path, '/home/CWELLMAN/logo.PNG');
    assert.ok(local !== '' && !fs.existsSync(local), 'the temporary file is gone');
    assert.equal(p.text(ifsUri('IFS', '/home/CWELLMAN/logo.PNG')), undefined);
  });

  test('an image over 10 MiB is refused before anything is downloaded', async () => {
    const { host, p } = provider(() => info('file', DOCUMENT_LIMIT + 1));
    await assert.rejects(p.readFile(ifsUri('IFS', '/home/CWELLMAN/scan.pdf')), /files open up to 10\.0 MB/);
    assert.deepEqual(methods(host), ['ifs.info']);
  });

  test('stat: a link is a link to what it resolves to; not found is FileNotFound', async () => {
    const { p } = provider((m, params) => {
      if (m === 'ifs.info' && params.path === '/l') {
        return { ...info('file'), kind: 'symlink', target: '/d' };
      }
      if (m === 'ifs.resolve') {
        return { path: '/d' };
      }
      if (m === 'ifs.info' && params.path === '/d') {
        return info('directory');
      }
      throw NOT_FOUND;
    });
    const s = await p.stat(ifsUri('IFS', '/l'));
    assert.equal(s.type, vscode.FileType.SymbolicLink | vscode.FileType.Directory);
    await assert.rejects(p.stat(ifsUri('IFS', '/nope')), (e: vscode.FileSystemError) => e.code === 'FileNotFound');
  });

  test('directories, rename and copy map to the host methods', async () => {
    const { host, p } = provider((m) =>
      m === 'ifs.list'
        ? [
            { ...info('directory'), name: 'src' },
            { ...info('file'), name: 'a.txt' },
            { ...info('file'), kind: 'symlink', name: 'l' },
          ]
        : m === 'ifs.info'
          ? info('file')
          : null,
    );
    assert.deepEqual(await p.readDirectory(ifsUri('IFS', '/home')), [
      ['src', vscode.FileType.Directory],
      ['a.txt', vscode.FileType.File],
      ['l', vscode.FileType.SymbolicLink | vscode.FileType.File],
    ]);
    await p.createDirectory(ifsUri('IFS', '/home/new'));
    await p.rename(ifsUri('IFS', '/home/a.txt'), ifsUri('IFS', '/home/b.txt'), { overwrite: false });
    await p.copy(ifsUri('IFS', '/home/b.txt'), ifsUri('IFS', '/tmp/b.txt'), { overwrite: true });
    await p.delete(ifsUri('IFS', '/tmp/b.txt'));
    assert.deepEqual(
      host.sent.slice(1).map((s) => [s.method, s.params]),
      [
        ['ifs.mkdir', { name: 'IFS', path: '/home/new', parents: false }],
        ['ifs.rename', { name: 'IFS', from: '/home/a.txt', to: '/home/b.txt', replace: false }],
        ['ifs.info', { name: 'IFS', path: '/home/b.txt' }],
        ['ifs.copy', { name: 'IFS', from: '/home/b.txt', to: '/tmp/b.txt', replace: true }],
        ['ifs.delete', { name: 'IFS', path: '/tmp/b.txt' }],
      ],
    );
  });

});
