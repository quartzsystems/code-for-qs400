// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import type { LocalTarget, RunResult } from '../actions/run';
import { errorText } from '../connections/prompts';
import type { SessionManager } from '../connections/sessions';
import type { ConnectionStore } from '../connections/store';
import type { SessionJob } from '../host/protocol';
import { MEMBER_SCHEME, parseMemberUri, writableUri } from '../members/uri';
import { DEBUG_TYPE, NO_DEBUG_DATA, programName, withDebugView } from './config';
import { programOfDocument, programOfEntry } from './programs';
import { type DebugSourceDeps, resolveDebugSource } from './source';
import type { ProjectStore } from '../projects/store';

/** Workspace state of the programs last attached with, per connection. */
const ATTACH_PROGRAMS_KEY = 'code-for-qs400.debug.attachPrograms';

/** Context key: the active editor's member or project file has a program to debug. */
export const DEBUGGABLE_KEY = 'code-for-qs400.debuggable';

export const RECOMPILE = 'Recompile with DBGVIEW(*SOURCE)';
export const START_AGAIN = 'Start again';

/** `LIB/PGM` names typed with commas or blanks between them; the first that is no name, as an error. */
export function parsePrograms(text: string): string[] | string {
  const out: string[] = [];
  for (const word of text.split(/[\s,]+/).filter((w) => w !== '')) {
    const p = programName(word);
    if (!p) {
      return `${word} is not a program name (LIB/PGM)`;
    }
    out.push(p);
  }
  return out;
}

/** **Attach to Job…**: the programs to debug in the job, then an `attach` session. */
export async function attachToJob(connection: string, job: SessionJob, state: vscode.Memento): Promise<boolean> {
  const qualified = `${job.number}/${job.user}/${job.name}`;
  const remembered = state.get<Record<string, string>>(ATTACH_PROGRAMS_KEY, {});
  const typed = await vscode.window.showInputBox({
    title: `Attach to ${qualified}`,
    prompt: 'Programs to debug in the job (LIB/PGM), separated by commas or blanks. Breakpoints are set in their sources.',
    value: remembered[connection.toUpperCase()] ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const p = parsePrograms(v);
      return typeof p === 'string' ? p : undefined;
    },
  });
  if (typed === undefined) {
    return false;
  }
  const programs = parsePrograms(typed) as string[];
  await state.update(ATTACH_PROGRAMS_KEY, { ...remembered, [connection.toUpperCase()]: programs.join(', ') });
  return vscode.debug.startDebugging(undefined, {
    type: DEBUG_TYPE,
    request: 'attach',
    name: `Attach to ${qualified}`,
    connection,
    job: qualified,
    programs,
  });
}

/** What the debug commands need from the window. */
export interface DebugCommandDeps {
  store: ConnectionStore;
  sessions: SessionManager;
  projects: ProjectStore;
  source: DebugSourceDeps;
  /** A project's local file as what it deploys to; Phase 8's resolver. */
  local: (uri: vscode.Uri) => Promise<LocalTarget | string | undefined>;
  /** The compile that applies to a target, by name. */
  compileFor: (arg: vscode.Uri) => Promise<string | undefined>;
  /** Runs an action, its resolved command rewritten. */
  run: (arg: vscode.Uri, action: string, rewrite?: (command: string) => string) => Promise<RunResult | undefined>;
  /** Starts a session; `vscode.debug.startDebugging` but for the tests. */
  startDebugging?: (config: vscode.DebugConfiguration) => Thenable<boolean>;
  /** A notification with one button; the button's label when it was pressed. */
  ask?: (kind: 'error' | 'info', message: string, button: string) => Thenable<string | undefined>;
}

type Mode = 'call' | 'serviceEntry';

/** What a debug command was handed: an Objects view node, a Project view file, a URI, or nothing (the active editor). */
type DebugArg = vscode.Uri | { kind?: string; connection?: string; entry?: { library: string; object: string; type: string }; folder?: vscode.Uri; rel?: string } | undefined;

/**
 * **Debug (Call)** and **Debug (Service entry)** on a program in the
 * Objects view, on a member's editor, and on a project's local file
 * (deployed first, compiled when the program is older than its source),
 * and the `CPF9C15` recompile.
 */
export class DebugCommands {
  constructor(private readonly deps: DebugCommandDeps) {}

