// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension';
import { DDS_FIELDS, DDS_GUIDE_COLUMNS, columnGuides, ddsGuides, describeDds } from '../src/languages/ddsGuides';

suite('DDS column guides', () => {
  test('a guide at each column the line reaches, none past its end', () => {
    const full = '     A            CMD           70A  B 21  7';
    const cols = columnGuides(full, 4, DDS_GUIDE_COLUMNS).map((r) => r.start.character + 1);
    assert.deepEqual(
      cols,
      DDS_GUIDE_COLUMNS.filter((c) => c <= full.length),
    );
    assert.ok(columnGuides(full, 4, DDS_GUIDE_COLUMNS).every((r) => r.start.line === 4));
    assert.deepEqual(
      columnGuides('     A', 0, DDS_GUIDE_COLUMNS).map((r) => r.start.character + 1),
      [6],
    );
    assert.deepEqual(columnGuides('', 0, DDS_GUIDE_COLUMNS), []);
  });

  test('the field at each column', () => {
    const line = '     A            CMD           70A  B 21  7';
    assert.equal(describeDds(line, 3), 'A · Sequence 1–5 · col 3');
    assert.equal(describeDds(line, 6), 'A · Form type 6 · col 6');
    assert.equal(describeDds(line, 12), 'A · Condition 8–16 · col 12');
    assert.equal(describeDds(line, 21), 'A · Name 19–28 · col 21');
    assert.equal(describeDds(line, 33), 'A · Length 30–34 · col 33');
    assert.equal(describeDds(line, 35), 'A · Data type 35 · col 35');
    assert.equal(describeDds(line, 38), 'A · Usage 38 · col 38');
    assert.equal(describeDds(line, 40), 'A · Line 39–41 · col 40');
    assert.equal(describeDds(line, 44), 'A · Position 42–44 · col 44');
    assert.equal(describeDds(line, 50), 'A · Keywords 45–80 · col 50');
    assert.equal(describeDds(line, 85), 'col 85');
    assert.equal(describeDds('     A* a comment', 12), 'A* · Comment · col 12');
    // Every column 1–80 is in exactly one field.
    for (let c = 1; c <= 80; c++) {
      assert.equal(DDS_FIELDS.filter((f) => c >= f.from && c <= f.to).length, 1, `col ${c}`);
    }
  });

  test('the status bar follows the cursor in a DDS editor', async () => {
    const ext = vscode.extensions.getExtension<ExtensionApi>('quartzsystems.code-for-qs400');
    assert.ok(ext);
    const { dds } = await ext.activate();
    const doc = await vscode.workspace.openTextDocument({ language: 'qs400-dds', content: '     A            CMD           70A  B 21  7\n' });
    const e = await vscode.window.showTextDocument(doc);
    e.selection = new vscode.Selection(0, 20, 0, 20);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(dds.statusText, 'A · Name 19–28 · col 21');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('no guides below the last line', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'qs400-dds', content: '     A          R REC\n     A            F1            10A\n' });
    const e = await vscode.window.showTextDocument(doc);
    const g = ddsGuides(e);
    assert.ok(g.length > 0);
    assert.ok(g.every((r) => r.start.line < doc.lineCount && r.end.character <= doc.lineAt(r.start.line).text.length));
    assert.ok(g.every((r) => r.start.line < 2), 'the empty last line has none');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});
