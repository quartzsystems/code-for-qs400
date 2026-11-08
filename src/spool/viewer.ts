// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The spooled file viewer: a read-only text document on the `qs400spl`
 * scheme, its text `spool.readText`'s laid out by `layout.ts`, in the
 * `qs400-spool` language (monospace, no word wrap, rulers at 80 and 132).
 * A file under 2000 pages is read whole; a larger one its first 100 pages,
 * with **Load All Pages** in the title bar. Each page's marker line shows
 * `— page n —`; the status bar shows the page under the cursor and **Go
 * to Page…** jumps. This is a text editor, not a webview.
 *
 * `qs400spl://<connection>/QSYSPRT(8) 123456∕QUSER∕QAPCNN?job=…&file=…&number=…`:
 * the tab shows the last path segment, so the job's slashes in the name
 * are U+2215 as in the job log's; the file is the query's.
 */

import * as vscode from 'vscode';
import { sameName } from '../connections/config';
import { showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import type { SpooledFileId } from '../host/protocol';
import { parseQualifiedJob, qualifiedJob } from '../jobs/model';
import type { FileArg, FileRef, SpoolProvider } from '../views/spool';
import { nodeRef } from '../views/spool';
import { LARGE_FILE, Layout, firstRead, layout, markerText, pageAt, pageLine } from './layout';
import { fileTitle, sameFile } from './model';

export const SPOOL_SCHEME = 'qs400spl';

/** The viewer's language: its rulers and no word wrap come from `configurationDefaults`. */
export const SPOOL_LANGUAGE = 'qs400-spool';

/** Set while the active viewer shows only part of its file. */
export const PARTIAL_CONTEXT = 'code-for-qs400.spoolPartial';

export function spoolUri(connection: string, id: SpooledFileId, pages?: number): vscode.Uri {
  const shown = fileTitle(id).replace(/\//g, '∕');
  const q = new URLSearchParams({ job: qualifiedJob(id.job), file: id.file, number: String(id.number) });
  if (pages !== undefined) {
    q.set('pages', String(pages));
  }
  return vscode.Uri.from({ scheme: SPOOL_SCHEME, authority: connection, path: `/${shown}`, query: q.toString() });
}

/** The connection, file and pages (as listed) a viewer URI names. */
export function parseSpoolUri(uri: vscode.Uri): (FileRef & { pages?: number }) | undefined {
  if (uri.scheme !== SPOOL_SCHEME || !uri.authority) {
    return undefined;
  }
  const q = new URLSearchParams(uri.query);
  const job = parseQualifiedJob(q.get('job') ?? '');
  const file = q.get('file');
  const number = Number(q.get('number'));
  if (!job || !file || !Number.isInteger(number) || number < 1) {
    return undefined;
  }
  const pages = q.has('pages') ? Number(q.get('pages')) : undefined;
  return { connection: uri.authority, id: { job, file, number }, pages: Number.isFinite(pages) ? pages : undefined };
}

interface Shown {
  ref: FileRef;
  layout: Layout;
  /** Pages in the whole file. */
  pages: number;
  /** Only the first pages are read. */
  partial: boolean;
}

export class SpoolViewer implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly shown = new Map<string, Shown>();
  /** Documents whose next read is the whole file. */
  private readonly whole = new Set<string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly marker = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    after: { color: new vscode.ThemeColor('editorLineNumber.foreground'), fontStyle: 'italic' },
  });
  private readonly status = vscode.window.createStatusBarItem('code-for-qs400.spoolPage', vscode.StatusBarAlignment.Right, 100);

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly spool?: SpoolProvider,
  ) {
    this.status.name = 'Spooled file page';
    this.status.command = 'code-for-qs400.spool.goToPage';
    this.status.tooltip = 'Go to Page…';
  }

  /** The status bar item's text: the page under the cursor. */
  get statusText(): string {
    return this.status.text;
  }

  /** What `uri`'s document shows, once read. */
  state(uri: vscode.Uri): Readonly<Shown> | undefined {
    return this.shown.get(uri.toString());
  }

  /**
   * The connection's name as saved or signed on: `Uri.toString` lower-cases
   * the authority, as Phase 2 decision 15 says.
   */
  private canonical(connection: string): string {
    return this.store.get(connection)?.name ?? this.sessions.signedOn().find((s) => sameName(s.name, connection))?.name ?? connection;
  }

  /** The file of a viewer URI, for the title bar's commands. */
  refOf(arg: FileArg): FileRef | undefined {
    const uri = arg instanceof vscode.Uri ? arg : arg === undefined ? vscode.window.activeTextEditor?.document.uri : undefined;
    const p = uri ? (this.state(uri)?.ref ?? parseSpoolUri(uri)) : undefined;
    return p ? { connection: this.canonical(p.connection), id: p.id } : undefined;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const p = parseSpoolUri(uri);
    if (!p) {
      return '';
    }
    const name = this.canonical(p.connection);
    const ref: FileRef = { connection: name, id: p.id };
    const key = uri.toString();
    try {
      const all = this.whole.has(key);
      let plan = all ? { lastPage: 0, partial: false } : firstRead(p.pages);
      let read = await this.sessions.call(name, 'spool.readText', { name, id: p.id, ...(plan.lastPage ? { lastPage: plan.lastPage } : {}) });
      if (plan.partial && read.pages <= read.lastPage) {
        plan = { lastPage: 0, partial: false };
      } else if (plan.partial && p.pages === undefined && read.pages < LARGE_FILE) {
        // Opened without the page count (a restored editor): small enough to read whole.
        read = await this.sessions.call(name, 'spool.readText', { name, id: p.id });
        plan = { lastPage: 0, partial: false };
      }
      const l = layout(read.text, 1);
      this.shown.set(key, { ref, layout: l, pages: read.pages, partial: plan.partial });
      return l.text;
    } catch (err) {
      void showError(err, name);
      this.shown.delete(key);
      return '';
    }
  }

  /** Opens `ref` in the viewer. */
  async open(ref: FileRef, pages?: number): Promise<vscode.TextEditor | undefined> {
    const uri = spoolUri(ref.connection, ref.id, pages);
    let doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== SPOOL_LANGUAGE) {
      doc = await vscode.languages.setTextDocumentLanguage(doc, SPOOL_LANGUAGE);
    }
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    this.decorate([ed]);
    this.update();
    return ed;
  }

  /** Reads the file again: all of it after **Load All Pages**. */
  reload(uri: vscode.Uri, all = false): void {
    if (all) {
      this.whole.add(uri.toString());
    }
    this.changed.fire(uri);
  }

  /** The page markers of the viewers shown. */
  decorate(editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void {
    for (const ed of editors) {
      const s = ed.document.uri.scheme === SPOOL_SCHEME ? this.state(ed.document.uri) : undefined;
      if (!s) {
        continue;
      }
      ed.setDecorations(
        this.marker,
        s.layout.markers
          .filter((line) => line < ed.document.lineCount)
          .map((line, i) => ({ range: new vscode.Range(line, 0, line, 0), renderOptions: { after: { contentText: markerText(s.layout.firstPage + i) } } })),
      );
    }
  }

  /** The status bar's page, and whether Load All Pages applies. */
  update(ed: vscode.TextEditor | undefined = vscode.window.activeTextEditor): void {
    const s = ed && ed.document.uri.scheme === SPOOL_SCHEME ? this.state(ed.document.uri) : undefined;
    void vscode.commands.executeCommand('setContext', PARTIAL_CONTEXT, !!s?.partial);
    if (!ed || !s) {
      this.status.hide();
      return;
    }
    const page = pageAt(s.layout, ed.selection.active.line);
    this.status.text = `$(file-text) Page ${page} of ${s.pages}${s.partial ? ` (${s.layout.markers.length} shown)` : ''}`;
    this.status.show();
  }

  /** **Go to Page…**: the cursor to page `page` (asked when absent) of `ed`. */
  async goToPage(ed: vscode.TextEditor | undefined = vscode.window.activeTextEditor, page?: number): Promise<number | undefined> {
    const s = ed && this.state(ed.document.uri);
    if (!ed || !s) {
      return undefined;
    }
    const last = s.layout.firstPage + s.layout.markers.length - 1;
    if (page === undefined) {
      const v = await vscode.window.showInputBox({
        title: fileTitle(s.ref.id),
        prompt: `Page, ${s.layout.firstPage} to ${last}${s.partial ? ` (of ${s.pages}; Load All Pages for the rest)` : ''}`,
        validateInput: (t) => {
          const n = Number(t.trim());
          return Number.isInteger(n) && n >= s.layout.firstPage && n <= last ? undefined : `A page from ${s.layout.firstPage} to ${last}.`;
        },
      });
      if (v === undefined) {
        return undefined;
      }
      page = Number(v.trim());
    }
    const line = pageLine(s.layout, page);
    if (line === undefined) {
      return undefined;
    }
    const at = new vscode.Position(Math.min(line + 1, ed.document.lineCount - 1), 0);
    ed.selection = new vscode.Selection(at, at);
    ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
    this.update(ed);
    return page;
  }

  /** Closes every viewer of `ref` (after a delete). */
  private async closeOf(ref: FileRef): Promise<void> {
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => {
        const input = t.input as { uri?: vscode.Uri } | undefined;
        const p = input?.uri ? parseSpoolUri(input.uri) : undefined;
        return p !== undefined && sameFile(p.id, ref.id);
      });
    if (tabs.length) {
      await vscode.window.tabGroups.close(tabs);
    }
  }

  register(): vscode.Disposable[] {
    const onViewer = (f: (uri: vscode.Uri) => unknown) => (uri?: vscode.Uri) => {
      const u = uri ?? vscode.window.activeTextEditor?.document.uri;
      return u?.scheme === SPOOL_SCHEME ? f(u) : undefined;
    };
    return [
      this,
      this.status,
      vscode.workspace.registerTextDocumentContentProvider(SPOOL_SCHEME, this),
      vscode.commands.registerCommand('code-for-qs400.spool.open', async (arg?: FileArg) => {
        const ref = nodeRef(arg);
        if (!ref) {
          return undefined;
        }
        const pages = arg && !(arg instanceof vscode.Uri) && 'kind' in arg && arg.kind === 'file' ? arg.file.pages : undefined;
        try {
          return await this.open(ref, pages);
        } catch (err) {
          void showError(err, ref.connection);
          return undefined;
        }
      }),
      vscode.commands.registerCommand('code-for-qs400.spool.goToPage', () => this.goToPage()),
      vscode.commands.registerCommand(
        'code-for-qs400.spool.loadAll',
        onViewer((u) => this.reload(u, true)),
      ),
      vscode.commands.registerCommand(
        'code-for-qs400.spool.viewerRefresh',
        onViewer((u) => this.reload(u)),
      ),
      vscode.window.onDidChangeVisibleTextEditors((eds) => this.decorate(eds)),
      vscode.window.onDidChangeActiveTextEditor((ed) => this.update(ed)),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.uri.scheme === SPOOL_SCHEME) {
          this.update(e.textEditor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === SPOOL_SCHEME) {
          this.decorate();
          this.update();
        }
      }),
      ...(this.spool
        ? [
            this.spool.onDidAct((a) => {
              if (a.what === 'deleted') {
                void this.closeOf(a.ref);
              }
            }),
          ]
        : []),
    ];
  }

  dispose(): void {
    this.changed.dispose();
    this.marker.dispose();
  }
}

/** Opens `ref` from outside the views (the output channel's `Listing: Open`). */
export async function openListing(viewer: SpoolViewer, ref: FileRef, pages?: number): Promise<vscode.TextEditor | undefined> {
  try {
    return await viewer.open(ref, pages);
  } catch (err) {
    void showError(err, ref.connection);
    return undefined;
  }
}
