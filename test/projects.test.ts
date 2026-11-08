// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { ConnectionStore } from '../src/connections/store';
import { globToRegExp, isIgnored, parseProjectText, projectText, textFor } from '../src/projects/config';
import { emptyState, fileStatus, parseState, remoteChanged, stateText } from '../src/projects/state';
import { ProjectStore, ensureGitignore } from '../src/projects/store';

export const EXAMPLE = `{
  // The prompt's example, with a comment and a trailing comma.
  "connection": "QSHQ400",
  "target": { "library": "HLINVDEV" },
  "layout": "sourceFiles",
  "encoding": { "ifsCcsid": 1208 },
  "ignore": [".git/**", "node_modules/**", "*.md"],
  "texts": { "QRPGLESRC/ASSETS.rpgle": "Asset maintenance" },
  "actions": [],
}`;

suite('Projects: qs400project.json', () => {
  test('the example reads with no problem', () => {
    const r = parseProjectText(EXAMPLE);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.config, {
      connection: 'QSHQ400',
      target: { kind: 'library', library: 'HLINVDEV' },
      layout: 'sourceFiles',
      ifsCcsid: 1208,
      ignore: ['.git/**', 'node_modules/**', '*.md'],
      texts: { 'QRPGLESRC/ASSETS.rpgle': 'Asset maintenance' },
      actions: [],
    });
    assert.equal(textFor(r.config!, 'qrpglesrc/assets.RPGLE'), 'Asset maintenance');
    assert.equal(textFor(r.config!, 'QRPGLESRC/OTHER.rpgle'), undefined);
  });

  test('an IFS target, the defaults, and a library upper-cased', () => {
    assert.deepEqual(parseProjectText('{"connection":"Q","target":{"path":"/home/CWELLMAN/app/"}}').config?.target, {
      kind: 'path',
      path: '/home/CWELLMAN/app',
    });
    const c = parseProjectText('{"connection":"Q","target":{"library":"hlinvdev"}}').config;
    assert.deepEqual(c?.target, { kind: 'library', library: 'HLINVDEV' });
    assert.equal(c?.ifsCcsid, 1208);
    assert.deepEqual(c?.ignore, []);
  });

  test('each problem at its place', () => {
    const text = '{"connection":"Q","target":{"library":"1BAD"},"layout":"flat","encoding":{"ifsCcsid":70000},"extra":1}';
    const r = parseProjectText(text);
    assert.equal(r.config, undefined, 'no usable target');
    const at = (m: string) => {
      const p = r.problems.find((x) => x.message.includes(m));
      assert.ok(p?.span, m);
      return text.slice(p.span.offset, p.span.offset + p.span.length);
    };
    assert.equal(at('not a library name'), '"1BAD"');
    assert.equal(at('layout must be'), '"flat"');
    assert.equal(at('ifsCcsid must be'), '70000');
    assert.equal(at('not a project property'), '"extra"');
    assert.ok(parseProjectText('{"target":{"library":"A"}}').problems.some((p) => p.message.startsWith('connection is required')));
    assert.ok(parseProjectText('{"connection":"Q","target":{"library":"A","path":"/x"}}').problems.some((p) => p.message.includes('not both')));
    assert.ok(parseProjectText('{"connection":"Q", ').problems.length > 0, 'a syntax error');
  });

  test('a text over 50 characters, and a path given twice', () => {
    const r = parseProjectText(`{"connection":"Q","target":{"library":"L"},"texts":{"A/B.rpgle":"${'x'.repeat(51)}","a/b.RPGLE":"y"}}`);
    assert.ok(r.problems.some((p) => p.message.includes('at most 50')));
    assert.ok(r.problems.some((p) => p.message.includes('given twice')));
  });

  test('the generator writes what the reader reads', () => {
    const text = projectText({ connection: 'QSHQ400', target: { kind: 'library', library: 'HLINVDEV' }, texts: { 'QRPGLESRC/B.rpgle': 'b', 'QCLSRC/A.clle': 'a' } });
    const r = parseProjectText(text);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(Object.keys(r.config!.texts), ['QCLSRC/A.clle', 'QRPGLESRC/B.rpgle'], 'sorted');
  });
});

