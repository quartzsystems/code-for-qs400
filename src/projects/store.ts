// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { applyEdits, modify } from 'jsonc-parser';
import * as vscode from 'vscode';
import { Action, parseActions, withSource } from '../actions/model';
import { unknownVariables } from '../actions/variables';
import { ConnectionStore } from '../connections/store';
import {
  PROJECT_FILE,
  STATE_DIR,
  STATE_FILE,
  ProjectConfig,
  ProjectProblem,
  isIgnored,
  parseProjectText,
  projectText,
  sortedTexts,
} from './config';
import { ProjectState, parseState, stateText } from './state';

/** The diagnostic collection `qs400project.json` checks go to. */
export const PROJECT_DIAGNOSTICS = 'code-for-qs400-project';

/** A workspace folder with a `qs400project.json`. */
export interface Project {
  folder: vscode.WorkspaceFolder;
  /** The project file. */
  file: vscode.Uri;
  /** Undefined when the file cannot be used; `problems` says why. */
  config?: ProjectConfig;
  problems: ProjectProblem[];
}

/** Whether a URI is a folder's `qs400project.json`. */
export function isProjectFile(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && nodePath.basename(uri.fsPath) === PROJECT_FILE;
}

/** A path relative to the folder, `/`-separated. */
export function relativeTo(folder: vscode.Uri, uri: vscode.Uri): string | undefined {
  const rel = nodePath.relative(folder.fsPath, uri.fsPath);
  if (rel === '' || rel.startsWith('..') || nodePath.isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(nodePath.sep).join('/');
}

/**
 * The projects of the workspace: each folder whose root has a
 * `qs400project.json`, read on start, when the file changes and when
 * folders change. Saving the file checks it, with its problems in the
 * Problems panel on their places, as `actions.json`'s are.
 */
export class ProjectStore implements vscode.Disposable {
  private list: Project[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly diagnostics = vscode.languages.createDiagnosticCollection(PROJECT_DIAGNOSTICS);
  /** Fires when the projects, or their files' state, may have changed. */
  readonly onDidChange = this.changed.event;
  /** Settles when the files have been read. */
  ready: Promise<void>;

  constructor(
    private readonly connections: ConnectionStore,
    private readonly output: vscode.LogOutputChannel,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${PROJECT_FILE}`);
    const reload = () => void this.reload();
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate(reload),
      watcher.onDidChange(reload),
      watcher.onDidDelete(reload),
      vscode.workspace.onDidChangeWorkspaceFolders(reload),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (isProjectFile(doc.uri)) {
          void this.validate(doc);
        }
      }),
      connections.onDidChange(() => this.changed.fire()),
    );
    this.ready = this.reload();
  }

  /** Every folder with a project file, usable or not, in workspace order. */
  projects(): Project[] {
    return this.list;
  }

  /** The usable projects. */
  usable(): (Project & { config: ProjectConfig })[] {
    return this.list.filter((p): p is Project & { config: ProjectConfig } => p.config !== undefined);
  }

  /** The project a local file is in; undefined for any other URI. */
  projectFor(uri: vscode.Uri): (Project & { config: ProjectConfig }) | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    return this.usable()
      .filter((p) => relativeTo(p.folder.uri, uri) !== undefined)
      .sort((a, b) => b.folder.uri.fsPath.length - a.folder.uri.fsPath.length)[0];
  }

  /** The connection as it is saved, for a project's `connection`. */
  connectionOf(p: { config: ProjectConfig }): string {
    return this.connections.get(p.config.connection)?.name ?? p.config.connection;
  }

  private async read(folder: vscode.WorkspaceFolder): Promise<Project | undefined> {
    const file = vscode.Uri.joinPath(folder.uri, PROJECT_FILE);
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    } catch {
      return undefined;
    }
    const parsed = parseProjectText(text);
    for (const p of parsed.problems) {
      this.output.warn(`${folder.name}/${PROJECT_FILE}: ${p.message}`);
    }
    return { folder, file, config: parsed.config, problems: parsed.problems };
  }

  /** Reads every folder's project file again. */
  async reload(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const read = await Promise.all(folders.filter((f) => f.uri.scheme === 'file').map((f) => this.read(f)));
    this.list = read.filter((p): p is Project => p !== undefined);
    this.changed.fire();
  }

  /** Something about the projects' files changed (a deploy, a pull, a save). */
  touch(): void {
    this.changed.fire();
  }

  /** A project's actions with their source, for Phase 4's merge. */
  actions(p: Project & { config: ProjectConfig }): Action[] {
    const label = `${p.folder.name} project`;
    const { entries } = parseActions(p.config.actions, label);
    return withSource(entries, { kind: 'workspace', label, file: p.file.toString() });
  }

  /**
   * Checks a `qs400project.json`: its JSON, its fields, the connection
   * named, and its actions' fields and variables. Each problem goes on
   * its place.
   */
  async validate(doc: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    const parsed = parseProjectText(doc.getText());
    const range = (s: { offset: number; length: number } | undefined) =>
      s ? new vscode.Range(doc.positionAt(s.offset), doc.positionAt(s.offset + s.length)) : new vscode.Range(0, 0, 0, 0);
    const out: vscode.Diagnostic[] = [];
    const add = (r: vscode.Range, message: string, severity = vscode.DiagnosticSeverity.Error) => {
      const d = new vscode.Diagnostic(r, message, severity);
      d.source = 'Code for QS/400';
      out.push(d);
    };
    for (const p of parsed.problems) {
      add(range(p.span), p.message);
    }
    const c = parsed.config;
    if (c && !this.connections.get(c.connection)) {
      const text = doc.getText();
      const at = text.indexOf(JSON.stringify(c.connection));
      add(
        at >= 0 ? new vscode.Range(doc.positionAt(at), doc.positionAt(at + c.connection.length + 2)) : new vscode.Range(0, 0, 0, 0),
        `No saved connection is named ${c.connection}`,
        vscode.DiagnosticSeverity.Warning,
      );
    }
    if (c) {
      const { entries, problems } = parseActions(c.actions, 'actions');
      for (const p of problems) {
        add(range(p.index === undefined ? undefined : parsed.actionSpans.elements[p.index]), p.message);
      }
      for (const e of entries) {
        const unknown = unknownVariables(e.command);
        if (unknown.length > 0) {
          add(range(parsed.actionSpans.commands[e.index]), `${unknown.join(', ')}: not a variable`);
        }
      }
    }
    this.diagnostics.set(doc.uri, out);
    await this.reload();
    return out;
  }

  /** The state file of a project. */
  stateUri(p: Project): vscode.Uri {
    return vscode.Uri.joinPath(p.folder.uri, STATE_FILE);
  }

  async readState(p: Project): Promise<ProjectState> {
    try {
      return parseState(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.stateUri(p))));
    } catch {
      return parseState(undefined);
    }
  }

  async writeState(p: Project, state: ProjectState): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(p.folder.uri, STATE_DIR));
    await vscode.workspace.fs.writeFile(this.stateUri(p), new TextEncoder().encode(stateText(state)));
    this.changed.fire();
  }

  /**
   * Every file of the project, relative and `/`-separated, sorted;
   * `ignored` beside, for the Project view. Directories the ignore globs
   * cover whole are not walked.
   */
  async files(p: Project & { config: ProjectConfig }): Promise<{ files: string[]; ignored: string[] }> {
    const files: string[] = [];
    const ignored: string[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) {
          // A glob that ignores every name in the directory ignores the directory.
          if (isIgnored(`${r}/\u0001`, p.config.ignore)) {
            continue;
          }
          await walk(nodePath.join(dir, e.name), r);
        } else if (e.isFile()) {
          (isIgnored(r, p.config.ignore) ? ignored : files).push(r);
        }
      }
    };
    await walk(p.folder.uri.fsPath, '');
    const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return { files: files.sort(order), ignored: ignored.filter((f) => f !== PROJECT_FILE && !f.startsWith(`${STATE_DIR}/`)).sort(order) };
  }

  /**
   * Writes a new project file in `folder` (the generator), and keeps
   * `.qs400/` out of git with a line in the folder's `.gitignore`.
   */
  async create(folder: vscode.Uri, config: Parameters<typeof projectText>[0]): Promise<void> {
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, PROJECT_FILE), new TextEncoder().encode(projectText(config)));
    await ensureGitignore(folder.fsPath);
    await this.reload();
  }

  /** Adds `texts` a pull found to a project file that exists, keeping what it gives. */
  async addTexts(p: Project, texts: Record<string, string>): Promise<void> {
    if (Object.keys(texts).length === 0) {
      return;
    }
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(p.file));
    const parsed = parseProjectText(text);
    if (!parsed.config) {
      return;
    }
    const have = new Set(Object.keys(parsed.config.texts).map((k) => k.toUpperCase()));
    const add = Object.fromEntries(Object.entries(texts).filter(([k]) => !have.has(k.toUpperCase())));
    if (Object.keys(add).length === 0) {
      return;
    }
    const merged = sortedTexts({ ...parsed.config.texts, ...add });
    const edits = modify(text, ['texts'], merged, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
    await vscode.workspace.fs.writeFile(p.file, new TextEncoder().encode(applyEdits(text, edits)));
    await this.reload();
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.diagnostics.dispose();
    this.changed.dispose();
  }
}

/** `.qs400/` in the folder's `.gitignore`, the file made when there is none. */
export async function ensureGitignore(folder: string): Promise<void> {
  const file = nodePath.join(folder, '.gitignore');
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    // None yet.
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === `${STATE_DIR}/` || l.trim() === STATE_DIR || l.trim() === `/${STATE_DIR}/`)) {
    return;
  }
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  await fs.writeFile(file, `${text}${sep}${STATE_DIR}/\n`, 'utf8');
}
