// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * **Run Statement**: the selection, else the statement under the cursor,
 * else the whole document statement by statement, stopping at the first
 * error. The statements are the SQL language server's
 * (`qs400/sqlStatements`); a document it has no answer for is split here
 * by the same rule (`statements.ts`). Each run is one `sql.run`; its error
 * goes to the Problems panel on the statement's first line, cleared at the
 * document's next run. **New SQL Editor** opens an untitled `qs400-sql`
 * document on the active connection.
 */

import * as vscode from 'vscode';
import { pickConnection } from '../commands/connection';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { HostClient, HostRpcError } from '../host/client';
import type { SqlErrorData, SqlRunResult } from '../host/protocol';
import type { SqlStatementRange } from '../languages/protocol';
import { firstLine, outcomeText } from './format';
import { SqlSessions, isSqlDocument } from './session';
import { type Span, splitStatements, statementAt } from './statements';

/** One statement run, whatever its outcome. */
export interface SqlRun {
  id: string;
  connection: string;
  sql: string;
  /** The document it came from, and its first line (from 0); none for a run from elsewhere. */
  uri?: vscode.Uri;
  line?: number;
  started: number;
  /** Milliseconds. */
  elapsed: number;
  result?: SqlRunResult;
  error?: { message: string; data?: SqlErrorData };
}

/** Asks the SQL server for a document's statements; undefined when it has no answer. */
export type StatementSource = (doc: vscode.TextDocument) => Promise<SqlStatementRange[] | null | undefined>;

/** The Problems entry of a failed run. */
export function runDiagnostic(doc: vscode.TextDocument, line: number, error: NonNullable<SqlRun['error']>): vscode.Diagnostic {
  const range = doc.lineAt(Math.min(line, doc.lineCount - 1)).range;
  const text = error.data?.text ?? error.message;
  const d = new vscode.Diagnostic(range, text, vscode.DiagnosticSeverity.Error);
  d.source = 'SQL';
  if (error.data?.messageId) {
    d.code = error.data.messageId;
  }
  if (error.data?.secondLevel) {
    d.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(doc.uri, range), error.data.secondLevel)];
  }
  return d;
}

export class SqlRunner implements vscode.Disposable {
  readonly diagnostics = vscode.languages.createDiagnosticCollection('code-for-qs400-sql');
  private readonly ran = new vscode.EventEmitter<SqlRun>();
  private next = 0;
  private readonly running = new Set<string>();

  /** Fires after each statement ran, failed or was cancelled. */
  readonly onDidRun = this.ran.event;

  constructor(
    private readonly host: HostClient,
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly sql: SqlSessions,
    private readonly statements: StatementSource,
  ) {}

