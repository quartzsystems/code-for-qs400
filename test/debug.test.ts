// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension';
import { HostDebugAdapter } from '../src/debug/adapter';
import { callCommand, clParameter, completeConfiguration, initialConfigurations, jobName, programName, type Qs400DebugConfiguration } from '../src/debug/config';
import { type DebugSourceDeps, resolveDebugSource } from '../src/debug/source';
import { StatementsProvider, statementLine } from '../src/debug/statements';
import { programOfEntry } from '../src/debug/programs';
import { parsePrograms } from '../src/debug/commands';
import { debugStatusText } from '../src/debug/statusBar';
import type { ObjectProperty } from '../src/host/protocol';

const EXTENSION_ID = 'quartzsystems.code-for-qs400';

async function api(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

function launch(extra: Partial<Qs400DebugConfiguration> = {}): Qs400DebugConfiguration {
  return { type: 'qs400', request: 'launch', name: 'Call', ...extra };
}

suite('Debug: configurations', () => {
  test('parameters are quoted as CL needs them', () => {
    assert.equal(clParameter(42), '42');
    assert.equal(clParameter(-3.5), '-3.5');
    assert.equal(clParameter('DESK'), "'DESK'");
    assert.equal(clParameter("O'Brien's"), "'O''Brien''s'");
    assert.equal(clParameter(''), "''");
    assert.equal(clParameter('42'), "'42'", 'a string stays a string');
    assert.throws(() => clParameter(1e21), /give it as a string/);
    assert.throws(() => clParameter(Number.NaN));
    assert.equal(callCommand('HLINV/ASSETS'), 'CALL PGM(HLINV/ASSETS)');
    assert.equal(callCommand('HLINV/ASSETS', []), 'CALL PGM(HLINV/ASSETS)');
    assert.equal(callCommand('HLINV/ASSETS', ['DESK', 3, "it's", '']), "CALL PGM(HLINV/ASSETS) PARM('DESK' 3 'it''s' '')");
  });

  test('names: programs and jobs', () => {
    assert.equal(programName('hlinv/assets'), 'HLINV/ASSETS');
    assert.equal(programName('ASSETS'), '*LIBL/ASSETS');
    assert.equal(programName('*CURLIB/ASSETS'), '*CURLIB/ASSETS');
    assert.equal(programName('A/B/C'), undefined);
    assert.equal(programName('HLINV/'), undefined);
    assert.equal(programName('HLINV/TOOLONGNAME1'), undefined);
    assert.equal(jobName('123456/cwellman/qpadev0001'), '123456/CWELLMAN/QPADEV0001');
    assert.equal(jobName('12345/CWELLMAN/QPADEV0001'), undefined);
    assert.equal(jobName('123456/CWELLMAN'), undefined);
    assert.equal(programOfEntry({ library: 'HLINV', object: 'ASSETS', type: '*PGM' }), 'HLINV/ASSETS');
    assert.equal(programOfEntry({ library: 'HLINV', object: 'ASSETS', type: '*FILE' }), undefined);
  });

  test('the provider fills in the connection and program and builds the CALL', () => {
    const c = completeConfiguration(launch({ parameters: ['DESK', 2] }), { connection: 'QSHQ400', program: 'HLINV/ASSETS' });
    assert.ok(typeof c !== 'string');
    assert.equal(c.connection, 'QSHQ400');
    assert.equal(c.program, 'HLINV/ASSETS');
    assert.equal(c.mode, 'call');
    assert.equal(c.command, "CALL PGM(HLINV/ASSETS) PARM('DESK' 2)");
    assert.equal(c.recompileOffer, true);
    assert.deepEqual(c.programs, []);

    // What launch.json says wins over the window.
    const own = completeConfiguration(launch({ connection: 'OTHER', program: 'hlinvdev/assets', programs: ['hlinv/assetsrv'] }), {
      connection: 'QSHQ400',
      program: 'HLINV/ASSETS',
    });
    assert.ok(typeof own !== 'string');
    assert.equal(own.connection, 'OTHER');
    assert.equal(own.program, 'HLINVDEV/ASSETS');
    assert.deepEqual(own.programs, ['HLINV/ASSETSRV']);

    // F5 with no launch.json: Call on what the window has.
    const bare = completeConfiguration({ type: '', request: '' as 'launch', name: '' }, { connection: 'QSHQ400', program: 'HLINV/ASSETS' });
    assert.ok(typeof bare !== 'string');
    assert.equal(bare.type, 'qs400');
    assert.equal(bare.request, 'launch');
    assert.equal(bare.command, 'CALL PGM(HLINV/ASSETS)');
  });

  test('what the provider cannot fill in is said', () => {
    assert.match(String(completeConfiguration(launch(), { program: 'HLINV/ASSETS' })), /No connection/);
    assert.match(String(completeConfiguration(launch(), { connection: 'QSHQ400' })), /No program/);
    assert.match(String(completeConfiguration(launch({ program: 'A/B/C' }), { connection: 'QSHQ400' })), /must be LIB\/PGM/);
    assert.match(String(completeConfiguration(launch({ mode: 'other' as 'call', program: 'HLINV/ASSETS' }), { connection: 'Q' })), /"mode"/);
    assert.match(String(completeConfiguration({ type: 'qs400', request: 'attach', name: 'A' }, { connection: 'Q' })), /"job"/);
    assert.match(String(completeConfiguration(launch({ program: 'HLINV/ASSETS', parameters: [Infinity] }), { connection: 'Q' })), /not a number CL can pass/);
  });

  test('attach and service entry', () => {
    const a = completeConfiguration({ type: 'qs400', request: 'attach', name: 'A', job: '123456/cwellman/qpadev0001', programs: ['HLINV/ASSETS'] }, { connection: 'QSHQ400' });
    assert.ok(typeof a !== 'string');
    assert.equal(a.job, '123456/CWELLMAN/QPADEV0001');
    assert.equal(a.command, undefined, 'nothing is called');
    const s = completeConfiguration(launch({ mode: 'serviceEntry', program: 'HLINV/ASSETS' }), { connection: 'QSHQ400' });
    assert.ok(typeof s !== 'string');
    assert.equal(s.user, '*CURRENT');
    assert.equal(s.command, undefined, 'nothing is called');
  });

  test('the launch.json snippets are the three modes', () => {
    const [call, attach, entry] = initialConfigurations();
    assert.deepEqual(
      [call.request, attach.request, entry.request, entry.mode],
      ['launch', 'attach', 'launch', 'serviceEntry'],
    );
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as { contributes: { debuggers: Array<{ type: string; configurationSnippets: unknown[] }>; breakpoints: Array<{ language: string }> } };
    assert.equal(pkg.contributes.debuggers[0].type, 'qs400');
    assert.equal(pkg.contributes.debuggers[0].configurationSnippets.length, 3);
    assert.deepEqual(pkg.contributes.breakpoints.map((b) => b.language), ['qs400-rpgle', 'qs400-cl']);
  });
});

/** A fake system's `object.properties`, by `LIB/OBJ TYPE`. */
function sourceDeps(objects: Record<string, ObjectProperty[]>, locals: { member?: vscode.Uri; path?: vscode.Uri } = {}) {
  const asked: string[] = [];
  const deps: DebugSourceDeps = {
    properties: async (_c, library, object, type) => {
      asked.push(`${library}/${object} ${type}`);
      const p = objects[`${library}/${object} ${type}`];
      if (!p) {
        throw new Error('CPF9801');
      }
      return p;
    },
    localMember: async () => locals.member,
    localPath: async () => locals.path,
  };
  return { deps, asked };
}

const ASSETS_PGM: ObjectProperty[] = [
  { name: 'Object', value: 'ASSETS' },
  { name: 'Library', value: 'HLINV' },
  { name: 'Type', value: '*PGM' },
  { name: 'Attribute', value: 'RPGLE' },
  { name: 'Source file', value: 'HLINV/QRPGLESRC' },
  { name: 'Source member', value: 'ASSETS' },
];

suite('Debug: qs400/debugSource', () => {
  test('a local project file first', async () => {
    const local = vscode.Uri.file('/work/hlinv/QRPGLESRC/ASSETS.rpgle');
    const { deps, asked } = sourceDeps({ 'HLINV/ASSETS *PGM': ASSETS_PGM }, { member: local });
    const a = await resolveDebugSource(deps, 'QSHQ400', 'HLINV/ASSETS', 'ASSETS');
    assert.deepEqual(a, { path: local.fsPath, name: 'ASSETS.rpgle' });
    // A bound program's module is gone after CRTBNDRPG: the program's own then.
    assert.deepEqual(asked, ['HLINV/ASSETS *MODULE', 'HLINV/ASSETS *PGM']);
  });

  test('else the member, read-only', async () => {
    const { deps } = sourceDeps({ 'HLINV/ASSETS *PGM': ASSETS_PGM });
    const a = await resolveDebugSource(deps, 'QSHQ400', 'HLINV/ASSETS', 'ASSETS');
    assert.ok(a);
    const uri = vscode.Uri.parse(a.path);
    assert.equal(uri.scheme, 'qs400mbr');
    assert.equal(uri.path, '/HLINV/QRPGLESRC/ASSETS.rpgle');
    assert.equal(uri.query, 'readonly');
    assert.equal(a.name, 'ASSETS.rpgle');
  });

  test('a module of a program made of several: its own *MODULE', async () => {
    const { deps, asked } = sourceDeps({
      'HLINV/ASSETRPT *MODULE': [
        { name: 'Attribute', value: 'CLLE' },
        { name: 'Source file', value: 'HLINV/QCLSRC' },
        { name: 'Source member', value: 'ASSETRPT' },
      ],
    });
    const a = await resolveDebugSource(deps, 'QSHQ400', 'HLINV/ASSETS', 'ASSETRPT');
    assert.ok(a);
    assert.equal(vscode.Uri.parse(a.path).path, '/HLINV/QCLSRC/ASSETRPT.clle');
    assert.deepEqual(asked, ['HLINV/ASSETRPT *MODULE'], 'not the program: another module is not its source');
  });

  test('else the stream file, a local one first', async () => {
    const props = [{ name: 'Source file', value: '/home/CWELLMAN/src/assets.rpgle' }];
    const { deps } = sourceDeps({ 'HLINV/ASSETS *PGM': props });
    const a = await resolveDebugSource(deps, 'QSHQ400', 'HLINV/ASSETS', 'ASSETS');
    assert.ok(a);
    const uri = vscode.Uri.parse(a.path);
    assert.equal(uri.scheme, 'qs400ifs');
    assert.equal(uri.path, '/home/CWELLMAN/src/assets.rpgle');
    const local = vscode.Uri.file('/work/ifs/assets.rpgle');
    const withLocal = await resolveDebugSource(sourceDeps({ 'HLINV/ASSETS *PGM': props }, { path: local }).deps, 'QSHQ400', 'HLINV/ASSETS', 'ASSETS');
    assert.equal(withLocal?.path, local.fsPath);
  });

  test('else nothing: the adapter shows the synthetic statements', async () => {
    assert.equal(await resolveDebugSource(sourceDeps({}).deps, 'QSHQ400', 'HLINV/ASSETS', 'ASSETS'), null);
    const noSource = sourceDeps({ 'HLINV/ASSETS *PGM': [{ name: 'Attribute', value: 'RPGLE' }] });
    assert.equal(await resolveDebugSource(noSource.deps, 'QSHQ400', 'HLINV/ASSETS', 'ASSETS'), null);
  });

  test('the synthetic document: line n is statement n, grown to the stack', async () => {
    const p = new StatementsProvider();
    const uri = vscode.Uri.parse('qs400dbg:/HLINV/ASSETS/ASSETS');
    const lines = p.provideTextDocumentContent(uri).split('\n');
    assert.equal(lines.length, 200);
    assert.equal(lines[11], statementLine('HLINV/ASSETS', 'ASSETS', 12));
    let changed = 0;
    p.onDidChange(() => changed++);
    p.grow('qs400dbg:/HLINV/ASSETS/ASSETS', 150);
    assert.equal(changed, 0, 'within what it has');
    p.grow('qs400dbg:/HLINV/ASSETS/ASSETS', 1234);
    assert.equal(changed, 1);
    assert.equal(p.provideTextDocumentContent(uri).split('\n').length, 1234);
    p.dispose();
  });

  test('the answer goes back as the request of the same name', async () => {
    const { debugging } = await api();
    const sent: Array<{ command: string; args: unknown }> = [];
    const session = {
      configuration: { connection: 'QSHQ400' },
      customRequest: async (command: string, args: unknown) => sent.push({ command, args }),
    } as unknown as vscode.DebugSession;
    // Not signed on: object.properties fails, so the answer is null.
    await debugging.answerSource(session, { id: 7, program: 'HLINV/ASSETS', module: 'ASSETS' });
    assert.deepEqual(sent, [{ command: 'qs400/debugSource', args: { id: 7, path: null, name: undefined } }]);
  });
});

suite('Debug: attach and the status bar', () => {
  test('the status bar names the job, with the service entry program in that mode', () => {
    assert.equal(debugStatusText({ job: '123456/QUSER/QAPCNN' }), '$(debug) 123456/QUSER/QAPCNN');
    assert.equal(debugStatusText({ serviceEntry: 'HLINV/ASSETS' }), '$(debug) waiting for HLINV/ASSETS');
    assert.equal(debugStatusText({ job: '777777/CWELLMAN/QPADEV0004', serviceEntry: 'HLINV/ASSETS' }), '$(debug) 777777/CWELLMAN/QPADEV0004 · HLINV/ASSETS');
    assert.equal(debugStatusText({}), undefined);
  });

  test('the programs to attach with', () => {
    assert.deepEqual(parsePrograms(''), []);
    assert.deepEqual(parsePrograms('hlinv/assets, HLINV/ASSETSRV  ASSETRPT'), ['HLINV/ASSETS', 'HLINV/ASSETSRV', '*LIBL/ASSETRPT']);
    assert.equal(parsePrograms('HLINV/ASSETS, A/B/C'), 'A/B/C is not a program name (LIB/PGM)');
  });

  test('Attach to Job… is on other jobs only, not the connection job', () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as { contributes: { menus: Record<string, Array<{ command: string; when?: string }>> } };
    const m = pkg.contributes.menus['view/item/context'].find((x) => x.command === 'code-for-qs400.debug.attach');
    assert.equal(m?.when, 'view == code-for-qs400.jobs && viewItem == jobs.job');
  });
});

