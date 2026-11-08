// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  Action,
  applies,
  firstToken,
  kindOf,
  mergeActions,
  parseActions,
  parseActionsText,
  withSource,
} from '../src/actions/model';
import { ActionStore } from '../src/actions/store';
import {
  ActionTarget,
  batchCommand,
  choiceKey,
  matchTarget,
  needsLibrary,
  resolveCommand,
  usesCurrentLibrary,
} from '../src/actions/targets';
import { substitute, unknownVariables, variablesIn } from '../src/actions/variables';
import { parseConnections, toSetting } from '../src/connections/config';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient } from '../src/host/client';
import { FakeHost, Memento } from './members.test';

const layer = (kind: 'default' | 'workspace' | 'connection', label: string, raw: unknown[]): Action[] =>
  withSource(parseActions(raw, label).entries, { kind, label });

const compile = (name: string, command: string, extra: Record<string, unknown> = {}) => ({
  name,
  command,
  environment: 'member',
  extensions: ['rpgle'],
  ...extra,
});

suite('Actions: reading and merging', () => {
  test('fields: defaults for refresh and runAs, extensions without case or a leading *', () => {
    const { entries, problems } = parseActions(
      [
        { name: 'Call', command: 'CALL PGM(&LIBRARY/&NAME)', environment: 'object', extensions: ['*pgm'] },
        { name: 'Any', command: 'DSPFD &SRCLIB/&SRCFILE', environment: 'member', extensions: ['*'] },
      ],
      'test',
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(entries[0], {
      name: 'Call',
      command: 'CALL PGM(&LIBRARY/&NAME)',
      environment: 'object',
      extensions: ['PGM'],
      refresh: 'none',
      runAs: 'connection',
      index: 0,
    });
    assert.deepEqual(entries[1].extensions, [], '* applies to every member');
  });

  test('bad entries are skipped and reported by index, never thrown', () => {
    const { entries, problems } = parseActions(
      [
        compile('Good', 'CRTBNDRPG PGM(&LIBRARY/&NAME)'),
        { name: 'No command', environment: 'member' },
        { name: 'Bad env', command: 'X', environment: 'program' },
        compile('Bad refresh', 'X', { refresh: 'all' }),
        compile('Bad runAs', 'X', { runAs: 'later' }),
        compile('good', 'DUPLICATE'),
        'not an object',
      ],
      'f',
    );
    assert.deepEqual(entries.map((e) => e.name), ['Good']);
    assert.deepEqual(
      problems.map((p) => p.index),
      [1, 2, 3, 4, 5, 6],
    );
    assert.match(problems[4].message, /name is used twice/);
    assert.deepEqual(parseActions({}, 'f').problems, [{ message: 'f: actions must be an array' }]);
  });

  test('merge order: connection over workspace over defaults; later folders over earlier ones', () => {
    const defaults = layer('default', 'default', [
      compile('Compile (CRTBNDRPG)', 'CRTBNDRPG DEFAULT'),
      compile('Compile (CRTRPGMOD)', 'CRTRPGMOD DEFAULT'),
      { name: 'Call (CALL)', command: 'CALL DEFAULT', environment: 'object' },
    ]);
    const folderA = layer('workspace', 'a', [compile('compile (crtbndrpg)', 'CRTBNDRPG A'), compile('Mine', 'A MINE')]);
    const folderB = layer('workspace', 'b', [compile('Mine', 'B MINE'), compile('Compile (CRTRPGMOD)', 'CRTRPGMOD B')]);
    const connection = layer('connection', 'QSHQ400', [compile('Compile (CRTBNDRPG)', 'CRTBNDRPG SITE TGTRLS(V1R0M0)')]);
    const merged = mergeActions([defaults, folderA, folderB, connection]);
    assert.deepEqual(
      merged.map((a) => [a.name, a.command, a.source.label]),
      [
        ['Compile (CRTBNDRPG)', 'CRTBNDRPG SITE TGTRLS(V1R0M0)', 'QSHQ400'],
        ['Compile (CRTRPGMOD)', 'CRTRPGMOD B', 'b'],
        ['Call (CALL)', 'CALL DEFAULT', 'default'],
        ['Mine', 'B MINE', 'b'],
      ],
    );
  });

  test('which actions apply: environment, then member type or extension without case', () => {
    const [rpg, any, pgm] = layer('default', 'd', [
      compile('RPG', 'X'),
      { name: 'Any member', command: 'X', environment: 'member' },
      { name: 'PGM', command: 'X', environment: 'object', extensions: ['*PGM'] },
    ]);
    assert.ok(applies(rpg, { environment: 'member', names: ['RPGLE', 'rpgle'] }));
    assert.ok(applies(rpg, { environment: 'file', names: ['rpgle'] }) === false);
    assert.ok(!applies(rpg, { environment: 'member', names: ['CLLE', 'clle'] }));
    assert.ok(applies(any, { environment: 'member', names: ['TXT'] }));
    assert.ok(applies(pgm, { environment: 'object', names: ['*PGM'] }));
    assert.ok(!applies(pgm, { environment: 'object', names: ['*MODULE'] }));
  });

  test('the QAP call: compile for the spec’s list, a library qualifier ignored; command otherwise', () => {
    assert.equal(firstToken('  qsys/crtbndrpg PGM(X)'), 'CRTBNDRPG');
    assert.equal(firstToken('CALL(X)'), 'CALL');
    assert.equal(kindOf('CRTBNDRPG PGM(A/B)'), 'compile');
    assert.equal(kindOf('QSYS/CRTSRVPGM SRVPGM(A/B)'), 'compile');
    assert.equal(kindOf('RUNSQLSTM SRCSTMF(x)'), 'compile');
    assert.equal(kindOf('CALL PGM(A/B)'), 'command');
    assert.equal(kindOf('SBMJOB CMD(CRTBNDRPG PGM(A/B))'), 'command');
    assert.equal(kindOf('CRTBNDRPGX PGM(A/B)'), 'command');
  });

  test('variables: found, && is a literal &, unknown ones named', () => {
    assert.deepEqual(
      variablesIn('CRTBNDRPG PGM(&LIBRARY/&name) TGTRLS(&CUSTOM:tgtrls) TEXT(&&X)').map((v) => v.name),
      ['LIBRARY', 'NAME', 'CUSTOM:TGTRLS'],
    );
    assert.deepEqual(unknownVariables('CALL &LIB/&NAME &FOO &LIB'), ['&LIB', '&FOO']);
    assert.deepEqual(substitute('A(&NAME) B(&&)', (n) => (n === 'NAME' ? 'X' : undefined)), { ok: true, command: 'A(X) B(&)' });
    assert.deepEqual(substitute('A(&NAME/&CURLIB/&CURLIB)', (n) => (n === 'NAME' ? 'X' : undefined)), {
      ok: false,
      unresolved: ['&CURLIB'],
    });
  });

  test('a connection keeps its actions and variables through an edit', () => {
    const raw = [
      {
        name: 'QSHQ400',
        host: 'h',
        user: 'u',
        actions: [compile('Compile (CRTBNDRPG)', 'CRTBNDRPG TGTRLS(&CUSTOM:TGTRLS)'), { broken: true }],
        variables: { tgtrls: 'V1R0M0', 'bad name': 'x', N: 3 },
      },
    ];
    const { connections, problems } = parseConnections(raw);
    assert.deepEqual(connections[0].variables, { TGTRLS: 'V1R0M0' });
    assert.equal(problems.length, 2);
    assert.deepEqual(toSetting(connections[0]).actions, raw[0].actions, 'kept as written, the broken entry too');
  });
});

/** An action store on a fake host, `QSHQ400` signed on and active. */
async function storeOn(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const output = vscode.window.createOutputChannel('actions test', { log: true });
  const host = new FakeHost(answer);
  const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
  const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
  const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
  await vscode.workspace
    .getConfiguration('code-for-qs400')
    .update('connections', [{ name: 'QSHQ400', host: 'qshq400.example', user: 'CWELLMAN', variables: { TGTRLS: 'V1R0M0' } }], true);
  sessions.update({ name: 'QSHQ400', state: 'connected', user: 'CWELLMAN' });
  await sessions.setActive('QSHQ400');
  const ext = vscode.extensions.getExtension('quartzsystems.code-for-qs400');
  assert.ok(ext);
  const actions = new ActionStore(ext.extensionPath, store, sessions, output);
  await actions.ready;
  return { host, actions, sessions, parts: [actions, sessions, store, host, output] as vscode.Disposable[] };
}

const ACTIONS_TEXT = `[
  // a comment, as VS Code's own JSON files allow
  {
    "name": "Compile (CRTBNDRPG)",
    "command": "CRTBNDRPG PGM(&LIBRARY/&NAME) SRCFILE(&SRCLIB/&SRCFILE) SRCMBR(&NAME) TGTRLS(&CUSTOM:TGTRLS)",
    "environment": "member",
    "extensions": ["rpgle"]
  },
  {
    "name": "Bad",
    "command": "CRTBNDRPGX PGM(&LIBRARY/&NAME)",
    "environment": "member",
    "extensions": ["rpgle"]
  },
  {
    "name": "Unknown variable",
    "environment": "member",
    "command": "CALL &PROGRAM"
  },
  { "name": "Bad environment", "command": "X", "environment": "program" },
]
`;

const CPD0030 = {
  id: 'CPD0030',
  severity: 30,
  text: 'Command CRTBNDRPGX in library *LIBL not found.',
  secondLevel: 'Cause . . . . . :   The command CRTBNDRPGX was not found in the libraries of the library list.',
};

suite('Actions: checking actions.json on save', () => {
  let parts: vscode.Disposable[] = [];
  teardown(async () => {
    parts.forEach((p) => p.dispose());
    parts = [];
    await vscode.workspace.getConfiguration('code-for-qs400').update('connections', undefined, true);
  });

  test('each check result sits on its own command’s line, with the server’s message; nothing is run', async () => {
    const s = await storeOn((method, params) => {
      assert.equal(method, 'action.check');
      const command = params.command as string;
      return command.startsWith('CRTBNDRPGX')
        ? { status: 'NotFound', valid: false, messages: [CPD0030] }
        : { status: 'Ok', valid: true, messages: [] };
    });
    parts = s.parts;
    const doc = await vscode.workspace.openTextDocument({ language: 'jsonc', content: ACTIONS_TEXT });
    const diags = await s.actions.validate(doc);

    assert.deepEqual(
      s.host.sent.map((x) => x.params.command),
      [
        'CRTBNDRPG PGM(QTEMP/SAMPLE) SRCFILE(QTEMP/QSRC) SRCMBR(SAMPLE) TGTRLS(V1R0M0)',
        'CRTBNDRPGX PGM(QTEMP/SAMPLE)',
      ],
      'sample values, the custom one from the connection; the unknown variable is never sent',
    );
    assert.ok(s.host.sent.every((x) => x.method === 'action.check'));

    const lineOf = (needle: string) => ACTIONS_TEXT.split('\n').findIndex((l) => l.includes(needle));
    const check = diags.find((d) => d.code === 'CPD0030');
    assert.ok(check, 'the check message');
    assert.equal(check.range.start.line, lineOf('"command": "CRTBNDRPGX'));
    assert.equal(check.message, CPD0030.text);
    assert.equal(check.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(check.relatedInformation?.[0].message, CPD0030.secondLevel);

    const unknown = diags.find((d) => d.message.includes('&PROGRAM'));
    assert.equal(unknown?.range.start.line, lineOf('"command": "CALL &PROGRAM"'));
    const env = diags.find((d) => d.message.includes('environment must be'));
    assert.equal(env?.range.start.line, lineOf('"Bad environment"'));
    assert.equal(diags.length, 3, 'the valid command has no diagnostic');
    assert.deepEqual(s.actions.diagnostics.get(doc.uri)?.length, 3);
  });

  test('no connection signed on: nothing sent, and the file says so', async () => {
    const s = await storeOn(() => assert.fail('nothing is sent'));
    parts = s.parts;
    s.sessions.update({ name: 'QSHQ400', state: 'disconnected' });
    const doc = await vscode.workspace.openTextDocument({ language: 'jsonc', content: ACTIONS_TEXT });
    const diags = await s.actions.validate(doc);
    assert.equal(s.host.sent.length, 0);
    assert.ok(diags.some((d) => d.severity === vscode.DiagnosticSeverity.Information && /not checked/i.test(d.message)));
  });
});

suite('Actions: the text of actions.json', () => {
  test('comments and trailing commas; each command found by index', () => {
    const t = parseActionsText(ACTIONS_TEXT);
    assert.deepEqual(t.syntax, []);
    assert.equal((t.value as unknown[]).length, 4);
    assert.equal(t.commands.length, 4);
    assert.equal(ACTIONS_TEXT.slice(t.commands[1]!.offset, t.commands[1]!.offset + t.commands[1]!.length), '"CRTBNDRPGX PGM(&LIBRARY/&NAME)"');
  });
});

suite('Actions: variables for a member, a stream file and an object', () => {
  const connection = { user: 'CWELLMAN', host: 'qshq400.example', custom: { TGTRLS: 'V1R0M0', DBG: '*SOURCE' } };
  const member: ActionTarget = {
    environment: 'member',
    connection: 'QSHQ400',
    library: 'HLINV',
    file: 'QTMPSRC',
    member: 'ASSETS42',
    type: 'RPGLE',
  };
  const file: ActionTarget = { environment: 'file', connection: 'QSHQ400', path: '/home/CWELLMAN/sql/make_tables.sql' };
  const object: ActionTarget = {
    environment: 'object',
    connection: 'QSHQ400',
    library: 'HLINV',
    object: 'ASSETS',
    type: '*PGM',
    attribute: 'RPGLE',
  };
  const ALL = '&LIBRARY|&NAME|&TYPE|&EXT|&CURLIB|&USERNAME|&HOST|&CUSTOM:TGTRLS';

  test('member: &LIBRARY is the current library; the source names its file and library', () => {
    const r = resolveCommand(
      'CRTBNDRPG PGM(&LIBRARY/&NAME) SRCFILE(&SRCLIB/&SRCFILE) SRCMBR(&NAME) TGTRLS(&CUSTOM:TGTRLS) DBGVIEW(&CUSTOM:dbg)',
      member,
      { connection, curlib: 'CWELLMAN' },
    );
    assert.deepEqual(r, {
      ok: true,
      command: 'CRTBNDRPG PGM(CWELLMAN/ASSETS42) SRCFILE(HLINV/QTMPSRC) SRCMBR(ASSETS42) TGTRLS(V1R0M0) DBGVIEW(*SOURCE)',
    });
    assert.deepEqual(resolveCommand(ALL, member, { connection, curlib: 'CWELLMAN' }), {
      ok: true,
      command: 'CWELLMAN|ASSETS42|RPGLE|rpgle|CWELLMAN|CWELLMAN|qshq400.example|V1R0M0',
    });
  });

  test('member with no current library: &LIBRARY is asked for, and the answer used', () => {
    const cmd = 'CRTBNDRPG PGM(&LIBRARY/&NAME)';
    assert.equal(needsLibrary(cmd, member, { connection }), true);
    assert.equal(needsLibrary(cmd, member, { connection, curlib: 'CWELLMAN' }), false);
    assert.equal(needsLibrary('CALL PGM(&LIBRARY/&NAME)', object, { connection }), false, 'an object has its own');
    assert.equal(needsLibrary('DSPFD &SRCLIB/&SRCFILE', member, { connection }), false, 'not used');
    assert.deepEqual(resolveCommand(cmd, member, { connection, library: 'QTEMP' }), {
      ok: true,
      command: 'CRTBNDRPG PGM(QTEMP/ASSETS42)',
    });
    assert.equal(usesCurrentLibrary(cmd, 'member'), true);
    assert.equal(usesCurrentLibrary('CALL PGM(&LIBRARY/&NAME)', 'object'), false);
    assert.equal(usesCurrentLibrary('CHGCURLIB &CURLIB', 'object'), true);
  });

  test('stream file: the path, its folder and its name with and without the extension', () => {
    assert.deepEqual(
      resolveCommand(
        "RUNSQLSTM SRCSTMF('&FULLPATH') COMMIT(*NONE) -- &PARENT &BASENAME &BASENAMEEXT &NAME &TYPE &EXT &LIBRARY",
        file,
        { connection, curlib: 'HLINV' },
      ),
      {
        ok: true,
        command:
          "RUNSQLSTM SRCSTMF('/home/CWELLMAN/sql/make_tables.sql') COMMIT(*NONE) -- /home/CWELLMAN/sql make_tables make_tables.sql MAKE_TABLES SQL sql HLINV",
      },
    );
  });

  test('object: its own library, name, type and attribute', () => {
    assert.deepEqual(resolveCommand(ALL, object, { connection, curlib: 'CWELLMAN' }), {
      ok: true,
      command: 'HLINV|ASSETS|*PGM|rpgle|CWELLMAN|CWELLMAN|qshq400.example|V1R0M0',
    });
  });

  test('unresolved: a variable the target has none for, or a custom one the connection lacks, is an error before anything is sent', () => {
    assert.deepEqual(resolveCommand('CALL PGM(&SRCLIB/&SRCFILE) PARM(&CUSTOM:NOPE &FULLPATH)', object, { connection }), {
      ok: false,
      unresolved: ['&SRCLIB', '&SRCFILE', '&CUSTOM:NOPE', '&FULLPATH'],
    });
    assert.deepEqual(resolveCommand('CHGCURLIB &CURLIB', member, { connection }), { ok: false, unresolved: ['&CURLIB'] });
    assert.deepEqual(resolveCommand('CRTBNDRPG PGM(&LIBRARY/&NAME)', member, { connection }), {
      ok: false,
      unresolved: ['&LIBRARY'],
    });
  });

  test('matching names, the remembered choice’s key, and batch', () => {
    assert.deepEqual(matchTarget(member).names, ['RPGLE', 'rpgle']);
    assert.deepEqual(matchTarget(file).names, ['sql']);
    assert.deepEqual(matchTarget(object).names, ['*PGM']);
    assert.equal(choiceKey(member), 'qshq400|member|RPGLE');
    assert.equal(choiceKey(object), 'qshq400|object|*PGM');
    assert.equal(batchCommand('CALL PGM(HLINV/ASSETS)', 'ASSETS'), 'SBMJOB CMD(CALL PGM(HLINV/ASSETS)) JOB(ASSETS) JOBQ(QBATCH)');
  });
});
