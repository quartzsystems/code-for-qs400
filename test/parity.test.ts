// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

// Phase 5 against a real system: for every member of HLINV's QRPGLESRC,
// QCLSRC, QDDSSRC and QSQLSRC, the language server's diagnostics and its
// default compile's, compared as (source, line, ID) sets; go to definition
// into a /COPY member of ASSETS; an undefined name as you type; the
// outline and rename. Skipped unless QS400_TEST_HOST, QS400_TEST_USER and
// QS400_TEST_PASSWORD are set. Members are opened read-only, so nothing
// is locked; each compile makes its object in the current library
// (QS400_TEST_CURLIB, default the user profile), where it stays.
//
// QS400_PARITY_RECORD=1 writes each compile to host/fixtures/parity/ for
// the offline Rust test (`cargo test -p code-host --test parity`), with
// the members' text beside it (gitignored: HLINV's source is not ours to
// ship). QS400_PARITY_LIBRARY names another library than HLINV.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ConnectionConfig } from '../src/connections/config';
import type { ExtensionApi } from '../src/extension';
import type { DiagnosticAt } from '../src/host/protocol';
import { LanguageServers } from '../src/languages/client';
import type { AnalyzedDiagnostic, FetchIncludeParams, FetchedInclude } from '../src/languages/protocol';
import { memberType } from '../src/members/types';
import { memberUri, parseMemberUri } from '../src/members/uri';

const env = process.env;
const HOST = env.QS400_TEST_HOST ?? '';
const USER = (env.QS400_TEST_USER ?? '').toUpperCase();
const PASSWORD = env.QS400_TEST_PASSWORD ?? '';
const NAME = 'QS400 parity test';
const LIBRARY = (env.QS400_PARITY_LIBRARY ?? 'HLINV').toUpperCase();
const RECORD = env.QS400_PARITY_RECORD === '1';
const FILES = ['QRPGLESRC', 'QCLSRC', 'QDDSSRC', 'QSQLSRC'];
const FIXTURES = path.resolve(__dirname, '..', '..', 'host', 'fixtures', 'parity');

/** Each source type's default compile (Phase 4's defaults). */
const COMPILE: Readonly<Record<string, string>> = {
  RPGLE: 'Compile (CRTBNDRPG)',
  SQLRPGLE: 'Compile (CRTSQLRPGI)',
  CLLE: 'Compile (CRTBNDCL)',
  CLP: 'Compile (CRTBNDCL)',
  PF: 'Compile (CRTPF)',
  LF: 'Compile (CRTLF)',
  DSPF: 'Compile (CRTDSPF)',
  PRTF: 'Compile (CRTPRTF)',
  CMD: 'Compile (CRTCMD)',
  SQL: 'Compile (RUNSQLSTM)',
};

function connection(): ConnectionConfig {
  const c: ConnectionConfig = { name: NAME, host: HOST, user: USER };
  if (env.QS400_TEST_PORT) {
    c.port = Number(env.QS400_TEST_PORT);
  }
  if (env.QS400_TEST_CA_FILE) {
    c.tls = { caFile: env.QS400_TEST_CA_FILE };
  }
  return c;
}

const config = () => vscode.workspace.getConfiguration('code-for-qs400');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `LIB/FILE(MBR)`, a path, or `*NONE`: how both sides name a source. */
export function sourceName(at: DiagnosticAt): string {
  switch (at.kind) {
    case 'member':
      return `${at.library.toUpperCase()}/${at.file.toUpperCase()}(${at.member.toUpperCase()})`;
    case 'path':
      return at.path;
    case 'none':
      return '*NONE';
  }
}

/** The (source, line, ID) keys of a list of diagnostics. */
export function keys(ds: readonly { at: DiagnosticAt; line: number; id: string }[]): Set<string> {
  return new Set(ds.map((d) => `${sourceName(d.at)}\t${d.line}\t${d.id}`));
}

/** The rows only one side has, as a table. */
export function differenceTable(member: string, compiler: Set<string>, editor: Set<string>): string[] {
  const rows: string[] = [];
  for (const k of [...compiler].sort()) {
    if (!editor.has(k)) {
      rows.push(`${member}\t${k}\tcompiler only`);
    }
  }
  for (const k of [...editor].sort()) {
    if (!compiler.has(k)) {
      rows.push(`${member}\t${k}\teditor only`);
    }
  }
  return rows;
}

