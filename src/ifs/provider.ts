// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { errorText, serverMessage } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { HostRpcError } from '../host/client';
import { IfsChange, IfsEntry, IfsErrorCodes, IfsInfo } from '../host/protocol';
import { baseName, formatSize, isWithin } from './paths';
import { Lister, copyTree, deleteWalked, walkBottomUp } from './tree';
import { DOCUMENT_LIMIT, isBinaryPath, languageForPath } from './types';
import { IFS_SCHEME, parseIfsUri } from './uri';

/** A text file as last read or written: what the next save is checked against. */
export interface LoadedText {
  connection: string;
  path: string;
  text: string;
  change: IfsChange;
  ccsid: number;
  /** When it was read or written here: the `mtime` VS Code sees, so its own check never fires before the host's. */
  mtime: number;
}

/** The answers to a save over someone else's change. */
export const OVERWRITE = 'Overwrite';
export const RELOAD = 'Reload';

/** Asks what to do when the file changed on the system since it was read. Replaced by tests. */
export type ConflictPrompt = (connection: string, path: string) => Thenable<string | undefined>;

const defaultConflictPrompt: ConflictPrompt = (connection, path) =>
  vscode.window.showWarningMessage(
    `${path} changed on ${connection} since it was opened. Overwrite it with your version, or reload it from the system and lose your changes?`,
    { modal: true },
    OVERWRITE,
    RELOAD,
  );

/** A host error as the file system error VS Code shows, with the server's text. */
export function ifsFsError(err: unknown): vscode.FileSystemError {
  const status = serverMessage(err)?.status;
  const text = errorText(err);
  if (status === 'NotFound') {
    return vscode.FileSystemError.FileNotFound(text);
  }
  if (status === 'NotAuthorized') {
    return vscode.FileSystemError.NoPermissions(text);
  }
  if (status === 'Exists') {
    return vscode.FileSystemError.FileExists(text);
  }
  return vscode.FileSystemError.Unavailable(text);
}

function isNotFound(err: unknown): boolean {
  return serverMessage(err)?.status === 'NotFound';
}

function isCode(err: unknown, code: number): err is HostRpcError {
  return err instanceof HostRpcError && err.code === code;
}

