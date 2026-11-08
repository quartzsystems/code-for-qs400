// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parsePropertiesUri, propertiesText, propertiesUri } from '../src/commands/objects';
import { parseConnections, toSetting } from '../src/connections/config';
import { LibraryListController } from '../src/connections/libraryList';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient, HostRpcError } from '../src/host/client';
import { ObjectEntry, SessionErrorCodes, SessionStatus } from '../src/host/protocol';
import { isFilterLibrary, isPattern, typesFor } from '../src/objects/filters';
import { ObjectsNode, ObjectsProvider, libraryNodes, objectContext, objectsTreeItem } from '../src/views/objects';

const SRC: ObjectEntry = {
  library: 'HLINV',
  object: 'QRPGLESRC',
  type: '*FILE',
  attribute: 'PF-SRC',
  text: 'RPG sources',
  size: 491520,
  changed: 0,
  owner: 'CWELLMAN',
};
const PGM: ObjectEntry = { ...SRC, object: 'ASSETS', type: '*PGM', attribute: 'RPGLE', text: 'Asset register' };

suite('Objects: patterns and filters', () => {
  test("a pattern is one of the spec's three forms", () => {
    for (const p of ['ASSETS', 'assets', 'ASSET*', 'A*', '$X_1.B', '*ALL', '*all']) {
      assert.ok(isPattern(p), p);
    }
    for (const p of ['', '*', '**', 'AS*ET', '*ASSET', '1ABC', 'ABCDEFGHIJK', 'ABCDEFGHIJ*', 'A B', '*LIBL']) {
      assert.ok(!isPattern(p), p);
    }
    assert.ok(isFilterLibrary('*libl') && isFilterLibrary('*USRLIBL') && isFilterLibrary('HLINV'));
    assert.ok(!isFilterLibrary('HL*'));
    assert.deepEqual(typesFor('*ALL'), []);
    assert.deepEqual(typesFor('*file'), ['*FILE']);
  });

  test('filters are read and written with their connection; bad ones are reported', () => {
    const { connections, problems } = parseConnections([
      {
        name: 'QSHQ400',
        host: 'h',
        user: 'cwellman',
        filters: [
          { name: 'Sources', library: 'HLINV', object: '*ALL', type: '*FILE', attribute: 'PF-SRC' },
          { name: 'Assets', library: '*LIBL', object: 'ASSET*', type: '*ALL' },
          { name: 'Bad', library: 'HLINV', object: 'AS*ET', type: '*ALL' },
          { name: 'sources', library: 'HLINV' },
          { library: 'HLINV' },
        ],
      },
    ]);
    assert.deepEqual(connections[0].filters, [
      { name: 'Sources', library: 'HLINV', object: '*ALL', type: '*FILE', attribute: 'PF-SRC' },
      { name: 'Assets', library: '*LIBL', object: 'ASSET*', type: '*ALL' },
    ]);
    assert.equal(problems.length, 3);
    assert.deepEqual(toSetting(connections[0]).filters, [
      { name: 'Sources', library: 'HLINV', object: '*ALL', type: '*FILE', attribute: 'PF-SRC' },
      { name: 'Assets', library: '*LIBL', object: 'ASSET*', type: '*ALL' },
    ]);
  });
});