suite('Parity: the comparison', () => {
  const at = (member: string): DiagnosticAt => ({ kind: 'member', library: 'hlinv', file: 'QRPGLESRC', member });

  test('keys are (source, line, ID), names in upper case', () => {
    assert.deepEqual([...keys([{ at: at('assets'), line: 42, id: 'RNF7030' }, { at: { kind: 'none' }, line: 0, id: 'RNS9310' }])], [
      'HLINV/QRPGLESRC(ASSETS)\t42\tRNF7030',
      '*NONE\t0\tRNS9310',
    ]);
    assert.equal(sourceName({ kind: 'path', path: '/home/x.rpgle' }), '/home/x.rpgle');
  });

  test('the table lists what only one side has', () => {
    const compiler = keys([{ at: at('ASSETS'), line: 42, id: 'RNF7030' }, { at: at('CP'), line: 3, id: 'RNF3304' }]);
    const editor = keys([{ at: at('CP'), line: 3, id: 'RNF3304' }, { at: at('ASSETS'), line: 7, id: 'RNF0273' }]);
    assert.deepEqual(differenceTable('HLINV/QRPGLESRC(ASSETS)', compiler, editor), [
      'HLINV/QRPGLESRC(ASSETS)\tHLINV/QRPGLESRC(ASSETS)\t42\tRNF7030\tcompiler only',
      'HLINV/QRPGLESRC(ASSETS)\tHLINV/QRPGLESRC(ASSETS)\t7\tRNF0273\teditor only',
    ]);
    assert.deepEqual(differenceTable('x', editor, editor), []);
  });
});

