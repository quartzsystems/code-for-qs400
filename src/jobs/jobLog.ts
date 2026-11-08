// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { sameName } from '../connections/config';
import { showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { JobLogEntry, JobLogResult, SessionJob } from '../host/protocol';
import { jobText, timestamp } from '../actions/output';
import { GLYPHS, Glyph, glyphLines } from './model';

/** The scheme job logs open on: read-only, being a content provider's. */
export const JOBLOG_SCHEME = 'qs400joblog';

/** Where the ID starts on each line: after `YYYY-MM-DD HH:MM:SS` and two spaces. */
export const ID_COLUMN = 21;

/** The width the ID column is padded to: a message ID's seven characters. */
const ID_WIDTH = 7;

/**
 * `qs400joblog://<connection>/Job log 123456∕QUSER∕QAPCNN?job=123456/QUSER/QAPCNN`.
 * The tab shows the last path segment, so the job's slashes in the name are
 * U+2215 (∕), which the editor does not split on; the job itself is the
 * query's, in plain ASCII.
 */
export function jobLogUri(connection: string, job: SessionJob): vscode.Uri {
  const shown = jobText(job).replace(/\//g, '∕');
  return vscode.Uri.from({ scheme: JOBLOG_SCHEME, authority: connection, path: `/Job log ${shown}`, query: `job=${jobText(job)}` });
}

/** The connection and job a job log URI names. */
export function parseJobLogUri(uri: vscode.Uri): { connection: string; job: SessionJob } | undefined {
  const m = /^job=(\d{6})\/([^/]+)\/([^/]+)$/.exec(uri.query);
  if (uri.scheme !== JOBLOG_SCHEME || !uri.authority || !m) {
    return undefined;
  }
  return { connection: uri.authority, job: { number: m[1], user: m[2], name: m[3] } };
}

/** One line per entry, `time  ID  text`, oldest first, so the newest is at the bottom. */
export function jobLogLines(entries: JobLogEntry[]): string[] {
  return entries.map((e) => `${timestamp(new Date(e.sent))}  ${e.id.padEnd(ID_WIDTH)}  ${e.text.replace(/\s*\r?\n\s*/g, ' ')}`);
}

/** The hover of an entry: its ID, severity and type, its text and its second-level text. */
export function entryHover(e: JobLogEntry): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**');
  md.appendText(e.id || 'Message');
  md.appendMarkdown('**');
  md.appendText(` · severity ${e.severity} · ${e.kind} · ${e.fromProgram || '?'} → ${e.toProgram || '?'}`);
  md.appendMarkdown('\n\n');
  md.appendText(e.text);
  if (e.secondLevel) {
    md.appendMarkdown('\n\n');
    md.appendText(e.secondLevel);
  }
  return md;
}

/**
 * **Job log**: a read-only document of any job's log, built from
 * `jobs.log` drained whole (the connection job's when no job is named),
 * with a hover on each message ID and each entry's kind as a glyph in the
 * gutter. **Refresh** in the editor title reads it again. The Jobs view's
 * **Job log**, the output channel's `Job log: Show` and Phase 4's
 * **Job Log** command all open it.
 */
export class JobLogProvider implements vscode.TextDocumentContentProvider, vscode.HoverProvider, vscode.Disposable {
  private readonly logs = new Map<string, JobLogResult>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly glyphs = new Map<Glyph, vscode.TextEditorDecorationType>();

  /** `media` is the folder of the gutter glyphs; without it there are none (the tests). */
  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    media?: vscode.Uri,
  ) {
    if (media) {
      for (const g of GLYPHS) {
        this.glyphs.set(g, vscode.window.createTextEditorDecorationType({ gutterIconPath: vscode.Uri.joinPath(media, `joblog-${g}.svg`), gutterIconSize: 'contain' }));
      }
    }
  }

  /**
   * Reads the log again; the result is what the document shows next. Without
   * a job it is the connection job's, as the session names it.
   */
  async read(connection: string, job?: SessionJob): Promise<{ uri: vscode.Uri; log: JobLogResult }> {
    const name = this.store.get(connection)?.name ?? connection;
    const which = job ?? this.sessions.status(name).job;
    const log: JobLogResult = which
      ? { job: which, entries: await this.sessions.call(name, 'jobs.log', { name, job: which }) }
      : await this.sessions.call(name, 'job.log', { name });
    const uri = jobLogUri(name, log.job);
    this.logs.set(uri.toString(), log);
    return { uri, log };
  }

  /** The entries the document `uri` shows. */
  entries(uri: vscode.Uri): JobLogEntry[] | undefined {
    return this.logs.get(uri.toString())?.entries;
  }

  /** Puts each entry's glyph in the gutter of the job log editors shown. */
  decorate(editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void {
    if (this.glyphs.size === 0) {
      return;
    }
    for (const ed of editors) {
      const entries = ed.document.uri.scheme === JOBLOG_SCHEME ? this.entries(ed.document.uri) : undefined;
      if (!entries) {
        continue;
      }
      for (const [g, lines] of glyphLines(entries)) {
        const type = this.glyphs.get(g);
        if (type) {
          ed.setDecorations(
            type,
            lines.filter((l) => l < ed.document.lineCount).map((l) => new vscode.Range(l, 0, l, 0)),
          );
        }
      }
    }
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let log = this.logs.get(uri.toString());
    if (!log) {
      const p = parseJobLogUri(uri);
      if (!p) {
        return '';
      }
      try {
        log = (await this.read(p.connection, p.job)).log;
      } catch (err) {
        void showError(err, p.connection);
        return '';
      }
    }
    return jobLogLines(log.entries).join('\n') + '\n';
  }

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const e = this.logs.get(doc.uri.toString())?.entries[pos.line];
    if (!e || !e.id || pos.character < ID_COLUMN || pos.character > ID_COLUMN + e.id.length) {
      return undefined;
    }
    return new vscode.Hover(entryHover(e), new vscode.Range(pos.line, ID_COLUMN, pos.line, ID_COLUMN + e.id.length));
  }

  /**
   * Opens the job log of `job` on `connection`: the connection job's when no
   * job is named, the active connection's when no connection is.
   */
  async open(connection?: string, job?: SessionJob): Promise<vscode.TextDocument | undefined> {
    const signedOn = this.sessions.signedOn();
    const name =
      (typeof connection === 'string' && connection) ||
      (this.sessions.active && signedOn.some((s) => sameName(s.name, this.sessions.active as string)) ? this.sessions.active : undefined) ||
      signedOn[0]?.name;
    if (!name) {
      void vscode.window.showInformationMessage('Connect to a system to see its job log.');
      return undefined;
    }
    try {
      const { uri } = await this.read(name, job);
      this.changed.fire(uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      this.decorate([ed]);
      return doc;
    } catch (err) {
      void showError(err, name);
      return undefined;
    }
  }

  /** Reads the log of the document `uri` (the active editor's when absent) again. */
  async refresh(uri?: vscode.Uri): Promise<void> {
    const u = uri ?? vscode.window.activeTextEditor?.document.uri;
    const p = u ? parseJobLogUri(u) : undefined;
    if (!u || !p) {
      return;
    }
    try {
      await this.read(p.connection, p.job);
      this.changed.fire(u);
    } catch (err) {
      void showError(err, p.connection);
    }
  }

  register(): vscode.Disposable[] {
    return [
      this,
      vscode.workspace.registerTextDocumentContentProvider(JOBLOG_SCHEME, this),
      vscode.languages.registerHoverProvider({ scheme: JOBLOG_SCHEME }, this),
      vscode.commands.registerCommand('code-for-qs400.job.log', (connection?: string, job?: SessionJob) => this.open(connection, job)),
      vscode.commands.registerCommand('code-for-qs400.job.logRefresh', (uri?: vscode.Uri) => this.refresh(uri)),
      vscode.window.onDidChangeVisibleTextEditors((eds) => this.decorate(eds)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === JOBLOG_SCHEME) {
          this.decorate();
        }
      }),
    ];
  }

  dispose(): void {
    this.changed.dispose();
    for (const t of this.glyphs.values()) {
      t.dispose();
    }
  }
}
