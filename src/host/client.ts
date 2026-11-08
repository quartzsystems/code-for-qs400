// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  HostNotifications,
  LogParams,
  MethodName,
  ParamsOf,
  ResultOf,
  RpcErrorObject,
} from './protocol';

/** Error returned by the host for a request. */
export class HostRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'HostRpcError';
  }
}

/** The host is not running or stopped while a request was in flight. */
export class HostStoppedError extends Error {
  constructor(message = 'QS/400 host stopped') {
    super(message);
    this.name = 'HostStoppedError';
  }
}

/**
 * Splits a byte stream into `Content-Length` frames (the LSP framing).
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly onFrame: (body: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
      if (!match) {
        throw new Error(`frame header has no Content-Length: ${JSON.stringify(header)}`);
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) {
        return;
      }
      const body = this.buffer.subarray(start, start + length);
      this.buffer = this.buffer.subarray(start + length);
      this.onFrame(body);
    }
  }
}

/** Encodes one JSON-RPC message as a frame. */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

export type HostState = 'idle' | 'running' | 'stopped';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Methods answered only when the work ends (a transfer), or that wait in the
 * connection job's lane, where the host bounds the wait itself: no timeout.
 */
export const UNTIMED_METHODS: ReadonlySet<MethodName> = new Set<MethodName>(['ifs.download', 'ifs.upload', 'action.check', 'action.run']);
const SHUTDOWN_GRACE_MS = 2_000;

/** File name of the host binary on this platform. */
export function hostBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'qs400-code-host.exe' : 'qs400-code-host';
}

/**
 * Spawns `qs400-code-host` and speaks JSON-RPC 2.0 to it over stdio.
 * One instance per VS Code window. The process starts on the first
 * request and is restarted on the next request after it stops.
 */
