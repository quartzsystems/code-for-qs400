// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { ConnectionStore } from '../src/connections/store';
import { ifsUri } from '../src/ifs/uri';
import { IncludeDeps, fetchInclude } from '../src/languages/includes';
import { memberUri } from '../src/members/uri';
import { WorkspaceIncludes } from '../src/projects/includes';
import { ProjectStore } from '../src/projects/store';

suite('Projects: includes from the workspace first', () => {
  let output: vscode.LogOutputChannel;
  let connections: ConnectionStore;
  let projects: ProjectStore;
  let lib: string;
  let ifs: string;
  let other: string;
  let ws: WorkspaceIncludes;

  const write = async (dir: string, rel: string, text: string) => {
    const f = nodePath.join(dir, ...rel.split('/'));
    await fs.mkdir(nodePath.dirname(f), { recursive: true });
    await fs.writeFile(f, text);
  };

  suiteSetup(async () => {
    output = vscode.window.createOutputChannel('includes test', { log: true });
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    connections = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    projects = new ProjectStore(connections, output);
    lib = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'qs4inc-lib-'));
    ifs = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'qs4inc-ifs-'));
    other = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'qs4inc-other-'));
    await projects.create(vscode.Uri.file(lib), { connection: 'PRJ', target: { kind: 'library', library: 'HLINVDEV' }, ignore: ['QRPGLESRC/SKIP*'] });
    await projects.create(vscode.Uri.file(ifs), { connection: 'PRJ', target: { kind: 'path', path: '/home/CWELLMAN/app' } });
    await projects.create(vscode.Uri.file(other), { connection: 'ELSE', target: { kind: 'library', library: 'ELSELIB' } });
    await write(lib, 'QRPGLESRC/ASSETS.rpgle', '**free\n/copy QRPGLESRC,ASSETCP\n');
    await write(lib, 'qrpglesrc/assetcp.rpgleinc', 'dcl-ds asset qualified;\nend-ds;\n');
    await write(lib, 'QRPGLESRC/SKIPME.rpgle', 'ignored\n');
    await write(ifs, 'src/main.rpgle', '**free\n/include ../inc/defs.rpgle\n');
    await write(ifs, 'inc/defs.rpgle', 'dcl-c ONE 1;\n');
    await write(other, 'QRPGLESRC/ASSETCP.rpgle', 'the other connection\n');
    ws = new WorkspaceIncludes(projects);
  });

  suiteTeardown(async () => {
    projects.dispose();
    connections.dispose();
    output.dispose();
    for (const d of [lib, ifs, other]) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  const local = (dir: string, rel: string) => vscode.Uri.file(nodePath.join(dir, ...rel.split('/')));
  const req = (file: string, member: string, library = '*LIBL') => ({ library, file, member });

  test('a /COPY from a local file: its own project’s FILE/MEMBER.*, any case, the library ignored', async () => {
    const r = await ws.find(local(lib, 'QRPGLESRC/ASSETS.rpgle').toString(), req('QRPGLESRC', 'ASSETCP', 'HLINV'), 'PRJ');
    assert.equal(r?.text, 'dcl-ds asset qualified;\nend-ds;\n');
    assert.deepEqual(r?.at, { kind: 'member', library: 'HLINVDEV', file: 'QRPGLESRC', member: 'ASSETCP' });
    assert.equal(vscode.Uri.parse(r?.uri ?? '').fsPath.toLowerCase(), local(lib, 'qrpglesrc/assetcp.rpgleinc').fsPath.toLowerCase());
    assert.equal(await ws.find(local(lib, 'QRPGLESRC/ASSETS.rpgle').toString(), req('QRPGLESRC', 'SKIPME'), 'PRJ'), null, 'an ignored file is no answer');
    assert.equal(await ws.find(local(lib, 'QRPGLESRC/ASSETS.rpgle').toString(), req('QRPGLESRC', 'NOSUCH'), 'PRJ'), null);
  });

  test('from a member on the system: only *LIBL, *CURLIB, none or the target library, and only on its connection', async () => {
    const doc = memberUri('PRJ', 'HLINVDEV', 'QRPGLESRC', 'ASSETS', 'RPGLE').toString();
    assert.ok(await ws.find(doc, req('QRPGLESRC', 'ASSETCP', '*LIBL'), 'PRJ'));
    assert.ok(await ws.find(doc, req('QRPGLESRC', 'ASSETCP', 'HLINVDEV'), 'PRJ'));
    assert.ok(await ws.find(doc, req('QRPGLESRC', 'ASSETCP', ''), 'PRJ'));
    assert.equal(await ws.find(doc, req('QRPGLESRC', 'ASSETCP', 'HLINV'), 'PRJ'), null, 'another library is the system’s');
    const elsewhere = await ws.find(memberUri('ELSE', 'ELSELIB', 'QRPGLESRC', 'X', 'RPGLE').toString(), req('QRPGLESRC', 'ASSETCP'), 'ELSE');
    assert.equal(elsewhere?.text, 'the other connection\n');
  });

  test('a stream file include: relative to a local file, or a path under an IFS project’s target', async () => {
    const r = await ws.find(local(ifs, 'src/main.rpgle').toString(), { library: '', file: '', member: '', path: '../inc/defs.rpgle' }, 'PRJ');
    assert.equal(r?.text, 'dcl-c ONE 1;\n');
    assert.deepEqual(r?.at, { kind: 'path', path: '/home/CWELLMAN/app/inc/defs.rpgle' });
    const fromSystem = await ws.find(
      ifsUri('PRJ', '/home/CWELLMAN/app/src/main.rpgle').toString(),
      { library: '', file: '/home/CWELLMAN/app/src', member: '', path: '/home/CWELLMAN/app/inc/defs.rpgle' },
      'PRJ',
    );
    assert.equal(fromSystem?.text, 'dcl-c ONE 1;\n');
  });

  test('the fetchInclude handler asks the workspace first and the system only when it has nothing', async () => {
    const sent: string[] = [];
    const deps: IncludeDeps = {
      call: (async (_name: string, method: string, params: Record<string, unknown>) => {
        sent.push(`${method} ${String(params.library)}/${String(params.file)}(${String(params.member)})`);
        return { type: 'RPGLE', text: 'from the system', width: 100, ccsid: 37, lines: [] };
      }) as IncludeDeps['call'],
      canonical: (n) => n,
      active: () => 'ACTIVE',
      log: () => undefined,
      local: (uri, request, connection) => ws.find(uri, request, connection),
      projectConnection: (uri) => ws.connectionOf(uri),
    };
    const uri = local(lib, 'QRPGLESRC/ASSETS.rpgle').toString();
    const hit = await fetchInclude(deps, { uri, request: req('QRPGLESRC', 'ASSETCP', 'HLINVDEV') });
    assert.equal(hit?.text, 'dcl-ds asset qualified;\nend-ds;\n');
    assert.deepEqual(sent, [], 'nothing asked of the system');
    const miss = await fetchInclude(deps, { uri, request: req('QRPGLESRC', 'NOSUCH', 'HLINVDEV') });
    assert.deepEqual(miss?.at, { kind: 'member', library: 'HLINVDEV', file: 'QRPGLESRC', member: 'NOSUCH' });
    assert.deepEqual(sent, ['member.read HLINVDEV/QRPGLESRC(NOSUCH)'], 'on the project’s connection');
  });

  test('saving a local file says which member or stream file changed', () => {
    assert.deepEqual(ws.changed(local(lib, 'qrpglesrc/assetcp.rpgleinc')), {
      connection: 'PRJ',
      member: { kind: 'member', library: 'HLINVDEV', file: 'QRPGLESRC', member: 'ASSETCP' },
    });
    assert.deepEqual(ws.changed(local(ifs, 'inc/defs.rpgle')), { connection: 'PRJ', member: { kind: 'path', path: '/home/CWELLMAN/app/inc/defs.rpgle' } });
    assert.equal(ws.changed(vscode.Uri.file(nodePath.join(os.tmpdir(), 'nowhere.rpgle'))), undefined);
  });
});
