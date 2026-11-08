// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../src/extension';
import { FrameReader, HostState, encodeFrame } from '../src/host/client';

const EXTENSION_ID = 'quartzsystems.code-for-qs400';
const ABOUT = 'Code for QS/400 V1R0M0 · host 1.0.0 · QAP v9';

async function api(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `${EXTENSION_ID} is installed`);
  return ext.activate();
}

function waitForState(host: ExtensionApi['host'], want: HostState): Promise<void> {
  if (host.state === want) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`host never reached state ${want}`));
    }, 10_000);
    const sub = host.onDidChangeState((s) => {
      if (s === want) {
        clearTimeout(timer);
        sub.dispose();
        resolve();
      }
    });
  });
}

suite('Code for QS/400', () => {
  test('activates and contributes its commands', async () => {
    const { host } = await api();
    assert.ok(host);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('code-for-qs400.about'));
    assert.ok(commands.includes('code-for-qs400.host.restart'));
  });

  test('About shows the version from the host', async () => {
    const line = await vscode.commands.executeCommand<string>('code-for-qs400.about');
    assert.equal(line, ABOUT);
    const { host } = await api();
    assert.deepEqual(await host.request('host.version'), { host: '1.0.0', product: 'V1R0M0', qap: 9 });
  });

  test('host.ping echoes the nonce', async () => {
    const { host } = await api();
    const nonce = `n-${Date.now()}`;
    assert.deepEqual(await host.request('host.ping', { nonce }), { nonce });
  });

  test('a crashed host is reported and restarts on the next command', async () => {
    const { host } = await api();
    await host.request('host.ping', { nonce: 'warm' });
    const pid = host.pid;
    assert.ok(pid);
    const stopped = waitForState(host, 'stopped');
    process.kill(pid);
    await stopped;
    assert.equal(host.pid, undefined);

    const line = await vscode.commands.executeCommand<string>('code-for-qs400.about');
    assert.equal(line, ABOUT);
    assert.equal(host.state, 'running');
    assert.notEqual(host.pid, pid);
  });

  test('host.restart replaces the process', async () => {
    const { host } = await api();
    await host.request('host.ping', { nonce: 'before' });
    const before = host.pid;
    await vscode.commands.executeCommand('code-for-qs400.host.restart');
    assert.equal(host.state, 'running');
    assert.ok(host.pid);
    assert.notEqual(host.pid, before);
    assert.deepEqual(await host.request('host.ping', { nonce: 'after' }), { nonce: 'after' });
  });

  test('frame reader reassembles split and joined frames', () => {
    const got: string[] = [];
    const reader = new FrameReader((b) => got.push(b.toString('utf8')));
    const a = encodeFrame({ a: 'é' });
    const b = encodeFrame({ b: 2 });
    const all = Buffer.concat([a, b]);
    for (let i = 0; i < all.length; i += 3) {
      reader.push(all.subarray(i, i + 3));
    }
    reader.push(Buffer.concat([a, b]));
    assert.deepEqual(got, ['{"a":"é"}', '{"b":2}', '{"a":"é"}', '{"b":2}']);
  });
});
