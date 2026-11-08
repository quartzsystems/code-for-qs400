// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SessionManager } from '../src/connections/sessions';
import { ConnectionStore } from '../src/connections/store';
import { HostClient } from '../src/host/client';
import { MessageArrived, QueuedMessage, SessionStatus } from '../src/host/protocol';
import {
  NOTIFY_SETTING,
  answeredKeys,
  messageDescription,
  notifies,
  orderMessages,
  parseQueue,
  queueKey,
  queueLabel,
  sentText,
} from '../src/messages/model';
import { MessagesProvider, NAMED_QUEUES_KEY, messageTreeItem } from '../src/views/messages';
import { FakeHost, Memento } from './members.test';

const T0 = new Date(2026, 10, 8, 9, 0, 0).getTime();

function msg(key: number, kind: QueuedMessage['kind'], text: string, minutes: number, over: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    key: key.toString(16).toUpperCase().padStart(8, '0'),
    id: '',
    kind,
    severity: kind === 'inquiry' ? 99 : 0,
    text,
    sent: T0 + minutes * 60_000,
    fromUser: 'CWELLMAN',
    fromJob: { number: '100200', user: 'CWELLMAN', name: 'QPADEV0001' },
    needsReply: kind === 'inquiry',
    ...over,
  };
}

const OWN: QueuedMessage[] = [
  msg(0x1a0, 'informational', 'Build finished.', 0),
  msg(0x1a1, 'inquiry', 'Old question', 1),
  msg(0x1a2, 'inquiry', 'Answered question', 2, { needsReply: false, reply: 'Y' }),
  msg(0x1a3, 'reply', 'Y', 3, { answers: '000001A2' }),
  msg(0x1a4, 'completion', 'Job 654321/CWELLMAN/CODETEST completed normally.', 4, { id: 'CPF1241' }),
  msg(0x1a5, 'inquiry', 'reply test', 5),
];

suite('Messages: the model', () => {
  test('inquiries waiting first, newest first; then the rest newest first', () => {
    assert.deepEqual(
      orderMessages(OWN).map((m) => m.key),
      ['000001A5', '000001A1', '000001A4', '000001A3', '000001A2', '000001A0'],
    );
    assert.deepEqual(orderMessages([]), []);
  });

  test('description, answered keys and queues', () => {
    assert.equal(messageDescription(OWN[4]), `CPF1241 · CWELLMAN · ${sentText(OWN[4].sent)}`);
    assert.equal(messageDescription(OWN[0]), `CWELLMAN · ${sentText(OWN[0].sent)}`);
    assert.equal(sentText(T0), '2026-11-08 09:00:00');
    assert.deepEqual(answeredKeys(OWN), ['000001A2', '000001A3']);
    assert.deepEqual(parseQueue(' qgpl/teamq '), { library: 'QGPL', queue: 'TEAMQ' });
    assert.equal(parseQueue('TEAMQ'), undefined);
    assert.equal(queueKey({ library: 'qgpl', queue: 'teamq' }), 'QGPL/TEAMQ');
    assert.equal(queueLabel('own'), 'My messages');
    assert.equal(queueLabel('sysopr'), 'System operator');
  });

  test('the notify setting', () => {
    const inquiry = OWN[5];
    const info = OWN[0];
    assert.ok(notifies('inquiries', inquiry));
    assert.ok(!notifies('inquiries', info));
    assert.ok(!notifies('inquiries', OWN[2]), 'an answered inquiry waits for nothing');
    assert.ok(notifies('all', info));
    assert.ok(!notifies('none', inquiry));
    assert.ok(notifies(undefined, inquiry), 'inquiries by default');
  });
});

/** The Messages view on a fake host with `QSHQ400` signed on and active. */
function messagesView(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const output = vscode.window.createOutputChannel('messages test', { log: true });
  const host = new FakeHost(answer);
  const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
  const store = new ConnectionStore(secrets as unknown as vscode.SecretStorage, output);
  const state = new Memento();
  const sessions = new SessionManager(host as unknown as HostClient, store, state, output);
  Object.defineProperty(sessions, 'active', { get: () => 'QSHQ400' });
  const status: SessionStatus = {
    name: 'QSHQ400',
    state: 'connected',
    user: 'CWELLMAN',
    system: { name: 'QSHQ400', product: 'QS00SS1', version: 'V1R0M0', qap: 9 },
    job: { number: '123456', user: 'QUSER', name: 'QAPCNN' },
  };
  sessions.update(status);
  const arrived = new vscode.EventEmitter<MessageArrived>();
  const notified: MessageArrived[] = [];
  const provider = new MessagesProvider(store, sessions, state, { onDidArriveMessage: arrived.event }, (a) => notified.push(a));
  const dispose = () => [provider, sessions, store, host, output, arrived].forEach((d) => d.dispose());
  return { host, sessions, provider, state, arrived, notified, dispose };
}