  /** The statements of `doc`: the server's, else split here. */
  async spans(doc: vscode.TextDocument): Promise<Span[]> {
    const text = doc.getText();
    if (doc.languageId === 'qs400-sql') {
      try {
        const ranges = await Promise.race([
          this.statements(doc),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000)),
        ]);
        if (ranges && (ranges.length > 0 || text.trim() === '')) {
          return ranges.map((r) => ({
            start: doc.offsetAt(new vscode.Position(r.range.start.line, r.range.start.character)),
            end: doc.offsetAt(new vscode.Position(r.range.end.line, r.range.end.character)),
          }));
        }
      } catch {
        // The server is not there: split here.
      }
    }
    return splitStatements(text);
  }

  /** What Run Statement runs in `editor`, in order. */
  async scope(editor: vscode.TextEditor): Promise<Span[]> {
    const doc = editor.document;
    const sel = editor.selection;
    if (!sel.isEmpty) {
      const base = doc.offsetAt(sel.start);
      return splitStatements(doc.getText(sel)).map((s) => ({ start: s.start + base, end: s.end + base }));
    }
    const all = await this.spans(doc);
    const at = statementAt(doc.getText(), all, doc.offsetAt(sel.active));
    return at ? [at] : all;
  }

  /** The connection to run on, signed on: the document's, else one picked. */
  private async connectionFor(doc: vscode.TextDocument): Promise<string | undefined> {
    let name = this.sql.connectionOf(doc);
    if (!name) {
      const c = await pickConnection(this.store, this.sessions, undefined, 'Connection to run the SQL on');
      if (!c) {
        return undefined;
      }
      name = c.name;
      this.sql.bind(doc, name);
    }
    const st = this.sessions.status(name).state;
    if (st === 'disconnected') {
      if (!(await this.sessions.connect(name))) {
        return undefined;
      }
    }
    return name;
  }

  /** Run Statement in `editor`. Returns every run, for tests. */
  async runEditor(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): Promise<SqlRun[]> {
    if (!editor || !isSqlDocument(editor.document)) {
      void vscode.window.showErrorMessage('Code for QS/400: Run Statement needs an SQL editor.');
      return [];
    }
    const doc = editor.document;
    const spans = await this.scope(editor);
    if (spans.length === 0) {
      void vscode.window.showInformationMessage('Code for QS/400: no statement to run.');
      return [];
    }
    const name = await this.connectionFor(doc);
    if (!name) {
      return [];
    }
    this.diagnostics.delete(doc.uri);
    const runs: SqlRun[] = [];
    const problems: vscode.Diagnostic[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `SQL on ${name}` }, async (p) => {
      for (const s of spans) {
        const text = doc.getText(new vscode.Range(doc.positionAt(s.start), doc.positionAt(s.end)));
        const line = doc.positionAt(s.start).line;
        p.report({ message: firstLine(text, 40) });
        const r = await this.run(name, text, { uri: doc.uri, line });
        runs.push(r);
        if (r.error) {
          problems.push(runDiagnostic(doc, line, r.error));
          this.diagnostics.set(doc.uri, problems);
          break;
        }
      }
    });
    return runs;
  }

  /** One statement on `name`, from anywhere (a document, the history, View data). */
  async run(name: string, sql: string, from: { uri?: vscode.Uri; line?: number } = {}): Promise<SqlRun> {
    const id = `s${++this.next}`;
    const started = Date.now();
    const run: SqlRun = { id, connection: name, sql, uri: from.uri, line: from.line, started, elapsed: 0 };
    this.running.add(id);
    try {
      run.result = await this.sessions.call(name, 'sql.run', { name, sql, maxRows: 500, run: id });
      this.sql.noteUncommitted(name, run.result.uncommitted);
    } catch (err) {
      run.error =
        err instanceof HostRpcError
          ? { message: err.message, data: err.data as SqlErrorData | undefined }
          : { message: err instanceof Error ? err.message : String(err) };
      if (run.error.data?.messageId === undefined) {
        void vscode.window.showErrorMessage(`Code for QS/400: ${name}: ${run.error.message}`);
      }
    } finally {
      this.running.delete(id);
      run.elapsed = Date.now() - started;
    }
    this.ran.fire(run);
    vscode.window.setStatusBarMessage(`${name}: ${run.result ? outcomeText(run.result) : (run.error?.data?.messageId ?? 'failed')}`, 4000);
    return run;
  }

  /** Asks every statement running to stop. */
  async cancel(): Promise<number> {
    const ids = [...this.running];
    for (const id of ids) {
      try {
        await this.host.request('sql.cancel', { id });
      } catch {
        // It ended meanwhile.
      }
    }
    return ids.length;
  }

  /** New SQL Editor: an untitled `qs400-sql` document on `connection`, else the active one. */
  async newEditor(content = '', connection?: string): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument({ language: 'qs400-sql', content });
    const name =
      connection ?? this.sessions.active ?? (await pickConnection(this.store, this.sessions, undefined, 'Connection for the SQL editor'))?.name;
    if (name) {
      this.sql.bind(doc, name);
    }
    return vscode.window.showTextDocument(doc);
  }

  register(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('code-for-qs400.sql.run', () => this.runEditor()),
      vscode.commands.registerCommand('code-for-qs400.sql.cancel', () => this.cancel()),
      vscode.commands.registerCommand('code-for-qs400.sql.newEditor', () => this.newEditor()),
    ];
  }

  dispose(): void {
    this.diagnostics.dispose();
    this.ran.dispose();
  }
}
