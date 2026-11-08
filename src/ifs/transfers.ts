// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { serverMessage, showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { HostClient, HostRpcError } from '../host/client';
import { IfsErrorCodes, IfsUploadMode } from '../host/protocol';
import { IfsCommandContext, connectionOf, ifsCommand } from '../commands/ifs';
import { IfsNode, IfsProvider, isDirectoryNode } from '../views/ifs';
import { baseName, formatSize, joinPath } from './paths';
import { IfsFsProvider } from './provider';
import { isBinaryPath } from './types';
import { ifsUri } from './uri';

/** The CCSID an uploaded file is created with: 65535 for a known binary, else 1208. Its bytes go as they are either way. */
export function uploadCcsid(path: string): number {
  return isBinaryPath(path) ? 65535 : 1208;
}

/** A local file to send, and where. */
export interface UploadItem {
  from: string;
  path: string;
  size: number;
}

/** A local folder's files and folders under `to`: the directories first, parents before children, then the files. */
export async function localTree(folder: string, to: string): Promise<{ dirs: string[]; files: UploadItem[] }> {
  const dirs = [to];
  const files: UploadItem[] = [];
  const visit = async (local: string, remote: string) => {
    const entries = await fs.readdir(local, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const l = nodePath.join(local, e.name);
      const r = joinPath(remote, e.name);
      if (e.isDirectory()) {
        dirs.push(r);
        await visit(l, r);
      } else if (e.isFile()) {
        files.push({ from: l, path: r, size: (await fs.stat(l)).size });
      }
    }
  };
  await visit(folder, to);
  return { dirs, files };
}

/** What the progress of one notification is made of. */
interface Run {
  /** The transfer the bar follows now, and the bytes done before it. */
  follow(transfer: string, before: number): void;
  /** Bytes done in all. */
  report(done: number): void;
  readonly cancelled: boolean;
}

function isCancelled(err: unknown): err is HostRpcError {
  return err instanceof HostRpcError && err.code === IfsErrorCodes.Cancelled;
}

function isExists(err: unknown): boolean {
  return serverMessage(err)?.status === 'Exists';
}

/**
 * Uploads and downloads with VS Code's progress notification: the bar
 * follows `ifs.progress` of the transfer running, Cancel sends
 * `ifs.cancel`. A cancelled upload leaves the part the system has; the
 * notification offers Resume, and the tree shows the file as partial
 * until it is resumed, replaced or deleted.
 */
export class Transfers {
  private made = 0;

  constructor(
    private readonly host: HostClient,
    private readonly sessions: SessionManager,
    private readonly view: IfsProvider,
    private readonly files: IfsFsProvider,
  ) {}

  private id(): string {
    return `x${process.pid.toString(36)}-${Date.now().toString(36)}-${++this.made}`;
  }

  private note(connection: string, path: string, text: string | undefined): void {
    const key = `${connection}|${path}`;
    if (text) {
      this.view.notes.set(key, text);
    } else {
      this.view.notes.delete(key);
    }
  }

