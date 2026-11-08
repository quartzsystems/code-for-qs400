// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient } from '../src/host/client';
import { MemberEntry, SourceLine } from '../src/host/protocol';
import { parseProjectText } from '../src/projects/config';
import {
  clashes,
  contentHash,
  isMember,
  localPathOf,
  memberFileText,
  memberLines,
  memberOf,
  relativeToTarget,
  remotePathOf,
  LocalMember,
} from '../src/projects/layout';
import { ProjectDeps, Puller } from '../src/projects/pull';
import { parseState } from '../src/projects/state';
import { ProjectStore } from '../src/projects/store';
import { ConflictChoice, ProjectUi } from '../src/projects/ui';
import { FakeHost, Memento } from './members.test';

suite('Projects: the layout', () => {
  test('a member from a local path: names upper-cased, the type from the extension', () => {
    assert.deepEqual(memberOf('QRPGLESRC/ASSETS.rpgle'), { rel: 'QRPGLESRC/ASSETS.rpgle', file: 'QRPGLESRC', member: 'ASSETS', ext: 'rpgle', type: 'RPGLE' });
    assert.deepEqual(memberOf('qclsrc/build.CLLE'), { rel: 'qclsrc/build.CLLE', file: 'QCLSRC', member: 'BUILD', ext: 'clle', type: 'CLLE' });
    assert.equal((memberOf('QDDSSRC/ASSETSP.pf') as LocalMember).type, 'PF');
    assert.equal((memberOf('QSQLSRC/SEED.sql') as LocalMember).type, 'SQL');
    assert.equal((memberOf('QTXTSRC/NOTES') as LocalMember).type, '', 'no extension: no source type');
    assert.equal((memberOf('QSRC/X.bnd') as LocalMember).type, 'BND');
    assert.equal((memberOf('QSRC/X.weird') as LocalMember).type, 'WEIRD', 'an unknown extension is its own type');
  });

  test('what is not a member, and why', () => {
    assert.equal(isMember(memberOf('README.md')), false);
    assert.match((memberOf('README.md') as { reason: string }).reason, /not in a source file/);
    assert.match((memberOf('A/B/C.rpgle') as { reason: string }).reason, /more than one directory/);
    assert.match((memberOf('QRPGLESRC/TOOLONGNAME1.rpgle') as { reason: string }).reason, /not a member name/);
    assert.match((memberOf('1SRC/A.rpgle') as { reason: string }).reason, /not a source file name/);
  });

  test('and back: the extension from the type, by Phase 2’s table', () => {
    assert.equal(localPathOf('qrpglesrc', 'assets', 'RPGLE'), 'QRPGLESRC/ASSETS.rpgle');
    assert.equal(localPathOf('QRPGLESRC', 'CP', 'SQLRPGLE'), 'QRPGLESRC/CP.sqlrpgle');
    assert.equal(localPathOf('QDDSSRC', 'SCREEN', 'DSPF'), 'QDDSSRC/SCREEN.dspf');
    assert.equal(localPathOf('QTXTSRC', 'NOTES', ''), 'QTXTSRC/NOTES.mbr');
    for (const t of ['RPGLE', 'SQLRPGLE', 'RPG', 'CLLE', 'CLP', 'CL', 'PF', 'LF', 'DSPF', 'PRTF', 'ICFF', 'CMD', 'SQL', 'C', 'CPP', 'TXT', 'BND', 'PNLGRP', 'MENU', '']) {
      const back = memberOf(localPathOf('QSRC', 'X', t));
      assert.equal((back as LocalMember).type, t, `round trip of ${t || '(none)'}`);
    }
  });

  test('two local files naming one member are a clash', () => {
    const ms = ['QRPGLESRC/ASSETS.rpgle', 'qrpglesrc/assets.RPGLE', 'QRPGLESRC/ASSETS.sqlrpgle', 'QRPGLESRC/OTHER.rpgle'].map((r) => memberOf(r) as LocalMember);
    const c = clashes(ms);
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].map((m) => m.rel), ['QRPGLESRC/ASSETS.rpgle', 'qrpglesrc/assets.RPGLE', 'QRPGLESRC/ASSETS.sqlrpgle']);
  });

  test('IFS paths both ways', () => {
    assert.equal(remotePathOf('/home/CWELLMAN/app', 'src/a.sql'), '/home/CWELLMAN/app/src/a.sql');
    assert.equal(remotePathOf('/', 'a.sql'), '/a.sql');
    assert.equal(relativeToTarget('/home/CWELLMAN/app', '/home/CWELLMAN/app/src/a.sql'), 'src/a.sql');
    assert.equal(relativeToTarget('/home/CWELLMAN/app', '/home/CWELLMAN/other/a.sql'), undefined);
  });

  test('a member’s lines from a local file, and the hash that ignores what a member cannot hold', () => {
    assert.deepEqual(memberLines('a\nb\n'), ['a', 'b'], 'the final newline is not a line');
    assert.deepEqual(memberLines('a\r\nb  \r\n\n'), ['a', 'b', ''], 'a blank last line is kept');
    assert.deepEqual(memberLines(''), []);
    assert.equal(memberFileText(['a', 'b']), 'a\nb\n');
    const enc = (s: string) => new TextEncoder().encode(s);
    assert.equal(contentHash(enc('a\nb\n'), 'member'), contentHash(enc('a  \r\nb\r\n'), 'member'));
    assert.notEqual(contentHash(enc('a\nb\n'), 'path'), contentHash(enc('a\r\nb\r\n'), 'path'), 'a stream file’s bytes are its own');
  });
});

