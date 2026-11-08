// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension';
import type { MethodName, ParamsOf, ResultOf } from '../src/host/protocol';
import { LanguageServers } from '../src/languages/client';
import { type IncludeDeps, connectionOf, fetchInclude, includePath, listMembers } from '../src/languages/includes';
import { ifsUri } from '../src/ifs/uri';
import { memberUri } from '../src/members/uri';

const EXTENSION_ID = 'quartzsystems.code-for-qs400';
const MAIN = 'qs400mbr://qshq400/HLINV/QRPGLESRC/ASSETS.rpgle';

async function api(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

type Call = { name: string; method: string; params: unknown };

/** A host that answers from a table of members and stream files. */
function fakeDeps(members: Record<string, { type: string; text: string }>, files: Record<string, string> = {}, active?: string) {
  const calls: Call[] = [];
  const deps: IncludeDeps = {
    async call<M extends MethodName>(name: string, method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
      calls.push({ name, method, params });
      const p = params as unknown as Record<string, unknown>;
      switch (method) {
        case 'object.list': {
          const libs = [...new Set(Object.keys(members).map((k) => k.split('/')[0]))];
          const file = String(p.pattern);
          const hits = libs.filter((l) => Object.keys(members).some((k) => k.startsWith(`${l}/${file}(`)));
          return hits.map((library) => ({ library, object: file, type: '*FILE', attribute: 'PF-SRC', text: '', size: 0, changed: 0, owner: '' })) as ResultOf<M>;
        }
        case 'member.read': {
          const m = members[`${p.library}/${p.file}(${p.member})`];
          if (!m) {
            throw new Error(`CPF9815: Member ${String(p.member)} file ${String(p.file)} in library ${String(p.library)} not found.`);
          }
          return { type: m.type, text: m.text, width: 92, ccsid: 37, lines: [] } as unknown as ResultOf<M>;
        }
        case 'member.list':
          return Object.keys(members)
            .filter((k) => k.startsWith(`${String(p.library)}/${String(p.file)}(`))
            .map((k) => ({ member: k.slice(k.indexOf('(') + 1, -1), type: members[k].type, text: '', records: 0, created: 0, changed: 0 })) as ResultOf<M>;
        case 'ifs.readText': {
          const t = files[String(p.path)];
          if (t === undefined) {
            throw new Error('CPFA0A9: Object not found.');
          }
          return { text: t, ccsid: 1208, size: t.length, change: 'c1' } as unknown as ResultOf<M>;
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
    canonical: (name) => (name.toLowerCase() === 'qshq400' ? 'QSHQ400' : name),
    active: () => active,
    log: () => undefined,
  };
  return { deps, calls };
}

suite('Languages: includes', () => {
  test('a member in the library asked for, read without a lock', async () => {
    const { deps, calls } = fakeDeps({ 'HLINV/QRPGLESRC(CP)': { type: 'RPGLE', text: 'x\n' } });
    const f = await fetchInclude(deps, { uri: MAIN, request: { library: 'HLINV', file: 'qrpglesrc', member: 'cp' } });
    assert.deepEqual(f, {
      uri: memberUri('QSHQ400', 'HLINV', 'QRPGLESRC', 'CP', 'RPGLE', true).toString(),
      at: { kind: 'member', library: 'HLINV', file: 'QRPGLESRC', member: 'CP' },
      text: 'x\n',
    });
    assert.deepEqual(calls, [
      { name: 'QSHQ400', method: 'member.read', params: { name: 'QSHQ400', library: 'HLINV', file: 'QRPGLESRC', member: 'CP', lock: false } },
    ]);
  });

  test('*LIBL answers with the library the member was found in', async () => {
    const { deps, calls } = fakeDeps({
      'QGPL/QRPGLESRC(OTHER)': { type: 'RPGLE', text: 'o\n' },
      'HLINV/QRPGLESRC(CP)': { type: 'SQLRPGLE', text: 'x\n' },
    });
    const f = await fetchInclude(deps, { uri: MAIN, request: { library: '*LIBL', file: 'QRPGLESRC', member: 'CP' } });
    assert.equal(f?.uri, memberUri('QSHQ400', 'HLINV', 'QRPGLESRC', 'CP', 'SQLRPGLE', true).toString());
    assert.ok(f?.uri.endsWith('/HLINV/QRPGLESRC/CP.sqlrpgle?readonly'));
    assert.deepEqual(f?.at, { kind: 'member', library: 'HLINV', file: 'QRPGLESRC', member: 'CP' });
    assert.equal(calls[0].method, 'object.list');
    assert.deepEqual(calls[0].params, { name: 'QSHQ400', library: '*LIBL', pattern: 'QRPGLESRC', types: ['*FILE'] });
    // QGPL has the file but not the member: tried, then HLINV.
    assert.deepEqual(
      calls.filter((c) => c.method === 'member.read').map((c) => (c.params as { library: string }).library),
      ['QGPL', 'HLINV'],
    );
  });

  test('a library not given is *LIBL', async () => {
    const { deps, calls } = fakeDeps({ 'HLINV/QRPGLESRC(CP)': { type: 'RPGLE', text: 'x\n' } });
    await fetchInclude(deps, { uri: MAIN, request: { library: '', file: 'QRPGLESRC', member: 'CP' } });
    assert.equal((calls[0].params as { library: string }).library, '*LIBL');
  });

  test('not found is null', async () => {
    const { deps } = fakeDeps({});
    assert.equal(await fetchInclude(deps, { uri: MAIN, request: { library: 'HLINV', file: 'QRPGLESRC', member: 'NOPE' } }), null);
    assert.equal(await fetchInclude(deps, { uri: MAIN, request: { library: '*LIBL', file: 'QRPGLESRC', member: 'NOPE' } }), null);
  });

  test('a stream file, relative to the including one', async () => {
    const { deps, calls } = fakeDeps({}, { '/home/CWELLMAN/src/inc/cp.rpgleinc': 'i\n' });
    const uri = 'qs400ifs://qshq400/home/CWELLMAN/src/main.rpgle';
    const f = await fetchInclude(deps, { uri, request: { library: '', file: '/home/CWELLMAN/src', member: '', path: 'inc/cp.rpgleinc' } });
    assert.deepEqual(f, {
      uri: ifsUri('QSHQ400', '/home/CWELLMAN/src/inc/cp.rpgleinc').toString(),
      at: { kind: 'path', path: '/home/CWELLMAN/src/inc/cp.rpgleinc' },
      text: 'i\n',
    });
    assert.deepEqual(calls[0].params, { name: 'QSHQ400', path: '/home/CWELLMAN/src/inc/cp.rpgleinc' });
    assert.equal(await fetchInclude(deps, { uri, request: { library: '', file: '', member: '', path: '/nope.rpgleinc' } }), null);
    assert.equal(includePath('/abs/x', '/dir'), '/abs/x');
    assert.equal(includePath('x', ''), '/x');
    assert.equal(includePath('x', '/dir/'), '/dir/x');
  });

  test('a local file uses the active connection, or none', async () => {
    const local = vscode.Uri.file(path.join(os.tmpdir(), 'x.rpgle')).toString();
    assert.equal(connectionOf(fakeDeps({}, {}, 'QSHQ400').deps, local), 'QSHQ400');
    const { deps, calls } = fakeDeps({ 'HLINV/QRPGLESRC(CP)': { type: 'RPGLE', text: 'x\n' } });
    assert.equal(await fetchInclude(deps, { uri: local, request: { library: 'HLINV', file: 'QRPGLESRC', member: 'CP' } }), null);
    assert.equal(calls.length, 0);
  });

  test('members for /COPY completion', async () => {
    const { deps } = fakeDeps({ 'HLINV/QRPGLESRC(CP)': { type: 'RPGLE', text: '' }, 'HLINV/QRPGLESRC(CP2)': { type: 'RPGLE', text: '' } });
    const m = await listMembers(deps, { uri: MAIN, library: 'hlinv', file: 'qrpglesrc' });
    assert.deepEqual(m.map((x) => x.member), ['CP', 'CP2']);
  });
});

/** Wait until `pick` takes the diagnostics of `uri`. */
async function diagnosticsOf(uri: vscode.Uri, pick: (d: readonly vscode.Diagnostic[]) => boolean): Promise<readonly vscode.Diagnostic[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const d = vscode.languages.getDiagnostics(uri);
    if (pick(d)) {
      return d;
    }
    if (Date.now() > deadline) {
      throw new Error(`diagnostics of ${uri.toString()} never matched: ${JSON.stringify(d.map((x) => [x.range.start.line, x.code, x.message]))}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const codeOf = (d: vscode.Diagnostic) => (typeof d.code === 'object' ? d.code.value : d.code);

suite('Languages: the RPG server', () => {
  let dir: string;
  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs4lsp-'));
  });
  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows may still hold a handle on the folder; it is a temporary one.
    }
  });

  async function openRpg(name: string, text: string): Promise<vscode.TextDocument> {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    return doc.languageId === 'qs400-rpgle' ? doc : vscode.languages.setTextDocumentLanguage(doc, 'qs400-rpgle');
  }

  test('the host publishes a front-end diagnostic as you type', async () => {
    await api();
    const doc = await openRpg('t1.rpgle', '     C                   SETON                                        LR\n');
    await vscode.window.showTextDocument(doc);
    const editor = vscode.window.activeTextEditor!;
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), '     C                   FOOBAR\n'));
    const t0 = Date.now();
    const d = await diagnosticsOf(doc.uri, (ds) => ds.some((x) => codeOf(x) === 'RNF5014'));
    const elapsed = Date.now() - t0;
    const hit = d.find((x) => codeOf(x) === 'RNF5014')!;
    assert.equal(hit.range.start.line, 0);
    assert.equal(hit.severity, vscode.DiagnosticSeverity.Error);
    assert.ok(hit.relatedInformation?.[0]?.message, 'second-level text');
    assert.ok(elapsed < 2_000, `${elapsed} ms`);
    // Deleting the line clears it.
    await editor.edit((e) => e.delete(new vscode.Range(0, 0, 1, 0)));
    await diagnosticsOf(doc.uri, (ds) => !ds.some((x) => codeOf(x) === 'RNF5014'));
  });

  test('each language has its server in the host', async () => {
    await api();
    const cases: [string, string, string, string, number][] = [
      ['t.clle', 'qs400-cl', '             PGM\n             CHGVAR     VAR(&X) VALUE(1)\n             ENDPGM\n', 'CPD0727', 1],
      ['T.pf', 'qs400-dds', '     A          R A\n     A            X              1A\n     A          R B\n     A            Y              1A\n', 'DDS1002', 2],
      ['t.sql', 'qs400-sql', 'SELECT * FROM T WHERE A = = 1;\n', 'SQL0104', 0],
      ['T.cmd', 'qs400-cmd', "             CMD        PROMPT('X')\n             PARM       KWD(A) TYPE(*CHAR) FOOBAR(1)\n", 'CPD0242', 1],
    ];
    for (const [name, language, text, id, line] of cases) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      let doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      if (doc.languageId !== language) {
        doc = await vscode.languages.setTextDocumentLanguage(doc, language);
      }
      // The client syncs a document that was open before it started only
      // once the document is in an editor, as an opened member is.
      await vscode.window.showTextDocument(doc);
      const d = await diagnosticsOf(doc.uri, (ds) => ds.some((x) => codeOf(x) === id));
      assert.equal(d.find((x) => codeOf(x) === id)!.range.start.line, line, `${language} ${id}`);
    }
  });

  test('qs400/fetchInclude round-trips through the client', async () => {
    const { host } = await api();
    const { deps, calls } = fakeDeps(
      { 'HLINV/QRPGLESRC(CP)': { type: 'RPGLE', text: '     D CPFLD           S             10A\n     D BAD             X\n' } },
      {},
      'QSHQ400',
    );
    const own = new LanguageServers(() => host.resolveBinary(), deps, vscode.window.createOutputChannel('qs4 test', { log: true }));
    try {
      const doc = await openRpg(
        't2.rpgle',
        '     D LOCAL           S             10A\n      /COPY HLINV/QRPGLESRC,CP\n     C                   EVAL      LOCAL = CPFLD\n     C                   SETON                                        LR\n',
      );
      await own.client('qs400-rpgle');
      const d = await diagnosticsOf(doc.uri, (ds) => ds.some((x) => x.message === '1 message in HLINV/QRPGLESRC(CP)'));
      assert.equal(d.find((x) => x.message.startsWith('1 message'))!.range.start.line, 1);
      assert.ok(calls.some((c) => c.method === 'member.read' && (c.params as { member: string }).member === 'CP'));
      // What analyze returned, every source.
      const items = await own.analyzed(doc);
      assert.deepEqual(
        items?.map((i) => [i.at.kind === 'member' ? i.at.member : i.at.kind, i.line, i.id]),
        [['CP', 2, 'RNF3304']],
      );
      // Go to definition into the copy member: its read-only URI, at the declaration.
      const defs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(2, 46));
      const into = defs.find((l) => l.uri.scheme === 'qs400mbr');
      assert.ok(into, JSON.stringify(defs));
      assert.equal(into.uri.path, '/HLINV/QRPGLESRC/CP.rpgle');
      assert.equal(into.uri.query, 'readonly');
      assert.equal(into.range.start.line, 0);
      // The outline: the member's own declaration only.
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
      assert.ok(symbols.some((x) => x.name === 'LOCAL' && x.kind === vscode.SymbolKind.Variable));
      assert.ok(!symbols.some((x) => x.name === 'CPFLD'));
    } finally {
      own.dispose();
    }
  });
});
