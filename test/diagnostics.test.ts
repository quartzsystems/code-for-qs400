// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CompileDiagnostics, toDiagnostic } from '../src/actions/diagnostics';
import { Action, parseActions, withSource } from '../src/actions/model';
import { END_OF_LINE, placeIn, placeRange } from '../src/actions/placement';
import { RunResult } from '../src/actions/run';
import { SEVERITY_TABLE, problemSeverity } from '../src/actions/severity';
import { ActionTarget } from '../src/actions/targets';
import { ActionOutcome, CompileDiagnostic } from '../src/host/protocol';

const MEMBER: ActionTarget = {
  environment: 'member',
  connection: 'QSHQ400',
  library: 'HLINV',
  file: 'QTMPSRC',
  member: 'ASSETS42',
  type: 'RPGLE',
};
const OBJECT: ActionTarget = {
  environment: 'object',
  connection: 'QSHQ400',
  library: 'HLINV',
  object: 'ASSETS',
  type: '*MODULE',
  attribute: 'RPGLE',
};
const HELP = 'The name is not declared in the program. Declare it, or correct the spelling.';

function diag(over: Partial<CompileDiagnostic> = {}): CompileDiagnostic {
  return {
    at: { kind: 'member', library: 'HLINV', file: 'QTMPSRC', member: 'ASSETS42' },
    line: 42,
    column: 9,
    endLine: 0,
    endColumn: 17,
    severity: 30,
    id: 'RNF7030',
    text: 'ASSETQTY is not defined.',
    help: HELP,
    ...over,
  };
}

const action = (raw: Record<string, unknown>): Action => withSource(parseActions([raw], 't').entries, { kind: 'default', label: 'default' })[0];
const CRTBNDRPG = action({ name: 'Compile (CRTBNDRPG)', command: 'CRTBNDRPG PGM(&LIBRARY/&NAME)', environment: 'member' });
const CALL = action({ name: 'Call (CALL)', command: 'CALL PGM(&LIBRARY/&NAME)', environment: 'object' });

function compiled(target: ActionTarget, diagnostics: CompileDiagnostic[], status = diagnostics.some((d) => d.severity >= 20) ? 'Error' : 'Ok'): RunResult {
  const outcome: ActionOutcome = { status, job: { number: '123456', user: 'QUSER', name: 'QAPCNN' }, messages: [], diagnostics };
  return { action: CRTBNDRPG, target, command: 'CRTBNDRPG PGM(CWELLMAN/ASSETS42) SRCFILE(HLINV/QTMPSRC)', outcome };
}

suite('Diagnostics: severity', () => {
  test('one table: < 10 information, 10–19 warning, ≥ 20 error', () => {
    assert.deepEqual(
      [0, 9, 10, 19, 20, 30, 40, 99].map(problemSeverity),
      ['information', 'information', 'warning', 'warning', 'error', 'error', 'error', 'error'],
    );
    assert.equal(SEVERITY_TABLE.length, 3);
  });
});