/** A UI that answers from a script and records what it was asked. */
export class FakeUi implements ProjectUi {
  readonly asked: string[] = [];
  conflicts: ConflictChoice[] = [];
  overwrite = false;
  create = true;
  library: string | undefined = 'HLINVDEV';
  path: string | undefined;
  folderUri: vscode.Uri | undefined;
  async conflict(label: string): Promise<ConflictChoice> {
    this.asked.push(`conflict ${label}`);
    return this.conflicts.shift() ?? 'skip';
  }
  async overwriteLocal(rel: string): Promise<boolean> {
    this.asked.push(`overwrite ${rel}`);
    return this.overwrite;
  }
  async createSourceFiles(library: string, files: string[]): Promise<boolean> {
    this.asked.push(`create ${library} ${files.join(',')}`);
    return this.create;
  }
  async targetLibrary(suggested: string): Promise<string | undefined> {
    this.asked.push(`library ${suggested}`);
    return this.library;
  }
  async targetPath(suggested: string): Promise<string | undefined> {
    this.asked.push(`path ${suggested}`);
    return this.path ?? suggested;
  }
  async folder(): Promise<vscode.Uri | undefined> {
    return this.folderUri;
  }
  info(message: string): void {
    this.asked.push(`info ${message}`);
  }
  error(message: string): void {
    this.asked.push(`error ${message}`);
  }
}

const line = (n: number, text: string, date = '260105'): SourceLine => ({ seq: `${String(n).padStart(4, '0')}.00`, date, text });

