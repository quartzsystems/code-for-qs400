// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient } from '../src/host/client';
import { OutputQueue, SessionStatus, SpoolChanged, SpoolProgress, SpooledFile } from '../src/host/protocol';
import {
  deleteQuestion,
  fileDescription,
  fileLabel,
  fileTitle,
  highestNumber,
  jobFilesUser,
  listingFile,
  newListing,
  queueDescription,
  saveName,
  statusLabel,
} from '../src/spool/model';
import { MY_FILES, QUEUE_LIBRARY_KEY, SpoolProvider, spoolTreeItem } from '../src/views/spool';
import { FakeHost, Memento } from './members.test';

export const CONN_JOB = { number: '123456', user: 'QUSER', name: 'QAPCNN' };

export function splf(number: number, over: Partial<SpooledFile> = {}): SpooledFile {
  return {
    id: { job: CONN_JOB, file: 'QSYSPRT', number },
    status: 'ready',
    outq: { library: 'QUSRSYS', name: 'CWELLMAN' },
    user: 'CWELLMAN',
    userData: 'ASSETS',
    formType: '*STD',
    deviceType: 'scs',
    pages: 3,
    copies: 1,
    size: 4096,
    created: Date.UTC(2026, 10, 8, 9, 0, 0),
    ...over,
  };
}

const QUEUE: OutputQueue = { outq: { library: 'QUSRSYS', name: 'PRT01' }, text: 'Printer 1', files: 12, writer: 'PRT01', held: false };

suite('Spooled files: the model', () => {
  test('labels, descriptions and titles', () => {
    const f = splf(8, { status: 'held' });
    assert.equal(fileLabel(f.id), 'QSYSPRT (8)');
    assert.equal(fileTitle(f.id), 'QSYSPRT(8) 123456/QUSER/QAPCNN');
    assert.equal(fileDescription(f), 'Held · 3 pages · ASSETS · *STD · QUSRSYS/CWELLMAN');
    assert.equal(fileDescription(splf(1, { pages: 1, userData: '', formType: '' })), 'Ready · 1 page · QUSRSYS/CWELLMAN');
    assert.equal(queueDescription(QUEUE), '12 files · writer PRT01');
    assert.equal(queueDescription({ ...QUEUE, files: 1, writer: '', held: true }), '1 file · no writer · held');
    assert.equal(statusLabel('message'), 'Message waiting');
    assert.equal(saveName(f.id, 'pdf'), 'QSYSPRT-8-123456.pdf');
    assert.equal(deleteQuestion(f.id), 'Delete spooled file QSYSPRT number 8 of job 123456/QUSER/QAPCNN?');
  });

  test('the listing file a command names, and the run’s listing', () => {
    assert.equal(listingFile('CRTBNDRPG PGM(CWELLMAN/ASSETS) SRCFILE(HLINV/QRPGLESRC)'), 'QSYSPRT');
    assert.equal(listingFile('CRTBNDRPG PGM(A/B) PRTFILE(QGPL/MYLIST)'), 'MYLIST');
    assert.equal(listingFile('CRTBNDCL PGM(A/B) prtfile( mylist )'), 'MYLIST');
    assert.equal(listingFile('CRTBNDRPG PRTFILE(*LIBL/QSYSPRT)'), 'QSYSPRT');
    const files = [splf(6), splf(7), { ...splf(9), id: { ...splf(9).id, file: 'QPJOBLOG' } }, splf(8)];
    assert.equal(highestNumber(files, CONN_JOB), 9);
    assert.equal(highestNumber(files, { ...CONN_JOB, number: '000001' }), 0);
    assert.equal(newListing(files, CONN_JOB, 'QSYSPRT', 6)?.id.number, 8);
    assert.equal(newListing(files, CONN_JOB, 'QSYSPRT', 9), undefined, 'nothing made during the run');
    assert.equal(jobFilesUser(CONN_JOB, CONN_JOB), '*CURRENT');
    assert.equal(jobFilesUser({ number: '654321', user: 'CWELLMAN', name: 'CODETEST' }, CONN_JOB), 'CWELLMAN');
  });
});

/** A Spooled files view on a fake host with `QSHQ400` signed on and active. */
export function spoolView(answer: (method: string, params: Record<string, unknown>) => unknown, qap = 9) {
  const output = vscode.window.createOutputChannel('spool test', { log: true });
  const host = new FakeHost(answer);
  const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
  const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
  const state = new Memento();
  const sessions = new SessionManager(host as unknown as HostClient, store, state, output);
  Object.defineProperty(sessions, 'active', { get: () => 'QSHQ400' });
  const status: SessionStatus = {
    name: 'QSHQ400',
    state: 'connected',
    user: 'CWELLMAN',
    system: { name: 'QSHQ400', product: 'QS00SS1', version: 'V1R0M0', qap },
    job: CONN_JOB,
  };
  sessions.update(status);
  const changed = new vscode.EventEmitter<SpoolChanged>();
  const progress = new vscode.EventEmitter<SpoolProgress>();
  const events = { onDidChangeSpool: changed.event, onDidSpoolProgress: progress.event };
  const provider = new SpoolProvider(store, sessions, state, events);
  const dispose = () => [provider, sessions, store, host, output, changed, progress].forEach((d) => d.dispose());
  return { host, store, sessions, provider, state, changed, progress, events, dispose };
}

