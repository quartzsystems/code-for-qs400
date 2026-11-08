// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import type { SessionManager } from '../src/connections/sessions';
import type { ObjectEntry } from '../src/host/protocol';
import { listObjects, listSourceFiles, markSourceFiles, sourceFilesQuery } from '../src/objects/sourceFiles';

const file = (object: string, attribute: string, library = 'INVMGR'): ObjectEntry => ({
  library,
  object,
  type: '*FILE',
  attribute,
  text: `${object} text`,
  size: 0,
  changed: 0,
  owner: 'CWELLMAN',
});

/** QS/400 as it is: every physical file `PF`, the attribute filter on that, the catalog knowing which are source. */
function qs400(opts: { sql?: boolean } = {}) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const objects = [file('QSQLSRC', 'PF'), file('QDDSSRC', 'PF'), file('INVMGRITEM', 'PF'), file('INVMGRV', 'LF'), file('INVMGR01D', 'DSPF')];
  const sessions = {
    call: async (_name: string, method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === 'object.list') {
        return objects.filter((o) => params.attribute === undefined || o.attribute === params.attribute);
      }
      if (method === 'sql.run') {
        if (opts.sql === false) {
          throw new Error('QAP version 4 not available on this server');
        }
        return {
          kind: 'query',
          columns: [{ name: 'SYSTEM_TABLE_SCHEMA' }, { name: 'SYSTEM_TABLE_NAME' }],
          rows: [
            ['INVMGR    ', 'QSQLSRC   '],
            ['INVMGR    ', 'QDDSSRC   '],
          ],
          end: true,
          messages: [],
          uncommitted: false,
        };
      }
      return null;
    },
  };
  return { sessions: sessions as unknown as SessionManager, sent };
}

suite('Objects: source files from the catalog', () => {
  test('the query names the libraries once, quoted', () => {
    assert.equal(
      sourceFilesQuery(['invmgr', 'INVMGR', "O'X"]),
      "SELECT SYSTEM_TABLE_SCHEMA, SYSTEM_TABLE_NAME FROM QSYS2.SYSTABLES WHERE FILE_TYPE = 'S' AND SYSTEM_TABLE_SCHEMA IN ('INVMGR', 'O''X')",
    );
  });

  test('PF files are marked PF-SRC or PF-DTA as the catalog says; others are left alone', async () => {
    const { sessions } = qs400();
    const marked = await markSourceFiles(sessions, 'QS400', [file('QSQLSRC', 'PF'), file('INVMGRITEM', 'PF'), file('INVMGRV', 'LF')]);
    assert.deepEqual(
      marked.map((o) => `${o.object} ${o.attribute}`),
      ['QSQLSRC PF-SRC', 'INVMGRITEM PF-DTA', 'INVMGRV LF'],
    );
  });

  test('the source files of a library, though ListObjects filtered on PF-SRC finds none', async () => {
    const { sessions, sent } = qs400();
    const files = await listSourceFiles(sessions, 'QS400', 'INVMGR');
    assert.deepEqual(
      files.map((o) => o.object),
      ['QSQLSRC', 'QDDSSRC'],
    );
    assert.equal(files[0].text, 'QSQLSRC text', 'the text comes from the object list');
    assert.equal(sent[0].params.attribute, undefined, 'PF-SRC is not sent to the server');
  });

  test('a filter on an attribute ListObjects knows is still sent; PF-DTA is applied here', async () => {
    const { sessions, sent } = qs400();
    const dspf = await listObjects(sessions, 'QS400', { library: 'INVMGR', pattern: '*ALL', types: ['*FILE'], attribute: 'dspf' });
    assert.deepEqual(
      dspf.map((o) => o.object),
      ['INVMGR01D'],
    );
    assert.equal(sent[0].params.attribute, 'DSPF');
    const data = await listObjects(sessions, 'QS400', { library: 'INVMGR', pattern: '*ALL', types: ['*FILE'], attribute: 'PF-DTA' });
    assert.deepEqual(
      data.map((o) => o.object),
      ['INVMGRITEM'],
    );
  });

  test('without the catalog (no SQL on the server), the attributes stay as listed', async () => {
    const { sessions } = qs400({ sql: false });
    const all = await listObjects(sessions, 'QS400', { library: 'INVMGR', pattern: '*ALL', types: ['*FILE'] });
    assert.ok(all.every((o) => !o.attribute.startsWith('PF-')));
    assert.deepEqual(await listSourceFiles(sessions, 'QS400', 'INVMGR'), []);
  });
});
