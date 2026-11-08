// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

// The Phase 1 and Phase 2 exit tests' automatic steps against a real
// QS/400 system. Skipped unless QS400_TEST_HOST, QS400_TEST_USER and
// QS400_TEST_PASSWORD are set. Optional: QS400_TEST_PORT, QS400_TEST_CA_FILE,
// QS400_TEST_LIBRARY (added to the list, default QGPL),
// QS400_TEST_CURLIB (set as the current library, default the user profile),
// QS400_TEST_SRCPF (the source file Phase 2 makes its members in, default
// HLINV/QTMPSRC) and QS400_TEST_SOURCE (the member it copies, default
// HLINV/QRPGLESRC(ASSETS)).
// No step signs on with a wrong password: an unattended run must never count
// against QMAXSIGN. Wrong passwords, lockout and expiry are checked by hand
// (CONTRIBUTING.md, "Phase 1 exit test").

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ConnectionConfig, connectParams } from '../src/connections/config';
import { moved, withAdded } from '../src/connections/libraryList';
import type { ExtensionApi } from '../src/extension';
import { HostRpcError } from '../src/host/client';
import { LibraryList, SessionErrorCodes } from '../src/host/protocol';
import { seqValue } from '../src/members/diff';
import { memberUri } from '../src/members/uri';

const env = process.env;
const HOST = env.QS400_TEST_HOST ?? '';
const USER = (env.QS400_TEST_USER ?? '').toUpperCase();
const PASSWORD = env.QS400_TEST_PASSWORD ?? '';
const NAME = 'QS400 live test';

function connection(): ConnectionConfig {
  const c: ConnectionConfig = { name: NAME, host: HOST, user: USER };
  if (env.QS400_TEST_PORT) {
    c.port = Number(env.QS400_TEST_PORT);
  }
  if (env.QS400_TEST_CA_FILE) {
    c.tls = { caFile: env.QS400_TEST_CA_FILE };
  }
  return c;
}

async function until<T>(what: string, f: () => T | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) {
      return v;
    }
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const config = () => vscode.workspace.getConfiguration('code-for-qs400');

suite('Live: Phase 1 exit test', function () {
  let api: ExtensionApi;

  suiteSetup(async function () {
    if (!HOST || !USER || !PASSWORD) {
      console.log('live tests skipped: set QS400_TEST_HOST, QS400_TEST_USER and QS400_TEST_PASSWORD');
      this.skip();
    }
    const ext = vscode.extensions.getExtension<ExtensionApi>('quartzsystems.code-for-qs400');
    assert.ok(ext);
    api = await ext.activate();
    await config().update('connections', [connection()], true);
  });

  suiteTeardown(async function () {
    if (!api) {
      return;
    }
    await api.host.request('session.disconnect', { name: NAME }).catch(() => undefined);
    await config().update('connections', undefined, true);
  });

  test('connect: the status names the user and the session job', async () => {
    const s = await api.host.request('session.connect', connectParams(connection(), PASSWORD));
    assert.equal(s.state, 'connected');
    assert.equal(s.user, USER);
    assert.ok(s.job, 'a session job');
    assert.match(s.job.number, /^\d{6}$/);
    assert.equal(s.job.user, USER);
    assert.ok(s.system);
    assert.match(s.system.version, /^V\d+R\d+M\d+$/);
    console.log(`live: ${s.system.name} ${s.system.product} ${s.system.version}, QAP ${s.system.qap}, job ${s.job.number}/${s.job.user}/${s.job.name}`);
    assert.deepEqual(await api.host.request('session.status', { name: NAME }), s);
    await api.host.request('session.disconnect', { name: NAME });
    assert.equal((await api.host.request('session.status', { name: NAME })).state, 'disconnected');
  });

  test('library list: add, move to the top, set current; it comes back as saved', async function () {
    const c = connection();
    const lib = (env.QS400_TEST_LIBRARY ?? 'QGPL').toUpperCase();
    const curlib = (env.QS400_TEST_CURLIB ?? USER).toUpperCase();
    await api.sessions.signOn(c, { password: PASSWORD, save: false }, false);
    try {
      await api.host.request('libl.get', { name: NAME });
    } catch (err) {
      if (err instanceof HostRpcError && err.code === SessionErrorCodes.QapUnavailable) {
        console.log(`live: library list skipped: ${err.message} (the server is below QAP version 8)`);
        this.skip();
      }
      throw err;
    }
    const start = await api.host.request('libl.get', { name: NAME });
    let list: LibraryList | undefined = start;
    list = await api.libraryList.apply(NAME, withAdded(list, lib));
    assert.ok(list?.user.includes(lib));
    while (list && list.user.indexOf(lib) > 0) {
      list = await api.libraryList.apply(NAME, moved(list, list.user.indexOf(lib), -1));
    }
    assert.equal(list?.user[0], lib);
    list = await api.libraryList.apply(NAME, { current: curlib, user: list.user.filter((l) => l !== curlib) });
    assert.equal(list?.current, curlib);
    const saved = api.store.get(NAME)?.libraryList;
    assert.deepEqual(saved, { current: curlib, user: list.user });

    await api.sessions.disconnect(NAME);
    const again = await api.sessions.signOn(c, { password: PASSWORD, save: false }, false);
    assert.equal(again?.state, 'connected');
    const back = await until('the saved list applied', () => {
      const d = api.libraryList.node(NAME).description;
      return typeof d === 'string' && d.includes(curlib) ? d : undefined;
    });
    assert.equal(back, `*CURLIB ${curlib}`);
    const now = await api.host.request('libl.get', { name: NAME });
    assert.equal(now.current, curlib);
    assert.deepEqual(now.user, saved?.user);

    // Leave the saved list as it was before the test.
    await api.libraryList.apply(NAME, { current: start.current, user: start.user });
  });
});

