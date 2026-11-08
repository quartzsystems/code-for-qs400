// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

// The Phase 1, 2, 3 and 4 exit tests' automatic steps against a real
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
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConnectionConfig, connectParams } from '../src/connections/config';
import { moved, withAdded } from '../src/connections/libraryList';
import { jobText } from '../src/actions/output';
import type { ExtensionApi } from '../src/extension';
import { HostRpcError } from '../src/host/client';
import { IfsErrorCodes, LibraryList, SessionErrorCodes } from '../src/host/protocol';
import { localTree } from '../src/ifs/transfers';
import { ifsUri } from '../src/ifs/uri';
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

// Phase 3: the IFS, under /home/<QS400_TEST_USER>/code-test, which the suite
// makes and removes. The EDTF and WRKLNK checks are by hand (CONTRIBUTING.md,
// "Phase 3 exit test").
suite('Live: Phase 3 exit test', function () {
  let api: ExtensionApi;
  const ROOT = `/home/${USER}/code-test`;
  const at = (name: string) => `${ROOT}/${name}`;
  const uri = (name: string) => ifsUri(NAME, at(name));
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const info = (path: string) => api.host.request('ifs.info', { name: NAME, path });
  const readText = (path: string) => api.host.request('ifs.readText', { name: NAME, path });
  const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  let local = '';

  const removeRoot = async () => {
    await api.ifsFs.delete(ifsUri(NAME, ROOT), { recursive: true }).catch(() => undefined);
  };

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
      await api.host.request('ifs.list', { name: NAME, path: `/home/${USER}` });
    } catch (err) {
      if (err instanceof HostRpcError && err.code === SessionErrorCodes.QapUnavailable) {
        console.log(`live: Phase 3 skipped: ${err.message}`);
        this.skip();
      }
      throw err;
    }
    await removeRoot();
    await api.host.request('ifs.mkdir', { name: NAME, path: ROOT, parents: true });
    local = fs.mkdtempSync(path.join(os.tmpdir(), 'qs400-live-ifs-'));
  });

  suiteTeardown(async function () {
    if (!api) {
      return;
    }
    await removeRoot();
    if (local) {
      fs.rmSync(local, { recursive: true, force: true });
    }
    await api.host.request('session.disconnect', { name: NAME }).catch(() => undefined);
    await config().update('connections', undefined, true);
  });

  test('utf8.txt: made from VS Code as 1208, é and — round-trip', async () => {
    const text = 'Grüße: é and — in UTF-8\n';
    await api.ifsFs.writeFile(uri('utf8.txt'), enc(text), { create: true, overwrite: false });
    const i = await info(at('utf8.txt'));
    assert.equal(i.ccsid, 1208);
    assert.equal((await readText(at('utf8.txt'))).text, text);
    api.ifsFs.forget(uri('utf8.txt'));
    assert.equal(dec(await api.ifsFs.readFile(uri('utf8.txt'))), text);
    console.log(`live: utf8.txt ${i.size} bytes, CCSID ${i.ccsid}, change ${i.change}`);
  });

  test('ebcdic.txt: New File with CCSID 37, typed, saved, read back; a character 37 lacks is refused and nothing is written', async () => {
    await api.host.request('ifs.writeText', { name: NAME, path: at('ebcdic.txt'), text: '', ccsid: 37, mode: 'create' });
    const typed = 'Typed in VS Code: café, naïve, 100%\n';
    await api.ifsFs.readFile(uri('ebcdic.txt'));
    await api.ifsFs.writeFile(uri('ebcdic.txt'), enc(typed), { create: true, overwrite: true });
    const i = await info(at('ebcdic.txt'));
    assert.equal(i.ccsid, 37);
    assert.equal(i.size, [...typed].length, 'one byte a character in CCSID 37');
    api.ifsFs.forget(uri('ebcdic.txt'));
    assert.equal(dec(await api.ifsFs.readFile(uri('ebcdic.txt'))), typed);
    await assert.rejects(api.ifsFs.writeFile(uri('ebcdic.txt'), enc(`${typed}Not in 37: 😀\n`), { create: true, overwrite: true }), (e: Error) => {
      console.log(`live: a character CCSID 37 lacks: ${e.message}`);
      return /TCP1A5A/.test(e.message);
    });
    const after = await readText(at('ebcdic.txt'));
    assert.equal(after.text, typed, 'unchanged');
    assert.equal(after.change, (await info(at('ebcdic.txt'))).change);
  });

  test('a save over a change made elsewhere is refused with the change', async () => {
    const first = await readText(at('utf8.txt'));
    await api.host.request('ifs.writeText', { name: NAME, path: at('utf8.txt'), text: 'elsewhere\n', mode: 'replace' });
    await assert.rejects(
      api.host.request('ifs.writeText', { name: NAME, path: at('utf8.txt'), text: 'mine\n', mode: 'replace', expect: first.change }),
      (e: HostRpcError) => e.code === IfsErrorCodes.Changed,
    );
    assert.equal((await readText(at('utf8.txt'))).text, 'elsewhere\n');
  });

  test('20 MB: cancelled half way, resumed, downloaded; the checksum matches', async function () {
    this.timeout(15 * 60_000);
    const size = 20 * 1024 * 1024;
    const from = path.join(local, 'twenty.dat');
    fs.writeFileSync(from, crypto.randomBytes(size));
    const transfer = `live-${Date.now()}`;
    let cancelled = false;
    let progressSeen = 0;
    const sub = api.host.onDidProgress((p) => {
      if (p.transfer !== transfer) {
        return;
      }
      progressSeen++;
      if (!cancelled && p.done >= size / 2) {
        cancelled = true;
        void api.host.request('ifs.cancel', { name: NAME, transfer });
      }
    });
    try {
      await assert.rejects(
        api.host.request('ifs.upload', { name: NAME, from, path: at('twenty.dat'), ccsid: 65535, mode: 'create', transfer }),
        (e: HostRpcError) => e.code === IfsErrorCodes.Cancelled,
      );
    } finally {
      sub.dispose();
    }
    const partial = await info(at('twenty.dat'));
    console.log(`live: 20 MB upload cancelled after ${progressSeen} progress notifications; the system has ${partial.size} of ${size} bytes`);
    assert.ok(partial.size < size, 'not complete');
    const r = await api.host.request('ifs.upload', { name: NAME, from, path: at('twenty.dat'), mode: 'resume' });
    assert.equal(r.size, size);
    assert.equal((await info(at('twenty.dat'))).size, size);
    const back = path.join(local, 'twenty.back');
    await api.host.request('ifs.download', { name: NAME, path: at('twenty.dat'), to: back });
    const a = sha256(from);
    const b = sha256(back);
    console.log(`live: sha256 uploaded ${a}, downloaded ${b}: ${a === b ? 'match' : 'DIFFER'}`);
    assert.equal(b, a);
  });

  test('the 20 MB file does not open as a document: the refusal names the size and the limit', async () => {
    await assert.rejects(api.ifsFs.readFile(uri('twenty.dat')), (e: Error) => {
      console.log(`live: opening 20 MB: ${e.message}`);
      return /20\.0 MB/.test(e.message) && /10\.0 MB/.test(e.message);
    });
  });

  test('a folder of three files up, and down into a new local folder: the trees match', async function () {
    this.timeout(5 * 60_000);
    const src = path.join(local, 'three');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'one.txt'), 'one\n');
    fs.writeFileSync(path.join(src, 'two.rpgle'), '**free\ndsply \'two\';\n');
    fs.writeFileSync(path.join(src, 'sub', 'three.bin'), crypto.randomBytes(3000));
    const tree = await localTree(src, at('three'));
    const total = tree.files.reduce((n, f) => n + f.size, 0);
    assert.equal(await api.transfers.upload(NAME, tree.files, 'create', tree.dirs), total);
    const listed = await api.host.request('ifs.list', { name: NAME, path: at('three') });
    assert.deepEqual(listed.map((e) => e.name).sort(), ['one.txt', 'sub', 'two.rpgle']);
    const dst = path.join(local, 'three-back');
    const files = tree.files.map((f) => ({ path: f.path, to: path.join(dst, path.relative(src, f.from)), size: f.size }));
    await api.transfers.download(NAME, files, [dst, path.join(dst, 'sub')]);
    for (const rel of ['one.txt', 'two.rpgle', path.join('sub', 'three.bin')]) {
      assert.deepEqual(fs.readFileSync(path.join(dst, rel)), fs.readFileSync(path.join(src, rel)), rel);
    }
  });

  test('rename, copy and delete; a directory not empty is deleted children first', async () => {
    await api.host.request('ifs.rename', { name: NAME, from: at('utf8.txt'), to: at('renamed.txt'), replace: false });
    await api.host.request('ifs.copy', { name: NAME, from: at('renamed.txt'), to: at('copied.txt'), replace: false });
    await assert.rejects(api.host.request('ifs.copy', { name: NAME, from: at('renamed.txt'), to: at('copied.txt'), replace: false }), (e: HostRpcError) => {
      console.log(`live: copy onto an existing file: ${e.message}`);
      return (e.data as { status?: string }).status === 'Exists';
    });
    await assert.rejects(api.host.request('ifs.delete', { name: NAME, path: at('three') }), (e: HostRpcError) => {
      console.log(`live: delete of a directory not empty: ${e.message}`);
      return true;
    });
    await api.ifsFs.delete(ifsUri(NAME, at('three')), { recursive: true });
    await api.host.request('ifs.delete', { name: NAME, path: at('copied.txt') });
    const names = (await api.host.request('ifs.list', { name: NAME, path: ROOT })).map((e) => e.name).sort();
    assert.deepEqual(names, ['ebcdic.txt', 'renamed.txt', 'twenty.dat']);
    await assert.rejects(info(at('gone.txt')), (e: HostRpcError) => {
      console.log(`live: not found: ${e.message}`);
      return (e.data as { status?: string }).status === 'NotFound';
    });
  });

  test('a .png opens as bytes for the image preview', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const from = path.join(local, 'dot.png');
    fs.writeFileSync(from, png);
    await api.host.request('ifs.upload', { name: NAME, from, path: at('dot.png'), ccsid: 65535, mode: 'create' });
    assert.deepEqual(Buffer.from(await api.ifsFs.readFile(uri('dot.png'))), png);
  });
});

