// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

// The Phase 1 exit test's connect and library list steps against a real
// QS/400 system. Skipped unless QS400_TEST_HOST, QS400_TEST_USER and
// QS400_TEST_PASSWORD are set. Optional: QS400_TEST_PORT, QS400_TEST_CA_FILE,
// QS400_TEST_LIBRARY (added to the list, default QGPL) and
// QS400_TEST_CURLIB (set as the current library, default the user profile).
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

suite('Live: Phase 1 exit test', function () {
  let api: ExtensionApi;
  const config = () => vscode.workspace.getConfiguration('code-for-qs400');

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
      if (err instanceof HostRpcError && err.code === SessionErrorCodes.LibraryListUnavailable) {
        console.log(`live: library list skipped: ${err.message} (blocked on QAP library_list)`);
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
