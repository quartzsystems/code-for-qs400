// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { HostRpcError } from '../src/host/client';
import { DeployErrorCodes, DeployMemberParams } from '../src/host/protocol';
import { projectText } from '../src/projects/config';
import { Deployer, GitChanges, UsableProject } from '../src/projects/deploy';
import { GitApi, GitApiChanges } from '../src/projects/git';
import { Puller } from '../src/projects/pull';
import { parseState } from '../src/projects/state';
import { fakeLibrary, libraryAnswer, projectRig } from './pull.test';

/** A system with `HLINV` to pull from and `HLINVDEV` to deploy to, the clock in milliseconds. */
export class FakeSystem {
  readonly lib = fakeLibrary();
  readonly dev = new Map<string, { type: string; text: string; lines: string[]; changed: number }>();
  readonly files = new Set<string>();
  clock = 10_000;
  readonly deploys: DeployMemberParams[] = [];
  readonly commands: string[] = [];

  answer = (method: string, p: Record<string, unknown>): unknown => {
    if (p.library === 'HLINV' || method === 'member.read') {
      if (p.library === 'HLINV') {
        return libraryAnswer(this.lib)(method, p);
      }
    }
    const key = `${String(p.file)}/${String(p.member)}`;
    switch (method) {
      case 'object.list':
        return [...this.files].map((f) => ({ library: 'HLINVDEV', object: f, type: '*FILE', attribute: 'PF-SRC', text: '', size: 0, changed: 0, owner: '' }));
      case 'member.list':
        return [...this.dev.entries()]
          .filter(([k]) => k.startsWith(`${String(p.file)}/`))
          .filter(([k]) => !p.pattern || k.endsWith(`/${String(p.pattern)}`))
          .map(([k, v]) => ({ member: k.split('/')[1], type: v.type, text: v.text, records: v.lines.length, created: 1, changed: v.changed }));
      case 'member.read': {
        const m = this.dev.get(key);
        if (!m) {
          throw new Error('not found');
        }
        return { type: m.type, text: m.text, width: 100, ccsid: 37, lines: m.lines.map((text, i) => ({ seq: `${String(i + 1).padStart(4, '0')}.00`, date: '260105', text })) };
      }
      case 'action.run': {
        this.commands.push(String(p.command));
        const f = /FILE\(HLINVDEV\/(\w+)\)/.exec(String(p.command))?.[1];
        if (f) {
          this.files.add(f);
        }
        return { status: 'Ok', messages: [], diagnostics: [] };
      }
      case 'deploy.member': {
        const d = p as unknown as DeployMemberParams;
        this.deploys.push(d);
        const have = this.dev.get(key);
        if (have && d.expect !== undefined && have.changed > d.expect) {
          throw new HostRpcError(DeployErrorCodes.Conflict, 'changed on the system', { changed: have.changed });
        }
        if (have && have.lines.join('\n') === d.lines.join('\n')) {
          return { outcome: 'unchanged', lines: d.lines.length, renumbered: false, changed: have.changed };
        }
        const changed = ++this.clock;
        this.dev.set(key, { type: d.type, text: have?.text ?? d.text ?? '', lines: d.lines, changed });
        return { outcome: have ? 'written' : 'created', lines: d.lines.length, renumbered: !have, changed };
      }
    }
    return null;
  };

  /** Someone at a 5250 session edits a member. */
  edit(key: string, lines: string[]): void {
    const m = this.dev.get(key);
    assert.ok(m, key);
    this.dev.set(key, { ...m, lines, changed: ++this.clock });
  }
}

