// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { FrameReader, encodeFrame } from '../host/client';

/** The sign-on the adapter's own QAP connection uses, as `launch` and `attach` carry it under `qs400`. */
export interface DebugCredentials {
  host: string;
  port?: number;
  user: string;
  password: string;
  caFile?: string;
  certificates?: string[];
  libraryList?: { current?: string; user: string[] };
}

/**
 * `qs400-code-host dap` behind VS Code's own debug UI. The extension owns
 * the process's stdio so the sign-on goes into the `launch` or `attach`
 * request's arguments as they are written to the adapter (never on its
 * command line), and is never part of the session's configuration, which
 * any extension can read.
 */
export class HostDebugAdapter implements vscode.DebugAdapter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly sent = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.sent.event;
  private credentials: DebugCredentials | undefined;

  constructor(binary: string, credentials: DebugCredentials, log: (line: string) => void) {
    this.credentials = credentials;
    this.child = spawn(binary, ['dap'], { stdio: 'pipe', windowsHide: true });
    const reader = new FrameReader((body) => {
      try {
        this.sent.fire(JSON.parse(body.toString('utf8')) as vscode.DebugProtocolMessage);
      } catch (err) {
        log(`debug adapter: a message that does not read: ${String(err)}`);
      }
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk);
      } catch (err) {
        log(`debug adapter: ${String(err)}`);
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim() !== '') {
          log(`debug adapter: ${line}`);
        }
      }
    });
    this.child.on('error', (err) => {
      log(`debug adapter: ${err.message}`);
      this.ended(err.message);
    });
    this.child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        this.ended(`the debug adapter exited with ${code}`);
      }
    });
  }

  /** The process is gone: VS Code ends the session. */
  private ended(why: string): void {
    this.sent.fire({ type: 'event', event: 'output', seq: 0, body: { category: 'stderr', output: `${why}\n` } } as vscode.DebugProtocolMessage);
    this.sent.fire({ type: 'event', event: 'terminated', seq: 0, body: {} } as vscode.DebugProtocolMessage);
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    let m = message as { type?: string; command?: string; arguments?: Record<string, unknown> };
    if (m.type === 'request' && (m.command === 'launch' || m.command === 'attach') && this.credentials) {
      m = { ...m, arguments: { ...(m.arguments ?? {}), qs400: this.credentials } };
      // Sent once; nothing keeps it.
      this.credentials = undefined;
    }
    if (this.child.stdin.writable) {
      this.child.stdin.write(encodeFrame(m));
    }
  }

  dispose(): void {
    this.credentials = undefined;
    this.sent.dispose();
    if (this.child.exitCode === null) {
      this.child.stdin.end();
      // `disconnect` has been answered by now; a hung adapter is ended.
      setTimeout(() => {
        if (this.child.exitCode === null) {
          this.child.kill();
        }
      }, 2_000).unref();
    }
  }
}