  /** Runs `work` under one cancellable notification of `total` bytes. */
  private run<T>(connection: string, title: string, total: number, work: (run: Run) => Promise<T>): Thenable<T> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (progress, token) => {
        let shown = 0;
        let current: { transfer: string; before: number } | undefined;
        let cancelled = false;
        const report = (done: number) => {
          const pct = total > 0 ? Math.min(100, (done * 100) / total) : 100;
          progress.report({ increment: pct - shown, message: `${formatSize(done)} of ${formatSize(total)}` });
          shown = pct;
        };
        const subs = [
          this.host.onDidProgress((p) => {
            if (current && p.transfer === current.transfer) {
              report(current.before + p.done);
            }
          }),
          token.onCancellationRequested(() => {
            cancelled = true;
            if (current) {
              void this.sessions
                .call(connection, 'ifs.cancel', { name: connection, transfer: current.transfer })
                .catch(() => undefined);
            }
          }),
        ];
        try {
          return await work({
            follow: (transfer, before) => {
              current = { transfer, before };
            },
            report,
            get cancelled() {
              return cancelled;
            },
          });
        } finally {
          for (const s of subs) {
            s.dispose();
          }
        }
      },
    );
  }

  /** One `ifs.upload` under `run`; `undefined` when cancelled. Exists on create asks once. */
  private async sendOne(connection: string, item: UploadItem, mode: IfsUploadMode, run: Run, before: number, replaceAll: { value: boolean }): Promise<number | undefined> {
    const transfer = this.id();
    run.follow(transfer, before);
    const params = { name: connection, from: item.from, path: item.path, ccsid: uploadCcsid(item.path), transfer };
    try {
      const r = await this.sessions.call(connection, 'ifs.upload', { ...params, mode: mode === 'create' && replaceAll.value ? 'replace' : mode });
      this.note(connection, item.path, undefined);
      this.files.changed(ifsUri(connection, item.path));
      return r.size;
    } catch (err) {
      if (isCancelled(err)) {
        const offset = (err.data as { offset?: number } | undefined)?.offset ?? 0;
        this.note(connection, item.path, `partial upload: ${formatSize(offset)} of ${formatSize(item.size)}`);
        return undefined;
      }
      if (mode !== 'create' || !isExists(err)) {
        throw err;
      }
      const choice = await vscode.window.showWarningMessage(`${item.path} exists. Replace it?`, { modal: true }, 'Replace', 'Replace All');
      if (!choice) {
        return 0;
      }
      replaceAll.value = choice === 'Replace All';
      return this.sendOne(connection, item, 'replace', run, before, replaceAll);
    }
  }

  /** After a cancel: Resume, or delete what the system has. */
  private offerResume(connection: string, items: UploadItem[]): void {
    const names = items.length === 1 ? baseName(items[0].path) : `${items.length} files`;
    void vscode.window
      .showInformationMessage(
        `Code for QS/400: upload of ${names} cancelled. The system keeps the part already sent; Resume goes on from there.`,
        'Resume',
        'Delete Partial File',
      )
      .then(async (choice) => {
        if (choice === 'Resume') {
          await this.upload(connection, items, 'resume');
        } else if (choice === 'Delete Partial File') {
          const partial = items.find((i) => this.view.notes.has(`${connection}|${i.path}`));
          if (partial) {
            await this.sessions.call(connection, 'ifs.delete', { name: connection, path: partial.path }).catch((err) => showError(err, connection));
            this.note(connection, partial.path, undefined);
            this.view.refresh();
          }
        }
      });
  }

  /** Uploads files one after the other under one notification. Directories in `dirs` are made first. */
  async upload(connection: string, items: UploadItem[], mode: IfsUploadMode = 'create', dirs: string[] = [], title?: string): Promise<number | undefined> {
    const total = items.reduce((n, i) => n + i.size, 0);
    const label = title ?? (items.length === 1 ? `Uploading ${baseName(items[0].path)}` : `Uploading ${items.length} files`);
    const pending = [...items];
    const done = await this.run(connection, label, total, async (run) => {
      for (const d of dirs) {
        await this.sessions.call(connection, 'ifs.mkdir', { name: connection, path: d, parents: true });
      }
      let before = 0;
      const replaceAll = { value: false };
      while (pending.length > 0) {
        const item = pending[0];
        const size = await this.sendOne(connection, item, mode, run, before, replaceAll);
        if (size === undefined || run.cancelled) {
          return undefined;
        }
        pending.shift();
        before += item.size;
        run.report(before);
      }
      return before;
    }).then(
      (v) => v,
      (err: unknown) => {
        this.view.refresh();
        throw err;
      },
    );
    this.view.refresh();
    if (done === undefined) {
      this.offerResume(connection, pending);
    }
    return done;
  }

  /** Downloads `[path, local]` pairs under one notification, making the local folders in `dirs` first. A cancel stops the rest. */
  async download(connection: string, items: { path: string; to: string; size: number }[], dirs: string[] = [], title?: string): Promise<number | undefined> {
    const total = items.reduce((n, i) => n + i.size, 0);
    const label = title ?? (items.length === 1 ? `Downloading ${baseName(items[0].path)}` : `Downloading ${items.length} files`);
    return this.run(connection, label, total, async (run) => {
      for (const d of dirs) {
        await fs.mkdir(d, { recursive: true });
      }
      let before = 0;
      for (const item of items) {
        const transfer = this.id();
        run.follow(transfer, before);
        try {
          await this.sessions.call(connection, 'ifs.download', { name: connection, path: item.path, to: item.to, transfer });
        } catch (err) {
          if (isCancelled(err)) {
            return undefined;
          }
          throw err;
        }
        before += item.size;
        run.report(before);
        if (run.cancelled) {
          return undefined;
        }
      }
      return before;
    });
  }
}

/** A remote directory's files and folders, for a folder download into `to`. */
async function remoteTree(sessions: SessionManager, connection: string, dir: string, to: string) {
  const dirs = [to];
  const files: { path: string; to: string; size: number }[] = [];
  const visit = async (remote: string, local: string) => {
    for (const e of await sessions.call(connection, 'ifs.list', { name: connection, path: remote })) {
      const r = joinPath(remote, e.name);
      const l = nodePath.join(local, e.name);
      if (e.kind === 'directory') {
        dirs.push(l);
        await visit(r, l);
      } else if (e.kind === 'file') {
        files.push({ path: r, to: l, size: e.size });
      }
    }
  };
  await visit(dir, to);
  return { dirs, files };
}

