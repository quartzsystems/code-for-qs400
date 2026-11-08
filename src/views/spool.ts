// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The Spooled files view: the active connection's **My spooled files**
 * (`*CURRENT`), **Output queues** in a library (default `*LIBL`, saved per
 * connection) with each queue's files, and a transient **Job
 * nnnnnn/USER/NAME** node when the Jobs view asked for a job's files.
 * Lists are read when a node opens. While the view is shown, the signed-on
 * profile's files are watched (`spool.watch { profile: *CURRENT }`): a
 * `spool.changed` refreshes the node it concerns, and new files count on
 * the view's badge until the next Refresh.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { sameName } from '../connections/config';
import { errorText, showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import type { HostClient } from '../host/client';
import { HostRpcError } from '../host/client';
import { OutputQueue, SessionJob, SpoolChanged, SpoolErrorCodes, SpooledFile, SpooledFileId } from '../host/protocol';
import { qualifiedJob, sameJob } from '../jobs/model';
import { deleteQuestion, fileDescription, fileLabel, fileTitle, jobFilesUser, queueDescription, saveName, statusLabel } from '../spool/model';
import { isSignedOn } from './connections';

/** Workspace state key of each connection's output queue library. */
export const QUEUE_LIBRARY_KEY = 'code-for-qs400.spool.queueLibrary';

/** The QAP version the view needs: `Spool`. Its watch needs 6. */
export const QAP_SPOOL = 3;
export const QAP_WATCH = 6;

/** The target the view watches while it is shown. */
export const MY_FILES = { profile: '*CURRENT' } as const;

export type SpoolNode =
  | { kind: 'message'; connection: string; text: string }
  | { kind: 'mine'; connection: string }
  | { kind: 'queues'; connection: string; library: string }
  | { kind: 'queue'; connection: string; queue: OutputQueue }
  | { kind: 'job'; connection: string; job: SessionJob }
  | { kind: 'file'; connection: string; file: SpooledFile };

/** A spooled file on a connection: what every file command acts on. */
export interface FileRef {
  connection: string;
  id: SpooledFileId;
}

/** What a command did to a file. */
export interface FileAction {
  ref: FileRef;
  what: 'held' | 'released' | 'deleted' | 'moved';
}

export function spoolTreeItem(n: SpoolNode): vscode.TreeItem {
  const C = vscode.TreeItemCollapsibleState.Collapsed;
  switch (n.kind) {
    case 'message': {
      const i = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
      i.contextValue = 'spool.message';
      i.iconPath = new vscode.ThemeIcon('info');
      return i;
    }
    case 'mine': {
      const i = new vscode.TreeItem('My spooled files', vscode.TreeItemCollapsibleState.Expanded);
      i.id = `${n.connection}/mine`;
      i.description = n.connection;
      i.iconPath = new vscode.ThemeIcon('account');
      i.contextValue = 'spool.mine';
      return i;
    }
    case 'queues': {
      const i = new vscode.TreeItem('Output queues', C);
      i.id = `${n.connection}/queues`;
      i.description = n.library;
      i.iconPath = new vscode.ThemeIcon('list-ordered');
      i.contextValue = 'spool.queues';
      i.tooltip = `Output queues in ${n.library}. Filter… names another library, *LIBL or *ALL.`;
      return i;
    }
    case 'queue': {
      const q = n.queue;
      const i = new vscode.TreeItem(`${q.outq.library}/${q.outq.name}`, C);
      i.id = `${n.connection}/queue/${q.outq.library}/${q.outq.name}`;
      i.description = queueDescription(q);
      i.tooltip = [`${q.outq.library}/${q.outq.name}${q.text ? ` — ${q.text}` : ''}`, queueDescription(q)].join('\n');
      i.iconPath = new vscode.ThemeIcon(q.held ? 'debug-pause' : 'inbox');
      i.contextValue = 'spool.queue';
      return i;
    }
    case 'job': {
      const i = new vscode.TreeItem(`Job ${qualifiedJob(n.job)}`, vscode.TreeItemCollapsibleState.Expanded);
      i.id = `${n.connection}/job/${qualifiedJob(n.job)}`;
      i.iconPath = new vscode.ThemeIcon('gear');
      i.contextValue = 'spool.job';
      return i;
    }
    case 'file': {
      const f = n.file;
      const i = new vscode.TreeItem(fileLabel(f.id), vscode.TreeItemCollapsibleState.None);
      i.description = fileDescription(f);
      i.tooltip = [
        fileTitle(f.id),
        `Status: ${statusLabel(f.status)}`,
        `Pages: ${f.pages} · copies: ${f.copies} · ${f.size} bytes`,
        `Output queue: ${f.outq.library}/${f.outq.name}`,
        `Owner: ${f.user}`,
        f.userData && `User data: ${f.userData}`,
        f.formType && `Form type: ${f.formType}`,
        `Device type: ${f.deviceType.toUpperCase()}`,
        `Created: ${new Date(f.created).toLocaleString()}`,
      ]
        .filter(Boolean)
        .join('\n');
      i.iconPath = new vscode.ThemeIcon(f.status === 'held' ? 'debug-pause' : 'file-text');
      i.contextValue = `spool.file.${f.status}`;
      i.command = { command: 'code-for-qs400.spool.open', title: 'Open', arguments: [n] };
      return i;
    }
  }
}

/** The host events the view listens to; a `HostClient`, or a test's fake. */
export type SpoolEvents = Pick<HostClient, 'onDidChangeSpool' | 'onDidSpoolProgress'>;

export class SpoolProvider implements vscode.TreeDataProvider<SpoolNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SpoolNode | undefined>();
  private readonly acted = new vscode.EventEmitter<FileAction>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChangeTreeData = this.changed.event;
  /** Fires after a command changed or deleted a file, for the viewer. */
  readonly onDidAct = this.acted.event;
  private nodes: { mine?: SpoolNode; queues?: SpoolNode; job?: SpoolNode } = {};
  private jobNode: Extract<SpoolNode, { kind: 'job' }> | undefined;
  private view: vscode.TreeView<SpoolNode> | undefined;
  /** The connection watched now, and its job when the watch was sent. */
  private watching: string | undefined;
  private watchedJob: string | undefined;
  /** New files reported since the last Refresh. */
  private added = 0;

  constructor(
    store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly workspaceState: vscode.Memento,
    events: SpoolEvents,
  ) {
    this.subscriptions = [
      sessions.onDidChange((s) => {
        if (!s || s.name === this.connection() || (this.watching && sameName(s.name, this.watching))) {
          this.refresh();
          void this.syncWatch();
        }
      }),
      store.onDidChange(() => this.refresh()),
      events.onDidChangeSpool((c) => this.spoolChanged(c)),
    ];
  }

  /** The view: its visibility starts and stops the watch; its badge counts new files. */
  attach(view: vscode.TreeView<SpoolNode>): vscode.Disposable {
    this.view = view;
    void this.syncWatch();
    return view.onDidChangeVisibility(() => void this.syncWatch());
  }

  /** The active connection when it is signed on. */
  connection(): string | undefined {
    const name = this.sessions.active;
    return name && isSignedOn(this.sessions.status(name)) ? name : undefined;
  }

  /** Watches the active connection's own files while the view is shown, and nothing otherwise. */
  async syncWatch(): Promise<void> {
    const name = this.connection();
    const qap = name ? (this.sessions.status(name).system?.qap ?? 0) : 0;
    const want = this.view?.visible && name && qap >= QAP_WATCH ? name : undefined;
    const had = this.watching;
    if (had && (!want || !sameName(had, want))) {
      this.watching = undefined;
      await this.sessions.call(had, 'spool.unwatch', { name: had, target: MY_FILES }).catch(() => undefined);
    }
    const job = want ? this.sessions.status(want).job : undefined;
    const jobText = job ? qualifiedJob(job) : undefined;
    // Again after a new sign-on (a new job), whose client watches nothing;
    // a resume keeps the job, and the client watches again by itself.
    if (want && (!had || !sameName(had, want) || jobText !== this.watchedJob)) {
      try {
        await this.sessions.call(want, 'spool.watch', { name: want, target: MY_FILES });
        this.watching = want;
        this.watchedJob = jobText;
      } catch {
        this.watching = undefined;
        this.watchedJob = undefined;
      }
    }
  }

  /** The node a change concerns, refreshed; a new file counts on the badge. */
  private spoolChanged(c: SpoolChanged): void {
    const name = this.connection();
    if (!name || !sameName(c.name, name)) {
      return;
    }
    if (c.change === 'added') {
      this.added++;
      this.showBadge();
    }
    if ('profile' in c.target) {
      this.changed.fire(this.nodes.mine);
    } else {
      this.changed.fire(this.nodes.queues);
    }
    if (this.jobNode && (!c.id || sameJob(c.id.job, this.jobNode.job))) {
      this.changed.fire(this.jobNode);
    }
  }

  private showBadge(): void {
    if (this.view) {
      this.view.badge = this.added ? { value: this.added, tooltip: `${this.added} new spooled ${this.added === 1 ? 'file' : 'files'}` } : undefined;
    }
  }

  /** New files counted since the last Refresh. */
  get newFiles(): number {
    return this.added;
  }

  refresh(clearBadge = false): void {
    this.nodes = {};
    if (clearBadge) {
      this.added = 0;
      this.showBadge();
    }
    this.changed.fire(undefined);
  }

  /** The transient node of a job's files, arrived at from the Jobs view. */
  showJob(connection: string, job: SessionJob): SpoolNode {
    this.jobNode = { kind: 'job', connection, job };
    this.refresh();
    return this.jobNode;
  }

  clearJob(): void {
    this.jobNode = undefined;
    this.refresh();
  }

  /** The output queue library saved for `name`: `*LIBL` when none. */
  library(name: string): string {
    const all = this.workspaceState.get<Record<string, string>>(QUEUE_LIBRARY_KEY) ?? {};
    return all[name.toUpperCase()] ?? '*LIBL';
  }

  async setLibrary(name: string, library: string): Promise<void> {
    const all = { ...(this.workspaceState.get<Record<string, string>>(QUEUE_LIBRARY_KEY) ?? {}) };
    const l = library.trim().toUpperCase();
    if (l === '' || l === '*LIBL') {
      delete all[name.toUpperCase()];
    } else {
      all[name.toUpperCase()] = l;
    }
    await this.workspaceState.update(QUEUE_LIBRARY_KEY, all);
    this.refresh();
  }

  /** A command changed `ref`: lists read again, the viewer told. */
  didAct(ref: FileRef, what: FileAction['what']): void {
    this.refresh();
    this.acted.fire({ ref, what });
  }

  getTreeItem(n: SpoolNode): vscode.TreeItem {
    return spoolTreeItem(n);
  }

  /** Only the roots are revealed. */
  getParent(): SpoolNode | undefined {
    return undefined;
  }

  async getChildren(n?: SpoolNode): Promise<SpoolNode[]> {
    if (!n) {
      return this.roots();
    }
    try {
      return await this.children(n);
    } catch (err) {
      return [{ kind: 'message', connection: n.connection, text: errorText(err, n.connection) }];
    }
  }

  private roots(): SpoolNode[] {
    const name = this.connection();
    if (!name) {
      return [{ kind: 'message', connection: '', text: 'Connect to see spooled files' }];
    }
    const qap = this.sessions.status(name).system?.qap;
    if (qap !== undefined && qap < QAP_SPOOL) {
      return [{ kind: 'message', connection: name, text: 'QAP version 3 not available on this server' }];
    }
    this.nodes.mine ??= { kind: 'mine', connection: name };
    this.nodes.queues ??= { kind: 'queues', connection: name, library: this.library(name) };
    const roots: SpoolNode[] = [this.nodes.mine, this.nodes.queues];
    if (this.jobNode && sameName(this.jobNode.connection, name)) {
      roots.unshift(this.jobNode);
    }
    return roots;
  }

  private async children(n: SpoolNode): Promise<SpoolNode[]> {
    const name = n.connection;
    const files = (list: SpooledFile[], none: string): SpoolNode[] =>
      list.length ? list.map((file) => ({ kind: 'file' as const, connection: name, file })) : [{ kind: 'message', connection: name, text: none }];
    switch (n.kind) {
      case 'mine':
        return files(await this.sessions.call(name, 'spool.files', { name }), 'No spooled files');
      case 'queues': {
        const q = await this.sessions.call(name, 'spool.queues', { name, library: n.library });
        return q.length ? q.map((queue) => ({ kind: 'queue' as const, connection: name, queue })) : [{ kind: 'message', connection: name, text: `No output queues in ${n.library}` }];
      }
      case 'queue':
        return files(await this.sessions.call(name, 'spool.files', { name, user: '*ALL', outq: n.queue.outq }), 'No spooled files');
      case 'job': {
        const user = jobFilesUser(n.job, this.sessions.status(name).job);
        return files(await this.sessions.call(name, 'spool.files', { name, user, job: n.job }), `No spooled files of job ${qualifiedJob(n.job)}`);
      }
      default:
        return [];
    }
  }

  dispose(): void {
    if (this.watching) {
      const had = this.watching;
      void this.sessions.call(had, 'spool.unwatch', { name: had, target: MY_FILES }).catch(() => undefined);
    }
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.changed.dispose();
    this.acted.dispose();
  }
}

