// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient } from '../src/host/client';
import { JobEntry, JobLogEntry, SessionStatus } from '../src/host/protocol';
import { JobLogProvider } from '../src/jobs/jobLog';
import {
  endQuestion,
  filterLabel,
  glyphLines,
  groupJobs,
  jobDescription,
  kindGlyph,
  parseDelay,
  parseQualifiedJob,
  qualifiedJob,
  sameJob,
} from '../src/jobs/model';
import { JOBS_FILTER_KEY, JobNode, JobsProvider, jobTreeItem } from '../src/views/jobs';
import { FakeHost, Memento } from './members.test';

const OWN = { number: '123456', user: 'QUSER', name: 'QAPCNN' };

function entry(number: string, name: string, state: JobEntry['state'], over: Partial<JobEntry> = {}): JobEntry {
  const active = state === 'active';
  return {
    job: { number, user: 'CWELLMAN', name },
    state,
    status: active ? '*ACTIVE' : state === 'onJobQueue' ? '*JOBQ' : '*OUTQ',
    type: active ? 'INTER' : 'BATCH',
    subsystem: active ? 'QINTER' : '',
    function: active ? 'CMD-WRKSPLF' : '',
    entered: Date.UTC(2026, 10, 8, 9, 0, 0),
    ...over,
  };
}

const JOBS: JobEntry[] = [
  entry('100001', 'QPADEV0001', 'active'),
  { ...entry('123456', 'QAPCNN', 'active', { function: 'PGM-QAPCNN', type: 'BATCHI', subsystem: 'QSYSWRK' }), job: OWN },
  entry('654321', 'CODETEST', 'active', { type: 'BATCH', subsystem: 'QBATCH', function: 'CMD-DLYJOB' }),
  entry('654400', 'NIGHTLY', 'onJobQueue'),
  entry('654000', 'ASSETS', 'onOutputQueue'),
  entry('654001', 'ASSETS', 'onOutputQueue'),
];

suite('Jobs: the model', () => {
  test('grouped by state in the server order, every group present', () => {
    const g = groupJobs(JOBS);
    assert.deepEqual([...g.keys()], ['active', 'onJobQueue', 'onOutputQueue']);
    assert.deepEqual(
      g.get('active')!.map((j) => j.job.name),
      ['QPADEV0001', 'QAPCNN', 'CODETEST'],
    );
    assert.deepEqual(
      g.get('onOutputQueue')!.map((j) => j.job.number),
      ['654000', '654001'],
    );
    const none = groupJobs([]);
    assert.deepEqual([...none.values()].map((l) => l.length), [0, 0, 0]);
  });

  test('description: number/user, status, type, subsystem, function; the own job marked', () => {
    assert.equal(jobDescription(JOBS[2], false), '654321/CWELLMAN · *ACTIVE · BATCH · QBATCH · CMD-DLYJOB');
    assert.equal(jobDescription(JOBS[3], false), '654400/CWELLMAN · *JOBQ · BATCH');
    assert.equal(jobDescription(JOBS[1], true), '123456/QUSER · *ACTIVE · BATCHI · QSYSWRK · PGM-QAPCNN · this connection');
  });

  test('qualified names', () => {
    assert.equal(qualifiedJob(OWN), '123456/QUSER/QAPCNN');
    assert.deepEqual(parseQualifiedJob(' 654321/CWELLMAN/CODETEST '), { number: '654321', user: 'CWELLMAN', name: 'CODETEST' });
    assert.equal(parseQualifiedJob('65432/CWELLMAN/CODETEST'), undefined);
    assert.equal(parseQualifiedJob('654321/CWELLMAN'), undefined);
    assert.ok(sameJob(OWN, { number: '123456', user: 'quser', name: 'qapcnn' }));
    assert.ok(!sameJob(OWN, { ...OWN, number: '123457' }));
    assert.ok(!sameJob(OWN, undefined));
  });

  test('filters, End’s question and delay', () => {
    assert.equal(filterLabel('*CURRENT'), 'My jobs');
    assert.equal(filterLabel('*all'), 'All jobs (*ALL)');
    assert.equal(filterLabel('qsys'), 'Jobs of QSYS');
    const j = { number: '654321', user: 'CWELLMAN', name: 'CODETEST' };
    assert.equal(endQuestion(j, 'immediate'), 'End job 654321/CWELLMAN/CODETEST *IMMED?');
    assert.equal(endQuestion(j, 'controlled', 30), 'End job 654321/CWELLMAN/CODETEST *CNTRLD DELAY(30)?');
    assert.equal(endQuestion(j, 'controlled'), 'End job 654321/CWELLMAN/CODETEST *CNTRLD?');
    assert.equal(parseDelay(''), undefined);
    assert.equal(parseDelay(' 30 '), 30);
    assert.equal(parseDelay('999999'), 999999);
    for (const bad of ['0', '1000000', '-1', '3.5', 'x']) {
      assert.equal(parseDelay(bad), 'invalid', bad);
    }
  });

  test('the job log’s glyphs, by kind, line n entry n', () => {
    assert.equal(kindGlyph('escape'), 'escape');
    assert.equal(kindGlyph('senderCopy'), 'inquiry');
    assert.equal(kindGlyph('notify'), 'info');
    const e = (kind: JobLogEntry['kind']): JobLogEntry => ({ sent: 0, id: 'CPF0000', severity: 0, kind, text: '', fromProgram: 'A', toProgram: 'B' });
    const g = glyphLines([e('completion'), e('escape'), e('informational'), e('diagnostic'), e('inquiry'), e('escape')]);
    assert.deepEqual(g.get('escape'), [1, 5]);
    assert.deepEqual(g.get('completion'), [0]);
    assert.deepEqual(g.get('diagnostic'), [3]);
    assert.deepEqual(g.get('inquiry'), [4]);
    assert.deepEqual(g.get('info'), [2]);
  });
});