suite('Projects: ignore globs', () => {
  test('*, ?, ** and names in any directory', () => {
    assert.ok(globToRegExp('*.md').test('README.md'));
    assert.ok(globToRegExp('*.md').test('docs/guide.MD'), 'no slash: any directory, without case');
    assert.ok(!globToRegExp('*.md').test('README.mdx'));
    assert.ok(globToRegExp('node_modules/**').test('node_modules/a/b.js'));
    assert.ok(!globToRegExp('node_modules/**').test('src/node_modules/a.js'), 'with a slash: from the folder');
    assert.ok(globToRegExp('**/build/**').test('a/b/build/x'));
    assert.ok(globToRegExp('**/build/**').test('build/x'));
    assert.ok(globToRegExp('QRPGLESRC/TEST?.rpgle').test('QRPGLESRC/TEST1.rpgle'));
    assert.ok(!globToRegExp('QRPGLESRC/TEST?.rpgle').test('QRPGLESRC/TEST12.rpgle'));
    assert.ok(globToRegExp('tmp/').test('tmp/a'));
  });

  test('the project’s own files are always ignored', () => {
    for (const p of ['.git/config', '.qs400/state.json', '.vscode/actions.json', 'qs400project.json']) {
      assert.ok(isIgnored(p, []), p);
    }
    assert.ok(!isIgnored('QRPGLESRC/ASSETS.rpgle', ['*.md']));
  });
});

suite('Projects: state.json', () => {
  test('round trip, sorted, and damage dropped', () => {
    const s = emptyState();
    s.files['QRPGLESRC/B.rpgle'] = { hash: 'b', remote: 2, at: 'QRPGLESRC/B' };
    s.files['QCLSRC/A.clle'] = { hash: 'a', remote: 1, at: 'QCLSRC/A' };
    const text = stateText(s);
    assert.ok(text.indexOf('QCLSRC/A.clle') < text.indexOf('QRPGLESRC/B.rpgle'));
    assert.deepEqual(parseState(text), s);
    assert.deepEqual(parseState('not json'), emptyState());
    assert.deepEqual(parseState('{"files":{"x":{"hash":1}}}'), emptyState());
  });

  test('changed, new, deployed and conflict', () => {
    const at = 'HLINVDEV/QRPGLESRC(A)';
    const r = { hash: 'h', remote: 1000, at };
    assert.equal(fileStatus('h', r), 'deployed');
    assert.equal(fileStatus('x', r), 'changed');
    assert.equal(fileStatus('x', undefined), 'new');
    assert.equal(fileStatus('h', r, 1000, at), 'deployed', 'the same timestamp');
    assert.equal(fileStatus('x', r, 2000, at), 'conflict', 'newer on the system');
    assert.equal(fileStatus('h', r, 500, at), 'deployed', 'older is not newer');
    assert.equal(fileStatus('h', { ...r, at: 'HLINV/QRPGLESRC(A)' }, 2000, at), 'deployed', 'a pull from another library is no baseline');
    assert.ok(remoteChanged('17', '18'), 'a change counter is only compared');
    assert.ok(!remoteChanged('17', '17'));
    assert.ok(!remoteChanged(undefined, 5));
  });
});

suite('Projects: the store', () => {
  let output: vscode.LogOutputChannel;
  suiteSetup(() => {
    output = vscode.window.createOutputChannel('projects test', { log: true });
  });
  suiteTeardown(() => output.dispose());

  test('.gitignore gains .qs400/ once', async () => {
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'qs4proj-'));
    try {
      await fs.writeFile(nodePath.join(dir, '.gitignore'), 'node_modules/');
      await ensureGitignore(dir);
      await ensureGitignore(dir);
      assert.equal(await fs.readFile(nodePath.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.qs400/\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('validation puts each problem on its place, and warns of an unknown connection', async () => {
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const connections = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const store = new ProjectStore(connections, output);
    try {
      const doc = await vscode.workspace.openTextDocument({
        language: 'jsonc',
        content: '{\n  "connection": "NOSUCH",\n  "target": { "library": "HLINVDEV" },\n  "actions": [{ "name": "X", "command": "CRTX &NOPE", "environment": "member" }]\n}',
      });
      const d = await store.validate(doc);
      const warn = d.find((x) => x.message.includes('No saved connection'));
      assert.equal(warn?.severity, vscode.DiagnosticSeverity.Warning);
      assert.equal(warn?.range.start.line, 1);
      const v = d.find((x) => x.message.includes('not a variable'));
      assert.equal(v?.range.start.line, 3);
    } finally {
      store.dispose();
      connections.dispose();
    }
  });
});