/** The file a command was handed: a tree node, or what the viewer resolves (a URI). */
export type FileArg = SpoolNode | vscode.Uri | FileRef | undefined;

/** How the commands find the file of what they were handed; the viewer adds URIs. */
export type FileResolver = (arg: FileArg) => FileRef | undefined;

export function nodeRef(arg: FileArg): FileRef | undefined {
  if (arg && !(arg instanceof vscode.Uri)) {
    if ('kind' in arg && arg.kind === 'file') {
      return { connection: arg.connection, id: arg.file.id };
    }
    if ('id' in arg && 'connection' in arg) {
      return arg;
    }
  }
  return undefined;
}

/** Saves `ref` as text or PDF where the user picks, with progress and cancel. */
export async function saveAs(
  sessions: SessionManager,
  events: SpoolEvents,
  ref: FileRef,
  format: 'text' | 'pdf',
  pickTarget: (suggested: vscode.Uri) => Thenable<vscode.Uri | undefined> = (defaultUri) =>
    vscode.window.showSaveDialog({ defaultUri, filters: format === 'pdf' ? { PDF: ['pdf'] } : { Text: ['txt'] }, title: `Save ${fileTitle(ref.id)}` }),
): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
  const to = await pickTarget(vscode.Uri.joinPath(folder, saveName(ref.id, format === 'pdf' ? 'pdf' : 'txt')));
  if (!to) {
    return undefined;
  }
  const download = `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = ref.connection;
  try {
    const done = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Saving ${fileTitle(ref.id)}`, cancellable: true },
      async (progress, token) => {
        const sub = events.onDidSpoolProgress((p) => {
          if (p.download === download && p.total > 0) {
            progress.report({ message: `page ${p.pages} of ${p.total}` });
          }
        });
        const cancel = token.onCancellationRequested(() => void sessions.call(name, 'spool.cancel', { name, download }).catch(() => undefined));
        try {
          return await sessions.call(name, 'spool.download', { name, id: ref.id, format, to: to.fsPath, download });
        } finally {
          sub.dispose();
          cancel.dispose();
        }
      },
    );
    const open = 'Open';
    void vscode.window.showInformationMessage(`Saved ${fileTitle(ref.id)} to ${path.basename(to.fsPath)} (${done.pages} pages).`, open).then((p) => {
      if (p === open) {
        void (format === 'pdf' ? vscode.env.openExternal(to) : vscode.window.showTextDocument(to));
      }
    });
    return to;
  } catch (err) {
    if (err instanceof HostRpcError && err.code === SpoolErrorCodes.Cancelled) {
      return undefined;
    }
    void showError(err, name);
    return undefined;
  }
}