suite('Messages: the view', () => {
  test('My messages and System operator when readable; named queues after; inquiries first', async () => {
    const v = messagesView((method, params) => {
      if (method === 'messages.canRead') {
        assert.deepEqual(params, { name: 'QSHQ400', queue: 'sysopr' });
        return { ok: true };
      }
      assert.equal(method, 'messages.list');
      return params.queue === 'own' ? OWN : [];
    });
    try {
      await v.provider.setNamed('QSHQ400', [{ library: 'QGPL', queue: 'TEAMQ' }]);
      assert.deepEqual(v.state.get(NAMED_QUEUES_KEY), { QSHQ400: ['QGPL/TEAMQ'] });
      const roots = await v.provider.getChildren();
      assert.deepEqual(
        roots.map((r) => messageTreeItem(r).label),
        ['My messages', 'System operator', 'QGPL/TEAMQ'],
      );
      const items = (await v.provider.getChildren(roots[0])).map(messageTreeItem);
      assert.deepEqual(
        items.map((i) => i.label),
        ['reply test', 'Old question', 'Job 654321/CWELLMAN/CODETEST completed normally.', 'Y', 'Answered question', 'Build finished.'],
      );
      assert.equal(items[0].contextValue, 'messages.message.waiting');
      assert.equal(items[2].contextValue, 'messages.message');
      assert.equal((items[0].iconPath as vscode.ThemeIcon).id, 'question');
      assert.match(String(items[0].description), /^CWELLMAN · 2026-11-08 09:05:00 · 000001A5$/);
      assert.match(String(items[0].tooltip), /Waiting for a reply/);
      const [none] = await v.provider.getChildren(roots[2]);
      assert.equal(messageTreeItem(none).label, 'No messages');
    } finally {
      v.dispose();
    }
  });

  test('System operator is left out when the profile may not read it', async () => {
    const v = messagesView((method) => (method === 'messages.canRead' ? { ok: false } : []));
    try {
      const roots = await v.provider.getChildren();
      assert.deepEqual(
        roots.map((r) => messageTreeItem(r).label),
        ['My messages'],
      );
      await v.provider.getChildren();
      assert.equal(v.host.sent.filter((s) => s.method === 'messages.canRead').length, 1, 'asked once per session job');
    } finally {
      v.dispose();
    }
  });

  test('own is watched for the session; arrivals count on the badge and notify as set', async () => {
    let own = OWN.slice(0, 2);
    const v = messagesView((method) => (method === 'messages.list' ? own : null));
    const config = vscode.workspace.getConfiguration();
    try {
      await v.provider.syncWatches();
      assert.deepEqual(v.host.sent.slice(0, 2), [
        { method: 'messages.watch', params: { name: 'QSHQ400', queue: 'own' } },
        { method: 'messages.list', params: { name: 'QSHQ400', queue: 'own', newestFirst: true } },
      ]);
      assert.equal(v.provider.badgeCount(), 1, 'the inquiry already waiting');
      await v.provider.syncWatches();
      assert.equal(v.host.sent.length, 2, 'once per session job');

      const inquiry = msg(0x1a6, 'inquiry', 'reply test', 6);
      own = [...own, inquiry];
      v.arrived.fire({ name: 'QSHQ400', queue: 'own', message: inquiry, caughtUp: false });
      assert.equal(v.provider.badgeCount(), 2);
      assert.deepEqual(
        v.notified.map((a) => a.message.key),
        ['000001A6'],
      );
      v.arrived.fire({ name: 'QSHQ400', queue: 'own', message: msg(0x1a7, 'informational', 'Job ended.', 7), caughtUp: false });
      assert.equal(v.provider.badgeCount(), 3, 'information counts too');
      assert.equal(v.notified.length, 1, 'but has no notification by default');

      await config.update(NOTIFY_SETTING, 'all', vscode.ConfigurationTarget.Global);
      v.arrived.fire({ name: 'QSHQ400', queue: 'own', message: msg(0x1a8, 'informational', 'Another.', 8), caughtUp: true });
      assert.equal(v.notified.length, 2);
      await config.update(NOTIFY_SETTING, 'none', vscode.ConfigurationTarget.Global);
      v.arrived.fire({ name: 'QSHQ400', queue: 'own', message: msg(0x1a9, 'inquiry', 'Silent?', 9), caughtUp: false });
      assert.equal(v.notified.length, 2);
      assert.equal(v.provider.badgeCount(), 5, 'three inquiries waiting, two new messages');

      // Replying clears the inquiry; looking clears what was only new.
      v.provider.answered('QSHQ400', 'own', ['000001A6']);
      assert.equal(v.provider.badgeCount(), 4);
      v.provider.seen();
      assert.equal(v.provider.badgeCount(), 2, 'the two inquiries still waiting');
      // A reply that arrives answers its inquiry.
      v.arrived.fire({ name: 'QSHQ400', queue: 'own', message: msg(0x1aa, 'reply', 'OK', 10, { answers: '000001A9' }), caughtUp: false });
      v.provider.seen();
      assert.equal(v.provider.badgeCount(), 1);
    } finally {
      await config.update(NOTIFY_SETTING, undefined, vscode.ConfigurationTarget.Global);
      v.dispose();
    }
  });
});