/** The Jobs view on a fake host with `QSHQ400` signed on and active. */
function jobsView(answer: (method: string, params: Record<string, unknown>) => unknown, qap = 9) {
  const output = vscode.window.createOutputChannel('jobs test', { log: true });
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
    job: OWN,
  };
  sessions.update(status);
  const provider = new JobsProvider(store, sessions, state);
  const dispose = () => [provider, sessions, store, host, output].forEach((d) => d.dispose());
  return { host, store, sessions, provider, state, dispose };
}

suite('Jobs: the view', () => {
  test('My jobs, then Active, On job queue, On output queue; the connection job marked', async () => {
    const v = jobsView((method, params) => {
      assert.equal(method, 'jobs.list');
      assert.deepEqual(params, { name: 'QSHQ400', user: '*CURRENT' });
      return JOBS;
    });
    try {
      const [root] = await v.provider.getChildren();
      assert.equal(root.kind, 'filter');
      assert.equal(jobTreeItem(root).label, 'My jobs');
      const groups = await v.provider.getChildren(root);
      assert.deepEqual(
        groups.map((g) => [jobTreeItem(g).label, jobTreeItem(g).description]),
        [
          ['Active', '3'],
          ['On job queue', '1'],
          ['On output queue', '2'],
        ],
      );
      const active = await v.provider.getChildren(groups[0]);
      const items = active.map(jobTreeItem);
      assert.deepEqual(
        items.map((i) => i.label),
        ['QPADEV0001', 'QAPCNN', 'CODETEST'],
      );
      assert.equal(items[1].contextValue, 'jobs.job.own');
      assert.match(String(items[1].description), /this connection$/);
      assert.equal(items[2].contextValue, 'jobs.job');
      assert.equal(items[2].description, '654321/CWELLMAN · *ACTIVE · BATCH · QBATCH · CMD-DLYJOB');
      // Read once per refresh, and found again for reveal.
      const found = await v.provider.find({ number: '654321', user: 'CWELLMAN', name: 'CODETEST' });
      assert.equal(found?.entry.job.name, 'CODETEST');
      assert.equal(v.provider.getParent(found as JobNode), found?.parent);
      assert.equal(v.host.sent.length, 1);
      v.provider.refresh();
      await v.provider.getChildren(await v.provider.getChildren().then((r) => r[0]));
      assert.equal(v.host.sent.length, 2);
    } finally {
      v.dispose();
    }
  });

  test('the filter is saved per connection; *ALL refused shows the server’s message', async () => {
    const v = jobsView((_m, params) => {
      if (params.user === '*ALL') {
        throw new Error('CPF1343: Job 000000/QSYS/* not valid job type for function.');
      }
      return [];
    });
    try {
      await v.provider.setFilter('QSHQ400', '*all');
      assert.deepEqual(v.state.get(JOBS_FILTER_KEY), { QSHQ400: '*ALL' });
      const [root] = await v.provider.getChildren();
      assert.equal(jobTreeItem(root).label, 'All jobs (*ALL)');
      const [msg] = await v.provider.getChildren(root);
      assert.equal(msg.kind, 'message');
      assert.match(String(jobTreeItem(msg).label), /CPF1343/);
      await v.provider.setFilter('QSHQ400', '*CURRENT');
      assert.deepEqual(v.state.get(JOBS_FILTER_KEY), {});
    } finally {
      v.dispose();
    }
  });

  test('a server below QAP 8 gets one line and no call', async () => {
    const v = jobsView(() => assert.fail('nothing is sent'), 7);
    try {
      const [n] = await v.provider.getChildren();
      assert.equal(jobTreeItem(n).label, 'QAP version 8 not available on this server');
    } finally {
      v.dispose();
    }
  });

  test('the job log of any job comes from jobs.log', async () => {
    const entries: JobLogEntry[] = [
      { sent: Date.UTC(2026, 10, 8, 9, 0, 1), id: 'CPF1124', severity: 0, kind: 'informational', text: 'Job 654321/CWELLMAN/CODETEST started.', fromProgram: 'QWTPIIPP', toProgram: '*EXT' },
    ];
    const v = jobsView((method, params) => {
      assert.equal(method, 'jobs.log');
      assert.deepEqual(params, { name: 'QSHQ400', job: { number: '654321', user: 'CWELLMAN', name: 'CODETEST' } });
      return entries;
    });
    const p = new JobLogProvider(v.store, v.sessions);
    try {
      const { uri, log } = await p.read('QSHQ400', { number: '654321', user: 'CWELLMAN', name: 'CODETEST' });
      assert.equal(uri.path, '/Job log 654321∕CWELLMAN∕CODETEST');
      assert.equal(log.entries.length, 1);
      const hover = p.provideHover({ uri } as vscode.TextDocument, new vscode.Position(0, 22));
      const md = (hover?.contents[0] as vscode.MarkdownString).value.replace(/&nbsp;/g, ' ');
      // appendText escapes the `*` of `*EXT`.
      assert.match(md, /QWTPIIPP → \\?\*EXT/);
    } finally {
      p.dispose();
      v.dispose();
    }
  });

  test('without a job named, the connection job’s log, through jobs.log', async () => {
    const v = jobsView((method, params) => {
      assert.equal(method, 'jobs.log');
      assert.deepEqual(params, { name: 'QSHQ400', job: OWN });
      return [];
    });
    const p = new JobLogProvider(v.store, v.sessions);
    try {
      const { log } = await p.read('QSHQ400');
      assert.deepEqual(log.job, OWN);
    } finally {
      p.dispose();
      v.dispose();
    }
  });
});
