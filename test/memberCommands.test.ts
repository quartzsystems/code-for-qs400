// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { memberName, parseQualified } from '../src/commands/members';
import type { ExtensionApi } from '../src/extension';

suite('Member commands', () => {
  test('member names and LIB/FILE(MEMBER)', () => {
    assert.equal(memberName(' assets '), 'ASSETS');
    assert.equal(memberName('$X_1.A'), '$X_1.A');
    for (const bad of ['', '1ABC', 'ABCDEFGHIJK', 'A B', 'A*']) {
      assert.equal(memberName(bad), undefined, bad);
    }
    const within = { library: 'HLINV', file: 'QRPGLESRC' };
    assert.deepEqual(parseQualified('copy1', within), { library: 'HLINV', file: 'QRPGLESRC', member: 'COPY1' });
    assert.deepEqual(parseQualified('hlinv/qtmpsrc(assets)', within), { library: 'HLINV', file: 'QTMPSRC', member: 'ASSETS' });
    for (const bad of ['HLINV/QTMPSRC', 'HLINV/(A)', '/QTMPSRC(A)', 'HLINV/QTMPSRC(A', 'A/B/C(D)']) {
      assert.equal(parseQualified(bad, within), undefined, bad);
    }
  });

  test('every command the manifest contributes is registered', async () => {
    const ext = vscode.extensions.getExtension<ExtensionApi>('quartzsystems.code-for-qs400');
    assert.ok(ext);
    await ext.activate();
    const all = new Set(await vscode.commands.getCommands(true));
    const contributed = (ext.packageJSON as { contributes: { commands: { command: string }[] } }).contributes.commands;
    for (const { command } of contributed) {
      assert.ok(all.has(command), command);
    }
  });
});