suite('Debug: the adapter process', () => {
  test('the sign-on goes into launch, not the configuration, and an unreachable system fails the launch', async () => {
    const { host } = await api();
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const logs: string[] = [];
    const creds = { host: '127.0.0.1', port, user: 'CWELLMAN', password: 'secret' };
    const adapter = new HostDebugAdapter(host.resolveBinary(), creds, (l) => logs.push(l));
    const got: Array<Record<string, unknown>> = [];
    adapter.onDidSendMessage((m) => got.push(m as Record<string, unknown>));
    const response = (seq: number) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no response to ${seq}: ${JSON.stringify(got)}`)), 20_000);
        const look = setInterval(() => {
          const r = got.find((m) => m.type === 'response' && m.request_seq === seq);
          if (r) {
            clearTimeout(t);
            clearInterval(look);
            resolve(r);
          }
        }, 20);
      });
    const launchArgs: Record<string, unknown> = { program: 'HLINV/ASSETS', command: 'CALL PGM(HLINV/ASSETS)' };
    try {
      adapter.handleMessage({ seq: 1, type: 'request', command: 'initialize', arguments: { adapterID: 'qs400' } } as vscode.DebugProtocolMessage);
      const init = await response(1);
      assert.equal(init.success, true);
      assert.equal((init.body as Record<string, unknown>).supportsSetVariable, false);
      adapter.handleMessage({ seq: 2, type: 'request', command: 'launch', arguments: launchArgs } as vscode.DebugProtocolMessage);
      const l = await response(2);
      assert.equal(l.success, false, 'nothing listens on that port');
      // Refused for the connection, not for a missing sign-on.
      assert.doesNotMatch(String(l.message), /missing field|qs400/, String(l.message));
      assert.equal(launchArgs.qs400, undefined, "the caller's arguments are not changed");
      adapter.handleMessage({ seq: 3, type: 'request', command: 'disconnect', arguments: {} } as vscode.DebugProtocolMessage);
      assert.equal((await response(3)).success, true);
    } finally {
      adapter.dispose();
    }
  });
});