suite('Objects: nodes', () => {
  test('roots: the current library first as *CURLIB, then the user part', () => {
    const nodes = libraryNodes('Q', { current: 'CWELLMAN', system: ['QSYS'], user: ['HLINV', 'QGPL'] });
    assert.deepEqual(
      nodes.map((n) => {
        const i = objectsTreeItem(n);
        return [i.label, i.description];
      }),
      [
        ['CWELLMAN', '*CURLIB'],
        ['HLINV', undefined],
        ['QGPL', undefined],
      ],
    );
  });

  test('a source file expands; other objects do not; attribute and text are the description', () => {
    const src = objectsTreeItem({ kind: 'object', connection: 'Q', entry: SRC });
    assert.equal(src.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.equal(src.description, 'PF-SRC RPG sources');
    assert.equal(src.contextValue, 'object.file.srcpf');
    const pgm = objectsTreeItem({ kind: 'object', connection: 'Q', entry: PGM });
    assert.equal(pgm.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.equal(pgm.description, 'RPGLE Asset register');
    assert.equal(objectContext(PGM), 'object.pgm');
    const mbr = objectsTreeItem({
      kind: 'member',
      connection: 'Q',
      library: 'HLINV',
      file: 'QRPGLESRC',
      entry: { member: 'ASSETS', type: 'RPGLE', text: 'Asset register', records: 120, created: 0, changed: 0 },
    });
    assert.deepEqual([mbr.label, mbr.description, mbr.tooltip], ['ASSETS', 'RPGLE', 'Asset register']);
  });

  test('properties: the document is named <LIB>/<OBJ> (*TYPE) and lists name: value in order', () => {
    const uri = propertiesUri('QSHQ400', 'HLINV', 'ASSETS', '*PGM');
    assert.equal(uri.path, '/HLINV/ASSETS (*PGM)');
    assert.deepEqual(parsePropertiesUri(uri), { connection: 'QSHQ400', library: 'HLINV', object: 'ASSETS', type: '*PGM' });
    assert.equal(
      propertiesText([
        { name: 'Object', value: 'ASSETS' },
        { name: 'Library', value: 'HLINV' },
        { name: 'Type', value: '*PGM' },
      ]),
      'Object: ASSETS\nLibrary: HLINV\nType: *PGM\n',
    );
  });
});

/** A host answering from a function. */
class FakeHost {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  private readonly session = new vscode.EventEmitter<SessionStatus>();
  private readonly state = new vscode.EventEmitter<string>();
  readonly onDidChangeSession = this.session.event;
  readonly onDidChangeState = this.state.event;
  constructor(private readonly answer: (method: string, params: Record<string, unknown>) => unknown) {}
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    return this.answer(method, params);
  }
  dispose(): void {
    this.session.dispose();
    this.state.dispose();
  }
}

class Memento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();
  keys() {
    return [...this.map.keys()];
  }
  get<T>(key: string, fallback?: T): T | undefined {
    return (this.map.has(key) ? this.map.get(key) : fallback) as T | undefined;
  }
  update(key: string, value: unknown) {
    this.map.set(key, value);
    return Promise.resolve();
  }
}

