// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { ConnectionConfig } from '../connections/config';
import { promptPassword } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { DebugCredentials, HostDebugAdapter } from './adapter';
import { DEBUG_TYPE, DebugDefaults, Qs400DebugConfiguration, completeConfiguration, initialConfigurations } from './config';
import { DEBUG_SOURCE, DebugSourceDeps, resolveDebugSource } from './source';
import { STATEMENTS_SCHEME, StatementsProvider } from './statements';
import { noDebugDataOf } from './commands';

/** The key of the sign-on a resolved configuration waits on; the password itself is never in it. */
const CREDENTIALS_KEY = '__qs400Credentials';

/** What the debugger needs from the window. */
export interface DebuggingDeps {
  store: ConnectionStore;
  sessions: SessionManager;
  /** The host binary, which is also the adapter. */
  binary: () => string;
  log: (line: string) => void;
  source: DebugSourceDeps;
  /** `LIB/PGM` a document's member or project file compiles to. */
  programOf: (uri: vscode.Uri) => Promise<string | undefined>;
  /** `LIB/PGM` selected in the Objects view. */
  selectedProgram: () => string | undefined;
  /** A start refused with `CPF9C15`: the recompile offer. */
  noDebugData?: (config: vscode.DebugConfiguration, message: string) => void;
}

/**
 * The `qs400` debugger: VS Code's debug UI over `qs400-code-host dap`.
 * The configuration provider fills in the connection and program and
 * builds the CALL; the sign-on is read (or asked) when the configuration
 * is resolved and handed to the adapter with its `launch` or `attach`.
 * `qs400/debugSource` is answered from the project, the member or the
 * stream file a module was compiled from.
 */
export class Debugging implements vscode.Disposable, vscode.DebugConfigurationProvider {
  readonly statements = new StatementsProvider();
  private readonly waiting = new Map<string, DebugCredentials>();
  private next = 1;

  constructor(private readonly deps: DebuggingDeps) {}

  register(): vscode.Disposable[] {
    return [
      vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, this),
      vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
        createDebugAdapterDescriptor: (session) => this.adapterFor(session),
      }),
      vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, {
        createDebugAdapterTracker: (session) => ({
          onDidSendMessage: (m: unknown) => this.onAdapterMessage(session, m),
        }),
      }),
      vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
        if (e.session.type === DEBUG_TYPE && e.event === DEBUG_SOURCE) {
          void this.answerSource(e.session, e.body as { id: number; program: string; module: string });
        }
      }),
      vscode.workspace.registerTextDocumentContentProvider(STATEMENTS_SCHEME, this.statements),
      this.statements,
    ];
  }

  /** What the window offers for a configuration that leaves them out. */
  async defaults(): Promise<DebugDefaults> {
    const editor = vscode.window.activeTextEditor?.document.uri;
    const program = (editor ? await this.deps.programOf(editor).catch(() => undefined) : undefined) ?? this.deps.selectedProgram();
    return { connection: this.deps.sessions.active, program };
  }

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return initialConfigurations(this.deps.sessions.active ?? 'QSHQ400');
  }

  async resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
    const done = completeConfiguration(config as Qs400DebugConfiguration, await this.defaults());
    if (typeof done === 'string') {
      void vscode.window.showErrorMessage(`QS/400 debug: ${done}`);
      return undefined;
    }
    const c = this.deps.store.get(done.connection as string);
    if (!c) {
      void vscode.window.showErrorMessage(`QS/400 debug: no saved connection named ${done.connection}.`);
      return undefined;
    }
    done.connection = c.name;
    return done as vscode.DebugConfiguration;
  }

  /** The sign-on, asked for now when no password is saved, so a cancel ends nothing half started. */
  async resolveDebugConfigurationWithSubstitutedVariables(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
    const c = this.deps.store.get(String(config.connection));
    if (!c) {
      return undefined;
    }
    const creds = await this.credentials(c);
    if (!creds) {
      return undefined;
    }
    const key = String(this.next++);
    this.waiting.set(key, creds);
    return { ...config, [CREDENTIALS_KEY]: key };
  }

  /** The connection's sign-on: the saved password or one asked for, and the editor session's library list. */
  async credentials(c: ConnectionConfig): Promise<DebugCredentials | undefined> {
    let password = await this.deps.store.password(c.name);
    if (password === undefined) {
      const answer = await promptPassword(c, `Password for ${c.user} on ${c.host}, for the debug session's own connection.`);
      if (!answer) {
        return undefined;
      }
      if (answer.save) {
        await this.deps.store.storePassword(c.name, answer.password);
      }
      password = answer.password;
    }
    const creds: DebugCredentials = { host: c.host, user: c.user, password };
    if (c.port !== undefined) {
      creds.port = c.port;
    }
    if (c.tls?.caFile) {
      creds.caFile = c.tls.caFile;
    }
    const state = this.deps.sessions.status(c.name).state;
    if (state === 'connected' || state === 'stale') {
      try {
        const l = await this.deps.sessions.call(c.name, 'libl.get', { name: c.name });
        creds.libraryList = { user: l.user, ...(l.current ? { current: l.current } : {}) };
      } catch {
        // The adapter's job keeps the profile's list.
      }
    }
    return creds;
  }

  private async adapterFor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor | undefined> {
    const key = session.configuration[CREDENTIALS_KEY] as string | undefined;
    let creds = key ? this.waiting.get(key) : undefined;
    if (key) {
      this.waiting.delete(key);
    }
    if (!creds) {
      const c = this.deps.store.get(String(session.configuration.connection));
      creds = c ? await this.credentials(c) : undefined;
    }
    if (!creds) {
      void vscode.window.showErrorMessage(`QS/400 debug: no sign-on for ${String(session.configuration.connection)}.`);
      return undefined;
    }
    return new vscode.DebugAdapterInlineImplementation(new HostDebugAdapter(this.deps.binary(), creds, this.deps.log));
  }

  /** `qs400/debugSource { id, program, module }`: the source, or null for the synthetic statements. */
  async answerSource(session: vscode.DebugSession, body: { id: number; program: string; module: string }): Promise<void> {
    const connection = String(session.configuration.connection);
    let answer = null;
    try {
      answer = await resolveDebugSource(this.deps.source, connection, body.program, body.module);
    } catch (err) {
      this.deps.log(`debug source of ${body.program} ${body.module}: ${String(err)}`);
    }
    await session.customRequest(DEBUG_SOURCE, { id: body.id, path: answer?.path ?? null, name: answer?.name });
  }

  /** What the adapter sent, as the tracker sees it. */
  onAdapterMessage(session: vscode.DebugSession, m: unknown): void {
    const refused = noDebugDataOf(m);
    if (refused !== undefined) {
      this.deps.noDebugData?.(session.configuration, refused);
      return;
    }
    const msg = m as { type?: string; command?: string; success?: boolean; body?: { stackFrames?: Array<{ source?: { path?: string }; line?: number }> } };
    if (msg.type === 'response' && msg.command === 'stackTrace' && msg.success) {
      for (const f of msg.body?.stackFrames ?? []) {
        if (f.source?.path?.startsWith(`${STATEMENTS_SCHEME}:`) && f.line) {
          this.statements.grow(f.source.path, f.line);
        }
      }
    }
  }

  dispose(): void {
    this.waiting.clear();
  }
}
