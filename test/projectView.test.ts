// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { Deployer, UsableProject } from '../src/projects/deploy';
import { deployedAt, fileRows, groupByDir, pendingCount, statusBarText } from '../src/projects/model';
import { Puller } from '../src/projects/pull';
import { emptyState } from '../src/projects/state';
import { ProjectNode, ProjectView, remoteUri } from '../src/views/project';
import { FakeSystem } from './deploy.test';
import { projectRig } from './pull.test';

suite('Projects: the Project view’s model', () => {
  const lib = { kind: 'library' as const, library: 'HLINVDEV' };

  test('where each file goes, its state, grouped by directory with the folder’s own first', () => {
    assert.equal(deployedAt(lib, 'QRPGLESRC/ASSETS.rpgle'), 'HLINVDEV/QRPGLESRC(ASSETS)');
    assert.equal(deployedAt(lib, 'notes.txt'), undefined);
    assert.equal(deployedAt({ kind: 'path', path: '/app' }, 'src/a.sql'), '/app/src/a.sql');
    const state = emptyState();
    state.files['QRPGLESRC/ASSETS.rpgle'] = { hash: 'a', remote: 100, at: 'HLINVDEV/QRPGLESRC(ASSETS)' };
    state.files['QRPGLESRC/CP.rpgle'] = { hash: 'c', remote: 100, at: 'HLINVDEV/QRPGLESRC(CP)' };
    state.files['QCLSRC/BUILD.clle'] = { hash: 'b', remote: 100, at: 'HLINVDEV/QCLSRC(BUILD)' };
    const hashes = new Map([
      ['QRPGLESRC/ASSETS.rpgle', 'a'],
      ['QRPGLESRC/CP.rpgle', 'changed'],
      ['QCLSRC/BUILD.clle', 'b'],
      ['QSQLSRC/NEW.sql', 'n'],
      ['notes.txt', 't'],
    ]);
    const rows = fileRows(lib, [...hashes.keys()], ['README.md'], hashes, state, new Map([['QCLSRC/BUILD.clle', 200]]), new Set(['QRPGLESRC/ASSETS.rpgle']));
    const by = Object.fromEntries(rows.map((r) => [r.rel, r.status]));
    assert.deepEqual(by, {
      'QRPGLESRC/ASSETS.rpgle': 'conflict',
      'QRPGLESRC/CP.rpgle': 'changed',
      'QCLSRC/BUILD.clle': 'conflict',
      'QSQLSRC/NEW.sql': 'new',
      'notes.txt': 'new',
      'README.md': 'ignored',
    });
    assert.deepEqual(
      groupByDir(rows).map((g) => [g.dir, g.rows.map((r) => r.name)]),
      [
        ['', ['notes.txt']],
        ['QCLSRC', ['BUILD.clle']],
        ['QRPGLESRC', ['ASSETS.rpgle', 'CP.rpgle']],
        ['QSQLSRC', ['NEW.sql']],
      ],
    );
    assert.equal(pendingCount(rows), 5);
    assert.equal(statusBarText(rows), '$(cloud-upload) 5 changed');
  });
});

suite('Projects: the Project view', () => {
  let output: vscode.LogOutputChannel;
  suiteSetup(() => {
    output = vscode.window.createOutputChannel('project view test', { log: true });
  });
  suiteTeardown(() => output.dispose());

  test('a pulled, deployed project: its connection and target, files by directory, Changed after an edit, Conflict after Refresh', async () => {
    const sys = new FakeSystem();
    const rig = await projectRig(output, sys.answer);
    const puller = new Puller(rig.deps);
    const deployer = new Deployer(rig.deps, puller);
    const view = new ProjectView(rig.deps, deployer);
    try {
      await puller.pullSourceFiles('PRJ', 'HLINV', ['QRPGLESRC', 'QCLSRC'], rig.folder);
      await rig.write('README.md', 'ignored by the generator\n');
      const project = (await rig.projects.at(rig.folder)) as UsableProject;
      await deployer.deploy(project, 'all');
      await view.rescan();

      const roots = view.getChildren();
      assert.equal(roots.length, 1);
      const root = roots[0] as Extract<ProjectNode, { kind: 'project' }>;
      assert.equal(view.getTreeItem(root).description, 'PRJ · HLINVDEV');
      const kids = view.getChildren(root);
      assert.deepEqual(
        kids.map((k) => (k.kind === 'info' ? `${k.label}: ${k.description}` : k.kind === 'dir' ? `dir ${k.dir}` : k.kind)),
        ['Connection: PRJ', 'Library: HLINVDEV', 'dir QCLSRC', 'dir QRPGLESRC', 'ignored'],
      );
      const ignored = kids[4];
      assert.equal(view.getTreeItem(ignored).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'folded by default');
      const states = () => Object.fromEntries(view.rows(project).map((r) => [r.rel, r.status]));
      assert.deepEqual(states(), {
        '.gitignore': 'ignored',
        'QCLSRC/BUILD.clle': 'deployed',
        'QRPGLESRC/ASSETCP.rpgle': 'deployed',
        'QRPGLESRC/ASSETS.rpgle': 'deployed',
        'README.md': 'ignored',
      });

      await rig.write('QRPGLESRC/ASSETS.rpgle', '**free\n// edited\n');
      await rig.write('QRPGLESRC/NEWONE.rpgle', '**free\n');
      await view.rescan();
      assert.equal(states()['QRPGLESRC/ASSETS.rpgle'], 'changed');
      assert.equal(states()['QRPGLESRC/NEWONE.rpgle'], 'new');
      assert.equal(view.statusBar.text, '$(cloud-upload) 2 changed');

      sys.edit('QCLSRC/BUILD', ['PGM', '/* SEU */', 'ENDPGM']);
      await view.rescan();
      assert.equal(states()['QCLSRC/BUILD.clle'], 'deployed', 'only Refresh reads the system');
      await view.refresh();
      assert.equal(states()['QCLSRC/BUILD.clle'], 'conflict');
      const dir = view.getChildren(root).find((k) => k.kind === 'dir' && k.dir === 'QCLSRC');
      const file = view.getChildren(dir)[0];
      const item = view.getTreeItem(file);
      assert.equal(item.description, 'Conflict');
      assert.equal(item.contextValue, 'project.file.remote');
      assert.equal(remoteUri(project, 'PRJ', 'QCLSRC/BUILD.clle', true)?.toString(), 'qs400mbr://prj/HLINVDEV/QCLSRC/BUILD.clle?readonly');
    } finally {
      view.dispose();
      deployer.dispose();
      await rig.dispose();
    }
  });
});