// Phase 2: the test makes and removes its own members (QS4*) in
// QS400_TEST_SRCPF, which must exist (no host method creates objects), and
// copies QS400_TEST_SOURCE into it with CPYSRCF, which keeps sequence
// numbers and dates. The real member is only read. The lock scenario needs
// a 5250 session holding the member and is run by hand (CONTRIBUTING.md,
// "Phase 2 exit test").

const [SRC_LIB, SRC_FILE] = (env.QS400_TEST_SRCPF || 'HLINV/QTMPSRC').toUpperCase().split('/');
const SOURCE = /^([^/]+)\/([^(]+)\(([^)]+)\)$/.exec((env.QS400_TEST_SOURCE || 'HLINV/QRPGLESRC(ASSETS)').toUpperCase());
const MEMBERS = ['QS4TODAY', 'QS4LIVE', 'QS4TIGHT', 'QS4NEW', 'QS4COPY', 'QS4REN'];

suite('Live: Phase 2 exit test', function () {
  let api: ExtensionApi;
  /** Every host method sent while the spy is on. */
  const sent: string[] = [];
  let unspy: (() => void) | undefined;
  const at = (member: string) => ({ name: NAME, library: SRC_LIB, file: SRC_FILE, member });
  const uri = (member: string) => memberUri(NAME, SRC_LIB, SRC_FILE, member, 'RPGLE');
  const enc = (s: string) => new TextEncoder().encode(s);
  const read = (member: string) => api.host.request('member.read', { ...at(member), lock: false });
  const save = (member: string, lines: string[]) =>
    api.members.writeFile(uri(member), enc(lines.join('\n')), { create: false, overwrite: true });
  let today = '';

  suiteSetup(async function () {
    if (!HOST || !USER || !PASSWORD) {
      this.skip();
    }
    const ext = vscode.extensions.getExtension<ExtensionApi>('quartzsystems.code-for-qs400');
    assert.ok(ext);
    api = await ext.activate();
    await config().update('connections', [connection()], true);
    await api.sessions.signOn(connection(), { password: PASSWORD, save: false }, false);
    try {
      await api.host.request('member.list', { name: NAME, library: SRC_LIB, file: SRC_FILE });
    } catch (err) {
      if (err instanceof HostRpcError && err.code === SessionErrorCodes.QapUnavailable) {
        console.log(`live: Phase 2 skipped: ${err.message}`);
        this.skip();
      }
      throw err;
    }
    for (const m of MEMBERS) {
      await api.host.request('member.delete', at(m)).catch(() => undefined);
    }
    // The server's today: the date of a record it has just written.
    await api.host.request('member.create', { ...at('QS4TODAY'), type: 'TXT', text: 'Code for QS/400 live test' });
    await api.host.request('member.write', {
      ...at('QS4TODAY'),
      lines: [{ seq: '0001.00', date: '000000', text: 'x' }],
      renumber: false,
    });
    today = (await read('QS4TODAY')).lines[0].date;
    console.log(`live: the server's date is ${today}`);
    const request = api.host.request.bind(api.host);
    const spy = (method: string, ...rest: unknown[]) => {
      sent.push(method);
      return (request as (m: string, ...r: unknown[]) => Promise<unknown>)(method, ...rest);
    };
    (api.host as unknown as { request: unknown }).request = spy;
    unspy = () => ((api.host as unknown as { request: unknown }).request = request);
  });

  suiteTeardown(async function () {
    if (!api) {
      return;
    }
    unspy?.();
    for (const m of MEMBERS) {
      await api.members.release(uri(m)).catch(() => undefined);
      await api.host.request('member.delete', at(m)).catch(() => undefined);
    }
    await api.host.request('session.disconnect', { name: NAME }).catch(() => undefined);
    await config().update('connections', undefined, true);
  });

  test('a copy saved with no change: nothing written, identical to the original, dates kept', async function () {
    if (!SOURCE) {
      this.skip();
    }
    const [, library, file, member] = SOURCE;
    const from = { library, file, member };
    await api.host.request('member.copy', {
      name: NAME,
      from,
      to: { library: SRC_LIB, file: SRC_FILE, member: 'QS4LIVE' },
      replace: true,
    });
    const original = await api.host.request('member.read', { name: NAME, ...from, lock: false });
    const text = new TextDecoder().decode(await api.members.readFile(uri('QS4LIVE')));
    sent.length = 0;
    await api.members.writeFile(uri('QS4LIVE'), enc(text), { create: false, overwrite: true });
    assert.ok(!sent.includes('member.write'), `no WriteMember: ${sent.join(', ')}`);
    assert.deepEqual((await read('QS4LIVE')).lines, original.lines, 'CMPPFM: identical, dates unchanged');
  });

  test('one line changed: today on that line, its seq kept; every other line as it was', async function () {
    const before = (await read('QS4LIVE')).lines;
    if (before.length < 3) {
      this.skip();
    }
    const k = Math.floor(before.length / 2);
    await save(
      'QS4LIVE',
      before.map((l, i) => (i === k ? `${l.text} // changed by the live test` : l.text)),
    );
    const after = (await read('QS4LIVE')).lines;
    assert.equal(after.length, before.length);
    assert.equal(after[k].seq, before[k].seq);
    assert.equal(after[k].date, today);
    after.forEach((l, i) => {
      if (i !== k) {
        assert.deepEqual(l, before[i], `line ${i + 1}`);
      }
    });
  });

  test('two lines inserted in a gap: seqs between the neighbours, dated today', async function () {
    const before = (await read('QS4LIVE')).lines;
    if (before.length < 2) {
      this.skip();
    }
    const texts = before.map((l) => l.text);
    texts.splice(1, 0, '// inserted 1', '// inserted 2');
    await save('QS4LIVE', texts);
    const after = (await read('QS4LIVE')).lines;
    const [lo, hi] = [seqValue(before[0].seq), seqValue(before[1].seq)];
    for (const l of [after[1], after[2]]) {
      assert.ok(seqValue(l.seq) > lo && seqValue(l.seq) < hi, `${l.seq} between ${before[0].seq} and ${before[1].seq}`);
      assert.equal(l.date, today);
    }
    assert.ok(seqValue(after[1].seq) < seqValue(after[2].seq));
  });

  test('an insert with no gap left renumbers from 0001.00', async () => {
    await api.host.request('member.create', { ...at('QS4TIGHT'), type: 'RPGLE', text: '' });
    await api.host.request('member.write', {
      ...at('QS4TIGHT'),
      lines: [
        { seq: '0001.00', date: '000000', text: 'a' },
        { seq: '0001.01', date: '000000', text: 'b' },
      ],
      renumber: false,
    });
    await api.members.readFile(uri('QS4TIGHT'));
    await save('QS4TIGHT', ['a', 'new', 'b']);
    assert.deepEqual(
      (await read('QS4TIGHT')).lines.map((l) => [l.seq, l.text]),
      [
        ['0001.00', 'a'],
        ['0002.00', 'new'],
        ['0003.00', 'b'],
      ],
    );
  });

  test('create, copy, rename and delete show in the member list', async () => {
    const names = async () =>
      (await api.host.request('member.list', { name: NAME, library: SRC_LIB, file: SRC_FILE, pattern: 'QS4*' })).map(
        (m) => m.member,
      );
    const copy = (replace: boolean) =>
      api.host.request('member.copy', {
        name: NAME,
        from: { library: SRC_LIB, file: SRC_FILE, member: 'QS4NEW' },
        to: { library: SRC_LIB, file: SRC_FILE, member: 'QS4COPY' },
        replace,
      });
    await api.host.request('member.create', { ...at('QS4NEW'), type: 'CLLE', text: 'Made by the live test' });
    assert.ok((await names()).includes('QS4NEW'));
    await copy(false);
    assert.ok((await names()).includes('QS4COPY'));
    await assert.rejects(copy(false), (e: HostRpcError) => {
      console.log(`live: copy onto an existing member: ${e.message}`);
      return (e.data as { status?: string }).status === 'Exists';
    });
    await api.host.request('member.rename', { ...at('QS4COPY'), newName: 'QS4REN' });
    await api.host.request('member.changeText', { ...at('QS4REN'), text: 'Renamed by the live test' });
    const listed = await api.host.request('member.list', { name: NAME, library: SRC_LIB, file: SRC_FILE, pattern: 'QS4REN' });
    assert.deepEqual(
      listed.map((m) => [m.member, m.type, m.text]),
      [['QS4REN', 'CLLE', 'Renamed by the live test']],
    );
    await api.host.request('member.delete', at('QS4REN'));
    await api.host.request('member.delete', at('QS4NEW'));
    const left = await names();
    assert.ok(!left.includes('QS4REN') && !left.includes('QS4NEW'));
  });

  test('unlocking a member this connection does not hold is TCP1A61', async () => {
    await assert.rejects(api.host.request('member.unlock', at('QS4TODAY')), (e: HostRpcError) => {
      console.log(`live: unlock without a lock: ${e.message}`);
      return (e.data as { messageId?: string }).messageId === 'TCP1A61';
    });
  });

  test('a member held by STRSEU opens read-only with CPF1002 (manual)', function () {
    console.log('live: the lock scenario is manual: hold the member with STRSEU at a 5250 session (CONTRIBUTING.md)');
    this.skip();
  });
});
