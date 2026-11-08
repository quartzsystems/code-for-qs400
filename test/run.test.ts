// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { JOB_LOG_LINE, headerLines, linkConnection, outcomeLines, submittedJob, timestamp } from '../src/actions/output';
import { ActionRunner, LAST_ACTIONS_KEY, SavableDocument, nodeTarget, uriTarget } from '../src/actions/run';
import { ActionStore } from '../src/actions/store';
import { ActionTarget } from '../src/actions/targets';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient } from '../src/host/client';
import { ActionOutcome, CommandMessage } from '../src/host/protocol';
import { memberUri } from '../src/members/uri';
import { ifsUri } from '../src/ifs/uri';
import { FakeHost, Memento } from './members.test';

const JOB = { number: '123456', user: 'QUSER', name: 'QAPCNN' };
const RNS9310: CommandMessage = {
  id: 'RNS9310',
  severity: 50,
  text: 'Program ASSETS42 was not created in library CWELLMAN.',
  secondLevel: 'The listing shows why: diagnostics above GENLVL, OPTION(*NOGEN), or a problem binding or storing the program.',
};
const RNS9304: CommandMessage = {
  id: 'RNS9304',
  severity: 0,
  text: 'Program ASSETS42 created in library CWELLMAN. Highest severity: 00.',
};

suite('Run: the output block', () => {
  test('header: the time, the action, the target and the connection; then the command', () => {
    const when = new Date(2026, 10, 7, 23, 59, 1);
    assert.equal(timestamp(when), '2026-11-07 23:59:01');
    assert.deepEqual(
      headerLines({ when, action: 'Compile (CRTBNDRPG)', target: 'HLINV/QTMPSRC(ASSETS42)', connection: 'QSHQ400', command: 'CRTBNDRPG X' }),
      ['── 2026-11-07 23:59:01 · Compile (CRTBNDRPG) · HLINV/QTMPSRC(ASSETS42) · QSHQ400', 'Command: CRTBNDRPG X'],
    );
  });

  test('outcome: the job, messages oldest first as ID  text, the escape last and once, then the link', () => {
    const o: ActionOutcome = {
      status: 'Error',
      escape: RNS9310,
      job: JOB,
      messages: [{ id: 'RNF7031', severity: 0, text: 'The name is not referenced.' }, RNS9310],
      diagnostics: [],
    };
    assert.deepEqual(outcomeLines(o, false), [
      'Job:     123456/QUSER/QAPCNN',
      'RNF7031  The name is not referenced.',
      'RNS9310  Program ASSETS42 was not created in library CWELLMAN.',
      'Ended:   Error',
      JOB_LOG_LINE,
    ]);
    assert.deepEqual(outcomeLines({ status: 'Cancelled', messages: [], diagnostics: [] }, false), ['Ended:   Cancelled', JOB_LOG_LINE]);
    assert.deepEqual(outcomeLines({ status: 'Ok', job: JOB, messages: [RNS9304], diagnostics: [] }, false).slice(1, 3), [
      'RNS9304  Program ASSETS42 created in library CWELLMAN. Highest severity: 00.',
      'Ended:   Completed',
    ]);
  });

  test('batch: the job submitted, from CPC1221, and no diagnostics', () => {
    const cpc1221 = { id: 'CPC1221', severity: 0, text: 'Job 654321/CWELLMAN/ASSETS submitted to job queue QBATCH in QGPL.' };
    assert.equal(submittedJob([cpc1221]), '654321/CWELLMAN/ASSETS');
    const lines = outcomeLines({ status: 'Ok', job: JOB, messages: [cpc1221], diagnostics: [] }, true);
    assert.ok(lines.includes('Submitted: 654321/CWELLMAN/ASSETS'));
    assert.ok(lines.some((l) => l.startsWith('Diagnostics are not returned for batch runs')));
  });

  test('a Job log line opens the job log of its block’s connection', () => {
    const lines = [
      '── 2026-11-07 23:59:01 · Compile (CRTBNDRPG) · HLINV/QTMPSRC(ASSETS42) · QSHQ400',
      'Command: X',
      JOB_LOG_LINE,
      '── 2026-11-07 23:59:09 · Call (CALL) · HLINV/ASSETS *PGM · OTHER · SYSTEM',
      JOB_LOG_LINE,
    ];
    assert.equal(linkConnection(lines, 2), 'QSHQ400');
    assert.equal(linkConnection(lines, 4), 'SYSTEM');
  });
});