// Phase 4: the test copies QS400_TEST_SOURCE to QS4ACT42 in
// QS400_TEST_SRCPF, breaks line 42 with a name nothing defines, compiles
// it with the default Compile (CRTBNDRPG) into the current library
// (QS400_TEST_CURLIB, default the user profile), fixes it, compiles again,
// CALLs the program QS400_TEST_SOURCE names, and reads the connection
// job's log. It removes its member at the end; the program it made stays in
// the current library.

const ACT = 'QS4ACT42';

suite('Live: Phase 4 exit test', function () {
  let api: ExtensionApi;
  const at = { name: NAME, library: SRC_LIB, file: SRC_FILE, member: ACT };
  const uri = () => memberUri(NAME, SRC_LIB, SRC_FILE, ACT, 'RPGLE');
  const enc = (s: string) => new TextEncoder().encode(s);
  let original: string[] = [];
  const seen: string[] = [];

  suiteSetup(async function () {
    if (!HOST || !USER || !PASSWORD || !SOURCE) {
      this.skip();
    }
    const ext = vscode.extensions.getExtension<ExtensionApi>('quartzsystems.code-for-qs400');
    assert.ok(ext);
    api = await ext.activate();
    const c: ConnectionConfig = {
      ...connection(),
      actions: [
        {
          name: 'Live: wrong SRCFILE',
          command: 'CRTBNDRPG PGM(&LIBRARY/&NAME) SRCFILE(&SRCLIB/QS4NOSRC) SRCMBR(&NAME) DBGVIEW(*SOURCE)',
          environment: 'member',
        },
      ],
    };
    await config().update('connections', [c], true);
    await api.sessions.signOn(c, { password: PASSWORD, save: false }, false);
    try {
      const list = await api.host.request('libl.get', { name: NAME });
      const curlib = (env.QS400_TEST_CURLIB ?? USER).toUpperCase();
      await api.host.request('libl.set', { name: NAME, current: curlib, user: list.user.filter((l) => l !== curlib) });
    } catch (err) {
      if (err instanceof HostRpcError && err.code === SessionErrorCodes.QapUnavailable) {
        console.log(`live: Phase 4 skipped: ${err.message}`);
        this.skip();
      }
      throw err;
    }
    const [, library, file, member] = SOURCE;
    await api.host.request('member.copy', { name: NAME, from: { library, file, member }, to: { library: SRC_LIB, file: SRC_FILE, member: ACT }, replace: true });
    original = (await api.host.request('member.read', { ...at, lock: false })).lines.map((l) => l.text);
  });

  suiteTeardown(async function () {
    if (!api) {
      return;
    }
    await api.members.release(uri()).catch(() => undefined);
    await api.host.request('member.delete', at).catch(() => undefined);
    await api.host.request('session.disconnect', { name: NAME }).catch(() => undefined);
    await config().update('connections', undefined, true);
  });

  const problems = () => api.diagnostics.collection.get(uri()) ?? [];
  const errors = () => problems().filter((d) => d.severity === vscode.DiagnosticSeverity.Error);

  test('line 42 broken: one error at line 42 of the member, with its ID and second-level text', async () => {
    const lines = [...original];
    while (lines.length < 42) {
      lines.push('');
    }
    const free = /^\s*\*\*free/i.test(lines[0] ?? '');
    lines[41] = free ? 'QS4UNDEF = 1;' : '     C                   EVAL      QS4UNDEF = 1';
    await api.members.writeFile(uri(), enc(lines.join('\n')), { create: false, overwrite: true });
    const r = await api.runner.run(uri(), 'Compile (CRTBNDRPG)');
    assert.ok(r?.outcome, `an outcome: ${String(r?.error)}`);
    console.log(`live: broken compile ${r.outcome.status}, escape ${r.outcome.escape?.id ?? 'none'}: ${r.outcome.escape?.text ?? ''}`);
    for (const d of r.outcome.diagnostics) {
      console.log(`live:   ${d.id} sev ${d.severity} ${d.at.kind === 'member' ? `${d.at.library}/${d.at.file}(${d.at.member})` : d.at.kind} line ${d.line} col ${d.column}-${d.endColumn}: ${d.text}`);
    }
    const e = errors();
    assert.equal(e.length, 1, `one error in the Problems panel: ${e.map((d) => `${String(d.code)} line ${d.range.start.line + 1}`).join(', ')}`);
    assert.equal(e[0].range.start.line, 41, 'at line 42');
    assert.match(String(e[0].code), /^[A-Z]{3}[0-9A-F]{4}$/);
    assert.ok(e[0].relatedInformation?.[0].message, 'the second-level text');
    if (r.outcome.escape) {
      seen.push(r.outcome.escape.id);
    }
  });

  test('fixed: the Problems entry clears, the completion message and the job come back', async () => {
    await api.members.writeFile(uri(), enc(original.join('\n')), { create: false, overwrite: true });
    const r = await api.runner.run(uri(), 'Compile (CRTBNDRPG)');
    assert.ok(r?.outcome);
    console.log(`live: fixed compile ${r.outcome.status}, job ${r.outcome.job ? jobText(r.outcome.job) : 'none'}, messages ${r.outcome.messages.map((m) => m.id).join(' ')}`);
    assert.equal(r.outcome.status, 'Ok');
    assert.ok(r.outcome.job);
    assert.equal(errors().length, 0);
    const last = r.outcome.messages[r.outcome.messages.length - 1];
    if (last) {
      seen.push(last.id);
    }
  });

  test('CALL from the Objects view: the messages, no Problems entries', async () => {
    const [, library, , member] = SOURCE as RegExpExecArray;
    const node = { kind: 'object', connection: NAME, entry: { library, object: member, type: '*PGM', attribute: 'RPGLE', text: '', size: 0, changed: 0, owner: '' } };
    const before = api.diagnostics.collection.get(uri())?.length ?? 0;
    const r = await api.runner.run(node, 'Call (CALL)');
    assert.ok(r?.outcome, `an outcome: ${String(r?.error)}`);
    console.log(`live: CALL ${library}/${member}: ${r.outcome.status}; ${r.outcome.messages.map((m) => `${m.id} ${m.text}`).join(' | ') || 'no messages'}`);
    assert.deepEqual(r.outcome.diagnostics, []);
    assert.equal(api.diagnostics.collection.get(uri())?.length ?? 0, before);
    seen.push(...r.outcome.messages.map((m) => m.id).filter((id) => id !== ''));
  });

  test('a bad command: CheckCommand answers the server’s message, nothing run', async () => {
    const check = await api.host.request('action.check', { name: NAME, command: 'CRTBNDRPGX PGM(QTEMP/SAMPLE)' });
    console.log(`live: CheckCommand CRTBNDRPGX: ${check.status}; ${check.messages.map((m) => `${m.id} ${m.text}`).join(' | ')}`);
    assert.equal(check.valid, false);
    assert.ok(check.messages.length > 0);
    const doc = await vscode.workspace.openTextDocument({
      language: 'jsonc',
      content: '[\n  { "name": "Bad", "environment": "member",\n    "command": "CRTBNDRPGX PGM(&LIBRARY/&NAME)" }\n]\n',
    });
    await api.sessions.setActive(NAME);
    const diags = await api.actions.validate(doc);
    assert.ok(diags.some((d) => d.range.start.line === 2 && d.code === check.messages[0].id), 'on the command’s line');
  });

  test('&SRCFILE wrong: the escape message is the server’s own', async () => {
    const r = await api.runner.run(uri(), 'Live: wrong SRCFILE');
    assert.ok(r?.outcome, `an outcome: ${String(r?.error)}`);
    console.log(`live: wrong SRCFILE: ${r.outcome.status}, escape ${r.outcome.escape?.id}: ${r.outcome.escape?.text}`);
    assert.notEqual(r.outcome.status, 'Ok');
    assert.ok(r.outcome.escape?.id);
    seen.push(r.outcome.escape.id);
  });

  test('job log of the connection job: the runs above, newest at the bottom', async () => {
    const log = await api.host.request('job.log', { name: NAME });
    console.log(`live: job log ${jobText(log.job)}, ${log.entries.length} entries; the last ten:`);
    for (const e of log.entries.slice(-10)) {
      console.log(`live:   ${e.id || '-------'} ${e.kind} ${e.text}`);
    }
    for (let i = 1; i < log.entries.length; i++) {
      assert.ok(log.entries[i].sent >= log.entries[i - 1].sent, 'oldest first');
    }
    const ids = new Set(log.entries.map((e) => e.id));
    for (const id of seen) {
      assert.ok(ids.has(id), `${id} is in the job log`);
    }
    const doc = await api.jobLog.open(NAME);
    assert.ok(doc);
    assert.equal(doc.lineCount - 1, log.entries.length);
  });
});