/** `HLINV`'s source as the fake system has it: four source files, a member each (two in QRPGLESRC). */
export function fakeLibrary(): { members: Map<string, { entry: MemberEntry; lines: SourceLine[]; text: string }> } {
  const members = new Map<string, { entry: MemberEntry; lines: SourceLine[]; text: string }>();
  const add = (file: string, member: string, type: string, text: string, lines: SourceLine[], changed: number) =>
    members.set(`${file}/${member}`, { entry: { member, type, text, records: lines.length, created: 1, changed }, lines, text });
  add('QRPGLESRC', 'ASSETS', 'RPGLE', 'Asset maintenance', [line(1, '**free'), line(2, 'dcl-s count int(10);'), line(3, '*inlr = *on;')], 1_000);
  add('QRPGLESRC', 'ASSETCP', 'RPGLE', 'Asset copy member', [line(1, 'dcl-ds asset qualified;'), line(2, '  id int(10);'), line(3, 'end-ds;')], 1_100);
  add('QCLSRC', 'BUILD', 'CLLE', 'Build', [line(1, 'PGM'), line(2, 'ENDPGM')], 1_200);
  add('QDDSSRC', 'ASSETSP', 'PF', '', [line(1, '     A          R ASSETR')], 1_300);
  add('QSQLSRC', 'SEED', 'SQL', 'Seed data', [line(1, "INSERT INTO ASSETS VALUES(1, 'A');")], 1_400);
  return { members };
}