/** Upload files…, Upload folder…, Download…, Download folder…, and local files dropped on a directory. */
export function registerTransferCommands(c: IfsCommandContext, t: Transfers, setDrop: (f: (target: IfsNode, files: vscode.Uri[]) => Promise<unknown>) => void): vscode.Disposable[] {
  const { provider, sessions } = c;
  const dirOf = (n: IfsNode | undefined) => (isDirectoryNode(n) ? n.path : undefined);

  const uploadLocal = async (connection: string, dir: string, locals: string[]) => {
    const files: UploadItem[] = [];
    const dirs: string[] = [];
    for (const local of locals) {
      const s = await fs.stat(local);
      if (s.isDirectory()) {
        const tree = await localTree(local, joinPath(dir, nodePath.basename(local)));
        dirs.push(...tree.dirs);
        files.push(...tree.files);
      } else {
        files.push({ from: local, path: joinPath(dir, nodePath.basename(local)), size: s.size });
      }
    }
    return t.upload(connection, files, 'create', dirs, `Uploading to ${dir}`);
  };

  setDrop(async (target, uris) => {
    const dir = isDirectoryNode(target) ? target.path : undefined;
    if (dir) {
      await uploadLocal(target.connection, dir, uris.map((u) => u.fsPath)).catch((err) => showError(err, target.connection));
    }
  });

  const download = async (connection: string, path: string) => {
    const info = await sessions.call(connection, 'ifs.info', { name: connection, path });
    const to = await vscode.window.showSaveDialog({
      title: `Download ${path}`,
      defaultUri: vscode.Uri.file(nodePath.join(os.homedir(), baseName(path))),
    });
    if (!to) {
      return undefined;
    }
    return t.download(connection, [{ path, to: to.fsPath, size: info.size }]);
  };

  return [
    ifsCommand('code-for-qs400.ifs.upload', async (n) => {
      const name = connectionOf(provider, n);
      const dir = dirOf(n);
      if (!name || !dir) {
        return undefined;
      }
      const picked = await vscode.window.showOpenDialog({ title: `Upload Files to ${dir}`, canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: 'Upload' });
      return picked?.length ? uploadLocal(name, dir, picked.map((u) => u.fsPath)) : undefined;
    }),
    ifsCommand('code-for-qs400.ifs.uploadFolder', async (n) => {
      const name = connectionOf(provider, n);
      const dir = dirOf(n);
      if (!name || !dir) {
        return undefined;
      }
      const picked = await vscode.window.showOpenDialog({ title: `Upload Folder to ${dir}`, canSelectMany: false, canSelectFiles: false, canSelectFolders: true, openLabel: 'Upload' });
      return picked?.length ? uploadLocal(name, dir, [picked[0].fsPath]) : undefined;
    }),
    ifsCommand('code-for-qs400.ifs.download', async (n) => {
      if (n?.kind !== 'entry' || n.entry.kind === 'directory') {
        return undefined;
      }
      return download(n.connection, n.path);
    }),
    vscode.commands.registerCommand('code-for-qs400.ifs.downloadPath', async (connection: string, path: string) => {
      try {
        return await download(connection, path);
      } catch (err) {
        void showError(err, connection);
        return undefined;
      }
    }),
    ifsCommand('code-for-qs400.ifs.downloadFolder', async (n) => {
      const dir = dirOf(n);
      if (!n || !dir) {
        return undefined;
      }
      const picked = await vscode.window.showOpenDialog({ title: `Download ${dir} into`, canSelectMany: false, canSelectFiles: false, canSelectFolders: true, openLabel: 'Download Here' });
      if (!picked?.length) {
        return undefined;
      }
      const to = nodePath.join(picked[0].fsPath, baseName(dir) === '/' ? 'root' : baseName(dir));
      const exists = await fs.stat(to).then(
        () => true,
        () => false,
      );
      if (exists) {
        const ok = await vscode.window.showWarningMessage(`${to} exists. Download into it, replacing files of the same name?`, { modal: true }, 'Download');
        if (ok !== 'Download') {
          return undefined;
        }
      }
      const tree = await remoteTree(sessions, n.connection, dir, to);
      const size = await t.download(n.connection, tree.files, tree.dirs, `Downloading ${dir}`);
      if (size !== undefined) {
        void vscode.window.showInformationMessage(`Code for QS/400: ${tree.files.length} files (${formatSize(size)}) downloaded to ${to}.`);
      }
      return size;
    }),
  ];
}