suite('Projects: deploy to a library', () => {
  let output: vscode.LogOutputChannel;
  suiteSetup(() => {
    output = vscode.window.createOutputChannel('deploy test', { log: true });
  });
  suiteTeardown(() => output.dispose());

  /** A pulled project of HLINV targeting HLINVDEV, and its deployer. */
  async function pulled(git?: GitChanges) {
    const sys = new FakeSystem();
    const rig = await projectRig(output, sys.answer);
    const puller = new Puller(rig.deps);
    await puller.pullSourceFiles('PRJ', 'HLINV', ['QRPGLESRC', 'QCLSRC', 'QDDSSRC', 'QSQLSRC'], rig.folder);
    const project = (await rig.projects.at(rig.folder)) as UsableProject;
    assert.ok(project?.config);
    const deployer = new Deployer(rig.deps, puller, git);
    rig.lines.length = 0;
    rig.ui.asked.length = 0;
    return { sys, rig, puller, project, deployer };
  }

  test('Deploy all to a new library: the source files made after a question, every member with its type and text', async () => {
    const { sys, rig, project, deployer } = await pulled();
    try {
      const r = await deployer.deploy(project, 'all');
      assert.deepEqual(rig.ui.asked, ['create HLINVDEV QCLSRC,QDDSSRC,QRPGLESRC,QSQLSRC']);
      assert.deepEqual(sys.commands, ['QCLSRC', 'QDDSSRC', 'QRPGLESRC', 'QSQLSRC'].map((f) => `CRTSRCPF FILE(HLINVDEV/${f}) RCDLEN(112)`));
      assert.equal(r?.deployed.length, 5);
      assert.deepEqual(
        [...sys.dev.entries()].map(([k, v]) => `${k} ${v.type} ${v.text}`).sort(),
        ['QCLSRC/BUILD CLLE Build', 'QDDSSRC/ASSETSP PF ', 'QRPGLESRC/ASSETCP RPGLE Asset copy member', 'QRPGLESRC/ASSETS RPGLE Asset maintenance', 'QSQLSRC/SEED SQL Seed data'],
      );
      assert.deepEqual(sys.dev.get('QRPGLESRC/ASSETS')?.lines, ['**free', 'dcl-s count int(10);', '*inlr = *on;'], 'no extra line for the final newline');
      assert.ok(sys.deploys.every((d) => d.expect === undefined), 'nothing was recorded on HLINVDEV: nothing to check');
      assert.equal(rig.lines[rig.lines.length - 1], '5 deployed, 0 skipped, 0 conflicts');
      const state = parseState(await rig.read('.qs400/state.json'));
      assert.equal(state.files['QRPGLESRC/ASSETS.rpgle'].remote, sys.dev.get('QRPGLESRC/ASSETS')?.changed);
    } finally {
      await rig.dispose();
    }
  });

  test('Deploy changed sends only the changed file, checked against the timestamp recorded', async () => {
    const { sys, rig, project, deployer } = await pulled();
    try {
      await deployer.deploy(project, 'all');
      const before = new Map([...sys.dev.entries()].map(([k, v]) => [k, v.changed]));
      sys.deploys.length = 0;
      rig.lines.length = 0;
      await rig.write('QRPGLESRC/ASSETS.rpgle', '**free\ndcl-s count int(20);\n*inlr = *on;\n');
      const r = await deployer.deploy(project, 'changed');
      assert.deepEqual(r?.deployed, ['QRPGLESRC/ASSETS.rpgle']);
      assert.equal(sys.deploys.length, 1);
      assert.equal(sys.deploys[0].expect, before.get('QRPGLESRC/ASSETS'));
      assert.deepEqual(sys.deploys[0].lines, ['**free', 'dcl-s count int(20);', '*inlr = *on;']);
      const moved = [...sys.dev.entries()].filter(([k, v]) => v.changed !== before.get(k)).map(([k]) => k);
      assert.deepEqual(moved, ['QRPGLESRC/ASSETS'], 'exactly one member’s timestamp moved');
      assert.ok(rig.lines.includes('Deployed QRPGLESRC/ASSETS.rpgle → HLINVDEV/QRPGLESRC(ASSETS)'));
      assert.equal(rig.lines[rig.lines.length - 1], '1 deployed, 0 skipped, 0 conflicts');
      rig.lines.length = 0;
      await deployer.deploy(project, 'changed');
      assert.deepEqual(rig.lines.slice(1), ['Nothing to deploy', '0 deployed, 0 skipped, 0 conflicts']);
    } finally {
      await rig.dispose();
    }
  });

  test('a member changed at a 5250 session is a conflict, listed before anything is written: Skip, Pull, Overwrite', async () => {
    const { sys, rig, project, deployer } = await pulled();
    try {
      await deployer.deploy(project, 'all');
      sys.edit('QRPGLESRC/ASSETS', ['**free', '// from SEU', '*inlr = *on;']);
      await rig.write('QRPGLESRC/ASSETS.rpgle', '**free\n// local\n*inlr = *on;\n');
      sys.deploys.length = 0;
      rig.lines.length = 0;
      rig.ui.asked.length = 0;

      rig.ui.conflicts = ['skip'];
      const skipped = await deployer.deploy(project, 'changed');
      assert.deepEqual(rig.ui.asked, ['conflict QRPGLESRC/ASSETS.rpgle']);
      assert.deepEqual(skipped?.conflicts, ['QRPGLESRC/ASSETS.rpgle']);
      assert.equal(sys.deploys.length, 0, 'nothing written');
      assert.match(rig.lines[1], /^Conflict QRPGLESRC\/ASSETS\.rpgle \(HLINVDEV\/QRPGLESRC\(ASSETS\)\): changed on the system at /);
      assert.ok(deployer.conflicts.get(project.folder.uri.toString())?.has('QRPGLESRC/ASSETS.rpgle'), 'marked for the Project view');
      assert.equal(rig.lines[rig.lines.length - 1], '0 deployed, 0 skipped, 1 conflicts');

      rig.ui.conflicts = ['pull'];
      await deployer.deploy(project, 'changed');
      assert.equal(await rig.read('QRPGLESRC/ASSETS.rpgle'), '**free\n// from SEU\n*inlr = *on;\n', 'the system’s copy in the local file');
      assert.equal(sys.deploys.length, 0);
      const state = parseState(await rig.read('.qs400/state.json'));
      assert.equal(state.files['QRPGLESRC/ASSETS.rpgle'].remote, sys.dev.get('QRPGLESRC/ASSETS')?.changed, 'no longer a conflict');

      // Pull marked it changed: Deploy changed takes it, and the system already has it.
      await rig.write('QRPGLESRC/ASSETS.rpgle', '**free\n// merged\n*inlr = *on;\n');
      sys.edit('QRPGLESRC/ASSETS', ['**free', '// SEU again', '*inlr = *on;']);
      rig.ui.conflicts = ['overwrite'];
      const over = await deployer.deploy(project, 'changed');
      assert.deepEqual(over?.deployed, ['QRPGLESRC/ASSETS.rpgle']);
      assert.equal(sys.deploys[0].expect, undefined, 'Overwrite checks nothing');
      assert.deepEqual(sys.dev.get('QRPGLESRC/ASSETS')?.lines, ['**free', '// merged', '*inlr = *on;']);
    } finally {
      await rig.dispose();
    }
  });

  test('a file removed locally is left on the system and said once', async () => {
    const { rig, project, deployer } = await pulled();
    try {
      await deployer.deploy(project, 'all');
      await fs.rm(nodePath.join(rig.dir, 'QSQLSRC', 'SEED.sql'));
      rig.lines.length = 0;
      const r = await deployer.deploy(project, 'changed');
      assert.deepEqual(r?.leftOnSystem, ['QSQLSRC/SEED.sql']);
      assert.ok(rig.lines.includes('Left on the system  HLINVDEV/QSQLSRC(SEED): QSQLSRC/SEED.sql was removed locally'));
      rig.lines.length = 0;
      const again = await deployer.deploy(project, 'changed');
      assert.deepEqual(again?.leftOnSystem, []);
    } finally {
      await rig.dispose();
    }
  });

  test('two files naming one member are an error and neither is deployed; a file outside the layout is skipped', async () => {
    const { sys, rig, project, deployer } = await pulled();
    try {
      await rig.write('QRPGLESRC/ASSETS.sqlrpgle', '**free\n');
      await rig.write('notes.txt', 'x\n');
      const r = await deployer.deploy(project, 'all');
      assert.deepEqual(r?.failed.sort(), ['QRPGLESRC/ASSETS.rpgle', 'QRPGLESRC/ASSETS.sqlrpgle']);
      assert.ok(r?.skipped.includes('notes.txt'));
      assert.ok(!sys.dev.has('QRPGLESRC/ASSETS'));
      assert.ok(rig.lines.some((l) => l.startsWith('Error    QRPGLESRC/ASSETS.rpgle and QRPGLESRC/ASSETS.sqlrpgle name the same member HLINVDEV/QRPGLESRC(ASSETS)')));
    } finally {
      await rig.dispose();
    }
  });

  test('declining CRTSRCPF skips that file’s members', async () => {
    const { sys, rig, project, deployer } = await pulled();
    try {
      rig.ui.create = false;
      const r = await deployer.deploy(project, 'all');
      assert.equal(sys.commands.length, 0);
      assert.equal(r?.skipped.length, 5);
      assert.equal(sys.deploys.length, 0);
    } finally {
      await rig.dispose();
    }
  });

  test('the generator’s project file is read back as the project deployed', async () => {
    assert.ok(projectText({ connection: 'PRJ', target: { kind: 'library', library: 'HLINVDEV' } }).includes('"library": "HLINVDEV"'));
  });
});