  register(): vscode.Disposable[] {
    const update = () => void this.updateContext(vscode.window.activeTextEditor?.document.uri);
    update();
    return [
      vscode.commands.registerCommand('code-for-qs400.debug.call', (arg?: DebugArg) => this.debug(arg, 'call')),
      vscode.commands.registerCommand('code-for-qs400.debug.serviceEntry', (arg?: DebugArg) => this.debug(arg, 'serviceEntry')),
      vscode.window.onDidChangeActiveTextEditor(update),
      this.deps.sessions.onDidChange(update),
    ];
  }

  private ask(kind: 'error' | 'info', message: string, button: string): Thenable<string | undefined> {
    if (this.deps.ask) {
      return this.deps.ask(kind, message, button);
    }
    return kind === 'error' ? vscode.window.showErrorMessage(message, button) : vscode.window.showInformationMessage(message, button);
  }

  private start(config: vscode.DebugConfiguration): Thenable<boolean> {
    return (this.deps.startDebugging ?? ((c) => vscode.debug.startDebugging(undefined, c)))(config);
  }

  /** The editor title shows the commands for a member whose program is in the current library, or a project's file. */
  async updateContext(uri: vscode.Uri | undefined): Promise<boolean> {
    let on = false;
    if (uri?.scheme === 'file') {
      on = (await programOfDocument(uri, this.deps.sessions, this.deps.projects)) !== undefined;
    } else if (uri?.scheme === MEMBER_SCHEME && parseMemberUri(uri)?.kind === 'member') {
      const p = await programOfDocument(uri, this.deps.sessions, this.deps.projects);
      on = p !== undefined && (await this.programExists(p.connection, p.program));
    }
    await vscode.commands.executeCommand('setContext', DEBUGGABLE_KEY, on);
    return on;
  }

  private async programExists(connection: string, program: string): Promise<boolean> {
    const [library, object] = program.split('/');
    if (library.startsWith('*') || this.deps.sessions.status(connection).state !== 'connected') {
      return false;
    }
    try {
      const list = await this.deps.sessions.call(connection, 'object.list', { name: connection, library, pattern: object, types: ['*PGM'] });
      return list.some((o) => o.object.toUpperCase() === object);
    } catch {
      return false;
    }
  }