suite('Objects: the view against a host', () => {
  const config = () => vscode.workspace.getConfiguration('code-for-qs400');
  let output: vscode.LogOutputChannel;
  const parts: vscode.Disposable[] = [];

  async function view(host: FakeHost, qap = 9) {
    const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
    const sessions = new SessionManager(host as unknown as HostClient, store, new Memento(), output);
    const libl = new LibraryListController(store, sessions, output);
    const objects = new ObjectsProvider(store, sessions, libl);
    parts.push(objects, libl, sessions, store, host);
    sessions.update({
      name: 'OBJ',
      state: 'connected',
      user: 'CWELLMAN',
      system: { name: 'QSHQ400', product: 'QS00SS1', version: 'V1R0M0', qap },
    });
    await sessions.setActive('OBJ');
    return { store, objects };
  }

  const labels = (nodes: ObjectsNode[]) => nodes.map((n) => objectsTreeItem(n).label);

  suiteSetup(() => {
    output = vscode.window.createOutputChannel('objects test', { log: true });
  });

  setup(async () => {
    await config().update(
      'connections',
      [
        {
          name: 'OBJ',
          host: 'h.example',
          user: 'CWELLMAN',
          filters: [{ name: 'RPG sources', library: 'HLINV', object: 'Q*', type: '*FILE', attribute: 'PF-SRC' }],
        },
      ],
      true,
    );
  });

  teardown(async () => {
    for (const p of parts.splice(0)) {
      p.dispose();
    }
    await config().update('connections', undefined, true);
  });

  suiteTeardown(() => output.dispose());

  test('libraries, types, objects, members and a filter, each one host call', async () => {
    const host = new FakeHost((method, params) => {
      switch (method) {
        case 'libl.get':
          return { current: 'CWELLMAN', system: ['QSYS'], user: ['HLINV'] };
        case 'object.list':
          return params.types && (params.types as string[]).includes('*PGM') ? [PGM] : [SRC];
        case 'member.list':
          return [{ member: 'ASSETS', type: 'RPGLE', text: 'Asset register', records: 120, created: 0, changed: 0 }];
        default:
          throw new Error(`unexpected ${method}`);
      }
    });
    const { objects } = await view(host);
    const roots = await objects.getChildren();
    assert.deepEqual(labels(roots), ['CWELLMAN', 'HLINV', 'Filters']);

    const types = await objects.getChildren(roots[1]);
    assert.deepEqual(labels(types), ['*FILE', '*PGM', '*SRVPGM', '*MODULE', '*CMD', '*DTAARA', '*MSGF', '*BNDDIR', 'All']);

    host.sent.length = 0;
    const pgms = await objects.getChildren(types[1]);
    assert.deepEqual(labels(pgms), ['ASSETS']);
    const all = await objects.getChildren(types[8]);
    assert.deepEqual(labels(all), ['QRPGLESRC']);
    const members = await objects.getChildren(all[0]);
    assert.deepEqual(labels(members), ['ASSETS']);
    assert.deepEqual(host.sent, [
      { method: 'object.list', params: { name: 'OBJ', library: 'HLINV', pattern: '*ALL', types: ['*PGM'] } },
      { method: 'object.list', params: { name: 'OBJ', library: 'HLINV', pattern: '*ALL', types: [] } },
      { method: 'member.list', params: { name: 'OBJ', library: 'HLINV', file: 'QRPGLESRC' } },
    ]);

    host.sent.length = 0;
    const filters = await objects.getChildren(roots[2]);
    assert.deepEqual(labels(filters), ['RPG sources']);
    assert.deepEqual(labels(await objects.getChildren(filters[0])), ['QRPGLESRC']);
    assert.deepEqual(host.sent, [
      {
        method: 'object.list',
        params: { name: 'OBJ', library: 'HLINV', pattern: 'Q*', types: ['*FILE'], attribute: 'PF-SRC' },
      },
    ]);
  });

  test('below QAP version 8: one line, and nothing asked', async () => {
    const host = new FakeHost(() => {
      throw new Error('nothing should be asked');
    });
    const { objects } = await view(host, 7);
    // The library list node reads its list when the session connects; that is not the view.
    await new Promise((r) => setTimeout(r, 50));
    host.sent.length = 0;
    const roots = await objects.getChildren();
    assert.equal(roots.length, 1);
    const item = objectsTreeItem(roots[0]);
    assert.equal(item.label, 'QAP version 8 not available on this server');
    assert.equal(item.description, 'QAP v7');
    assert.equal(host.sent.length, 0);
  });

  test("the host's -32001 is the same one line; a server refusal shows its message", async () => {
    const host = new FakeHost((method) => {
      if (method === 'libl.get') {
        throw new HostRpcError(SessionErrorCodes.QapUnavailable, 'QAP version 8 not available on this server', {
          version: 6,
        });
      }
      throw new Error('unexpected');
    });
    const { objects } = await view(host);
    const roots = await objects.getChildren();
    assert.deepEqual(labels(roots), ['QAP version 8 not available on this server']);

    const refusing = new FakeHost((method) => {
      if (method === 'libl.get') {
        return { current: null, system: [], user: ['NOAUT'] };
      }
      throw new HostRpcError(SessionErrorCodes.Server, 'CPF2182: Not authorized to library NOAUT.', {
        status: 'NotAuthorized',
        messageId: 'CPF2182',
        text: 'Not authorized to library NOAUT.',
      });
    });
    const second = await view(refusing);
    const lib = (await second.objects.getChildren())[0];
    const types = await second.objects.getChildren(lib);
    assert.deepEqual(labels(await second.objects.getChildren(types[0])), ['CPF2182: Not authorized to library NOAUT.']);
  });
});
