// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { FIRST_PAGES, firstRead, layout, markerText, pageAt, pageLine } from '../src/spool/layout';
import { SPOOL_LANGUAGE, SpoolViewer, parseSpoolUri, spoolUri } from '../src/spool/viewer';
import { CONN_JOB, splf, spoolView } from './spool.test';

/** 132 columns: 1234567890 repeated, so a column is its own last digit. */
const RULER = Array.from({ length: 132 }, (_, i) => String((i + 1) % 10)).join('');

/** A compile listing of three pages, as `spool.readText` sends it: a form feed between pages. */
export const LISTING =
  `${RULER}\n` +
  '5770WDS V1R0M0  ILE RPG             HLINV/ASSETS                                               2026-11-08 09:00:00     Page    1\n' +
  '\f' +
  '   42  ASSETQTY = 0;\n' +
  ' RNF7030 30      42  ASSETQTY is not defined.\n' +
  '\n' +
  '\f' +
  '                     M e s s a g e   S u m m a r y\n' +
  ' Msg id  Sv Number Message text\n' +
  ' RNF7030 30      1 The name or indicator is not defined.\n' +
  '   * * * * *   E N D   O F   C O M P I L A T I O N   * * * * *\n';

suite('Spooled file viewer: the layout', () => {
  test('a marker line before each page; no printed line changes', () => {
    const l = layout(LISTING);
    const lines = l.text.split('\n');
    assert.deepEqual(l.markers, [0, 3, 7]);
    assert.ok(l.markers.every((m) => lines[m] === ''), 'markers are empty lines');
    assert.equal(lines[1], RULER);
    assert.equal(lines[1].length, 132);
    assert.equal(lines[2].length, 128);
    assert.equal(lines[4], '   42  ASSETQTY = 0;');
    assert.equal(lines[6], '', 'a printed blank line is kept');
    assert.equal(lines[10], ' RNF7030 30      1 The name or indicator is not defined.');
    assert.ok(!l.text.includes('\f'));
    assert.equal(lines.length, 13, 'the last page’s last line break ends it');
    assert.equal(markerText(2), '— page 2 —');
  });

  test('the page under a line, and the line of a page', () => {
    const l = layout(LISTING);
    assert.equal(pageAt(l, 0), 1);
    assert.equal(pageAt(l, 2), 1);
    assert.equal(pageAt(l, 3), 2);
    assert.equal(pageAt(l, 6), 2);
    assert.equal(pageAt(l, 7), 3);
    assert.equal(pageAt(l, 99), 3);
    assert.equal(pageLine(l, 3), 7);
    assert.equal(pageLine(l, 4), undefined);
    const later = layout('a\fb\n', 101);
    assert.equal(pageAt(later, 2), 102);
    assert.equal(pageLine(later, 101), 0);
    assert.deepEqual(layout(''), { text: '', markers: [], firstPage: 1 });
    assert.deepEqual(layout('x\r\ny\r\n').text, '\nx\ny\n');
  });

  test('a file under 2000 pages is read whole, a larger one its first 100', () => {
    assert.deepEqual(firstRead(3), { lastPage: 0, partial: false });
    assert.deepEqual(firstRead(1999), { lastPage: 0, partial: false });
    assert.deepEqual(firstRead(2000), { lastPage: FIRST_PAGES, partial: true });
    assert.deepEqual(firstRead(undefined), { lastPage: FIRST_PAGES, partial: true });
  });

  test('the URI names the file; the tab its title', () => {
    const id = { job: CONN_JOB, file: 'QSYSPRT', number: 8 };
    const uri = spoolUri('QSHQ400', id, 3);
    assert.equal(uri.path.split('/').pop(), 'QSYSPRT(8) 123456∕QUSER∕QAPCNN');
    assert.deepEqual(parseSpoolUri(uri), { connection: 'QSHQ400', id, pages: 3 });
    assert.deepEqual(parseSpoolUri(spoolUri('QSHQ400', id)), { connection: 'QSHQ400', id, pages: undefined });
    assert.equal(parseSpoolUri(vscode.Uri.parse('qs400spl://QSHQ400/x?file=QSYSPRT')), undefined);
  });
});