  /** The connection and program a command was handed, a local file deployed and compiled first. */
  async program(arg: DebugArg): Promise<{ connection: string; program: string } | undefined> {
    if (arg && !(arg instanceof vscode.Uri) && arg.kind === 'object' && arg.entry && arg.connection) {
      const p = programOfEntry(arg.entry);
      return p ? { connection: this.deps.store.get(arg.connection)?.name ?? arg.connection, program: p } : undefined;
    }
    const uri =
      arg instanceof vscode.Uri
        ? arg
        : arg?.kind === 'file' && arg.folder && arg.rel
          ? vscode.Uri.joinPath(arg.folder, arg.rel)
          : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      return undefined;
    }
    if (uri.scheme === 'file') {
      return this.localProgram(uri);
    }
    return programOfDocument(uri, this.deps.sessions, this.deps.projects);
  }

  /** A project's file: deployed, compiled when its program is older than the member (or missing), then its program. */
  private async localProgram(uri: vscode.Uri): Promise<{ connection: string; program: string } | undefined> {
    const lt = await this.deps.local(uri);
    if (typeof lt === 'string' || !lt || lt.target.environment !== 'member' || !lt.library) {
      void vscode.window.showErrorMessage(`QS/400 debug: ${typeof lt === 'string' ? lt : `${vscode.workspace.asRelativePath(uri)} is not a member of a library project`}.`);
      return undefined;
    }
    const t = lt.target;
    const connection = t.connection;
    const library = lt.library;
    const deployed = await lt.deploy();
    if (deployed !== true) {
      void vscode.window.showErrorMessage(`QS/400 debug: ${vscode.workspace.asRelativePath(uri)} was not deployed: ${deployed}.`);
      return undefined;
    }
    if (await this.programOlder(connection, library, t.file, t.member)) {
      const name = await this.deps.compileFor(uri);
      if (!name) {
        void vscode.window.showErrorMessage(`QS/400 debug: no compile applies to ${vscode.workspace.asRelativePath(uri)}.`);
        return undefined;
      }
      const r = await this.deps.run(uri, name);
      if (r?.outcome?.status !== 'Ok') {
        return undefined;
      }
    }
    return { connection, program: `${library}/${t.member}` };
  }

  /** Whether `LIB/MEMBER` the program is missing or changed before its member. */
  async programOlder(connection: string, library: string, file: string, member: string): Promise<boolean> {
    try {
      const [objects, members] = await Promise.all([
        this.deps.sessions.call(connection, 'object.list', { name: connection, library, pattern: member, types: ['*PGM'] }),
        this.deps.sessions.call(connection, 'member.list', { name: connection, library, file, pattern: member }),
      ]);
      const o = objects.find((x) => x.object.toUpperCase() === member);
      const m = members.find((x) => x.member.toUpperCase() === member);
      return !o || (m !== undefined && o.changed < m.changed);
    } catch {
      return true;
    }
  }

  async debug(arg: DebugArg, mode: Mode): Promise<boolean> {
    let p: { connection: string; program: string } | undefined;
    try {
      p = await this.program(arg);
    } catch (err) {
      void vscode.window.showErrorMessage(`QS/400 debug: ${errorText(err)}`);
      return false;
    }
    if (!p) {
      if (arg === undefined && !vscode.window.activeTextEditor) {
        void vscode.window.showInformationMessage('Open a member or a project file, or pick a program in the Objects view, to debug it.');
      }
      return false;
    }
    const config: vscode.DebugConfiguration =
      mode === 'call'
        ? { type: DEBUG_TYPE, request: 'launch', name: `Call ${p.program}`, connection: p.connection, program: p.program, parameters: [] }
        : { type: DEBUG_TYPE, request: 'launch', name: `Service entry ${p.program}`, connection: p.connection, mode: 'serviceEntry', program: p.program, user: '*CURRENT' };
    return this.start(config);
  }

  /**
   * A start refused with `CPF9C15`: the server's text with **Recompile with
   * DBGVIEW(*SOURCE)**, which runs the source's default compile with the
   * option forced, then **Start again**.
   */
  async noDebugData(config: vscode.DebugConfiguration, message: string): Promise<boolean> {
    if ((await this.ask('error', `QS/400 debug: ${message}`, RECOMPILE)) !== RECOMPILE) {
      return false;
    }
    return this.recompile(config);
  }

  /** The recompile, and the offer to start again. */
  async recompile(config: vscode.DebugConfiguration): Promise<boolean> {
    const connection = String(config.connection);
    const program = String(config.program);
    const name = program.split('/')[1] ?? program;
    const src = await resolveDebugSource(this.deps.source, connection, program, name);
    if (!src) {
      void vscode.window.showErrorMessage(`QS/400 debug: ${program} names no source member to compile again.`);
      return false;
    }
    let uri = /^[a-z][\w+.-]+:/i.test(src.path) && !/^[a-z]:[\\/]/i.test(src.path) ? vscode.Uri.parse(src.path) : vscode.Uri.file(src.path);
    if (uri.scheme === MEMBER_SCHEME) {
      uri = writableUri(uri);
    }
    const action = await this.deps.compileFor(uri);
    if (!action) {
      void vscode.window.showErrorMessage(`QS/400 debug: no compile applies to ${src.name}.`);
      return false;
    }
    const r = await this.deps.run(uri, action, withDebugView);
    if (r?.outcome?.status !== 'Ok') {
      return false;
    }
    if ((await this.ask('info', `${program} compiled with DBGVIEW(*SOURCE).`, START_AGAIN)) !== START_AGAIN) {
      return false;
    }
    return this.start(restartable(config));
  }
}

/** The configuration as it was asked for: what the provider added is added again. */
export function restartable(config: vscode.DebugConfiguration): vscode.DebugConfiguration {
  const rest: vscode.DebugConfiguration = { ...config };
  for (const k of ['command', 'recompileOffer', '__qs400Credentials', 'qs400']) {
    delete rest[k];
  }
  return rest;
}

/** Whether a launch response is the `CPF9C15` refusal, and its text. */
export function noDebugDataOf(m: unknown): string | undefined {
  const r = m as { type?: string; command?: string; success?: boolean; message?: string; body?: { error?: { variables?: { messageId?: string } } } };
  return r.type === 'response' && r.command === 'launch' && r.success === false && r.body?.error?.variables?.messageId === NO_DEBUG_DATA ? r.message : undefined;
}