suite('Live: Phase 5 exit test', function () {
  let api: ExtensionApi;
  let own: LanguageServers;
  const fetched: { params: FetchIncludeParams; result: FetchedInclude | null }[] = [];
  let tmp: string;

  suiteSetup(async function () {
    if (!HOST || !USER || !PASSWORD) {
      this.skip();
    }
    const ext = vscode.extensions.getExtension<ExtensionApi>('quartzsystems.code-for-qs400');
    assert.ok(ext);
    api = await ext.activate();
    const c = connection();
    await config().update('connections', [c], true);
    await api.sessions.signOn(c, { password: PASSWORD, save: false }, false);
    const list = await api.host.request('libl.get', { name: NAME });
    const curlib = (env.QS400_TEST_CURLIB ?? USER).toUpperCase();
    await api.host.request('libl.set', { name: NAME, current: curlib, user: list.user.filter((l) => l !== curlib) });
    // A server of the test's own, on the extension's sessions, so what it
    // fetched can be recorded.
    own = new LanguageServers(
      () => api.host.resolveBinary(),
      {
        call: (name, method, params) => api.sessions.call(name, method, params),
        canonical: (name) => api.store.get(name)?.name ?? name,
        active: () => NAME,
        log: (line) => console.log(`live: ${line}`),
      },
      vscode.window.createOutputChannel('QS/400 parity', { log: true }),
    );
    own.onDidFetch((f) => fetched.push(f));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs4parity-'));
  });

  suiteTeardown(async function () {
    if (!api) {
      return;
    }
    own?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.host.request('session.disconnect', { name: NAME }).catch(() => undefined);
    await config().update('connections', undefined, true);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Open a member read-only and wait for the test's server to analyze it. */
  async function analyzed(uri: vscode.Uri): Promise<{ doc: vscode.TextDocument; items: AnalyzedDiagnostic[] }> {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
    await own.client(doc.languageId);
    const end = Date.now() + 60_000;
    for (;;) {
      const items = await own.analyzed(doc);
      if (items) {
        return { doc, items };
      }
      if (Date.now() > end) {
        throw new Error(`${uri.toString()} was never analyzed`);
      }
      await sleep(100);
    }
  }

  test('every HLINV member: the editor’s diagnostics are the compile’s', async function () {
    this.timeout(60 * 60_000);
    const rows: string[] = [];
    const summary: string[] = [];
    for (const file of FILES) {
      let members;
      try {
        members = await api.host.request('member.list', { name: NAME, library: LIBRARY, file });
      } catch (err) {
        summary.push(`${LIBRARY}/${file}: not listed (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      let equal = 0;
      let differ = 0;
      for (const m of members) {
        const type = m.type.toUpperCase();
        const action = COMPILE[type];
        const label = `${LIBRARY}/${file}(${m.member})`;
        if (!action) {
          summary.push(`${label}: type ${type || '(none)'} has no default compile, skipped`);
          continue;
        }
        const uri = memberUri(NAME, LIBRARY, file, m.member, type, true);
        const { doc, items } = await analyzed(uri);
        const r = await api.runner.run(uri, action);
        assert.ok(r?.outcome, `${label}: ${action} gave no outcome: ${String(r?.error)}`);
        const compiler = keys(r.outcome.diagnostics);
        const editor = keys(items);
        const diff = differenceTable(label, compiler, editor);
        console.log(`live: ${label} ${action} ${r.outcome.status}: compiler ${compiler.size}, editor ${editor.size}, ${diff.length === 0 ? 'equal' : `${diff.length} differ`}`);
        rows.push(...diff);
        if (diff.length === 0) {
          equal++;
        } else {
          differ++;
        }
        if (RECORD) {
          // Every include fetched so far: one fetched for an earlier member
          // is cached and not asked for again.
          record(file, m.member, type, doc.getText(), r.command, fetched, r.outcome.diagnostics);
        }
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
      summary.push(`${LIBRARY}/${file}: ${equal} equal, ${differ} differ`);
    }
    console.log(`live: parity ${summary.join('; ')}`);
    if (rows.length > 0) {
      console.log('live: member\tsource\tline\tid\twhere');
      for (const row of rows) {
        console.log(`live: ${row}`);
      }
    }
    assert.equal(rows.length, 0, `the editor and the compiler differ in ${rows.length} row(s); see the table above`);
  });

  test('ASSETS: go to definition on a name from a /COPY member opens it read-only at the declaration', async function () {
    this.timeout(10 * 60_000);
    const uri = memberUri(NAME, LIBRARY, 'QRPGLESRC', 'ASSETS', 'RPGLE', true);
    const { doc } = await analyzed(uri);
    let found: vscode.Location | undefined;
    let word = '';
    outer: for (let n = 0; n < doc.lineCount; n++) {
      const text = doc.lineAt(n).text;
      if (/^\s*.{0,6}\/(copy|include)\b/i.test(text)) {
        continue;
      }
      for (const m of text.matchAll(/[A-Za-z_#@$][A-Za-z0-9_#@$]*/g)) {
        const locs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', uri, new vscode.Position(n, m.index! + 1));
        const into = locs?.find((l) => l.uri.scheme === uri.scheme && l.uri.path !== uri.path);
        if (into) {
          found = into;
          word = m[0];
          break outer;
        }
      }
    }
    assert.ok(found, 'a name ASSETS uses is declared in a /COPY member');
    console.log(`live: ${word} is declared in ${found.uri.path} line ${found.range.start.line + 1}`);
    const editor = await vscode.window.showTextDocument(found.uri, { selection: found.range });
    assert.equal(editor.document.uri.query, 'readonly');
    const stat = await vscode.workspace.fs.stat(found.uri);
    assert.ok((stat.permissions ?? 0) & vscode.FilePermission.Readonly, 'the copy member is read-only');
    assert.equal(editor.document.getText(found.range).toUpperCase(), word.toUpperCase());
  });

  /** A local copy of ASSETS, its includes from the parity connection. */
  async function localAssets(): Promise<vscode.TextEditor> {
    const text = (await api.host.request('member.read', { name: NAME, library: LIBRARY, file: 'QRPGLESRC', member: 'ASSETS', lock: false })).text;
    const file = path.join(tmp, 'ASSETS.rpgle');
    fs.writeFileSync(file, text);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc);
    await analyzedLocal(doc);
    return editor;
  }

  async function analyzedLocal(doc: vscode.TextDocument): Promise<AnalyzedDiagnostic[]> {
    await own.client(doc.languageId);
    const end = Date.now() + 60_000;
    for (;;) {
      const items = await own.analyzed(doc);
      if (items) {
        return items;
      }
      assert.ok(Date.now() < end, 'analyzed');
      await sleep(50);
    }
  }

  test('an undefined name on a new line: RNF7030 within half a second, with its second-level text, gone with the line', async function () {
    this.timeout(5 * 60_000);
    const editor = await localAssets();
    const doc = editor.document;
    const free = /^\*\*free/i.test(doc.lineAt(0).text);
    const at = doc.lineCount - 1;
    const line = free ? 'QS4UNDEF = 1;\n' : '     C                   EVAL      QS4UNDEF = 1\n';
    const t0 = Date.now();
    await editor.edit((e) => e.insert(new vscode.Position(at, 0), line));
    let hit: vscode.Diagnostic | undefined;
    while (!hit && Date.now() - t0 < 5_000) {
      hit = vscode.languages.getDiagnostics(doc.uri).find((d) => (typeof d.code === 'object' ? d.code.value : d.code) === 'RNF7030' && d.range.start.line === at);
      await sleep(10);
    }
    const ms = Date.now() - t0;
    console.log(`live: RNF7030 ${hit ? `after ${ms} ms` : 'never came (rpgfront at 5e2bbee9 does not report undefined names)'}`);
    assert.ok(hit, 'RNF7030 on the new line');
    assert.ok(ms <= 500, `within half a second: ${ms} ms`);
    assert.ok(hit.relatedInformation?.[0]?.message, 'the second-level text');
    await editor.edit((e) => e.delete(new vscode.Range(at, 0, at + 1, 0)));
    const end = Date.now() + 5_000;
    while (vscode.languages.getDiagnostics(doc.uri).some((d) => d.range.start.line === at && (typeof d.code === 'object' ? d.code.value : d.code) === 'RNF7030')) {
      assert.ok(Date.now() < end, 'RNF7030 goes with the line');
      await sleep(20);
    }
  });

  test('ASSETS: the outline, and rename of a local variable within the document', async function () {
    this.timeout(5 * 60_000);
    const editor = await localAssets();
    const doc = editor.document;
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
    const all: vscode.DocumentSymbol[] = [];
    const walk = (s: vscode.DocumentSymbol[]) => s.forEach((x) => (all.push(x), walk(x.children)));
    walk(symbols);
    const kinds = new Set(all.map((s) => vscode.SymbolKind[s.kind]));
    console.log(`live: ASSETS outline: ${all.length} symbols, kinds ${[...kinds].join(' ')}`);
    for (const k of ['Function', 'File', 'Struct']) {
      assert.ok(kinds.has(k), `the outline shows a ${k}`);
    }
    // A procedure's local variable.
    const local = symbols.filter((s) => s.kind === vscode.SymbolKind.Function).flatMap((p) => p.children).find((c) => c.kind === vscode.SymbolKind.Variable);
    assert.ok(local, 'a subprocedure with a local variable');
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, local.selectionRange.start, 'QS4RENAMED');
    const entries = edit.entries();
    assert.equal(entries.length, 1, 'nothing outside the document');
    assert.equal(entries[0][0].toString(), doc.uri.toString());
    for (const e of entries[0][1]) {
      assert.equal(doc.getText(e.range).toUpperCase(), local.name.toUpperCase());
    }
    console.log(`live: rename ${local.name}: ${entries[0][1].length} edit(s)`);
  });
});

/** Write one compile and its sources for the offline parity test. */
function record(
  file: string,
  member: string,
  type: string,
  text: string,
  command: string,
  fetches: { params: FetchIncludeParams; result: FetchedInclude | null }[],
  diagnostics: unknown[],
): void {
  const ext = memberType(type).ext;
  fs.mkdirSync(path.join(FIXTURES, file), { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, file, `${member}.${ext}`), text);
  const includes = [];
  const seen = new Set<string>();
  for (const f of fetches) {
    const req = JSON.stringify(f.params.request);
    if (!f.result || f.result.at.kind !== 'member' || seen.has(req)) {
      continue;
    }
    seen.add(req);
    const p = parseMemberUri(vscode.Uri.parse(f.result.uri));
    const incExt = p?.kind === 'member' ? p.ext : 'mbr';
    const rel = `${f.result.at.file}/${f.result.at.member}.${incExt}`;
    fs.mkdirSync(path.join(FIXTURES, f.result.at.file), { recursive: true });
    fs.writeFileSync(path.join(FIXTURES, rel), f.result.text);
    includes.push({ request: f.params.request, at: f.result.at, source: rel });
  }
  const rec = { member: { library: LIBRARY, file, member, type }, command, includes, diagnostics };
  fs.writeFileSync(path.join(FIXTURES, file, `${member}.${ext}.json`), `${JSON.stringify(rec, null, 2)}\n`);
}