suite('Diagnostics: placement', () => {
  test('member: line and columns from 1 to 0-based, end_line 0 is the line, end_column the last column covered', () => {
    assert.deepEqual(placeRange(diag()), { startLine: 41, startCharacter: 8, endLine: 41, endCharacter: 17 });
    assert.deepEqual(placeIn(diag(), MEMBER), { kind: 'member', library: 'HLINV', file: 'QTMPSRC', member: 'ASSETS42', target: true });
  });

  test('column 0 is the whole line; end_column 0 runs to its end; several lines', () => {
    assert.deepEqual(placeRange(diag({ column: 0, endColumn: 0 })), { startLine: 41, startCharacter: 0, endLine: 41, endCharacter: END_OF_LINE });
    assert.deepEqual(placeRange(diag({ endColumn: 0 })), { startLine: 41, startCharacter: 8, endLine: 41, endCharacter: END_OF_LINE });
    assert.deepEqual(placeRange(diag({ endLine: 44, endColumn: 3 })), { startLine: 41, startCharacter: 8, endLine: 43, endCharacter: 3 });
    assert.deepEqual(placeRange(diag({ line: 0, column: 0 })), { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: END_OF_LINE }, 'line unknown: line 1');
  });

  test('a /COPY member is that member, not the target; a path is that stream file', () => {
    assert.deepEqual(placeIn(diag({ at: { kind: 'member', library: 'hlinv', file: 'QRPGLESRC', member: 'ASSETCPY' } }), MEMBER), {
      kind: 'member',
      library: 'HLINV',
      file: 'QRPGLESRC',
      member: 'ASSETCPY',
      target: false,
    });
    assert.deepEqual(placeIn(diag({ at: { kind: 'path', path: '/home/CWELLMAN/inc.rpgleinc' } }), MEMBER), {
      kind: 'path',
      path: '/home/CWELLMAN/inc.rpgleinc',
      target: false,
    });
  });

  test('none: the target of the action, at line 1', () => {
    const none = diag({ at: { kind: 'none' }, line: 0, column: 0, endColumn: 0 });
    assert.deepEqual(placeIn(none, MEMBER), { kind: 'member', library: 'HLINV', file: 'QTMPSRC', member: 'ASSETS42', target: true });
    assert.deepEqual(placeIn(none, OBJECT), { kind: 'object', library: 'HLINV', object: 'ASSETS', type: '*MODULE' });
    assert.deepEqual(placeRange({ ...none, line: 17 }), { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: END_OF_LINE });
  });

  test('as VS Code shows it: code is the ID, the text the message, the second level in the related information', () => {
    const uri = vscode.Uri.parse('qs400mbr://QSHQ400/HLINV/QTMPSRC/ASSETS42.rpgle');
    const d = toDiagnostic(diag(), uri, 'CRTBNDRPG');
    assert.equal(d.code, 'RNF7030');
    assert.equal(d.message, 'ASSETQTY is not defined.');
    assert.equal(d.source, 'CRTBNDRPG');
    assert.equal(d.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(d.range.start.line, 41);
    assert.equal(d.relatedInformation?.[0].message, HELP);
    assert.equal(d.relatedInformation?.[0].location.uri.toString(), uri.toString());
    assert.equal(toDiagnostic(diag({ severity: 0 }), uri, 'X').severity, vscode.DiagnosticSeverity.Information);
    assert.equal(toDiagnostic(diag({ severity: 10 }), uri, 'X').severity, vscode.DiagnosticSeverity.Warning);
    assert.equal(toDiagnostic(diag({ help: '' }), uri, 'X').relatedInformation, undefined);
  });
});

suite('Diagnostics: the collection', () => {
  let c: CompileDiagnostics;
  setup(() => (c = new CompileDiagnostics()));
  teardown(() => c.dispose());

  const at = (uri: string) => c.collection.get(vscode.Uri.parse(uri)) ?? [];
  const TARGET = 'qs400mbr://QSHQ400/HLINV/QTMPSRC/ASSETS42.rpgle';
  const COPY = 'qs400mbr://QSHQ400/HLINV/QRPGLESRC/ASSETCPY.rpgle?readonly';

  test('a compile: the target writable, a /COPY member read-only; the next clean compile clears both', () => {
    c.apply(compiled(MEMBER, [diag(), diag({ at: { kind: 'member', library: 'HLINV', file: 'QRPGLESRC', member: 'ASSETCPY' }, line: 7 })]));
    assert.equal(at(TARGET).length, 1);
    assert.equal(at(TARGET)[0].range.start.line, 41);
    assert.equal(at(TARGET)[0].code, 'RNF7030');
    assert.equal(at(COPY).length, 1);
    assert.equal(at(COPY)[0].range.start.line, 6);

    c.apply(compiled(MEMBER, []));
    assert.equal(at(TARGET).length, 0);
    assert.equal(at(COPY).length, 0);
  });

  test('another target’s diagnostics stay; a shared /COPY member carries both', () => {
    const other: ActionTarget = { ...MEMBER, member: 'ORDERS' } as ActionTarget;
    const copy = { at: { kind: 'member' as const, library: 'HLINV', file: 'QRPGLESRC', member: 'ASSETCPY' }, line: 7 };
    c.apply(compiled(MEMBER, [diag(), diag(copy)]));
    c.apply(compiled(other, [diag({ at: { kind: 'member', library: 'HLINV', file: 'QTMPSRC', member: 'ORDERS' } }), diag(copy)]));
    assert.equal(at(COPY).length, 2);
    c.apply(compiled(MEMBER, []));
    assert.equal(at(TARGET).length, 0);
    assert.equal(at(COPY).length, 1, 'ORDERS still reports it');
    assert.equal(at('qs400mbr://QSHQ400/HLINV/QTMPSRC/ORDERS.rpgle').length, 1);
  });

  test('a command, a batch run and a cancelled compile change nothing; Clear clears everything', async () => {
    c.apply(compiled(MEMBER, [diag()]));
    c.apply({ action: CALL, target: OBJECT, command: 'CALL PGM(HLINV/ASSETS)', outcome: { status: 'Ok', messages: [], diagnostics: [] } });
    c.apply({ ...compiled(MEMBER, []), action: { ...CRTBNDRPG, runAs: 'batch' }, command: 'SBMJOB CMD(CRTBNDRPG PGM(X/Y))' });
    c.apply(compiled(MEMBER, [], 'Cancelled'));
    assert.equal(at(TARGET).length, 1);
    c.clear();
    assert.equal(at(TARGET).length, 0);
  });

  test('none on an object: its properties document, line 1', () => {
    c.apply({ ...compiled(OBJECT, [diag({ at: { kind: 'none' }, line: 0, column: 0, endColumn: 0, id: 'CPD5D02', text: 'Definition supplied multiple times.' })]), command: 'CRTPGM PGM(HLINV/ASSETS) MODULE(HLINV/ASSETS)' });
    const d = at('qs400obj://QSHQ400/HLINV/ASSETS%20(*MODULE)');
    assert.equal(d.length, 1);
    assert.equal(d[0].source, 'CRTPGM');
    assert.equal(d[0].range.start.line, 0);
  });
});
