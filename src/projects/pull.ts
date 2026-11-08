// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { errorText } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { IfsEntry, MemberEntry } from '../host/protocol';
import { joinPath } from '../ifs/paths';
import { isBinaryPath } from '../ifs/types';
import { qualifiedMember } from '../members/uri';
import { ProjectConfig, ProjectTarget } from './config';
import {
  LocalMember,
  contentHash,
  isMember,
  localPathOf,
  memberFileText,
  memberKey,
  memberOf,
  relativeToTarget,
} from './layout';
import { ProjectState } from './state';
import { Project, ProjectStore } from './store';
import { ProjectUi, blockHeader } from './ui';

/** What deploy and pull share. */
export interface ProjectDeps {
  store: ConnectionStore;
  sessions: SessionManager;
  projects: ProjectStore;
  ui: ProjectUi;
  /** A line in the **Code for QS/400** output channel. */
  append(line: string): void;
  /** Shows the output channel. */
  showOutput?(): void;
}

/** A member to pull: its source file, and its `member.list` entry. */
export interface PullItem {
  library: string;
  file: string;
  entry: MemberEntry;
}

export interface PullResult {
  /** Local paths written. */
  pulled: string[];
  /** Local paths kept as they were (local changes kept). */
  kept: string[];
  /** Local paths already the same as the system's. */
  unchanged: string[];
  failed: string[];
}

function emptyResult(): PullResult {
  return { pulled: [], kept: [], unchanged: [], failed: [] };
}

async function readLocal(file: string): Promise<Uint8Array | undefined> {
  try {
    return await fs.readFile(file);
  } catch {
    return undefined;
  }
}

