// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension';
import { FixedFormRpg, lineGuides } from '../src/languages/fixedForm';
import { type SpecForm, boundaries, columnOf, describe, fieldAt, formOf, isFree, offsetOf } from '../src/languages/rpgColumns';

async function api(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>('quartzsystems.code-for-qs400');
  assert.ok(ext);
  return ext.activate();
}

const D = '     D ASSETQTY        S              7P 0 INZ(0)';
const C = '     C     ITEMNO        CHAIN     ITEMMST';
const CX = '     C                   EVAL      ASSETQTY = ASSETQTY + 1';

suite('Fixed-form RPG: columns', () => {
  let forms: SpecForm[];
  suiteSetup(async () => {
    const { languages } = await api();
    forms = (await languages.request<SpecForm[]>('qs400-rpgle', 'qs400/specForms')) ?? [];
    assert.ok(forms.length > 0, 'the server gave the table');
  });

  test('the table is the server’s', () => {
    assert.deepEqual(
      forms.map((f) => f.id),
      ['H', 'F', 'D', 'I', 'IX', 'IR', 'IF', 'C', 'CX', 'O', 'OF', 'P'],
    );
  });

  test('a line’s specification', () => {
    const id = (l: string) => formOf(l, forms)?.id;
    assert.equal(id(D), 'D');
    assert.equal(id(C), 'C');
    assert.equal(id(CX), 'CX');
    assert.equal(id('     C                   IF        %FOUND(ITEMMST)'), 'CX');
    assert.equal(id('     C                             AND X = 1'), 'CX');
    assert.equal(id('     FITEMMST   IF   E           K DISK'), 'F');
    assert.equal(id('     H DFTACTGRP(*NO)'), 'H');
    assert.equal(id('     PGETQTY           B                   EXPORT'), 'P');
    assert.equal(id('     IITEMR'), 'IR');
    assert.equal(id('     OQPRINT    E            DETAIL'), 'O');
    assert.equal(id('     O                       ITEMNO'), 'OF');
    // Not specifications.
    assert.equal(id('      * a comment'), undefined);
    assert.equal(id('      /COPY QRPGLESRC,CP'), undefined);
    assert.equal(id('        x = 1;'), undefined);
    assert.equal(id('     C/EXEC SQL'), undefined);
    assert.equal(id('** CTDATA MSGS'), undefined);
    assert.equal(id('    '), undefined);
  });

  test('boundaries and the field under a column', () => {
    const d = formOf(D, forms)!;
    assert.deepEqual(boundaries(d), [6, 7, 22, 23, 24, 26, 33, 40, 41, 43, 44, 81]);
    assert.equal(fieldAt(d, 24)?.ruler, 'Ds');
    assert.equal(describe(d, 24), 'D · Ds 24–25 · col 24');
    assert.equal(describe(d, 22), 'D · E 22 · col 22');
    assert.equal(describe(d, 6), 'D · Form type 6 · col 6');
    assert.equal(describe(d, 3), 'D · Sequence 1–5 · col 3');
    assert.equal(describe(formOf(C, forms), 27), 'C · Opcode(E) 26–35 · col 27');
    assert.equal(describe(undefined, 9), 'col 9');
  });

  test('columns count characters, not UTF-16 units', () => {
    const line = '     D é😀X';
    assert.equal(columnOf(line, line.indexOf('X')), 10);
    assert.equal(offsetOf(line, 10), line.indexOf('X'));
    assert.equal(offsetOf(line, 11), undefined);
    // A guide on the emoji covers both of its units.
    const g = lineGuides('     D😀' + ' '.repeat(40), 0, forms);
    const at7 = g.find((r) => r.start.character === 6)!;
    assert.equal(at7.end.character, 8);
  });

  test('a line gets guides only where it reaches', () => {
    const g = lineGuides(D, 3, forms).map((r) => r.start.character + 1);
    assert.deepEqual(g, [6, 7, 22, 23, 24, 26, 33, 40, 41, 43, 44]);
    assert.ok(lineGuides(D, 3, forms).every((r) => r.start.line === 3));
    assert.deepEqual(lineGuides('      * comment', 0, forms), []);
  });
});

suite('Fixed-form RPG: fixed and **FREE', () => {
  let dir: string;
  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs4rpg-'));
  });
  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows may still hold a handle on the folder; it is a temporary one.
    }
  });

  async function open(name: string, text: string): Promise<vscode.TextEditor> {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.equal(doc.languageId, 'qs400-rpgle', 'local .rpgle files are RPG');
    return vscode.window.showTextDocument(doc);
  }

  test('a fixed-form member gets guides and the column', async () => {
    const { rpg } = await api();
    const e = await open('fixed.rpgle', `${D}\n${C}\n`);
    assert.ok(FixedFormRpg.isFixed(e.document));
    await rpg.table();
    e.selection = new vscode.Selection(0, 23, 0, 23);
    await rpg.paint();
    assert.equal(rpg.statusText, 'D · Ds 24–25 · col 24');
  });

  test('a **FREE member gets none', async () => {
    const e = await open('free.rpgle', '**FREE\ndcl-s x int(10);\n');
    assert.equal(isFree(e.document.lineAt(0).text), true);
    assert.equal(FixedFormRpg.isFixed(e.document), false);
    assert.equal(isFree('**free'), true);
    assert.equal(isFree('     **FREE'), false);
  });
});
