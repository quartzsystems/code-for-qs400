// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorText } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { CommandMessage } from '../host/protocol';
import {
  Action,
  ActionProblem,
  Span,
  mergeActions,
  parseActions,
  parseActionsText,
  withSource,
} from './model';
import { ConnectionValues, sampleValue, substitute, unknownVariables } from './variables';

/** The workspace file of a folder's actions. */
export const WORKSPACE_ACTIONS = '.vscode/actions.json';

/** The diagnostic collection `actions.json` checks go to. */
export const ACTIONS_DIAGNOSTICS = 'code-for-qs400-actions';

/** Whether a document is an `actions.json` of a `.vscode` folder. */
export function isActionsFile(uri: vscode.Uri): boolean {
  return /(^|\/)\.vscode\/actions\.json$/i.test(uri.path);
}

/** A connection's user, host and custom variables. */
export function connectionValues(store: ConnectionStore, sessions: SessionManager, name: string): ConnectionValues {
  const c = store.get(name);
  return {
    user: sessions.status(name).user ?? c?.user ?? '',
    host: c?.host ?? '',
    custom: c?.variables ?? {},
  };
}

interface Layer {
  /** The file, as a URI string. */
  file: string;
  label: string;
  actions: Action[];
}

/**
 * The actions in effect for each connection: the defaults shipped with the
 * extension, then each workspace folder's `.vscode/actions.json` (later
 * folders override earlier ones by name), then the connection's own
 * `actions`. Saving an `actions.json` checks every command with
 * `CheckCommand` on the active connection, with sample values for its
 * variables, and puts the server's messages on the command's line.
 */
export class ActionStore implements vscode.Disposable {
  private defaults: Layer | undefined;
  private workspace: Layer[] = [];
  /** Problems found in a file or connection, by file URI or `connection:<name>`: reported once. */
  private readonly reported = new Map<string, string>();
  /** What the last check of a file found, by file URI string, then by index. */
  private readonly marks = new Map<string, Map<number, string>>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly diagnostics = vscode.languages.createDiagnosticCollection(ACTIONS_DIAGNOSTICS);
  /** Settles when the files have been read. */
  ready: Promise<void>;

  /** Fires when the actions in effect may have changed. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly extensionPath: string,
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly output: vscode.LogOutputChannel,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${WORKSPACE_ACTIONS}`);
    const reload = () => void this.reloadWorkspace();
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate(reload),
      watcher.onDidChange(reload),
      watcher.onDidDelete(reload),
      vscode.workspace.onDidChangeWorkspaceFolders(reload),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (isActionsFile(doc.uri)) {
          void this.validate(doc);
        }
      }),
      store.onDidChange(() => this.changed.fire()),
    );
    this.ready = Promise.all([this.loadDefaults(), this.reloadWorkspace()]).then(() => undefined);
  }

  private async read(uri: vscode.Uri, label: string, kind: 'default' | 'workspace'): Promise<Layer | undefined> {
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
    const parsed = parseActionsText(text);
    const { entries, problems } = parseActions(parsed.value ?? [], label);
    const all = [...parsed.syntax.map((s) => `${label}: ${s.message} at offset ${s.offset}`), ...problems.map((p) => p.message)];
    this.report(uri.toString(), all);
    return { file: uri.toString(), label, actions: withSource(entries, { kind, label, file: uri.toString() }) };
  }

  private report(key: string, problems: string[]): void {
    const text = problems.join('\n');
    if (this.reported.get(key) !== text) {
      this.reported.set(key, text);
      for (const p of problems) {
        this.output.warn(`actions: ${p}`);
      }
    }
  }

  private async loadDefaults(): Promise<void> {
    const uri = vscode.Uri.file(path.join(this.extensionPath, 'defaults', 'actions.json'));
    this.defaults = await this.read(uri, 'default', 'default');
    this.changed.fire();
  }

  /** Reads every workspace folder's `.vscode/actions.json` again. */
  async reloadWorkspace(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const layers = await Promise.all(
      folders.map((f) => this.read(vscode.Uri.joinPath(f.uri, WORKSPACE_ACTIONS), f.name, 'workspace')),
    );
    this.workspace = layers.filter((l): l is Layer => l !== undefined);
    this.changed.fire();
  }