async function writeLocal(file: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(nodePath.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

/** The project of a folder, by its URI. */
export function projectOfFolder(projects: ProjectStore, folder: vscode.Uri): Promise<Project | undefined> {
  return projects.at(folder);
}

/**
 * Pull: members or stream files from the system to a folder's layout, so
 * existing code can go under git. Members are written as text with `\n`
 * after each line, no sequence numbers and no dates. A local file changed
 * since the last deploy or pull is asked about, Overwrite or Keep. The
 * hash and the system's change timestamp of each file written are kept in
 * `.qs400/state.json`; a folder with no `qs400project.json` gets one.
 */
export class Puller {
  constructor(private readonly deps: ProjectDeps) {}

  private get sessions(): SessionManager {
    return this.deps.sessions;
  }

  /**
   * Whether a local file may be replaced by `remote`: it is the same, or
   * not there, or unchanged since its record; otherwise the question.
   * 'same' when there is nothing to write.
   */
  private async mayWrite(file: string, rel: string, remoteHash: string, kind: 'member' | 'path', state: ProjectState): Promise<'write' | 'same' | 'keep'> {
    const local = await readLocal(file);
    if (!local) {
      return 'write';
    }
    const localHash = contentHash(local, kind);
    if (localHash === remoteHash) {
      return 'same';
    }
    const rec = state.files[rel];
    if (rec && rec.hash === localHash) {
      return 'write';
    }
    return (await this.deps.ui.overwriteLocal(rel)) ? 'write' : 'keep';
  }

  /** The local paths already holding each member, by `FILE/MEMBER`, whatever their case. */
  private async localMembers(folder: vscode.Uri): Promise<Map<string, LocalMember[]>> {
    const out = new Map<string, LocalMember[]>();
    const walk = async (dir: string, rel: string, depth: number) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory() && depth === 0 && !e.name.startsWith('.')) {
          await walk(nodePath.join(dir, e.name), r, 1);
        } else if (e.isFile() && depth === 1) {
          const m = memberOf(r);
          if (isMember(m)) {
            const k = memberKey(m.file, m.member);
            out.set(k, [...(out.get(k) ?? []), m]);
          }
        }
      }
    };
    await walk(folder.fsPath, '', 0);
    return out;
  }

  /**
   * Writes `items` into the folder's layout. A folder with no project gets
   * one, its target library asked for (offered `library`); member texts go
   * to its `texts`. Answers what was done; undefined when it was not
   * started (no folder, the question dismissed, an IFS project).
   */
  async pullMembers(connection: string, library: string, items: PullItem[], folderArg?: vscode.Uri): Promise<PullResult | undefined> {
    const folder = folderArg ?? (await this.deps.ui.folder());
    if (!folder) {
      return undefined;
    }
    let project = await projectOfFolder(this.deps.projects, folder);
    if (project?.config?.target.kind === 'path') {
      this.deps.ui.error(`${project.folder.name}'s project deploys to the IFS path ${project.config.target.path}; pull members into a folder whose project targets a library.`);
      return undefined;
    }
    let target: ProjectTarget | undefined = project?.config?.target;
    if (!project) {
      const lib = await this.deps.ui.targetLibrary(library);
      if (!lib) {
        return undefined;
      }
      target = { kind: 'library', library: lib };
    }
    const state = project ? await this.deps.projects.readState(project) : { version: 1 as const, files: {} };
    const existing = await this.localMembers(folder);
    const texts: Record<string, string> = {};
    const result = emptyResult();
    this.deps.append(blockHeader(new Date(), 'Pull', items.length === 1 ? qualifiedMember({ library, file: items[0].file, member: items[0].entry.member }) : library, connection));

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Pull from ${library}`, cancellable: true },
      async (progress, token) => {
        for (const [i, item] of items.entries()) {
          if (token.isCancellationRequested) {
            this.deps.append('Cancelled');
            break;
          }
          const m = item.entry;
          const label = qualifiedMember({ library: item.library, file: item.file, member: m.member });
          progress.report({ message: `${label} (${i + 1} of ${items.length})`, increment: 100 / items.length });
          const want = localPathOf(item.file, m.member, m.type);
          // A local file that already names the member, in any case, keeps its name when its extension is the member's type.
          const have = existing.get(memberKey(item.file, m.member)) ?? [];
          const same = have.find((h) => h.type.toUpperCase() === m.type.trim().toUpperCase());
          const rel = same?.rel ?? want;
          for (const other of have.filter((h) => h !== same)) {
            this.deps.append(`Note     ${other.rel} names the same member as ${rel}; rename or remove one before deploying`);
          }
          try {
            const read = await this.sessions.call(connection, 'member.read', {
              name: connection,
              library: item.library,
              file: item.file,
              member: m.member,
              lock: false,
            });
            const bytes = new TextEncoder().encode(memberFileText(read.lines.map((l) => l.text)));
            const hash = contentHash(bytes, 'member');
            const file = nodePath.join(folder.fsPath, ...rel.split('/'));
            const may = await this.mayWrite(file, rel, hash, 'member', state);
            if (may === 'keep') {
              result.kept.push(rel);
              this.deps.append(`Kept     ${rel}: local changes kept`);
              continue;
            }
            if (may === 'write') {
              await writeLocal(file, bytes);
              result.pulled.push(rel);
              this.deps.append(`Pulled   ${label} → ${rel}`);
            } else {
              result.unchanged.push(rel);
              this.deps.append(`Same     ${label} = ${rel}`);
            }
            state.files[rel] = { hash, remote: m.changed, at: qualifiedMember({ library: item.library, file: item.file, member: m.member }) };
            const text = (read.text || m.text).trim();
            if (text !== '') {
              texts[rel] = text;
            }
          } catch (err) {
            result.failed.push(rel);
            this.deps.append(`Failed   ${label}: ${errorText(err, connection)}`);
          }
        }
      },
    );

    if (!project) {
      await this.deps.projects.create(folder, { connection, target: target as ProjectTarget, texts });
      project = await projectOfFolder(this.deps.projects, folder);
    } else {
      await this.deps.projects.addTexts(project, texts);
    }
    if (project) {
      await this.deps.projects.writeState(project, state);
    }
    this.deps.append(summary(result));
    return result;
  }

  /** Every member of the source files named, then pulled. */
  async pullSourceFiles(connection: string, library: string, files: string[], folder?: vscode.Uri): Promise<PullResult | undefined> {
    const items: PullItem[] = [];
    for (const file of files) {
      try {
        const entries = await this.sessions.call(connection, 'member.list', { name: connection, library, file });
        items.push(...entries.map((entry) => ({ library, file, entry })));
      } catch (err) {
        this.deps.ui.error(`${library}/${file}: ${errorText(err, connection)}`);
        return undefined;
      }
    }
    return this.pullMembers(connection, library, items, folder);
  }

  /** **Pull Library…**: a library, then which of its source files, all picked to start with. */
  async pullLibrary(arg?: { connection?: string; library?: string }, folder?: vscode.Uri): Promise<PullResult | undefined> {
    const connection = await this.connection(arg?.connection);
    if (!connection) {
      return undefined;
    }
    let library = arg?.library;
    if (!library) {
      let libs;
      try {
        libs = await this.sessions.call(connection, 'object.libraries', { name: connection });
      } catch (err) {
        this.deps.ui.error(errorText(err, connection));
        return undefined;
      }
      const picked = await vscode.window.showQuickPick(
        libs.map((l) => ({ label: l.library, description: l.text })),
        { title: `Pull Library from ${connection}`, placeHolder: 'Library' },
      );
      library = picked?.label;
    }
    if (!library) {
      return undefined;
    }
    let files;
    try {
      files = await this.sessions.call(connection, 'object.list', {
        name: connection,
        library,
        pattern: '*ALL',
        types: ['*FILE'],
        attribute: 'PF-SRC',
      });
    } catch (err) {
      this.deps.ui.error(errorText(err, connection));
      return undefined;
    }
    if (files.length === 0) {
      this.deps.ui.info(`${library} has no source files.`);
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      files.map((f) => ({ label: f.object, description: f.text, picked: true })),
      { title: `Pull from ${library}`, placeHolder: 'Source files', canPickMany: true },
    );
    if (!picked || picked.length === 0) {
      return undefined;
    }
    return this.pullSourceFiles(connection, library, picked.map((p) => p.label), folder);
  }

  /** The connection a command acts on: the one given, else the active one if signed on, else the pick. */
  private async connection(given?: string): Promise<string | undefined> {
    if (given) {
      return this.deps.store.get(given)?.name ?? given;
    }
    const signed = this.sessions.signedOn().map((s) => s.name);
    const active = this.sessions.active;
    if (active && signed.includes(active)) {
      return active;
    }
    if (signed.length === 1) {
      return signed[0];
    }
    const names = this.deps.store.list().map((c) => c.name);
    if (names.length === 0) {
      this.deps.ui.info('Add a connection first.');
      return undefined;
    }
    return vscode.window.showQuickPick(names, { title: 'Connection', placeHolder: 'The system to pull from' });
  }

  /**
   * Pull of a stream file or a directory's files into an IFS project: a
   * text file converted to UTF-8 by the server (`ifs.readText`) unless it
   * is 1208 or binary already, which come as their bytes
   * (`ifs.download`). Symbolic links and other kinds are skipped.
   */
  async pullPath(connection: string, path: string, kind: 'file' | 'directory', folderArg?: vscode.Uri): Promise<PullResult | undefined> {
    const folder = folderArg ?? (await this.deps.ui.folder());
    if (!folder) {
      return undefined;
    }
    let project = await projectOfFolder(this.deps.projects, folder);
    let targetPath: string | undefined;
    if (project?.config) {
      if (project.config.target.kind !== 'path') {
        this.deps.ui.error(`${project.folder.name}'s project deploys to the library ${project.config.target.library}; pull stream files into a folder whose project targets an IFS path.`);
        return undefined;
      }
      targetPath = project.config.target.path;
      if (path !== targetPath && relativeToTarget(targetPath, path) === undefined) {
        this.deps.ui.error(`${path} is not under ${targetPath}, the project's target.`);
        return undefined;
      }
    } else if (!project) {
      const suggested = kind === 'directory' ? path : path.slice(0, path.lastIndexOf('/')) || '/';
      targetPath = await this.deps.ui.targetPath(suggested);
      if (!targetPath) {
        return undefined;
      }
      targetPath = targetPath.replace(/\/+$/, '') || '/';
    } else {
      this.deps.ui.error(`${project.folder.name}/qs400project.json has problems; fix them first.`);
      return undefined;
    }
    const files: { path: string; entry?: IfsEntry }[] = [];
    if (kind === 'file') {
      files.push({ path });
    } else {
      const walk = async (dir: string) => {
        const entries = await this.sessions.call(connection, 'ifs.list', { name: connection, path: dir });
        for (const e of entries) {
          const p = joinPath(dir, e.name);
          if (e.kind === 'file') {
            files.push({ path: p, entry: e });
          } else if (e.kind === 'directory') {
            await walk(p);
          } else {
            this.deps.append(`Skipped  ${p}: a ${e.kind === 'symlink' ? 'symbolic link' : 'special file'}`);
          }
        }
      };
      try {
        await walk(path);
      } catch (err) {
        this.deps.ui.error(errorText(err, connection));
        return undefined;
      }
    }
    const state = project ? await this.deps.projects.readState(project) : { version: 1 as const, files: {} };
    const result = emptyResult();
    this.deps.append(blockHeader(new Date(), 'Pull', path, connection));
    const tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'qs4pull-'));
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Pull ${path}`, cancellable: true },
        async (progress, token) => {
          for (const [i, f] of files.entries()) {
            if (token.isCancellationRequested) {
              this.deps.append('Cancelled');
              break;
            }
            const rel = relativeToTarget(targetPath as string, f.path) ?? f.path.slice(f.path.lastIndexOf('/') + 1);
            progress.report({ message: `${rel} (${i + 1} of ${files.length})`, increment: 100 / files.length });
            try {
              // The stamp before the data (Phase 3): a change in between shows as a conflict later.
              const info = await this.sessions.call(connection, 'ifs.info', { name: connection, path: f.path });
              let bytes: Uint8Array;
              if (isBinaryPath(f.path) || info.ccsid === 1208 || info.ccsid === 65535) {
                const to = nodePath.join(tmp, `f${i}`);
                await this.sessions.call(connection, 'ifs.download', { name: connection, path: f.path, to });
                bytes = await fs.readFile(to);
              } else {
                const t = await this.sessions.call(connection, 'ifs.readText', { name: connection, path: f.path });
                bytes = new TextEncoder().encode(t.text);
                this.deps.append(`Note     ${f.path} is CCSID ${info.ccsid}; pulled as UTF-8, and a deploy sends UTF-8 bytes`);
              }
              const hash = contentHash(bytes, 'path');
              const file = nodePath.join(folder.fsPath, ...rel.split('/'));
              const may = await this.mayWrite(file, rel, hash, 'path', state);
              if (may === 'keep') {
                result.kept.push(rel);
                this.deps.append(`Kept     ${rel}: local changes kept`);
                continue;
              }
              if (may === 'write') {
                await writeLocal(file, bytes);
                result.pulled.push(rel);
                this.deps.append(`Pulled   ${f.path} → ${rel}`);
              } else {
                result.unchanged.push(rel);
                this.deps.append(`Same     ${f.path} = ${rel}`);
              }
              state.files[rel] = { hash, remote: info.change, at: f.path };
            } catch (err) {
              result.failed.push(rel);
              this.deps.append(`Failed   ${f.path}: ${errorText(err, connection)}`);
            }
          }
        },
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
    if (!project) {
      await this.deps.projects.create(folder, { connection, target: { kind: 'path', path: targetPath } });
      project = await projectOfFolder(this.deps.projects, folder);
    }
    if (project) {
      await this.deps.projects.writeState(project, state);
    }
    this.deps.append(summary(result));
    return result;
  }

  /**
   * One local file again from the system (a conflict's **Pull**, the
   * Project view's **Pull**): its record keeps its old hash and takes the
   * system's timestamp, so the file shows as changed until it is deployed.
   */
  async pullOne(project: Project & { config: ProjectConfig }, rel: string, opts: { keepHash: boolean; state?: ProjectState }): Promise<void> {
    const connection = this.deps.projects.connectionOf(project);
    // A deploy under way hands its own state, which it writes at its end.
    const state = opts.state ?? (await this.deps.projects.readState(project));
    const file = nodePath.join(project.folder.uri.fsPath, ...rel.split('/'));
    const t = project.config.target;
    let bytes: Uint8Array;
    let remote: number | string;
    let at: string;
    if (t.kind === 'library') {
      const m = memberOf(rel);
      if (!isMember(m)) {
        throw new Error(`${rel}: ${m.reason}`);
      }
      const entries = await this.sessions.call(connection, 'member.list', { name: connection, library: t.library, file: m.file, pattern: m.member });
      const entry = entries.find((e) => e.member.toUpperCase() === m.member);
      if (!entry) {
        throw new Error(`${qualifiedMember({ library: t.library, file: m.file, member: m.member })} is not on the system`);
      }
      const read = await this.sessions.call(connection, 'member.read', { name: connection, library: t.library, file: m.file, member: m.member, lock: false });
      bytes = new TextEncoder().encode(memberFileText(read.lines.map((l) => l.text)));
      remote = entry.changed;
      at = qualifiedMember({ library: t.library, file: m.file, member: m.member });
    } else {
      const path = joinPath(t.path, rel);
      const info = await this.sessions.call(connection, 'ifs.info', { name: connection, path });
      if (isBinaryPath(path) || info.ccsid === 1208 || info.ccsid === 65535) {
        const tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'qs4pull-'));
        try {
          const to = nodePath.join(tmp, 'f');
          await this.sessions.call(connection, 'ifs.download', { name: connection, path, to });
          bytes = await fs.readFile(to);
        } finally {
          await fs.rm(tmp, { recursive: true, force: true });
        }
      } else {
        bytes = new TextEncoder().encode((await this.sessions.call(connection, 'ifs.readText', { name: connection, path })).text);
      }
      remote = info.change;
      at = path;
    }
    await writeLocal(file, bytes);
    const kind = t.kind === 'library' ? 'member' : 'path';
    const before = state.files[rel];
    state.files[rel] = {
      hash: opts.keepHash && before ? before.hash : contentHash(bytes, kind),
      remote,
      at,
    };
    if (!opts.state) {
      await this.deps.projects.writeState(project, state);
    }
    this.deps.append(`Pulled   ${at} → ${rel}`);
  }
}

export function summary(r: PullResult): string {
  return `${r.pulled.length} pulled, ${r.unchanged.length} unchanged, ${r.kept.length} kept${r.failed.length > 0 ? `, ${r.failed.length} failed` : ''}`;
}