suite('Spooled file viewer: the editor', () => {
  test('opens read whole in the spool language; Go to page and the status bar', async () => {
    const v = spoolView((method, params) => {
      assert.equal(method, 'spool.readText');
      assert.deepEqual(params, { name: 'QSHQ400', id: splf(8).id });
      return { pages: 3, firstPage: 1, lastPage: 3, text: LISTING };
    });
    const viewer = new SpoolViewer(v.store, v.sessions, v.provider);
    const subs = viewer.register();
    try {
      const ed = await viewer.open({ connection: 'QSHQ400', id: splf(8).id }, 3);
      assert.ok(ed);
      assert.equal(ed.document.languageId, SPOOL_LANGUAGE);
      assert.equal(ed.document.lineAt(1).text, RULER);
      assert.equal(ed.document.lineAt(1).text.length, 132);
      const s = viewer.state(ed.document.uri);
      assert.deepEqual(s?.layout.markers, [0, 3, 7]);
      assert.equal(s?.partial, false);
      const rulers = vscode.workspace.getConfiguration('editor', { languageId: SPOOL_LANGUAGE }).get<number[]>('rulers');
      assert.deepEqual(rulers, [80, 132]);
      assert.equal(vscode.workspace.getConfiguration('editor', { languageId: SPOOL_LANGUAGE }).get('wordWrap'), 'off');
      assert.equal(await viewer.goToPage(ed, 3), 3);
      assert.equal(ed.selection.active.line, 8);
      assert.equal(viewer.statusText, '$(file-text) Page 3 of 3');
      assert.equal(await viewer.goToPage(ed, 2), 2);
      assert.equal(ed.selection.active.line, 4);
      assert.equal(await viewer.goToPage(ed, 4), undefined, 'no page 4');
      assert.deepEqual(viewer.refOf(ed.document.uri), { connection: 'QSHQ400', id: splf(8).id });
      // A search finds the text as printed.
      assert.ok(ed.document.getText().includes('E N D   O F   C O M P I L A T I O N'));
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      subs.forEach((d) => d.dispose());
      v.dispose();
    }
  });

  test('a large file opens at its first 100 pages; Load all reads the rest', async () => {
    const pages = Array.from({ length: 2500 }, (_, i) => `page ${i + 1}\n`);
    const asked: unknown[] = [];
    const v = spoolView((_method, params) => {
      asked.push(params.lastPage ?? 'all');
      const last = (params.lastPage as number | undefined) ?? 2500;
      return { pages: 2500, firstPage: 1, lastPage: last, text: pages.slice(0, last).join('\f') };
    });
    const viewer = new SpoolViewer(v.store, v.sessions, v.provider);
    const subs = viewer.register();
    try {
      const ed = await viewer.open({ connection: 'QSHQ400', id: splf(9).id }, 2500);
      const uri = ed!.document.uri;
      assert.equal(viewer.state(uri)?.partial, true);
      assert.equal(viewer.state(uri)?.layout.markers.length, 100);
      assert.deepEqual(asked, [100]);
      const done = new Promise<void>((resolve) => {
        const sub = vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.document.uri.toString() === uri.toString()) {
            sub.dispose();
            resolve();
          }
        });
      });
      await vscode.commands.executeCommand('code-for-qs400.spool.loadAll', uri);
      await done;
      assert.equal(viewer.state(uri)?.partial, false);
      assert.equal(viewer.state(uri)?.layout.markers.length, 2500);
      assert.deepEqual(asked, [100, 'all']);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      subs.forEach((d) => d.dispose());
      v.dispose();
    }
  });

  test('restored without its page count: a small file is read whole after its first look', async () => {
    const asked: unknown[] = [];
    const v = spoolView((_m, params) => {
      asked.push(params.lastPage ?? 'all');
      return { pages: 150, firstPage: 1, lastPage: (params.lastPage as number | undefined) ?? 150, text: 'x\fy\n' };
    });
    const viewer = new SpoolViewer(v.store, v.sessions, v.provider);
    try {
      await viewer.provideTextDocumentContent(spoolUri('QSHQ400', splf(10).id));
      assert.deepEqual(asked, [100, 'all']);
      assert.equal(viewer.state(spoolUri('QSHQ400', splf(10).id))?.partial, false);
    } finally {
      viewer.dispose();
      v.dispose();
    }
  });
});
