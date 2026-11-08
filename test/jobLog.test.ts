// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient } from '../src/host/client';
import { JobLogEntry } from '../src/host/protocol';
import { ID_COLUMN, JobLogProvider, jobLogLines, jobLogUri, parseJobLogUri } from '../src/jobs/jobLog';
import { FakeHost, Memento } from './members.test';

const JOB = { number: '123456', user: 'QUSER', name: 'QAPCNN' };
const at = (h: number, m: number, s: number) => new Date(2026, 10, 7, h, m, s).getTime();
const ENTRIES: JobLogEntry[] = [
  { sent: at(23, 58, 0), id: 'RNF7030', severity: 30, kind: 'diagnostic', text: 'ASSETQTY is not defined.', secondLevel: 'The name is not declared in the program. Declare it, or correct the spelling.', fromProgram: 'QRPGLE', toProgram: 'QAPCNN' },
  { sent: at(23, 58, 1), id: 'RNS9310', severity: 50, kind: 'escape', text: 'Program ASSETS42 was not created\nin library CWELLMAN.', fromProgram: 'QRPGLE', toProgram: 'QAPCNN' },
  { sent: at(23, 59, 9), id: '', severity: 0, kind: 'informational', text: 'An impromptu message.', fromProgram: 'QAPCNN', toProgram: '*EXT' },
];

suite('Job log: the document', () => {
  test('one line per entry, time  ID  text, oldest first; the ID column fixed', () => {
    const lines = jobLogLines(ENTRIES);
    assert.deepEqual(lines, [
      '2026-11-07 23:58:00  RNF7030  ASSETQTY is not defined.',
      '2026-11-07 23:58:01  RNS9310  Program ASSETS42 was not created in library CWELLMAN.',
      '2026-11-07 23:59:09           An impromptu message.',
    ]);
    assert.equal(lines[0].indexOf('RNF7030'), ID_COLUMN);
  });

  test('named Job log nnnnnn/USER/NAME on the tab; the job in the query', () => {
    const uri = jobLogUri('QSHQ400', JOB);
    assert.equal(uri.path, '/Job log 123456∕QUSER∕QAPCNN');
    assert.equal(uri.path.split('/').pop(), 'Job log 123456∕QUSER∕QAPCNN');
    assert.deepEqual(parseJobLogUri(uri), { connection: 'QSHQ400', job: JOB });
    assert.equal(parseJobLogUri(vscode.Uri.parse('qs400joblog://QSHQ400/x')), undefined);
  });

  test('from job.log on a fake host; each ID a hover to its second-level text', async () => {
    const output = vscode.window.createOutputChannel('job log test', { log: true });
    const host = new FakeHost((method, params) => {
      assert.equal(method, 'job.log');
      assert.deepEqual(params, { name: 'QSHQ400' });
      return { job: JOB, entries: ENTRIES };
    });
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    const p = new JobLogProvider(store, sessions);
    try {
      const { uri } = await p.read('QSHQ400');
      assert.equal(uri.toString(), jobLogUri('QSHQ400', JOB).toString());
      const text = await p.provideTextDocumentContent(uri);
      assert.equal(text.split('\n')[1], '2026-11-07 23:58:01  RNS9310  Program ASSETS42 was not created in library CWELLMAN.');
      const doc = { uri } as vscode.TextDocument;
      const hover = p.provideHover(doc, new vscode.Position(0, ID_COLUMN + 3));
      assert.ok(hover);
      // appendText keeps the server's spacing as &nbsp;.
      const md = (hover.contents[0] as vscode.MarkdownString).value.replace(/&nbsp;/g, ' ');
      assert.match(md, /RNF7030/);
      assert.match(md, /The name is not declared in the program/);
      assert.equal(hover.range?.start.character, ID_COLUMN);
      assert.equal(p.provideHover(doc, new vscode.Position(0, 3)), undefined, 'the time is no hover');
      assert.equal(p.provideHover(doc, new vscode.Position(2, ID_COLUMN)), undefined, 'no ID, no hover');
    } finally {
      [p, sessions, store, host, output].forEach((d) => d.dispose());
    }
  });
});