export class HostClient implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stopping = false;
  private _state: HostState = 'idle';
  private readonly stateEmitter = new vscode.EventEmitter<HostState>();
  private readonly logEmitter = new vscode.EventEmitter<LogParams>();
  private readonly sessionEmitter = new vscode.EventEmitter<HostNotifications['session.changed']>();
  private readonly progressEmitter = new vscode.EventEmitter<HostNotifications['ifs.progress']>();
  private readonly transferEmitter = new vscode.EventEmitter<HostNotifications['ifs.transferEnded']>();

  /** Fires on every state change. */
  readonly onDidChangeState = this.stateEmitter.event;
  /** Fires for each `host.log` notification. */
  readonly onDidLog = this.logEmitter.event;
  /** Fires for each `session.changed` notification. */
  readonly onDidChangeSession = this.sessionEmitter.event;
  /** Fires for each `ifs.progress` notification. */
  readonly onDidProgress = this.progressEmitter.event;
  /** Fires for each `ifs.transferEnded` notification. */
  readonly onDidEndTransfer = this.transferEmitter.event;

  constructor(
    private readonly extensionPath: string,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  get state(): HostState {
    return this._state;
  }

  /** Process id of the running host, for diagnostics and tests. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Path of the binary that will be spawned. */
  resolveBinary(): string {
    const configured = vscode.workspace
      .getConfiguration('code-for-qs400')
      .get<string>('host.path', '')
      .trim();
    return configured !== ''
      ? configured
      : path.join(this.extensionPath, 'bin', hostBinaryName());
  }

  /**
   * Sends a request, starting the host first if needed. It fails after
   * 30 s without a reply, except the `UNTIMED_METHODS`.
   */
  async request<M extends MethodName>(method: M, ...args: ParamsOf<M> extends undefined ? [] : [ParamsOf<M>]): Promise<ResultOf<M>> {
    const child = this.ensureStarted();
    const id = this.nextId++;
    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (args.length > 0) {
      message.params = args[0];
    }
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = UNTIMED_METHODS.has(method)
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS} ms`));
          }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(encodeFrame(message), (err) => {
        if (err) {
          this.settle(id, undefined, new HostStoppedError(`write to host failed: ${err.message}`));
        }
      });
    });
  }

  /** Stops the host (gracefully, then by force) and starts a new one. */
  async restart(): Promise<void> {
    await this.stop();
    this.ensureStarted();
  }

  /** Asks the host to shut down; kills it if it does not exit promptly. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      await Promise.race([this.request('host.shutdown'), delay(SHUTDOWN_GRACE_MS)]);
    } catch {
      // The host may already be gone; the kill below covers it.
    }
    const timedOut = await Promise.race([exited.then(() => false), delay(SHUTDOWN_GRACE_MS).then(() => true)]);
    if (timedOut) {
      child.kill();
      await exited;
    }
  }

  dispose(): void {
    this.stopping = true;
    const child = this.child;
    if (child) {
      try {
        child.stdin.write(encodeFrame({ jsonrpc: '2.0', id: this.nextId++, method: 'host.shutdown' }));
        child.stdin.end();
      } catch {
        // Ignore: the process is going away either way.
      }
      setTimeout(() => child.kill(), SHUTDOWN_GRACE_MS).unref();
    }
    this.stateEmitter.dispose();
    this.logEmitter.dispose();
    this.sessionEmitter.dispose();
    this.progressEmitter.dispose();
    this.transferEmitter.dispose();
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }
    const binary = this.resolveBinary();
    if (!fs.existsSync(binary)) {
      throw new Error(`qs400-code-host not found at ${binary}`);
    }
    this.output.info(`starting ${binary}`);
    const child = spawn(binary, ['serve'], { stdio: 'pipe', windowsHide: true });
    this.child = child;
    this.stopping = false;

    const reader = new FrameReader((body) => this.onMessage(body));
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk);
      } catch (err) {
        this.output.error(`bad frame from host: ${String(err)}`);
        child.kill();
      }
    });

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      const lines = (stderrTail + text).split(/\r?\n/);
      stderrTail = lines.pop() ?? '';
      for (const line of lines) {
        this.forwardStderr(line);
      }
    });

    child.on('error', (err) => {
      this.output.error(`host process error: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      this.forwardStderr(stderrTail);
      this.onExit(child, code, signal);
    });
    child.stdin.on('error', (err) => {
      this.output.warn(`host stdin closed: ${err.message}`);
    });

    this.setState('running');
    return child;
  }

  private onMessage(body: Buffer): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: RpcErrorObject };
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch {
      this.output.error('host sent a frame that is not JSON');
      return;
    }
    if (typeof msg.method === 'string') {
      this.onNotification(msg.method, msg.params);
      return;
    }
    if (typeof msg.id === 'number') {
      const err = msg.error ? new HostRpcError(msg.error.code, msg.error.message, msg.error.data) : undefined;
      this.settle(msg.id, msg.result, err);
    }
  }

  /**
   * Writes one stderr line to the output channel. The host prefixes its
   * log lines with `[info]`, `[warn]` or `[error]`; anything else (a panic
   * message, say) is shown as an error.
   */
  private forwardStderr(line: string): void {
    if (line === '') {
      return;
    }
    const m = /^\[(info|warn|error)\] (.*)$/.exec(line);
    if (!m) {
      this.output.error(line);
    } else if (m[1] === 'info') {
      this.output.info(m[2]);
    } else if (m[1] === 'warn') {
      this.output.warn(m[2]);
    } else {
      this.output.error(m[2]);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'host.log') {
      // The same line arrives on stderr, which is what the output channel
      // shows; the notification is for listeners in the extension.
      this.logEmitter.fire(params as HostNotifications['host.log']);
      return;
    }
    if (method === 'session.changed') {
      this.sessionEmitter.fire(params as HostNotifications['session.changed']);
      return;
    }
    if (method === 'ifs.progress') {
      this.progressEmitter.fire(params as HostNotifications['ifs.progress']);
      return;
    }
    if (method === 'ifs.transferEnded') {
      this.transferEmitter.fire(params as HostNotifications['ifs.transferEnded']);
      return;
    }
    this.output.debug(`unhandled notification ${method}`);
  }

  private settle(id: number, result: unknown, err: Error | undefined): void {
    const p = this.pending.get(id);
    if (!p) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (err) {
      p.reject(err);
    } else {
      p.resolve(result);
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    for (const id of [...this.pending.keys()]) {
      this.settle(id, undefined, new HostStoppedError());
    }
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (this.stopping) {
      this.output.info(`host exited (${how})`);
      this.setState('idle');
    } else {
      this.output.warn(`host stopped unexpectedly (${how}); it restarts on the next command`);
      this.setState('stopped');
    }
  }

  private setState(state: HostState): void {
    if (this._state !== state) {
      this._state = state;
      this.stateEmitter.fire(state);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
