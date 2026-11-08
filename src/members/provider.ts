// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { errorText, serverMessage, showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { MemberReadResult, SessionState, SourceLine } from '../host/protocol';
import { memberType, typeForExtension } from './types';
import { MEMBER_SCHEME, MemberPath, isReadonlyUri, parseMemberUri, qualifiedMember } from './uri';

type MemberAt = Extract<MemberPath, { kind: 'member' }>;

/** A member as last read: what the next save is diffed against. */
export interface LoadedMember {
  path: MemberAt;
  type: string;
  text: string;
  width: number;
  ccsid: number;
  lines: SourceLine[];
  /** No save: opened read-only, or another job held the member. */
  readonly: boolean;
  /** This connection holds the member `*SHRNUP`, by what is known. */
  locked: boolean;
  ctime: number;
  mtime: number;
}

/** The text of a member's lines, as its document shows it. */
export function joinLines(lines: SourceLine[]): string {
  return lines.map((l) => l.text).join('\n');
}

/** Whether the host's error is the server's `InUse`: another job holds the member (`CPF1002`). */
export function isInUse(err: unknown): boolean {
  return serverMessage(err)?.status === 'InUse';
}

/** A host error as the file system error VS Code shows, with the server's text. */
function fsError(err: unknown): vscode.FileSystemError {
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

const encoder = new TextEncoder();

/**
 * Members as files on the `qs400mbr` scheme. The first `stat` of a member
 * reads it (`member.read`, `lock: true`), because VS Code takes the
 * editor's read-only state from `stat`; a member another job holds is
 * read again with `lock: false` and opens read-only, and so does a URI
 * with the `readonly` query. The last read is kept per URI for the save
 * diff. Closing the last tab on a URI releases its lock.
 */
export class MemberFsProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly loaded = new Map<string, LoadedMember>();
  private readonly loading = new Map<string, Promise<LoadedMember>>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly lastState = new Map<string, SessionState>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChangeFile = this.emitter.event;

  constructor(
    protected readonly sessions: SessionManager,
    private readonly store: ConnectionStore,
    protected readonly output: vscode.LogOutputChannel,
  ) {
    this.subscriptions = [
      sessions.onDidChange((s) => {
        if (s) {
          void this.sessionChanged(s.name, s.state);
        }
      }),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.tabsChanged(e.closed)),
      vscode.workspace.onDidOpenTextDocument((d) => this.setLanguage(d)),
    ];
  }

  /** What the provider holds for a URI, when it has read it. */
  member(uri: vscode.Uri): LoadedMember | undefined {
    return this.loaded.get(uri.toString());
  }

  /**
   * What a URI names, with the connection as it is saved: `Uri.toString`
   * lower-cases the authority, and connection names compare without case.
   */
  protected path(uri: vscode.Uri): MemberPath | undefined {
    const p = parseMemberUri(uri);
    return p ? { ...p, connection: this.store.get(p.connection)?.name ?? p.connection } : undefined;
  }

  private memberAt(uri: vscode.Uri): MemberAt {
    const p = this.path(uri);
    if (p?.kind !== 'member') {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return p;
  }

  /** `member.read` of the member a URI names. */
  protected read(p: MemberAt, lock: boolean): Promise<MemberReadResult> {
    return this.sessions.call(p.connection, 'member.read', {
      name: p.connection,
      library: p.library,
      file: p.file,
      member: p.member,
      lock,
    });
  }

  private ensure(uri: vscode.Uri): Promise<LoadedMember> {
    const key = uri.toString();
    const have = this.loaded.get(key);
    if (have) {
      return Promise.resolve(have);
    }
    let p = this.loading.get(key);
    if (!p) {
      p = this.load(uri).finally(() => this.loading.delete(key));
      this.loading.set(key, p);
    }
    return p;
  }

  private async load(uri: vscode.Uri): Promise<LoadedMember> {
    const path = this.memberAt(uri);
    let readonly = isReadonlyUri(uri);
    let result: MemberReadResult | undefined;
    let locked = false;
    if (!readonly) {
      try {
        result = await this.read(path, true);
        locked = true;
      } catch (err) {
        if (!isInUse(err)) {
          throw fsError(err);
        }
        // CPF1002: shown as it came; the member opens read-only.
        void showError(err, path.connection);
        readonly = true;
      }
    }
    if (!result) {
      try {
        result = await this.read(path, false);
      } catch (err) {
        throw fsError(err);
      }
    }
    const now = Date.now();
    const m: LoadedMember = {
      path,
      type: result.type,
      text: result.text,
      width: result.width,
      ccsid: result.ccsid,
      lines: result.lines,
      readonly,
      locked,
      ctime: now,
      mtime: now,
    };
    this.loaded.set(uri.toString(), m);
    return m;
  }

  /**
   * Reads the member again into the cache, locking it again unless it is
   * read-only. When another job took the member meanwhile (`CPF1002`) it
   * is read without a lock, becomes read-only, and the error is `lost`.
   * `changed`: the lines differ from the ones kept.
   */
  async refresh(uri: vscode.Uri): Promise<{ changed: boolean; lost?: unknown }> {
    const m = this.loaded.get(uri.toString());
    if (!m) {
      return { changed: false };
    }
    let result: MemberReadResult | undefined;
    let lost: unknown;
    if (!m.readonly) {
      try {
        result = await this.read(m.path, true);
        m.locked = true;
      } catch (err) {
        if (!isInUse(err)) {
          throw err;
        }
        lost = err;
        m.locked = false;
        m.readonly = true;
      }
    }
    result ??= await this.read(m.path, false);
    const changed = joinLines(result.lines) !== joinLines(m.lines);
    m.type = result.type;
    m.text = result.text;
    m.width = result.width;
    m.ccsid = result.ccsid;
    m.lines = result.lines;
    m.mtime = Date.now();
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    return { changed, lost };
  }

  /** A session came back after a drop or a new sign-on: every lock it had is gone, so take them again. */
  private async sessionChanged(name: string, state: SessionState): Promise<void> {
    const before = this.lastState.get(name);
    this.lastState.set(name, state);
    const mine = [...this.loaded.entries()].filter(([, m]) => m.path.connection === name);
    if (state === 'disconnected' || state === 'stale') {
      for (const [, m] of mine) {
        m.locked = false;
      }
      return;
    }
    if (state !== 'connected' || before === undefined || before === 'connected') {
      return;
    }
    const lost: string[] = [];
    const changed: string[] = [];
    for (const [key, m] of mine) {
      if (m.readonly) {
        continue;
      }
      try {
        const r = await this.refresh(vscode.Uri.parse(key));
        if (r.lost) {
          lost.push(`${qualifiedMember(m.path)}: ${errorText(r.lost)}`);
        }
        if (r.changed) {
          changed.push(qualifiedMember(m.path));
        }
      } catch (err) {
        m.locked = false;
        lost.push(`${qualifiedMember(m.path)}: ${errorText(err)}`);
      }
    }
    if (lost.length > 0) {
      void vscode.window.showWarningMessage(
        `Code for QS/400: ${name} reconnected without the lock on ${lost.length === 1 ? 'a member' : `${lost.length} members`}; ${lost.length === 1 ? 'it is' : 'they are'} read-only now. ${lost.join(' · ')}`,
      );
    }
    if (changed.length > 0) {
      void vscode.window.showWarningMessage(
        `Code for QS/400: changed on ${name} while the connection was down: ${changed.join(', ')}. Saving replaces those changes.`,
      );
    }
    this.output.info(`${name}: locks taken again after reconnect (${mine.length - lost.length} of ${mine.length})`);
  }

  private tabsChanged(closed: readonly vscode.Tab[]): void {
    const uris = (tabs: readonly vscode.Tab[]) =>
      tabs.flatMap((t) => {
        const i = t.input;
        if (i instanceof vscode.TabInputText) {
          return [i.uri];
        }
        if (i instanceof vscode.TabInputTextDiff) {
          return [i.original, i.modified];
        }
        return [];
      });
    const open = new Set(uris(vscode.window.tabGroups.all.flatMap((g) => g.tabs)).map((u) => u.toString()));
    for (const uri of uris(closed)) {
      if (uri.scheme === MEMBER_SCHEME && !open.has(uri.toString())) {
        void this.release(uri);
      }
    }
  }

  /** Drops what is kept for a URI and ends its lock. */
  async release(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const m = this.loaded.get(key);
    this.loaded.delete(key);
    if (!m?.locked) {
      return;
    }
    try {
      await this.sessions.call(m.path.connection, 'member.unlock', {
        name: m.path.connection,
        library: m.path.library,
        file: m.path.file,
        member: m.path.member,
      });
    } catch (err) {
      void showError(err, m.path.connection);
    }
  }

  /** The language the member's type maps to. */
  private setLanguage(doc: vscode.TextDocument): void {
    const p = parseMemberUri(doc.uri);
    if (p?.kind !== 'member') {
      return;
    }
    const type = this.loaded.get(doc.uri.toString())?.type ?? typeForExtension(p.ext);
    const language = memberType(type).language;
    if (doc.languageId !== language) {
      void vscode.languages.setTextDocumentLanguage(doc, language);
    }
  }

  // FileSystemProvider

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const p = this.path(uri);
    if (!p) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (p.kind !== 'member') {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const m = await this.ensure(uri);
    return {
      type: vscode.FileType.File,
      ctime: m.ctime,
      mtime: m.mtime,
      size: encoder.encode(joinLines(m.lines)).byteLength,
      permissions: m.readonly ? vscode.FilePermission.Readonly : undefined,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const m = await this.ensure(uri);
    return encoder.encode(joinLines(m.lines));
  }

  async writeFile(uri: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(`saving ${uri.path} is not available yet`);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const p = this.path(uri);
    try {
      if (p?.kind === 'file') {
        const members = await this.sessions.call(p.connection, 'member.list', {
          name: p.connection,
          library: p.library,
          file: p.file,
        });
        return members.map((m) => [`${m.member}.${memberType(m.type).ext}`, vscode.FileType.File]);
      }
      if (p?.kind === 'library') {
        const files = await this.sessions.call(p.connection, 'object.list', {
          name: p.connection,
          library: p.library,
          pattern: '*ALL',
          types: ['*FILE'],
          attribute: 'PF-SRC',
        });
        return files.map((f) => [f.object, vscode.FileType.Directory]);
      }
      if (p?.kind === 'root') {
        const l = await this.sessions.call(p.connection, 'libl.get', { name: p.connection });
        return [...(l.current ? [l.current] : []), ...l.user.filter((u) => u !== l.current)].map((n) => [
          n,
          vscode.FileType.Directory,
        ]);
      }
    } catch (err) {
      throw fsError(err);
    }
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Create objects from the Objects view');
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const p = this.path(uri);
    if (p?.kind !== 'member') {
      throw vscode.FileSystemError.NoPermissions('Delete objects from the Objects view');
    }
    try {
      await this.sessions.call(p.connection, 'member.delete', {
        name: p.connection,
        library: p.library,
        file: p.file,
        member: p.member,
      });
    } catch (err) {
      throw fsError(err);
    }
    this.loaded.delete(uri.toString());
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    const a = this.path(from);
    const b = this.path(to);
    if (
      a?.kind !== 'member' ||
      b?.kind !== 'member' ||
      a.connection !== b.connection ||
      a.library !== b.library ||
      a.file !== b.file
    ) {
      throw vscode.FileSystemError.NoPermissions('A member is renamed within its source file');
    }
    const ref = { name: a.connection, library: a.library, file: a.file };
    try {
      if (a.member !== b.member) {
        await this.sessions.call(a.connection, 'member.rename', { ...ref, member: a.member, newName: b.member });
      }
      if (a.ext !== b.ext) {
        await this.sessions.call(a.connection, 'member.changeText', { ...ref, member: b.member, type: typeForExtension(b.ext) });
      }
    } catch (err) {
      throw fsError(err);
    }
    this.loaded.delete(from.toString());
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: from },
      { type: vscode.FileChangeType.Created, uri: to },
    ]);
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.emitter.dispose();
  }
}