  /** The connection's own actions. */
  private connectionActions(name: string): Action[] {
    const c = this.store.get(name);
    if (!c?.actions) {
      return [];
    }
    const label = `connection ${c.name}`;
    const { entries, problems } = parseActions(c.actions, label);
    this.report(`connection:${c.name}`, problems.map((p) => p.message));
    return withSource(entries, { kind: 'connection', label: c.name });
  }

  /** The actions in effect on connection `name`, in order. */
  actions(name: string | undefined): Action[] {
    return mergeActions([
      this.defaults?.actions ?? [],
      ...this.workspace.map((l) => l.actions),
      name ? this.connectionActions(name) : [],
    ]);
  }

  /** What the last check of the action's file found wrong with it, if anything. */
  mark(a: Action): string | undefined {
    return a.source.file ? this.marks.get(a.source.file)?.get(a.source.index) : undefined;
  }

  /**
   * Checks an `actions.json`: its JSON, each action's fields and variables,
   * and each command through `CheckCommand` on the active connection with
   * sample values. Nothing is run. The findings go to `diagnostics`, each on
   * its command's line (or its entry's), and mark the actions.
   */
  async validate(doc: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    const text = doc.getText();
    const parsed = parseActionsText(text);
    const range = (s: Span | undefined) =>
      s ? new vscode.Range(doc.positionAt(s.offset), doc.positionAt(s.offset + s.length)) : new vscode.Range(0, 0, 0, 0);
    const out: vscode.Diagnostic[] = [];
    const marks = new Map<number, string>();
    const add = (r: vscode.Range, message: string, severity = vscode.DiagnosticSeverity.Error, index?: number) => {
      const d = new vscode.Diagnostic(r, message, severity);
      d.source = 'Code for QS/400';
      out.push(d);
      if (index !== undefined && severity === vscode.DiagnosticSeverity.Error && !marks.has(index)) {
        marks.set(index, message);
      }
      return d;
    };
    for (const s of parsed.syntax) {
      add(range(s), s.message);
    }
    const label = path.basename(path.dirname(path.dirname(doc.uri.path))) || 'actions.json';
    const { entries, problems } = parseActions(parsed.value ?? [], label);
    for (const p of problems as ActionProblem[]) {
      add(range(p.index === undefined ? undefined : parsed.elements[p.index]), p.message, vscode.DiagnosticSeverity.Error, p.index);
    }
    const name = this.sessions.active;
    const signedOn = name !== undefined && this.sessions.signedOn().some((s) => s.name === name);
    const checkable = entries.filter((e) => {
      const unknown = unknownVariables(e.command);
      if (unknown.length > 0) {
        add(range(parsed.commands[e.index]), `${unknown.join(', ')}: not a variable`, vscode.DiagnosticSeverity.Error, e.index);
        return false;
      }
      return true;
    });
    if (!signedOn && checkable.length > 0) {
      add(
        range(parsed.commands[checkable[0].index]),
        'Commands not checked with CheckCommand: no connection is signed on.',
        vscode.DiagnosticSeverity.Information,
      );
    }
    if (signedOn && name) {
      const values = connectionValues(this.store, this.sessions, name);
      for (const e of checkable) {
        const sample = substitute(e.command, (v) => sampleValue(v, e.environment, e.extensions, values));
        if (!sample.ok) {
          continue;
        }
        const r = range(parsed.commands[e.index]);
        try {
          const result = await this.sessions.call(name, 'action.check', { name, command: sample.command });
          if (!result.valid) {
            const messages: CommandMessage[] =
              result.messages.length > 0 ? result.messages : [{ id: '', severity: 30, text: `CheckCommand: ${result.status}` }];
            for (const m of messages) {
              const d = add(r, m.text, vscode.DiagnosticSeverity.Error, e.index);
              if (m.id) {
                d.code = m.id;
              }
              if (m.secondLevel) {
                d.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(doc.uri, r), m.secondLevel)];
              }
            }
          }
        } catch (err) {
          add(r, `Not checked: ${errorText(err, name)}`, vscode.DiagnosticSeverity.Warning);
        }
      }
    }
    this.diagnostics.set(doc.uri, out);
    this.marks.set(doc.uri.toString(), marks);
    if (isActionsFile(doc.uri)) {
      await this.reloadWorkspace();
    }
    this.changed.fire();
    return out;
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.diagnostics.dispose();
    this.changed.dispose();
  }
}
