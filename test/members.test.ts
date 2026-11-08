// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient, HostRpcError } from '../src/host/client';
import { SessionErrorCodes, SessionStatus, SourceLine } from '../src/host/protocol';
import { MemberFsProvider } from '../src/members/provider';
import { memberType, typeForExtension } from '../src/members/types';
import { isReadonlyUri, memberUri, parseMemberUri } from '../src/members/uri';

suite('Members: the type table', () => {
  test('every type in the table: extension and language', () => {
    const table: [string, string, string][] = [
      ['RPGLE', 'rpgle', 'qs400-rpgle'],
      ['SQLRPGLE', 'sqlrpgle', 'qs400-rpgle'],
      ['RPG', 'rpg', 'qs400-rpgle'],
      ['CLLE', 'clle', 'qs400-cl'],
      ['CLP', 'clp', 'qs400-cl'],
      ['CL', 'cl', 'qs400-cl'],
      ['PF', 'pf', 'qs400-dds'],
      ['LF', 'lf', 'qs400-dds'],
      ['DSPF', 'dspf', 'qs400-dds'],
      ['PRTF', 'prtf', 'qs400-dds'],
      ['ICFF', 'icff', 'qs400-dds'],
      ['CMD', 'cmd', 'qs400-cmd'],
      ['SQL', 'sql', 'qs400-sql'],
      ['C', 'c', 'c'],
      ['CPP', 'cpp', 'cpp'],
      ['TXT', 'txt', 'plaintext'],
      ['BND', 'bnd', 'plaintext'],
      ['PNLGRP', 'pnlgrp', 'plaintext'],
      ['MENU', 'menu', 'plaintext'],
    ];
    for (const [type, ext, language] of table) {
      assert.deepEqual(memberType(type), { ext, language }, type);
      assert.deepEqual(memberType(type.toLowerCase()), { ext, language }, type.toLowerCase());
      assert.equal(typeForExtension(ext), type, ext);
    }
  });

  test('an unknown type is its name in lower case, plain text; no type is .mbr', () => {
    assert.deepEqual(memberType('RPGLEINC'), { ext: 'rpgleinc', language: 'plaintext' });
    assert.equal(typeForExtension('rpgleinc'), 'RPGLEINC');
    assert.deepEqual(memberType(''), { ext: 'mbr', language: 'plaintext' });
    assert.equal(typeForExtension('mbr'), '');
  });

  test('the languages are registered', async () => {
    const ids = await vscode.languages.getLanguages();
    for (const id of ['qs400-rpgle', 'qs400-cl', 'qs400-dds', 'qs400-sql', 'qs400-cmd']) {
      assert.ok(ids.includes(id), id);
    }
  });
});

suite('Members: URIs', () => {
  test('qs400mbr://<connection>/<LIBRARY>/<FILE>/<MEMBER>.<ext>, upper case, round trip', () => {
    const uri = memberUri('QSHQ400', 'hlinv', 'qrpglesrc', 'assets', 'RPGLE');
    assert.equal(uri.toString(), 'qs400mbr://qshq400/HLINV/QRPGLESRC/ASSETS.rpgle');
    assert.equal(uri.authority, 'QSHQ400');
    assert.deepEqual(parseMemberUri(uri), {
      kind: 'member',
      connection: 'QSHQ400',
      library: 'HLINV',
      file: 'QRPGLESRC',
      member: 'ASSETS',
      ext: 'rpgle',
    });
    const ro = memberUri('QSHQ400', 'HLINV', 'QRPGLESRC', 'ASSETS', 'RPGLE', true);
    assert.ok(isReadonlyUri(ro) && !isReadonlyUri(uri));
    assert.deepEqual(parseMemberUri(vscode.Uri.parse('qs400mbr://Q/HLINV/QTMPSRC')), {
      kind: 'file',
      connection: 'Q',
      library: 'HLINV',
      file: 'QTMPSRC',
    });
    assert.equal(parseMemberUri(vscode.Uri.parse('file:///HLINV/QRPGLESRC/ASSETS.rpgle')), undefined);
  });
});

