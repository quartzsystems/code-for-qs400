// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MemberReadResult, SourceLine } from '../src/host/protocol';
import { diffLines, documentLines, gapSeqs, planWrite, seqText, seqValue } from '../src/members/diff';
import { ASSETS, LINES, memberFs } from './members.test';

const enc = (s: string) => new TextEncoder().encode(s);
const opts = { create: false, overwrite: true };

suite('Save: sequence numbers', () => {
  test('seq text and value', () => {
    assert.equal(seqValue('0000.01'), 1);
    assert.equal(seqValue('9999.99'), 999_999);
    assert.equal(seqText(1), '0000.01');
    assert.equal(seqText(999_999), '9999.99');
    assert.equal(seqText(0), '0000.00');
  });

  test('gaps: midway between neighbours, steps of 1.00 after the last line, none when there is no room', () => {
    assert.deepEqual(gapSeqs(300, 400, 1), [350]);
    assert.deepEqual(gapSeqs(300, 400, 2), [333, 366]);
    assert.deepEqual(gapSeqs(0, 100, 1), [50]);
    assert.deepEqual(gapSeqs(100, 102, 1), [101]);
    assert.equal(gapSeqs(100, 101, 1), undefined, '0.01 apart');
    assert.equal(gapSeqs(100, 102, 2), undefined);
    assert.deepEqual(gapSeqs(400, undefined, 3), [500, 600, 700]);
    assert.deepEqual(gapSeqs(0, undefined, 2), [100, 200], 'an empty member');
    // Near 9999.99 the steps no longer fit: spread in what is left.
    assert.deepEqual(gapSeqs(999_950, undefined, 1), [999_975]);
    assert.equal(gapSeqs(999_999, undefined, 1), undefined, 'an insert past 9999.99');
  });

  test('the line diff is a longest common subsequence', () => {
    const e = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
    assert.deepEqual(
      e.map((x) => x.kind),
      ['same', 'insert', 'delete', 'same', 'same', 'insert'],
    );
    assert.deepEqual(documentLines('a  \r\nb\n'), ['a', 'b', '']);
  });

  test('a renumber asked for keeps the old seq on kept lines, so their dates stay', () => {
    const plan = planWrite(LINES, LINES.map((l) => l.text), true);
    assert.deepEqual(plan, { renumber: true, lines: LINES });
  });
});

suite('Save: six fixtures through the provider', () => {
  let output: vscode.LogOutputChannel;
  const parts: vscode.Disposable[] = [];

  suiteSetup(() => {
    output = vscode.window.createOutputChannel('save test', { log: true });
  });
  teardown(() => {
    for (const p of parts.splice(0)) {
      p.dispose();
    }
  });
  suiteTeardown(() => output.dispose());

  /** Opens a member of `lines`, saves `text`; what `member.write` was sent, if anything, and every method. */
  async function save(lines: SourceLine[], text: string) {
    const read: MemberReadResult = { type: 'RPGLE', text: '', width: 100, ccsid: 37, lines };
    const t = memberFs(output, (m) => (m === 'member.write' ? { lines: 0 } : read));
    parts.push(...t.parts);
    await t.fs.stat(ASSETS);
    await t.fs.writeFile(ASSETS, enc(text), opts);
    const write = t.host.sent.find((s) => s.method === 'member.write');
    return { write: write?.params as { lines: SourceLine[]; renumber: boolean } | undefined, methods: t.host.methods() };
  }

  const text = (lines: string[]) => lines.join('\n');
  const [L1, L2, L3, L4] = LINES;

  test('1. no change: nothing is written', async () => {
    const r = await save(LINES, text(LINES.map((l) => l.text)));
    assert.equal(r.write, undefined);
    assert.deepEqual(r.methods, ['member.read lock=true']);
  });

  test('2. one change: the line keeps its seq and date; everything else as it was', async () => {
    const r = await save(LINES, text(['**free', 'dcl-s count int(20);', '', '*inlr = *on;']));
    assert.deepEqual(r.write, {
      name: 'MBR',
      library: 'HLINV',
      file: 'QRPGLESRC',
      member: 'ASSETS',
      renumber: false,
      lines: [L1, { seq: '0002.00', date: '260105', text: 'dcl-s count int(20);' }, L3, L4],
    });
    // The write ended the lock; the cache is read again, locked again.
    assert.deepEqual(r.methods, ['member.read lock=true', 'member.write', 'member.read lock=true']);
  });

  test('3. insert at the top: midway between 0 and the first line', async () => {
    const r = await save(LINES, text(['// top', ...LINES.map((l) => l.text)]));
    assert.deepEqual(r.write?.lines, [{ seq: '0000.50', date: '000000', text: '// top' }, L1, L2, L3, L4]);
    assert.equal(r.write?.renumber, false);
  });

  test('4. insert two lines in a gap: between their neighbours', async () => {
    const r = await save(LINES, text(['**free', 'dcl-s count int(10);', '', 'dcl-s a int(10);', 'dcl-s b int(10);', '*inlr = *on;']));
    assert.deepEqual(r.write?.lines, [
      L1,
      L2,
      L3,
      { seq: '0003.33', date: '000000', text: 'dcl-s a int(10);' },
      { seq: '0003.66', date: '000000', text: 'dcl-s b int(10);' },
      L4,
    ]);
    assert.equal(r.write?.renumber, false);
  });

  test('5. insert with no room: renumber, old seqs on the kept lines, 0000.00 on the new one', async () => {
    const tight: SourceLine[] = [
      { seq: '0001.00', date: '260105', text: 'a' },
      { seq: '0001.01', date: '251231', text: 'b' },
    ];
    const r = await save(tight, text(['a', 'new', 'b']));
    assert.deepEqual(r.write?.lines, [
      { seq: '0001.00', date: '260105', text: 'a' },
      { seq: '0000.00', date: '000000', text: 'new' },
      { seq: '0001.01', date: '251231', text: 'b' },
    ]);
    assert.equal(r.write?.renumber, true);
  });

  test('6. delete lines: the rest keep their seqs and dates', async () => {
    const r = await save(LINES, text(['**free', '*inlr = *on;']));
    assert.deepEqual(r.write?.lines, [L1, L4]);
    assert.equal(r.write?.renumber, false);
  });

  test('trailing blanks and CRLF are not changes', async () => {
    const r = await save(LINES, LINES.map((l) => `${l.text}   `).join('\r\n'));
    assert.equal(r.write, undefined);
  });
});