suite('Spooled files: the view', () => {
  test('My spooled files and Output queues; files and queues described', async () => {
    const v = spoolView((method, params) => {
      if (method === 'spool.files' && params.outq) {
        assert.deepEqual(params, { name: 'QSHQ400', user: '*ALL', outq: QUEUE.outq });
        return [splf(1, { outq: QUEUE.outq })];
      }
      if (method === 'spool.files') {
        assert.deepEqual(params, { name: 'QSHQ400' });
        return [splf(7), splf(8, { status: 'held' })];
      }
      assert.equal(method, 'spool.queues');
      assert.deepEqual(params, { name: 'QSHQ400', library: '*LIBL' });
      return [QUEUE];
    });
    try {
      const roots = await v.provider.getChildren();
      assert.deepEqual(
        roots.map((r) => [spoolTreeItem(r).label, spoolTreeItem(r).description]),
        [
          ['My spooled files', 'QSHQ400'],
          ['Output queues', '*LIBL'],
        ],
      );
      const mine = (await v.provider.getChildren(roots[0])).map(spoolTreeItem);
      assert.deepEqual(
        mine.map((i) => [i.label, i.description, i.contextValue]),
        [
          ['QSYSPRT (7)', 'Ready · 3 pages · ASSETS · *STD · QUSRSYS/CWELLMAN', 'spool.file.ready'],
          ['QSYSPRT (8)', 'Held · 3 pages · ASSETS · *STD · QUSRSYS/CWELLMAN', 'spool.file.held'],
        ],
      );
      const [q] = await v.provider.getChildren(roots[1]);
      assert.equal(spoolTreeItem(q).label, 'QUSRSYS/PRT01');
      assert.equal(spoolTreeItem(q).description, '12 files · writer PRT01');
      const [f] = await v.provider.getChildren(q);
      assert.equal(spoolTreeItem(f).label, 'QSYSPRT (1)');
    } finally {
      v.dispose();
    }
  });

  test('the library is saved per connection', async () => {
    const v = spoolView(() => []);
    try {
      await v.provider.setLibrary('QSHQ400', 'qusrsys');
      assert.deepEqual(v.state.get(QUEUE_LIBRARY_KEY), { QSHQ400: 'QUSRSYS' });
      const roots = await v.provider.getChildren();
      assert.equal(spoolTreeItem(roots[1]).description, 'QUSRSYS');
      await v.provider.setLibrary('QSHQ400', '*libl');
      assert.deepEqual(v.state.get(QUEUE_LIBRARY_KEY), {});
    } finally {
      v.dispose();
    }
  });

  test('a job’s node comes first; the connection job’s files are the profile’s', async () => {
    const job = { number: '654321', user: 'CWELLMAN', name: 'CODETEST' };
    const v = spoolView((method, params) => {
      assert.equal(method, 'spool.files');
      return params.job ? [splf(1, { id: { job: params.job as typeof job, file: 'QPJOBLOG', number: 1 } })] : [];
    });
    try {
      v.provider.showJob('QSHQ400', job);
      const roots = await v.provider.getChildren();
      assert.equal(spoolTreeItem(roots[0]).label, 'Job 654321/CWELLMAN/CODETEST');
      const [f] = await v.provider.getChildren(roots[0]);
      assert.equal(spoolTreeItem(f).label, 'QPJOBLOG (1)');
      assert.deepEqual(v.host.sent.at(-1)?.params, { name: 'QSHQ400', user: 'CWELLMAN', job });
      v.provider.showJob('QSHQ400', CONN_JOB);
      await v.provider.getChildren((await v.provider.getChildren())[0]);
      assert.deepEqual(v.host.sent.at(-1)?.params, { name: 'QSHQ400', user: '*CURRENT', job: CONN_JOB });
      v.provider.clearJob();
      assert.equal((await v.provider.getChildren()).length, 2);
    } finally {
      v.dispose();
    }
  });

  test('spool.changed refreshes the node and counts new files until Refresh', async () => {
    const v = spoolView(() => []);
    try {
      const roots = await v.provider.getChildren();
      const fired: unknown[] = [];
      const sub = v.provider.onDidChangeTreeData((n) => fired.push(n));
      v.changed.fire({ name: 'QSHQ400', target: MY_FILES, change: 'added', id: splf(9).id, file: splf(9) });
      v.changed.fire({ name: 'QSHQ400', target: MY_FILES, change: 'changed', id: splf(9).id, file: splf(9, { status: 'held' }) });
      v.changed.fire({ name: 'OTHER', target: MY_FILES, change: 'added', id: splf(9).id });
      assert.equal(v.provider.newFiles, 1);
      assert.deepEqual(fired, [roots[0], roots[0]]);
      v.provider.refresh(true);
      assert.equal(v.provider.newFiles, 0);
      sub.dispose();
    } finally {
      v.dispose();
    }
  });

  test('a server below QAP 3 gets one line and no call', async () => {
    const v = spoolView(() => assert.fail('nothing is sent'), 2);
    try {
      const [n] = await v.provider.getChildren();
      assert.equal(spoolTreeItem(n).label, 'QAP version 3 not available on this server');
    } finally {
      v.dispose();
    }
  });
});
