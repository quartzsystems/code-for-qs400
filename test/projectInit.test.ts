// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { parseProjectText } from '../src/projects/config';
import { InitUi, initializeProject, suggestedKind } from '../src/projects/init';
import { projectRig } from './pull.test';

/** Answers Initialize's own questions and records them. */
class FakeInit implements InitUi {
  readonly asked: string[] = [];
  readonly opened: string[] = [];
  kind: 'library' | 'path' | undefined = 'library';
  async connection(names: string[]): Promise<string | undefined> {
    this.asked.push(`connection ${names.join(',')}`);
    return names[0];
  }
  async targetKind(suggested: 'library' | 'path'): Promise<'library' | 'path' | undefined> {
    this.asked.push(`kind ${suggested}`);
    return this.kind;
  }
  async open(file: vscode.Uri): Promise<void> {
    this.opened.push(nodePath.basename(file.fsPath));
  }
}

suite('Projects: initialize', () => {
  let output: vscode.LogOutputChannel;
  const config = () => vscode.workspace.getConfiguration('code-for-qs400');
  suiteSetup(async () => {
    output = vscode.window.createOutputChannel('init test', { log: true });
    await config().update(
      'connections',
      [
        { name: 'OTHER', host: 'other.example', user: 'U' },
        { name: 'PRJ', host: 'prj.example', user: 'CWELLMAN' },
      ],
      true,
    );
  });
  suiteTeardown(async () => {
    await config().update('connections', undefined, true);
    output.dispose();
  });

  test('a folder with source directories becomes a library project, nothing pulled', async () => {
    const rig = await projectRig(output, () => {
      throw new Error('nothing is sent');
    });
    try {
      await rig.write('qddssrc/INVMGR01D.dspf', '     A          R MENU\n');
      await rig.sessions.setActive('PRJ');
      const ui = new FakeInit();
      const file = await initializeProject(rig.deps, ui, rig.folder);
      assert.ok(file);
      assert.deepEqual(ui.asked, ['connection PRJ,OTHER', 'kind library']);
      assert.match(rig.ui.asked[0], /^library /);
      const parsed = parseProjectText(await rig.read('qs400project.json'));
      assert.deepEqual(parsed.problems, []);
      assert.equal(parsed.config?.connection, 'PRJ');
      assert.deepEqual(parsed.config?.target, { kind: 'library', library: 'HLINVDEV' });
      assert.match(await rig.read('.gitignore'), /^\.qs400\/$/m);
      assert.equal(await rig.read('qddssrc/INVMGR01D.dspf'), '     A          R MENU\n', 'the source is left alone');
      assert.deepEqual(ui.opened, ['qs400project.json']);
      assert.ok(await rig.projects.at(rig.folder));
    } finally {
      await rig.dispose();
    }
  });

  test('an IFS project is offered the home directory', async () => {
    const rig = await projectRig(output, () => null);
    try {
      await rig.write('src/app.js', '');
      const ui = new FakeInit();
      ui.kind = 'path';
      await initializeProject(rig.deps, ui, rig.folder);
      // The rig is signed on to PRJ only, so PRJ comes first.
      assert.deepEqual(ui.asked, ['connection PRJ,OTHER', 'kind path']);
      const want = `/home/cwellman/${nodePath.basename(rig.dir)}`;
      assert.ok(rig.ui.asked.includes(`path ${want}`), rig.ui.asked.join('\n'));
      const parsed = parseProjectText(await rig.read('qs400project.json'));
      assert.deepEqual(parsed.config?.target, { kind: 'path', path: want });
    } finally {
      await rig.dispose();
    }
  });

  test('a folder that has a project file gets it opened, not replaced', async () => {
    const rig = await projectRig(output, () => null);
    try {
      const ui = new FakeInit();
      await initializeProject(rig.deps, ui, rig.folder);
      const before = await rig.read('qs400project.json');
      ui.asked.length = 0;
      assert.equal(await initializeProject(rig.deps, ui, rig.folder), undefined);
      assert.deepEqual(ui.asked, []);
      assert.equal(await rig.read('qs400project.json'), before);
      assert.ok(rig.ui.asked.some((a) => a.includes('already has a qs400project.json')));
    } finally {
      await rig.dispose();
    }
  });

  test('what a folder suggests', async () => {
    const rig = await projectRig(output, () => null);
    try {
      assert.equal(await suggestedKind(rig.dir), 'library', 'an empty folder');
      await rig.write('QRPGLESRC/A.rpgle', '');
      await rig.write('README.md', '');
      assert.equal(await suggestedKind(rig.dir), 'library');
      await fs.rm(nodePath.join(rig.dir, 'QRPGLESRC'), { recursive: true });
      await rig.write('src/app.js', '');
      assert.equal(await suggestedKind(rig.dir), 'path');
    } finally {
      await rig.dispose();
    }
  });
});