/** A host answering from a function. */
export class FakeHost {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  private readonly session = new vscode.EventEmitter<SessionStatus>();
  private readonly state = new vscode.EventEmitter<string>();
  readonly onDidChangeSession = this.session.event;
  readonly onDidChangeState = this.state.event;
  constructor(public answer: (method: string, params: Record<string, unknown>) => unknown) {}
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    return this.answer(method, params);
  }
  methods(): string[] {
    return this.sent.map((s) => `${s.method}${'lock' in s.params ? ` lock=${String(s.params.lock)}` : ''}`);
  }
  dispose(): void {
    this.session.dispose();
    this.state.dispose();
  }
}

export class Memento implements vscode.Memento {
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

export const LINES: SourceLine[] = [
  { seq: '0001.00', date: '260105', text: '**free' },
  { seq: '0002.00', date: '260105', text: 'dcl-s count int(10);' },
  { seq: '0003.00', date: '000000', text: '' },
  { seq: '0004.00', date: '251231', text: '*inlr = *on;' },
];

export const CPF1002 = new HostRpcError(SessionErrorCodes.Server, 'CPF1002: Cannot allocate member ASSETS.', {
  status: 'InUse',
  messageId: 'CPF1002',
  text: 'Cannot allocate member ASSETS.',
  secondLevel: 'Cause . . . . . :   Member ASSETS is in use by job 123456/CWELLMAN/QPADEV0001.',
});

/** A member provider on a fake host, `MBR` signed on. */
export function memberFs(output: vscode.LogOutputChannel, answer: (method: string, params: Record<string, unknown>) => unknown) {
  const host = new FakeHost(answer);
  const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
  const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
  const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
  const fs = new MemberFsProvider(sessions, store, output);
  sessions.update({ name: 'MBR', state: 'connected', user: 'CWELLMAN' });
  return { host, store, sessions, fs, parts: [fs, sessions, store, host] as vscode.Disposable[] };
}

export const ASSETS = memberUri('MBR', 'HLINV', 'QRPGLESRC', 'ASSETS', 'RPGLE');

suite('Members: the qs400mbr provider', () => {
  let output: vscode.LogOutputChannel;
  const parts: vscode.Disposable[] = [];
  const read = { type: 'RPGLE', text: 'Asset register', width: 100, ccsid: 37, lines: LINES };

  const config = () => vscode.workspace.getConfiguration('code-for-qs400');

  suiteSetup(async () => {
    output = vscode.window.createOutputChannel('members test', { log: true });
    await config().update('connections', [{ name: 'MBR', host: 'h.example', user: 'CWELLMAN' }], true);
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

  test('a URI whose authority came back lower case still names the saved connection', async () => {
    const t = memberFs(output, () => read);
    parts.push(...t.parts);
    await t.fs.stat(vscode.Uri.parse(ASSETS.toString()));
    assert.equal(ASSETS.toString(), 'qs400mbr://mbr/HLINV/QRPGLESRC/ASSETS.rpgle');
    assert.equal(t.host.sent[0].params.name, 'MBR');
  });

  test('opening locks the member and shows its lines joined with \\n; it is read once', async () => {
    const t = memberFs(output, () => read);
    parts.push(...t.parts);
    const stat = await t.fs.stat(ASSETS);
    assert.equal(stat.type, vscode.FileType.File);
    assert.equal(stat.permissions, undefined, 'writable');
    const text = new TextDecoder().decode(await t.fs.readFile(ASSETS));
    assert.equal(text, '**free\ndcl-s count int(10);\n\n*inlr = *on;');
    assert.deepEqual(t.host.sent, [
      {
        method: 'member.read',
        params: { name: 'MBR', library: 'HLINV', file: 'QRPGLESRC', member: 'ASSETS', lock: true },
      },
    ]);
    assert.equal(t.fs.member(ASSETS)?.locked, true);
    assert.deepEqual(t.fs.member(ASSETS)?.lines, LINES);
  });

  test('a member another job holds: CPF1002, then read without a lock, read-only', async () => {
    const t = memberFs(output, (_, p) => {
      if (p.lock) {
        throw CPF1002;
      }
      return read;
    });
    parts.push(...t.parts);
    const stat = await t.fs.stat(ASSETS);
    assert.equal(stat.permissions, vscode.FilePermission.Readonly);
    assert.deepEqual(t.host.methods(), ['member.read lock=true', 'member.read lock=false']);
    assert.equal(t.fs.member(ASSETS)?.locked, false);
    await assert.rejects(t.fs.writeFile(ASSETS, new TextEncoder().encode('x'), { create: false, overwrite: true }), vscode.FileSystemError);
  });

  test('opened read-only: lock false, no unlock on release', async () => {
    const t = memberFs(output, () => read);
    parts.push(...t.parts);
    const ro = memberUri('MBR', 'HLINV', 'QRPGLESRC', 'ASSETS', 'RPGLE', true);
    assert.equal((await t.fs.stat(ro)).permissions, vscode.FilePermission.Readonly);
    await t.fs.release(ro);
    assert.deepEqual(t.host.methods(), ['member.read lock=false']);
  });

  test('release ends the lock and forgets the member', async () => {
    const t = memberFs(output, (m) => (m === 'member.read' ? read : null));
    parts.push(...t.parts);
    await t.fs.stat(ASSETS);
    await t.fs.release(ASSETS);
    assert.deepEqual(t.host.methods(), ['member.read lock=true', 'member.unlock']);
    assert.equal(t.fs.member(ASSETS), undefined);
  });

  test('a reconnect takes the locks again and reports one it lost', async () => {
    let held = false;
    const t = memberFs(output, (m, p) => {
      if (m === 'member.read' && p.lock && held) {
        throw CPF1002;
      }
      return read;
    });
    parts.push(...t.parts);
    await t.fs.stat(ASSETS);
    t.sessions.update({ name: 'MBR', state: 'stale', user: 'CWELLMAN' });
    assert.equal(t.fs.member(ASSETS)?.locked, false, 'the lock went with the connection');
    held = true;
    t.host.sent.length = 0;
    t.sessions.update({ name: 'MBR', state: 'connected', user: 'CWELLMAN' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(t.host.methods(), ['member.read lock=true', 'member.read lock=false']);
    assert.equal(t.fs.member(ASSETS)?.readonly, true);
  });

  test('directories: a file lists members, a library lists source files; no directories made', async () => {
    const t = memberFs(output, (m) => {
      if (m === 'member.list') {
        return [{ member: 'ASSETS', type: 'RPGLE', text: '', records: 4, created: 0, changed: 0 }];
      }
      return [{ library: 'HLINV', object: 'QRPGLESRC', type: '*FILE', attribute: 'PF-SRC', text: '', size: 0, changed: 0, owner: '' }];
    });
    parts.push(...t.parts);
    assert.deepEqual(await t.fs.readDirectory(vscode.Uri.parse('qs400mbr://MBR/HLINV/QRPGLESRC')), [
      ['ASSETS.rpgle', vscode.FileType.File],
    ]);
    assert.deepEqual(await t.fs.readDirectory(vscode.Uri.parse('qs400mbr://MBR/HLINV')), [
      ['QRPGLESRC', vscode.FileType.Directory],
    ]);
    assert.deepEqual(t.host.sent[1].params, {
      name: 'MBR',
      library: 'HLINV',
      pattern: '*ALL',
      types: ['*FILE'],
      attribute: 'PF-SRC',
    });
    assert.throws(
      () => t.fs.createDirectory(),
      (e: Error) => e instanceof vscode.FileSystemError && e.message.includes('Create objects from the Objects view'),
    );
  });
});