suite('Run: targets', () => {
  test('a member or a stream file URI, and the tree nodes', () => {
    const fakeStore = { get: (n: string) => (n.toLowerCase() === 'qshq400' ? { name: 'QSHQ400' } : undefined) } as unknown as ConnectionStore;
    assert.deepEqual(uriTarget(memberUri('qshq400', 'hlinv', 'qtmpsrc', 'assets42', 'RPGLE'), fakeStore), {
      environment: 'member',
      connection: 'QSHQ400',
      library: 'HLINV',
      file: 'QTMPSRC',
      member: 'ASSETS42',
      type: 'RPGLE',
      ext: 'rpgle',
    });
    assert.deepEqual(uriTarget(ifsUri('QSHQ400', '/home/CWELLMAN/a.sql'), fakeStore), {
      environment: 'file',
      connection: 'QSHQ400',
      path: '/home/CWELLMAN/a.sql',
    });
    const entry = { library: 'HLINV', object: 'ASSETS', type: '*PGM', attribute: 'RPGLE', text: '', size: 0, changed: 0, owner: '' };
    assert.deepEqual(nodeTarget({ kind: 'object', connection: 'QSHQ400', entry }, fakeStore), {
      environment: 'object',
      connection: 'QSHQ400',
      library: 'HLINV',
      object: 'ASSETS',
      type: '*PGM',
      attribute: 'RPGLE',
    });
    assert.equal(nodeTarget({ kind: 'entry', connection: 'QSHQ400', path: '/x', entry: { kind: 'directory' } }, fakeStore), undefined);
  });
});

const MEMBER_NODE = {
  kind: 'member',
  connection: 'QSHQ400',
  library: 'HLINV',
  file: 'QTMPSRC',
  entry: { member: 'ASSETS42', type: 'RPGLE', text: '', records: 0, created: 0, changed: 0 },
};
const OBJECT_NODE = {
  kind: 'object',
  connection: 'QSHQ400',
  entry: { library: 'HLINV', object: 'ASSETS', type: '*PGM', attribute: 'RPGLE', text: '', size: 0, changed: 0, owner: '' },
};

/** A runner on a fake host, `QSHQ400` signed on, with two actions of the connection's own. */
async function runnerOn(answer: (method: string, params: Record<string, unknown>) => unknown, doc?: SavableDocument) {
  const output = vscode.window.createOutputChannel('run test', { log: true });
  const host = new FakeHost(answer);
  const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
  const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
  const state = new Memento();
  const sessions = new SessionManager(host as unknown as HostClient, store, state, output);
  await vscode.workspace.getConfiguration('code-for-qs400').update(
    'connections',
    [
      {
        name: 'QSHQ400',
        host: 'qshq400.example',
        user: 'CWELLMAN',
        actions: [
          { name: 'Call (CALL)', command: 'CALL PGM(&LIBRARY/&NAME)', environment: 'object', extensions: ['*PGM'] },
          { name: 'Submit (SBMJOB CALL)', command: 'CALL PGM(&LIBRARY/&NAME)', environment: 'object', extensions: ['*PGM'], runAs: 'batch' },
          { name: 'Source', command: 'DSPFD FILE(&SRCLIB/&SRCFILE) TYPE(&CUSTOM:NONE)', environment: 'member' },
        ],
      },
    ],
    true,
  );
  sessions.update({ name: 'QSHQ400', state: 'connected', user: 'CWELLMAN', job: JOB });
  const ext = vscode.extensions.getExtension('quartzsystems.code-for-qs400');
  assert.ok(ext);
  const actions = new ActionStore(ext.extensionPath, store, sessions, output);
  await actions.ready;
  const lines: string[] = [];
  const runner = new ActionRunner(store, sessions, actions, state, { findDocument: () => doc, append: (l) => lines.push(l) });
  return { host, runner, state, lines, parts: [runner, actions, sessions, store, host, output] as vscode.Disposable[] };
}