suite('Projects: deploy to an IFS path, and git-changed', () => {
  let output: vscode.LogOutputChannel;
  suiteSetup(() => {
    output = vscode.window.createOutputChannel('deploy ifs test', { log: true });
  });
  suiteTeardown(() => output.dispose());

  /** A system's stream files by path, each with its change counter. */
  function ifsSystem() {
    const files = new Map<string, { change: number; from: string; ccsid?: number }>();
    let counter = 100;
    const calls: Record<string, unknown>[] = [];
    const answer = (method: string, p: Record<string, unknown>): unknown => {
      if (method === 'ifs.info') {
        const f = files.get(String(p.path));
        if (!f) {
          throw new HostRpcError(-32010, 'CPFA0A9: Object not found.', { status: 'NotFound', messageId: 'CPFA0A9' });
        }
        return { name: '', kind: 'file', size: 1, modified: 0, owner: '', ccsid: 1208, change: String(f.change) };
      }
      if (method === 'deploy.path') {
        calls.push(p);
        const have = files.get(String(p.path));
        if (have && p.expect !== undefined && String(have.change) !== p.expect) {
          throw new HostRpcError(DeployErrorCodes.Conflict, 'changed on the system', { change: String(have.change) });
        }
        files.set(String(p.path), { change: ++counter, from: String(p.from), ccsid: p.ccsid as number });
        return { outcome: have ? 'written' : 'created', size: 1, change: String(counter) };
      }
      return null;
    };
    return { files, calls, answer, bump: (path: string) => files.set(path, { ...(files.get(path) as { change: number; from: string }), change: ++counter }) };
  }

  test('each file under the target with the project’s CCSID; a change on the system since is a conflict', async () => {
    const sys = ifsSystem();
    const rig = await projectRig(output, sys.answer);
    try {
      await rig.projects.create(rig.folder, { connection: 'PRJ', target: { kind: 'path', path: '/home/CWELLMAN/app' }, ifsCcsid: 819 });
      await rig.write('src/a.sql', 'SELECT 1 FROM HLINV.ASSETS;\n');
      await rig.write('b.txt', 'b\n');
      await rig.write('README.md', 'ignored\n');
      const project = (await rig.projects.at(rig.folder)) as UsableProject;
      const deployer = new Deployer(rig.deps, new Puller(rig.deps));
      const r = await deployer.deploy(project, 'all');
      assert.deepEqual(r?.deployed, ['b.txt', 'src/a.sql']);
      assert.deepEqual(
        sys.calls.map((c) => [c.path, c.ccsid, c.expect, typeof c.transfer]),
        [
          ['/home/CWELLMAN/app/b.txt', 819, undefined, 'string'],
          ['/home/CWELLMAN/app/src/a.sql', 819, undefined, 'string'],
        ],
      );
      assert.equal(String(sys.calls[1].from).toLowerCase(), nodePath.join(rig.dir, 'src', 'a.sql').toLowerCase());
      const state = parseState(await rig.read('.qs400/state.json'));
      assert.deepEqual(state.files['src/a.sql'].at, '/home/CWELLMAN/app/src/a.sql');
      assert.ok(rig.lines.includes('Created  src/a.sql → /home/CWELLMAN/app/src/a.sql'));

      sys.bump('/home/CWELLMAN/app/src/a.sql');
      await rig.write('src/a.sql', 'SELECT 2 FROM HLINV.ASSETS;\n');
      sys.calls.length = 0;
      rig.ui.conflicts = ['skip'];
      const c = await deployer.deploy(project, 'changed');
      assert.deepEqual(c?.conflicts, ['src/a.sql']);
      assert.equal(sys.calls.length, 0);
      rig.ui.conflicts = ['overwrite'];
      const o = await deployer.deploy(project, 'changed');
      assert.deepEqual(o?.deployed, ['src/a.sql']);
      assert.equal(sys.calls[0].expect, undefined);
      assert.equal(deployer.localFor('prj', { kind: 'path', path: '/home/CWELLMAN/app/src/a.sql' })?.fsPath, vscode.Uri.file(nodePath.join(rig.dir, 'src', 'a.sql')).fsPath);
    } finally {
      await rig.dispose();
    }
  });

  test('git-changed: the files git reports, through the git API; none after a stash; no repository is Deploy changed', async () => {
    const sys = new FakeSystem();
    const rig = await projectRig(output, sys.answer);
    try {
      const changes: { uri: vscode.Uri }[] = [];
      let repo = true;
      const api: GitApi = {
        get repositories() {
          return repo ? [{ rootUri: rig.folder, state: { workingTreeChanges: changes, indexChanges: [], untrackedChanges: [] } }] : [];
        },
        getRepository: () => null,
      };
      const puller = new Puller(rig.deps);
      await puller.pullSourceFiles('PRJ', 'HLINV', ['QRPGLESRC', 'QCLSRC'], rig.folder);
      const project = (await rig.projects.at(rig.folder)) as UsableProject;
      const deployer = new Deployer(rig.deps, puller, new GitApiChanges(async () => api));
      await deployer.deploy(project, 'all');
      sys.deploys.length = 0;

      await rig.write('QCLSRC/BUILD.clle', 'PGM\n/* changed */\nENDPGM\n');
      await rig.write('QRPGLESRC/ASSETS.rpgle', '**free\n// changed too, but git is told only of BUILD\n');
      changes.push({ uri: vscode.Uri.file(nodePath.join(rig.dir, 'QCLSRC', 'BUILD.clle')) }, { uri: vscode.Uri.file(nodePath.join(rig.dir, '.qs400', 'state.json')) });
      const g = await deployer.deploy(project, 'git');
      assert.deepEqual(g?.deployed, ['QCLSRC/BUILD.clle']);
      assert.deepEqual(sys.deploys.map((d) => d.member), ['BUILD']);

      changes.length = 0;
      rig.lines.length = 0;
      const stashed = await deployer.deploy(project, 'git');
      assert.deepEqual(stashed?.deployed, []);
      assert.deepEqual(rig.lines.slice(1), ['Nothing to deploy', '0 deployed, 0 skipped, 0 conflicts']);

      repo = false;
      rig.ui.asked.length = 0;
      const fallback = await deployer.deploy(project, 'git');
      assert.ok(rig.ui.asked.some((a) => a.includes('is not in a git repository')));
      assert.deepEqual(fallback?.deployed, ['QRPGLESRC/ASSETS.rpgle'], 'what changed since the last deploy');
    } finally {
      await rig.dispose();
    }
  });
});
