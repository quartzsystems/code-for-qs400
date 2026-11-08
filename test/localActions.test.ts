// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { CompileDiagnostics } from '../src/actions/diagnostics';
import { ActionRunner } from '../src/actions/run';
import { ActionStore } from '../src/actions/store';
import { resolveCommand } from '../src/actions/targets';
import { CompileDiagnostic } from '../src/host/protocol';
import { MEMBER_SCHEME } from '../src/members/uri';
import { Deployer, UsableProject } from '../src/projects/deploy';
import { LocalActions, LocalRun } from '../src/projects/local';
import { Puller } from '../src/projects/pull';
import { FakeSystem } from './deploy.test';
import { Memento } from './members.test';
import { projectRig } from './pull.test';

const JOB = { number: '123456', user: 'QUSER', name: 'QAPCNN' };

function diag(at: CompileDiagnostic['at'], line: number, id: string): CompileDiagnostic {
  return { at, line, column: 0, endLine: 0, endColumn: 0, severity: 30, id, text: `${id} text`, help: '' };
}

suite('Projects: actions on local files', () => {
  let output: vscode.LogOutputChannel;
  const config = () => vscode.workspace.getConfiguration('code-for-qs400');
  suiteSetup(async () => {
    output = vscode.window.createOutputChannel('local actions test', { log: true });
    await config().update('connections', [{ name: 'PRJ', host: 'prj.example', user: 'CWELLMAN' }], true);
  });
  suiteTeardown(async () => {
    await config().update('connections', undefined, true);
    output.dispose();
  });

  /** HLINV pulled, its project targeting HLINVDEV, deployed whole. */
  async function deployedProject() {
    const sys = new FakeSystem();
    const runs: string[] = [];
    let outcome: { diagnostics: CompileDiagnostic[]; status: string } = { status: 'Ok', diagnostics: [] };
    const answer = (method: string, p: Record<string, unknown>): unknown => {
      if (method === 'libl.get') {
        return { current: 'CWELLMAN', system: ['QSYS'], user: ['HLINV'] };
      }
      if (method === 'action.run' && !String(p.command).startsWith('CRTSRCPF')) {
        runs.push(String(p.command));
        return { status: outcome.status, job: JOB, messages: [], diagnostics: outcome.diagnostics };
      }
      if (method === 'spool.files') {
        return [];
      }
      return sys.answer(method, p);
    };
    const rig = await projectRig(output, answer);
    const puller = new Puller(rig.deps);
    await puller.pullSourceFiles('PRJ', 'HLINV', ['QRPGLESRC', 'QCLSRC'], rig.folder);
    const project = (await rig.projects.at(rig.folder)) as UsableProject;
    const deployer = new Deployer(rig.deps, puller);
    await deployer.deploy(project, 'all');
    rig.ui.asked.length = 0;
    sys.deploys.length = 0;
    rig.lines.length = 0;
    // The rig's store reads the setting written above.
    rig.sessions.update({ name: 'PRJ', state: 'connected', user: 'CWELLMAN', job: JOB });
    // The pull made the project, so the store tracks its folder although it is no workspace folder.
    const local = new LocalActions(rig.deps, deployer);
    const resolve = (uri: vscode.Uri) => local.resolve(uri);
    return { sys, rig, deployer, resolve, runs, setOutcome: (o: typeof outcome) => (outcome = o) };
  }

  test('a local file of a library project is the member it deploys to; its variables come from the project', async () => {
    const { rig, resolve } = await deployedProject();
    try {
      const uri = vscode.Uri.file(nodePath.join(rig.dir, 'QRPGLESRC', 'ASSETS.rpgle'));
      const r = (await resolve(uri)) as LocalRun;
      assert.deepEqual(r.target, { environment: 'member', connection: 'PRJ', library: 'HLINVDEV', file: 'QRPGLESRC', member: 'ASSETS', type: 'RPGLE', ext: 'rpgle' });
      assert.equal(r.library, 'HLINVDEV');
      const resolved = resolveCommand('X LIB(&LIBRARY) SRCFILE(&SRCLIB/&SRCFILE) MBR(&NAME) TYPE(&TYPE) EXT(&EXT) CUR(&CURLIB)', r.target, {
        connection: { user: 'CWELLMAN', host: 'prj.example', custom: {} },
        library: r.library,
        curlib: 'CWELLMAN',
      });
      assert.deepEqual(resolved, { ok: true, command: 'X LIB(HLINVDEV) SRCFILE(HLINVDEV/QRPGLESRC) MBR(ASSETS) TYPE(RPGLE) EXT(rpgle) CUR(CWELLMAN)' });
      const notMember = await resolve(vscode.Uri.file(nodePath.join(rig.dir, 'notes.txt')));
      assert.match(String(notMember), /not in a source file directory/);
    } finally {
      await rig.dispose();
    }
  });

  test('Compile on a local file deploys it, compiles into the target, and puts the diagnostics on the local file', async () => {
    const { sys, rig, deployer, resolve, runs, setOutcome } = await deployedProject();
    const ext = vscode.extensions.getExtension('quartzsystems.code-for-qs400');
    assert.ok(ext);
    const actions = new ActionStore(ext.extensionPath, rig.store, rig.sessions, output);
    await actions.ready;
    const runner = new ActionRunner(rig.store, rig.sessions, actions, new Memento(), { findDocument: () => undefined, append: (l) => rig.lines.push(l), local: resolve });
    const diagnostics = new CompileDiagnostics((c, at) => deployer.localFor(c, at));
    try {
      const uri = vscode.Uri.file(nodePath.join(rig.dir, 'QRPGLESRC', 'ASSETS.rpgle'));
      const lines = Array.from({ length: 45 }, (_, i) => (i === 41 ? '  x = undefinedName;' : `// line ${i + 1}`));
      await rig.write('QRPGLESRC/ASSETS.rpgle', `${lines.join('\n')}\n`);
      setOutcome({
        status: 'Error',
        diagnostics: [
          diag({ kind: 'member', library: 'HLINVDEV', file: 'QRPGLESRC', member: 'ASSETS' }, 42, 'RNF7030'),
          diag({ kind: 'member', library: 'HLINVDEV', file: 'QRPGLESRC', member: 'ASSETCP' }, 2, 'RNF7031'),
          diag({ kind: 'member', library: 'HLINV', file: 'QRPGLESRC', member: 'NOLOCAL' }, 3, 'RNF7066'),
        ],
      });
      const r = await runner.run(uri, 'Compile (CRTBNDRPG)');
      assert.ok(r);
      assert.equal(sys.deploys.length, 1, 'deployed first');
      assert.equal(sys.deploys[0].member, 'ASSETS');
      assert.deepEqual(runs, ['CRTBNDRPG PGM(HLINVDEV/ASSETS) SRCFILE(HLINVDEV/QRPGLESRC) SRCMBR(ASSETS) DBGVIEW(*SOURCE) OPTION(*EVENTF)']);
      assert.equal(r.local?.toString(), uri.toString());

      diagnostics.apply(r);
      const onLocal = diagnostics.collection.get(uri) ?? [];
      assert.equal(onLocal.length, 1);
      assert.equal(onLocal[0].code, 'RNF7030');
      assert.equal(onLocal[0].range.start.line, 41, 'line 42 of the local file');
      const cp = vscode.Uri.file(nodePath.join(rig.dir, 'QRPGLESRC', 'ASSETCP.rpgle'));
      assert.equal((diagnostics.collection.get(cp) ?? [])[0]?.code, 'RNF7031', 'a /COPY member deployed from the project: its local file');
      const remote: string[] = [];
      diagnostics.collection.forEach((u, d) => {
        if (u.scheme === MEMBER_SCHEME) {
          remote.push(`${u.path} ${d.map((x) => x.code).join(',')}`);
        }
      });
      assert.deepEqual(remote, ['/HLINV/QRPGLESRC/NOLOCAL.rpgle RNF7066'], 'a member with no local file stays on its qs400mbr URI');
    } finally {
      diagnostics.dispose();
      runner.dispose();
      actions.dispose();
      await rig.dispose();
    }
  });

  test('a local file in conflict is not compiled', async () => {
    const { sys, rig, resolve, runs } = await deployedProject();
    const ext = vscode.extensions.getExtension('quartzsystems.code-for-qs400');
    assert.ok(ext);
    const actions = new ActionStore(ext.extensionPath, rig.store, rig.sessions, output);
    await actions.ready;
    const runner = new ActionRunner(rig.store, rig.sessions, actions, new Memento(), { findDocument: () => undefined, append: (l) => rig.lines.push(l), local: resolve });
    try {
      sys.edit('QRPGLESRC/ASSETS', ['**free', '// SEU']);
      await rig.write('QRPGLESRC/ASSETS.rpgle', '**free\n// local\n');
      rig.ui.conflicts = ['skip'];
      const r = await runner.run(vscode.Uri.file(nodePath.join(rig.dir, 'QRPGLESRC', 'ASSETS.rpgle')), 'Compile (CRTBNDRPG)');
      assert.equal(r, undefined);
      assert.deepEqual(runs, []);
      assert.ok(rig.lines.some((l) => l.includes('was not deployed')));
    } finally {
      runner.dispose();
      actions.dispose();
      await rig.dispose();
    }
  });
});