/** The refusal of a file over the document limit: its size and the limit, by name. */
export function tooLargeText(path: string, size: number, limit = DOCUMENT_LIMIT): string {
  return `${baseName(path)} is ${formatSize(size)} (${size.toLocaleString('en-US')} bytes); files open up to ${formatSize(limit)} (${limit.toLocaleString('en-US')} bytes). Download it instead.`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Stream files as files on the `qs400ifs` scheme. Text goes through
 * `ifs.readText` and `ifs.writeText`, converted by the server, and is kept
 * per URI with its `change`, which every save sends as `expect`; a save
 * over someone else's change asks Overwrite or Reload. Images and known
 * binary files go as bytes through a local temporary file, for VS Code's
 * own viewers. Both are capped at 10 MiB.
 */
export class IfsFsProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly loaded = new Map<string, LoadedText>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChangeFile = this.emitter.event;
  /** Asks Overwrite or Reload. */
  conflictPrompt: ConflictPrompt = defaultConflictPrompt;

  constructor(
    private readonly sessions: SessionManager,
    private readonly store: ConnectionStore,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.subscriptions = [vscode.workspace.onDidOpenTextDocument((d) => this.setLanguage(d))];
  }

  /**
   * The connection (as saved: `Uri.toString` lower-cases the authority,
   * and names compare without case) and the path of a URI.
   */
  private where(uri: vscode.Uri): { connection: string; path: string } {
    const p = parseIfsUri(uri);
    if (!p) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return { connection: this.store.get(p.connection)?.name ?? p.connection, path: p.path };
  }

  private key(uri: vscode.Uri): string {
    const { connection, path } = this.where(uri);
    return `${connection.toLowerCase()}|${path}`;
  }

  /** What the provider keeps for a text file it has read. */
  text(uri: vscode.Uri): LoadedText | undefined {
    return this.loaded.get(this.key(uri));
  }

  /** Forgets what is kept for a URI (after a rename or delete elsewhere). */
  forget(uri: vscode.Uri): void {
    this.loaded.delete(this.key(uri));
  }

  /** Tells VS Code the file changed (a transfer wrote it, say). */
  changed(uri: vscode.Uri, type = vscode.FileChangeType.Changed): void {
    if (type !== vscode.FileChangeType.Changed) {
      this.forget(uri);
    }
    this.emitter.fire([{ type, uri }]);
  }

  private info(connection: string, path: string): Promise<IfsInfo> {
    return this.sessions.call(connection, 'ifs.info', { name: connection, path });
  }

  private setLanguage(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== IFS_SCHEME) {
      return;
    }
    const language = languageForPath(doc.uri.path);
    if (language && doc.languageId !== language) {
      void vscode.languages.setTextDocumentLanguage(doc, language);
    }
  }

  // FileSystemProvider

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { connection, path } = this.where(uri);
    let e: IfsEntry;
    try {
      e = await this.info(connection, path);
    } catch (err) {
      throw ifsFsError(err);
    }
    let type: vscode.FileType;
    if (e.kind === 'symlink') {
      type = vscode.FileType.SymbolicLink | (await this.linkType(connection, path));
    } else {
      type = e.kind === 'directory' ? vscode.FileType.Directory : e.kind === 'file' ? vscode.FileType.File : vscode.FileType.Unknown;
    }
    const kept = this.loaded.get(this.key(uri));
    if (kept) {
      // The document's own size and time: VS Code's check of a newer file
      // must not decide a save; `expect` does.
      return { type, ctime: kept.mtime, mtime: kept.mtime, size: encoder.encode(kept.text).byteLength };
    }
    return { type, ctime: e.modified, mtime: e.modified, size: e.size };
  }

  private async linkType(connection: string, path: string): Promise<vscode.FileType> {
    try {
      const { path: target } = await this.sessions.call(connection, 'ifs.resolve', { name: connection, path });
      const t = await this.info(connection, target);
      return t.kind === 'directory' ? vscode.FileType.Directory : vscode.FileType.File;
    } catch {
      // A broken link is a link to nothing.
      return vscode.FileType.Unknown;
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { connection, path } = this.where(uri);
    try {
      const entries = await this.sessions.call(connection, 'ifs.list', { name: connection, path });
      return entries.map((e) => [
        e.name,
        e.kind === 'directory'
          ? vscode.FileType.Directory
          : e.kind === 'symlink'
            ? vscode.FileType.SymbolicLink | vscode.FileType.File
            : e.kind === 'file'
              ? vscode.FileType.File
              : vscode.FileType.Unknown,
      ]);
    } catch (err) {
      throw ifsFsError(err);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { connection, path } = this.where(uri);
    if (isBinaryPath(path)) {
      return this.readBytes(connection, path);
    }
    let r;
    try {
      r = await this.sessions.call(connection, 'ifs.readText', { name: connection, path });
    } catch (err) {
      if (isCode(err, IfsErrorCodes.TooLarge)) {
        const size = (err.data as { size?: number } | undefined)?.size ?? 0;
        throw this.tooLarge(connection, path, size);
      }
      throw ifsFsError(err);
    }
    this.loaded.set(this.key(uri), { connection, path, text: r.text, change: r.change, ccsid: r.ccsid, mtime: Date.now() });
    return encoder.encode(r.text);
  }

  /** The refusal of a file over the limit, with Download offered. */
  private tooLarge(connection: string, path: string, size: number): vscode.FileSystemError {
    const text = tooLargeText(path, size);
    void vscode.window.showWarningMessage(`Code for QS/400: ${text}`, 'Download…').then((picked) => {
      if (picked) {
        void vscode.commands.executeCommand('code-for-qs400.ifs.downloadPath', connection, path);
      }
    });
    return vscode.FileSystemError.Unavailable(text);
  }

  /** Bytes as stored, through a temporary local file: `ifs.download`. */
  private async readBytes(connection: string, path: string): Promise<Uint8Array> {
    let e: IfsInfo;
    try {
      e = await this.info(connection, path);
    } catch (err) {
      throw ifsFsError(err);
    }
    if (e.size > DOCUMENT_LIMIT) {
      throw this.tooLarge(connection, path, e.size);
    }
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'code-for-qs400-'));
    const local = nodePath.join(dir, 'file');
    try {
      await this.sessions.call(connection, 'ifs.download', { name: connection, path, to: local });
      return await fs.readFile(local);
    } catch (err) {
      throw ifsFsError(err);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** Bytes as they are, through a temporary local file: `ifs.upload`. */
  private async writeBytes(connection: string, path: string, content: Uint8Array, create: boolean): Promise<void> {
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'code-for-qs400-'));
    const local = nodePath.join(dir, 'file');
    try {
      await fs.writeFile(local, content);
      await this.sessions.call(connection, 'ifs.upload', { name: connection, from: local, path, mode: create ? 'create' : 'replace' });
    } catch (err) {
      throw ifsFsError(err);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const { connection, path } = this.where(uri);
    const key = this.key(uri);
    let kept = this.loaded.get(key);
    let exists = kept !== undefined;
    if (!kept) {
      try {
        await this.info(connection, path);
        exists = true;
      } catch (err) {
        if (!isNotFound(err)) {
          throw ifsFsError(err);
        }
      }
    }
    if (exists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (isBinaryPath(path)) {
      await this.writeBytes(connection, path, content, !exists);
      this.emitter.fire([{ type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
      return;
    }
    const text = decoder.decode(content);
    if (kept && kept.text === text) {
      // Nothing changed: nothing is written.
      return;
    }
    // A new file is 1208; New File with a CCSID makes the file first.
    const params = { name: connection, path, text, mode: exists ? ('replace' as const) : ('create' as const) };
    let written;
    try {
      written = await this.sessions.call(connection, 'ifs.writeText', kept ? { ...params, expect: kept.change } : params);
    } catch (err) {
      if (!isCode(err, IfsErrorCodes.Changed) || !kept) {
        throw ifsFsError(err);
      }
      const choice = await this.conflictPrompt(connection, path);
      if (choice === RELOAD) {
        this.reload(uri, kept);
        return;
      }
      if (choice !== OVERWRITE) {
        throw vscode.FileSystemError.Unavailable(`${path} changed on ${connection}; not saved`);
      }
      try {
        written = await this.sessions.call(connection, 'ifs.writeText', { ...params, mode: 'replace' });
      } catch (again) {
        throw ifsFsError(again);
      }
      this.output.info(`${connection}: ${path} overwritten over a change made on the system`);
    }
    kept = this.loaded.get(key) ?? kept;
    this.loaded.set(key, {
      connection,
      path,
      text,
      change: written.change,
      ccsid: kept?.ccsid ?? 1208,
      mtime: Math.max(Date.now(), (kept?.mtime ?? 0) + 1),
    });
    if (!exists) {
      this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
    }
  }

  /**
   * Reload: the save is let go without writing, and once VS Code has taken
   * it as saved, the file is read again with a newer time and announced as
   * changed, so the editor shows the system's text.
   */
  private reload(uri: vscode.Uri, kept: LoadedText): void {
    setTimeout(() => {
      void (async () => {
        try {
          const r = await this.sessions.call(kept.connection, 'ifs.readText', { name: kept.connection, path: kept.path });
          this.loaded.set(this.key(uri), {
            ...kept,
            text: r.text,
            change: r.change,
            ccsid: r.ccsid,
            mtime: Math.max(Date.now(), kept.mtime + 1),
          });
          this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        } catch (err) {
          void vscode.window.showErrorMessage(`Code for QS/400: could not reload ${kept.path}: ${errorText(err)}`);
        }
      })();
    }, 100);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { connection, path } = this.where(uri);
    try {
      await this.sessions.call(connection, 'ifs.mkdir', { name: connection, path, parents: false });
    } catch (err) {
      throw ifsFsError(err);
    }
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  /** Lists a directory, for the walks. */
  private lister(connection: string): Lister {
    return (dir) => this.sessions.call(connection, 'ifs.list', { name: connection, path: dir });
  }

  /** A file, a link or an empty directory; with `recursive`, a directory and everything in it, children first. */
  async delete(uri: vscode.Uri, options: { recursive: boolean } = { recursive: false }): Promise<void> {
    const { connection, path } = this.where(uri);
    const del = async (p: string) => {
      await this.sessions.call(connection, 'ifs.delete', { name: connection, path: p });
    };
    try {
      const e = options.recursive ? await this.info(connection, path) : undefined;
      if (e?.kind === 'directory') {
        await deleteWalked(await walkBottomUp(path, this.lister(connection)), del);
      } else {
        await del(path);
      }
    } catch (err) {
      throw ifsFsError(err);
    }
    this.changed(uri, vscode.FileChangeType.Deleted);
  }

  async rename(from: vscode.Uri, to: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const a = this.where(from);
    const b = this.where(to);
    if (a.connection.toLowerCase() !== b.connection.toLowerCase()) {
      throw vscode.FileSystemError.NoPermissions('A file is renamed within its connection');
    }
    try {
      await this.sessions.call(a.connection, 'ifs.rename', { name: a.connection, from: a.path, to: b.path, replace: options.overwrite });
    } catch (err) {
      throw ifsFsError(err);
    }
    this.forget(from);
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: from },
      { type: vscode.FileChangeType.Created, uri: to },
    ]);
  }

  /** A file copied on the system (`ifs.copy`); a directory copied entry by entry. */
  async copy(from: vscode.Uri, to: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const a = this.where(from);
    const b = this.where(to);
    if (a.connection.toLowerCase() !== b.connection.toLowerCase()) {
      throw vscode.FileSystemError.NoPermissions('A file is copied within its connection');
    }
    const name = a.connection;
    if (isWithin(b.path, a.path)) {
      throw vscode.FileSystemError.NoPermissions(`${a.path} cannot be copied into itself`);
    }
    const copy = async (f: string, t: string, replace: boolean) => {
      await this.sessions.call(name, 'ifs.copy', { name, from: f, to: t, replace });
    };
    try {
      const e = await this.info(name, a.path);
      if (e.kind === 'directory') {
        const skipped = await copyTree(a.path, b.path, {
          list: this.lister(name),
          mkdir: async (p) => {
            await this.sessions.call(name, 'ifs.mkdir', { name, path: p, parents: false });
          },
          copy: (f, t) => copy(f, t, false),
        });
        if (skipped.length > 0) {
          this.output.warn(`${name}: not copied, neither file nor directory: ${skipped.join(', ')}`);
        }
      } else {
        await copy(a.path, b.path, options.overwrite);
      }
    } catch (err) {
      throw ifsFsError(err);
    }
    this.forget(to);
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri: to }]);
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.emitter.dispose();
  }
}