/** The Spooled files view's commands; `resolve` finds the file of what a command is handed. */
export function registerSpoolViewCommands(
  provider: SpoolProvider,
  view: vscode.TreeView<SpoolNode>,
  sessions: SessionManager,
  events: SpoolEvents,
  resolve: FileResolver = nodeRef,
): vscode.Disposable[] {
  const onFile =
    (f: (r: FileRef) => Promise<unknown>) =>
    async (arg?: FileArg): Promise<unknown> => {
      const ref = resolve(arg);
      if (!ref) {
        return undefined;
      }
      try {
        return await f(ref);
      } catch (err) {
        void showError(err, ref.connection);
        return undefined;
      }
    };
  const done = (ref: FileRef, what: FileAction['what'], text: string = what) => {
    vscode.window.setStatusBarMessage(`$(check) ${fileTitle(ref.id)} ${text}`, 5000);
    provider.didAct(ref, what);
  };
  return [
    vscode.commands.registerCommand('code-for-qs400.spool.refresh', () => provider.refresh(true)),
    vscode.commands.registerCommand('code-for-qs400.spool.queueLibrary', async () => {
      const name = provider.connection();
      if (!name) {
        return undefined;
      }
      const v = await vscode.window.showInputBox({
        prompt: `Library whose output queues to show on ${name}: a library, *LIBL or *ALL.`,
        value: provider.library(name),
        validateInput: (t) => (/^(\*LIBL|\*ALL|[A-Za-z$#@][A-Za-z0-9$#@_.]{0,9})$/i.test(t.trim()) ? undefined : 'A library name, *LIBL or *ALL.'),
      });
      if (v !== undefined) {
        await provider.setLibrary(name, v);
      }
      return v;
    }),
    vscode.commands.registerCommand('code-for-qs400.spool.saveText', onFile((r) => saveAs(sessions, events, r, 'text'))),
    vscode.commands.registerCommand('code-for-qs400.spool.savePdf', onFile((r) => saveAs(sessions, events, r, 'pdf'))),
    vscode.commands.registerCommand(
      'code-for-qs400.spool.hold',
      onFile(async (r) => {
        const pick = await vscode.window.showQuickPick(
          [
            { label: 'At the end of the page', description: '*PAGEEND', immediately: false },
            { label: 'Immediately', description: '*IMMED', immediately: true },
          ],
          { title: `Hold ${fileTitle(r.id)}` },
        );
        if (!pick) {
          return undefined;
        }
        await sessions.call(r.connection, 'spool.hold', { name: r.connection, id: r.id, immediately: pick.immediately });
        done(r, 'held');
        return pick.immediately;
      }),
    ),
    vscode.commands.registerCommand(
      'code-for-qs400.spool.release',
      onFile(async (r) => {
        await sessions.call(r.connection, 'spool.release', { name: r.connection, id: r.id });
        done(r, 'released');
      }),
    ),
    vscode.commands.registerCommand(
      'code-for-qs400.spool.delete',
      onFile(async (r) => {
        const del = 'Delete';
        if ((await vscode.window.showWarningMessage(deleteQuestion(r.id), { modal: true }, del)) !== del) {
          return false;
        }
        await sessions.call(r.connection, 'spool.delete', { name: r.connection, id: r.id });
        done(r, 'deleted');
        return true;
      }),
    ),
    vscode.commands.registerCommand(
      'code-for-qs400.spool.move',
      onFile(async (r) => {
        const name = r.connection;
        const queues = await sessions.call(name, 'spool.queues', { name, library: provider.library(name) });
        const other = { label: 'Another output queue…', outq: undefined as OutputQueue['outq'] | undefined };
        const pick = await vscode.window.showQuickPick(
          [...queues.map((q) => ({ label: `${q.outq.library}/${q.outq.name}`, description: queueDescription(q), detail: q.text || undefined, outq: q.outq as OutputQueue['outq'] | undefined })), other],
          { title: `Move ${fileTitle(r.id)} to`, matchOnDescription: true },
        );
        if (!pick) {
          return undefined;
        }
        let outq = pick.outq;
        if (!outq) {
          const v = await vscode.window.showInputBox({
            prompt: 'Output queue, LIBRARY/QUEUE',
            validateInput: (t) => (/^[^/\s]{1,10}\/[^/\s]{1,10}$/.test(t.trim()) ? undefined : 'LIBRARY/QUEUE'),
          });
          if (!v) {
            return undefined;
          }
          const [library, queue] = v.trim().toUpperCase().split('/');
          outq = { library, name: queue };
        }
        const where = await vscode.window.showQuickPick(
          [
            { label: 'At the end of the queue', first: false },
            { label: 'To the top of the queue', first: true },
          ],
          { title: `Move ${fileTitle(r.id)} to ${outq.library}/${outq.name}` },
        );
        if (!where) {
          return undefined;
        }
        await sessions.call(name, 'spool.move', { name, id: r.id, outq, first: where.first });
        done(r, 'moved', `moved to ${outq.library}/${outq.name}`);
        return outq;
      }),
    ),
    vscode.commands.registerCommand('code-for-qs400.spool.showJob', async (connection: string, job: SessionJob) => {
      const node = provider.showJob(connection, job);
      await vscode.commands.executeCommand('code-for-qs400.spool.focus');
      await view.reveal(node, { select: true, focus: true, expand: true }).then(undefined, () => undefined);
      return node;
    }),
    vscode.commands.registerCommand('code-for-qs400.spool.clearJob', () => provider.clearJob()),
  ];
}