/** Pull and deploy on a fake host, signed on as `PRJ`, in a new temporary folder. */
export async function projectRig(output: vscode.LogOutputChannel, answer: (method: string, params: Record<string, unknown>) => unknown) {
  const host = new FakeHost(answer);
  const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
  const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
  const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
  sessions.update({ name: 'PRJ', state: 'connected', user: 'CWELLMAN' });
  const projects = new ProjectStore(store, output);
  const ui = new FakeUi();
  const lines: string[] = [];
  const deps: ProjectDeps = { store, sessions, projects, ui, append: (l) => lines.push(l) };
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'qs4prj-'));
  ui.folderUri = vscode.Uri.file(dir);
  return {
    host,
    store,
    sessions,
    projects,
    ui,
    lines,
    deps,
    dir,
    folder: vscode.Uri.file(dir),
    read: (rel: string) => fs.readFile(nodePath.join(dir, ...rel.split('/')), 'utf8'),
    write: async (rel: string, text: string) => {
      await fs.mkdir(nodePath.dirname(nodePath.join(dir, ...rel.split('/'))), { recursive: true });
      await fs.writeFile(nodePath.join(dir, ...rel.split('/')), text);
    },
    dispose: async () => {
      projects.dispose();
      sessions.dispose();
      store.dispose();
      host.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** The fake system's answers to `member.list` and `member.read`. */
export function libraryAnswer(lib: ReturnType<typeof fakeLibrary>) {
  return (method: string, p: Record<string, unknown>): unknown => {
    if (method === 'member.list') {
      return [...lib.members.entries()]
        .filter(([k]) => k.startsWith(`${String(p.file)}/`))
        .filter(([k]) => !p.pattern || k.endsWith(`/${String(p.pattern)}`))
        .map(([, v]) => v.entry);
    }
    if (method === 'member.read') {
      const m = lib.members.get(`${String(p.file)}/${String(p.member)}`);
      if (!m) {
        throw new Error('not found');
      }
      return { type: m.entry.type, text: m.text, width: 100, ccsid: 37, lines: m.lines };
    }
    return null;
  };
}

suite('Projects: pull', () => {
  let output: vscode.LogOutputChannel;
  suiteSetup(() => {
    output = vscode.window.createOutputChannel('pull test', { log: true });
  });
  suiteTeardown(() => output.dispose());

  test('a library’s source files into the layout, a new project file, state and .gitignore', async () => {
    const lib = fakeLibrary();
    const rig = await projectRig(output, libraryAnswer(lib));
    try {
      const puller = new Puller(rig.deps);
      const r = await puller.pullSourceFiles('PRJ', 'HLINV', ['QRPGLESRC', 'QCLSRC', 'QDDSSRC', 'QSQLSRC'], rig.folder);
      assert.deepEqual(r?.pulled.sort(), ['QCLSRC/BUILD.clle', 'QDDSSRC/ASSETSP.pf', 'QRPGLESRC/ASSETCP.rpgle', 'QRPGLESRC/ASSETS.rpgle', 'QSQLSRC/SEED.sql']);
      assert.deepEqual(rig.ui.asked, ['library HLINV'], 'the target library asked for, the pulled one offered');
      assert.equal(await rig.read('QRPGLESRC/ASSETS.rpgle'), '**free\ndcl-s count int(10);\n*inlr = *on;\n', 'text with \\n, no sequence numbers or dates');
      const project = parseProjectText(await rig.read('qs400project.json'));
      assert.deepEqual(project.problems, []);
      assert.equal(project.config?.connection, 'PRJ');
      assert.deepEqual(project.config?.target, { kind: 'library', library: 'HLINVDEV' });
      assert.deepEqual(project.config?.texts, {
        'QCLSRC/BUILD.clle': 'Build',
        'QRPGLESRC/ASSETCP.rpgle': 'Asset copy member',
        'QRPGLESRC/ASSETS.rpgle': 'Asset maintenance',
        'QSQLSRC/SEED.sql': 'Seed data',
      });
      const state = parseState(await rig.read('.qs400/state.json'));
      assert.deepEqual(state.files['QRPGLESRC/ASSETS.rpgle'], {
        hash: contentHash(new TextEncoder().encode('**free\ndcl-s count int(10);\n*inlr = *on;\n'), 'member'),
        remote: 1_000,
        at: 'HLINV/QRPGLESRC(ASSETS)',
      });
      assert.equal(await rig.read('.gitignore'), '.qs400/\n');
      assert.ok(rig.lines.some((l) => l.startsWith('── ') && l.endsWith(' · Pull · HLINV · PRJ')));
      assert.equal(rig.lines[rig.lines.length - 1], '5 pulled, 0 unchanged, 0 kept');
    } finally {
      await rig.dispose();
    }
  });

  test('a pull over a local change asks Overwrite or Keep; an unchanged file is not asked about', async () => {
    const lib = fakeLibrary();
    const rig = await projectRig(output, libraryAnswer(lib));
    try {
      const puller = new Puller(rig.deps);
      await puller.pullSourceFiles('PRJ', 'HLINV', ['QRPGLESRC'], rig.folder);
      await rig.write('QRPGLESRC/ASSETS.rpgle', '**free\n// mine\n');
      rig.ui.asked.length = 0;
      rig.ui.overwrite = false;
      const kept = await puller.pullSourceFiles('PRJ', 'HLINV', ['QRPGLESRC'], rig.folder);
      assert.deepEqual(rig.ui.asked, ['overwrite QRPGLESRC/ASSETS.rpgle']);
      assert.deepEqual(kept?.kept, ['QRPGLESRC/ASSETS.rpgle']);
      assert.deepEqual(kept?.unchanged, ['QRPGLESRC/ASSETCP.rpgle']);
      assert.equal(await rig.read('QRPGLESRC/ASSETS.rpgle'), '**free\n// mine\n');
      rig.ui.overwrite = true;
      const over = await puller.pullSourceFiles('PRJ', 'HLINV', ['QRPGLESRC'], rig.folder);
      assert.deepEqual(over?.pulled, ['QRPGLESRC/ASSETS.rpgle']);
      assert.equal(await rig.read('QRPGLESRC/ASSETS.rpgle'), '**free\ndcl-s count int(10);\n*inlr = *on;\n');
    } finally {
      await rig.dispose();
    }
  });

  test('a local file keeps its own name and case', async () => {
    const lib = fakeLibrary();
    const rig = await projectRig(output, libraryAnswer(lib));
    try {
      await rig.write('qclsrc/build.clle', 'PGM\nENDPGM\n');
      const r = await new Puller(rig.deps).pullSourceFiles('PRJ', 'HLINV', ['QCLSRC'], rig.folder);
      assert.deepEqual(r?.unchanged, ['qclsrc/build.clle']);
      assert.deepEqual(Object.keys(parseState(await rig.read('.qs400/state.json')).files), ['qclsrc/build.clle']);
    } finally {
      await rig.dispose();
    }
  });
});