suite('Run: running an action', () => {
  let parts: vscode.Disposable[] = [];
  teardown(async () => {
    parts.forEach((p) => p.dispose());
    parts = [];
    await vscode.workspace.getConfiguration('code-for-qs400').update('connections', undefined, true);
  });

  const compileAnswer = (method: string) => {
    if (method === 'libl.get') {
      return { current: 'CWELLMAN', system: ['QSYS'], user: ['HLINV'] };
    }
    if (method === 'action.run') {
      return { status: 'Ok', job: JOB, messages: [RNS9304], diagnostics: [] };
    }
    throw new Error(`unexpected ${method}`);
  };

  test('a compile: the current library read, the command resolved, sent as kind compile; the block written', async () => {
    const r = await runnerOn(compileAnswer);
    parts = r.parts;
    const result = await r.runner.run(MEMBER_NODE, 'Compile (CRTBNDRPG)');
    assert.ok(result?.outcome);
    const run = r.host.sent.find((s) => s.method === 'action.run');
    assert.ok(run);
    assert.equal(run.params.kind, 'compile');
    assert.equal(
      run.params.command,
      'CRTBNDRPG PGM(CWELLMAN/ASSETS42) SRCFILE(HLINV/QTMPSRC) SRCMBR(ASSETS42) DBGVIEW(*SOURCE) OPTION(*EVENTF)',
    );
    assert.match(String(run.params.run), /^a\d+-\d+$/);
    assert.match(r.lines[0], /^── \d{4}-\d\d-\d\d \d\d:\d\d:\d\d · Compile \(CRTBNDRPG\) · HLINV\/QTMPSRC\(ASSETS42\) · QSHQ400$/);
    assert.deepEqual(r.lines.slice(1), [
      `Command: ${String(run.params.command)}`,
      'Job:     123456/QUSER/QAPCNN',
      'RNS9304  Program ASSETS42 created in library CWELLMAN. Highest severity: 00.',
      'Ended:   Completed',
      JOB_LOG_LINE,
    ]);
    assert.deepEqual(r.state.get(LAST_ACTIONS_KEY), { 'qshq400|member|RPGLE': 'Compile (CRTBNDRPG)' });
  });

  test('a CALL on an object: kind command, its own library, the current library never read', async () => {
    const r = await runnerOn((method) => {
      assert.equal(method, 'action.run');
      return { status: 'Ok', job: JOB, messages: [], diagnostics: [] };
    });
    parts = r.parts;
    await r.runner.run(OBJECT_NODE, 'Call (CALL)');
    assert.deepEqual(
      r.host.sent.map((s) => [s.method, s.params.kind, s.params.command]),
      [['action.run', 'command', 'CALL PGM(HLINV/ASSETS)']],
    );
  });

  test('batch: SBMJOB around the command, as a command, the job named after the target', async () => {
    const r = await runnerOn(() => ({
      status: 'Ok',
      job: JOB,
      messages: [{ id: 'CPC1221', severity: 0, text: 'Job 654321/CWELLMAN/ASSETS submitted to job queue QBATCH in QGPL.' }],
      diagnostics: [],
    }));
    parts = r.parts;
    await r.runner.run(OBJECT_NODE, 'Submit (SBMJOB CALL)');
    assert.equal(r.host.sent[0].params.command, 'SBMJOB CMD(CALL PGM(HLINV/ASSETS)) JOB(ASSETS) JOBQ(QBATCH)');
    assert.equal(r.host.sent[0].params.kind, 'command');
    assert.ok(r.lines.includes('Submitted: 654321/CWELLMAN/ASSETS'));
  });

  test('a dirty document is saved first; a save that fails stops the run, nothing sent', async () => {
    let saves = 0;
    const r = await runnerOn(compileAnswer, { isDirty: true, save: async () => (saves++, false) });
    parts = r.parts;
    assert.equal(await r.runner.run(MEMBER_NODE, 'Compile (CRTBNDRPG)'), undefined);
    assert.equal(saves, 1);
    assert.deepEqual(r.host.sent, []);
    assert.equal(r.lines[r.lines.length - 1], 'Not run: HLINV/QTMPSRC(ASSETS42) could not be saved');
  });

  test('a dirty document that saves is run', async () => {
    let saves = 0;
    const r = await runnerOn(compileAnswer, { isDirty: true, save: async () => (saves++, true) });
    parts = r.parts;
    assert.ok((await r.runner.run(MEMBER_NODE, 'Compile (CRTBNDRPG)'))?.outcome);
    assert.equal(saves, 1);
  });

  test('an unresolved variable is an error before anything is sent', async () => {
    const r = await runnerOn(() => assert.fail('nothing is sent'));
    parts = r.parts;
    assert.equal(await r.runner.run(MEMBER_NODE, 'Source'), undefined);
    assert.deepEqual(r.host.sent, []);
    assert.equal(r.lines[r.lines.length - 1], 'Not run: &CUSTOM:NONE has no value for HLINV/QTMPSRC(ASSETS42)');
  });

  test('the escape message as the server sent it, and a failure before any outcome', async () => {
    const cpf9812 = { id: 'CPF9812', severity: 40, text: 'No file QNOSRC in library HLINV.', secondLevel: 'Check the name and the library, or the library list.' };
    const r = await runnerOn((method) =>
      method === 'libl.get' ? { current: 'CWELLMAN', system: [], user: [] } : { status: 'NotFound', escape: cpf9812, job: JOB, messages: [cpf9812], diagnostics: [] },
    );
    parts = r.parts;
    const result = await r.runner.run(MEMBER_NODE, 'Compile (CRTBNDRPG)');
    assert.equal(result?.outcome?.escape?.id, 'CPF9812');
    assert.deepEqual(r.lines.slice(-3), ['CPF9812  No file QNOSRC in library HLINV.', 'Ended:   NotFound', JOB_LOG_LINE]);
  });

  test('the last action run on a member type is offered first', async () => {
    const r = await runnerOn(() => ({ status: 'Ok', job: JOB, messages: [], diagnostics: [] }));
    parts = r.parts;
    const member: ActionTarget = { environment: 'member', connection: 'QSHQ400', library: 'HLINV', file: 'QTMPSRC', member: 'X', type: 'RPGLE' };
    assert.deepEqual(r.runner.applicable(member).map((a) => a.name), ['Compile (CRTBNDRPG)', 'Compile module (CRTRPGMOD)', 'Source']);
    await r.state.update(LAST_ACTIONS_KEY, { 'qshq400|member|RPGLE': 'Source' });
    assert.deepEqual(r.runner.applicable(member).map((a) => a.name), ['Source', 'Compile (CRTBNDRPG)', 'Compile module (CRTRPGMOD)']);
    const clle: ActionTarget = { ...member, type: 'CLLE' };
    assert.deepEqual(
      r.runner.applicable(clle).map((a) => a.name),
      ['Compile (CRTBNDCL)', 'Compile module (CRTCLMOD)', 'Source'],
      'remembered per type; the RPG compiles do not apply',
    );
  });
});
