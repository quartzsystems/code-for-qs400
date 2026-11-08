// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { errorText, serverMessage } from '../connections/prompts';
import { HostRpcError } from '../host/client';
import { DeployErrorCodes, IfsErrorCodes } from '../host/protocol';
import { qualifiedMember } from '../members/uri';
import { ProjectConfig, textFor } from './config';
import { formatSize } from '../ifs/paths';
import { LocalMember, clashes, contentHash, isMember, memberKey, memberLines, memberOf, remotePathOf } from './layout';
import { ProjectDeps, Puller } from './pull';
import { FileRecord, ProjectState, baseline, remoteChanged } from './state';
import { Project, relativeTo } from './store';
import { blockHeader } from './ui';

/** Which files a deploy takes: changed by hash, all, changed in git, or one. */
export type DeployScope = 'changed' | 'all' | 'git' | 'file';

export type UsableProject = Project & { config: ProjectConfig };

/** What a deploy did, by local path. */
export interface DeployResult {
  deployed: string[];
  /** Of `deployed`, those the system already held as they are: nothing written. */
  unchanged: string[];
  skipped: string[];
  conflicts: string[];
  failed: string[];
  /** Records of local files removed since the last deploy: their members or files stay. */
  leftOnSystem: string[];
}

function emptyResult(): DeployResult {
  return { deployed: [], unchanged: [], skipped: [], conflicts: [], failed: [], leftOnSystem: [] };
}

/** The output's last line. */
export function deploySummary(r: DeployResult): string {
  return `${r.deployed.length} deployed, ${r.skipped.length} skipped, ${r.conflicts.length} conflicts${r.failed.length > 0 ? `, ${r.failed.length} failed` : ''}`;
}

/** Local paths git reports changed or untracked in a folder; undefined when the folder is in no repository. */
export interface GitChanges {
  changed(folder: vscode.Uri): Promise<string[] | undefined>;
}

/** A local file a deploy considers. */
interface Candidate {
  rel: string;
  file: string;
  bytes: Uint8Array;
  hash: string;
  record?: FileRecord;
  member?: LocalMember;
}

/** What the system's timestamps are, read before anything is written. */
type Remote = Map<string, number | string>;

function isConflict(err: unknown): err is HostRpcError {
  return err instanceof HostRpcError && err.code === DeployErrorCodes.Conflict;
}

/** `remote`'s time as the output shows it. */
function when(remote: number | string | undefined): string {
  return typeof remote === 'number' ? new Date(remote).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : String(remote ?? '');
}

/**
 * **Deploy**: a project's local files onto its target. Changed files (by
 * content hash against `state.json`), all, the ones git reports changed,
 * or one. Conflicts (the system's timestamp newer than the one recorded)
 * are listed before anything is written and resolved per file:
 * Overwrite, Pull or Skip. Members go through `deploy.member`, so their
 * sequence numbers and dates follow Phase 2's save diff. Deletions are
 * never deployed. Each file is a line in the **Code for QS/400** output
 * channel, then `n deployed, n skipped, n conflicts`.
 */
export class Deployer {
  /** Where each deployed member or stream file is on disk, by `connection|LIB/FILE(MEMBER)` or `connection|/path`. */
  private readonly locals = new Map<string, vscode.Uri>();
  /** The files last found in conflict, by project folder, for the Project view. */
  readonly conflicts = new Map<string, Set<string>>();
  private readonly finished = new vscode.EventEmitter<{ project: UsableProject; result: DeployResult }>();
  private transfers = 0;
  /** Fires after each deploy. */
  readonly onDidDeploy = this.finished.event;

  constructor(
    private readonly deps: ProjectDeps,
    private readonly puller: Puller,
    private readonly git?: GitChanges,
    /** Open writable documents of a member written are read again (and locked again). */
    private readonly refreshMember?: (connection: string, library: string, file: string, member: string) => Promise<void>,
  ) {}

  /** The local file a deployed member or stream file came from. */
  localFor(connection: string, at: { kind: 'member'; library: string; file: string; member: string } | { kind: 'path'; path: string }): vscode.Uri | undefined {
    return this.locals.get(remoteKey(connection, at));
  }

  private remember(connection: string, at: Parameters<Deployer['localFor']>[1], uri: vscode.Uri): void {
    this.locals.set(remoteKey(connection, at), uri);
  }

  private conflictSet(p: UsableProject): Set<string> {
    const k = p.folder.uri.toString();
    let s = this.conflicts.get(k);
    if (!s) {
      s = new Set();
      this.conflicts.set(k, s);
    }
    return s;
  }

  /** Saves the project's dirty documents; false when one could not be saved. */
  private async saveDirty(p: UsableProject): Promise<boolean> {
    for (const d of vscode.workspace.textDocuments) {
      if (d.isDirty && relativeTo(p.folder.uri, d.uri) !== undefined && !(await d.save())) {
        return false;
      }
    }
    return true;
  }

  /** The project's files a scope takes, relative; undefined when the deploy is not to go on. */
  private async scoped(p: UsableProject, scope: DeployScope, state: ProjectState, all: string[], one?: string): Promise<string[] | undefined> {
    switch (scope) {
      case 'all':
        return all;
      case 'file':
        return one !== undefined && all.includes(one) ? [one] : [];
      case 'git': {
        const changed = await this.git?.changed(p.folder.uri);
        if (changed === undefined) {
          this.deps.append('Note     no git repository for this folder: deploying the files changed since the last deploy');
          this.deps.ui.info(`${p.folder.name} is not in a git repository; Deploy changed instead.`);
          return this.scoped(p, 'changed', state, all);
        }
        const set = new Set(changed);
        return all.filter((r) => set.has(r));
      }
      case 'changed': {
        const out: string[] = [];
        for (const rel of all) {
          const rec = state.files[rel];
          if (!rec) {
            out.push(rel);
            continue;
          }
          const bytes = await fs.readFile(nodePath.join(p.folder.uri.fsPath, ...rel.split('/')));
          if (contentHash(bytes, p.config.target.kind === 'library' ? 'member' : 'path') !== rec.hash) {
            out.push(rel);
          }
        }
        return out;
      }
    }
  }

  /**
   * Deploys the project's files of `scope` (`file`: the local file `one`,
   * relative). Undefined when nothing was started.
   */
  async deploy(p: UsableProject, scope: DeployScope, one?: string): Promise<DeployResult | undefined> {
    if (!(await this.saveDirty(p))) {
      this.deps.ui.error('A document could not be saved; nothing was deployed.');
      return undefined;
    }
    const connection = this.deps.projects.connectionOf(p);
    if (this.deps.sessions.status(connection).state === 'disconnected' && !(await this.deps.sessions.connect(connection))) {
      return undefined;
    }
    const t = p.config.target;
    const title = { changed: 'Deploy changed', all: 'Deploy all', git: 'Deploy git-changed', file: 'Deploy' }[scope];
    this.deps.append(blockHeader(new Date(), title, t.kind === 'library' ? t.library : t.path, connection));
    const state = await this.deps.projects.readState(p);
    const { files } = await this.deps.projects.files(p);
    const result = emptyResult();

    // Deletions are never deployed: a record whose local file is gone is said once and dropped.
    const present = new Set(files);
    for (const [rel, rec] of Object.entries(state.files)) {
      if (!present.has(rel)) {
        result.leftOnSystem.push(rel);
        this.deps.append(`Left on the system  ${rec.at}: ${rel} was removed locally`);
        delete state.files[rel];
      }
    }

    const rels = await this.scoped(p, scope, state, files, one);
    if (!rels) {
      return undefined;
    }
    if (rels.length === 0) {
      this.deps.append('Nothing to deploy');
      this.deps.append(deploySummary(result));
      await this.deps.projects.writeState(p, state);
      this.finished.fire({ project: p, result });
      return result;
    }

    const kind = t.kind === 'library' ? 'member' : 'path';
    const candidates: Candidate[] = [];
    for (const rel of rels) {
      const file = nodePath.join(p.folder.uri.fsPath, ...rel.split('/'));
      const bytes = await fs.readFile(file);
      candidates.push({ rel, file, bytes, hash: contentHash(bytes, kind), record: state.files[rel] });
    }

    try {
      if (t.kind === 'library') {
        await this.toLibrary(p, connection, t.library, candidates, state, result);
      } else {
        await this.toPath(p, connection, t.path, candidates, state, result);
      }
    } finally {
      await this.deps.projects.writeState(p, state);
    }
    this.deps.append(deploySummary(result));
    this.finished.fire({ project: p, result });
    return result;
  }

  /** The members of `candidates` into `library`. */
  private async toLibrary(p: UsableProject, connection: string, library: string, candidates: Candidate[], state: ProjectState, result: DeployResult): Promise<void> {
    // The layout: what is not a member is skipped; two files naming one member are an error.
    const members: Candidate[] = [];
    for (const c of candidates) {
      const m = memberOf(c.rel);
      if (!isMember(m)) {
        result.skipped.push(c.rel);
        this.deps.append(`Skipped  ${c.rel}: ${m.reason}`);
        continue;
      }
      members.push({ ...c, member: m });
    }
    const all = (await this.deps.projects.files(p)).files.map(memberOf).filter(isMember);
    const clashing = new Set(clashes(all).flatMap((g) => g.map((m) => m.rel)));
    for (const g of clashes(all)) {
      this.deps.append(`Error    ${g.map((m) => m.rel).join(' and ')} name the same member ${library}/${g[0].file}(${g[0].member}); none is deployed`);
    }
    const ok = members.filter((c) => {
      if (clashing.has(c.rel)) {
        result.failed.push(c.rel);
        return false;
      }
      return true;
    });
    if (clashing.size > 0) {
      this.deps.ui.error(`Two local files name the same member; see the Code for QS/400 output.`);
    }

    // Source files that are not there are made first, after a question naming them.
    const dirs = [...new Set(ok.map((c) => (c.member as LocalMember).file))];
    let existing: Set<string>;
    try {
      const objects = await this.deps.sessions.call(connection, 'object.list', {
        name: connection,
        library,
        pattern: '*ALL',
        types: ['*FILE'],
        attribute: 'PF-SRC',
      });
      existing = new Set(objects.map((o) => o.object.toUpperCase()));
    } catch (err) {
      this.deps.append(`Failed   ${library}: ${errorText(err, connection)}`);
      result.failed.push(...ok.map((c) => c.rel));
      this.deps.ui.error(errorText(err, connection));
      return;
    }
    const missing = dirs.filter((d) => !existing.has(d));
    const unmade = new Set<string>();
    if (missing.length > 0) {
      if (await this.deps.ui.createSourceFiles(library, missing)) {
        for (const f of missing) {
          const command = `CRTSRCPF FILE(${library}/${f}) RCDLEN(112)`;
          try {
            const o = await this.deps.sessions.call(connection, 'action.run', { name: connection, command, kind: 'command' });
            if (o.status === 'Ok') {
              this.deps.append(`Created  ${library}/${f}: ${command}`);
            } else {
              unmade.add(f);
              this.deps.append(`Failed   ${command}: ${o.escape ? `${o.escape.id}: ${o.escape.text}` : o.status}`);
            }
          } catch (err) {
            unmade.add(f);
            this.deps.append(`Failed   ${command}: ${errorText(err, connection)}`);
          }
        }
      } else {
        for (const f of missing) {
          unmade.add(f);
          this.deps.append(`Skipped  ${library}/${f}: the source file is not there and was not created`);
        }
      }
    }
    const go = ok.filter((c) => {
      if (unmade.has((c.member as LocalMember).file)) {
        result.skipped.push(c.rel);
        return false;
      }
      return true;
    });

    // The system's timestamps, one member.list per source file, before anything is written.
    const remote: Remote = new Map();
    for (const f of [...new Set(go.map((c) => (c.member as LocalMember).file))]) {
      if (!existing.has(f)) {
        continue;
      }
      try {
        const entries = await this.deps.sessions.call(connection, 'member.list', { name: connection, library, file: f });
        for (const e of entries) {
          remote.set(memberKey(f, e.member), e.changed);
        }
      } catch (err) {
        this.deps.append(`Failed   ${library}/${f}: ${errorText(err, connection)}`);
      }
    }
    const conflictSet = this.conflictSet(p);
    const choices = await this.resolveConflicts(
      p,
      go.map((c) => {
        const m = c.member as LocalMember;
        const at = qualifiedMember({ library, file: m.file, member: m.member });
        return { c, at, label: `${c.rel} (${at})`, now: remote.get(memberKey(m.file, m.member)) };
      }),
      result,
      state,
    );

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Deploy to ${library}`, cancellable: true },
      async (progress, token) => {
        for (const [i, c] of go.entries()) {
          const m = c.member as LocalMember;
          const ref = { library, file: m.file, member: m.member };
          const label = qualifiedMember(ref);
          const choice = choices.get(c.rel);
          if (choice === 'skip' || choice === 'pull') {
            continue;
          }
          if (token.isCancellationRequested) {
            result.skipped.push(c.rel);
            continue;
          }
          progress.report({ message: `${c.rel} (${i + 1} of ${go.length})`, increment: 100 / go.length });
          const recorded = baseline(c.record, label);
          const expect = choice === 'overwrite' || typeof recorded !== 'number' ? undefined : recorded;
          try {
            const r = await this.deps.sessions.call(connection, 'deploy.member', {
              name: connection,
              ...ref,
              type: m.type,
              text: textFor(p.config, c.rel) ?? '',
              lines: memberLines(new TextDecoder().decode(c.bytes)),
              expect,
            });
            let changed: number | null | undefined = r.changed;
            if (changed === null) {
              changed = await this.memberChanged(connection, library, m.file, m.member);
            }
            state.files[c.rel] = { hash: c.hash, remote: changed ?? baseline(c.record, label) ?? 0, at: label };
            conflictSet.delete(c.rel);
            this.remember(connection, { kind: 'member', ...ref }, vscode.Uri.file(c.file));
            result.deployed.push(c.rel);
            if (r.outcome === 'unchanged') {
              result.unchanged.push(c.rel);
            }
            const word = r.outcome === 'created' ? 'Created ' : r.outcome === 'written' ? 'Deployed' : 'Same    ';
            this.deps.append(`${word} ${c.rel} → ${label}${r.renumbered && r.outcome === 'written' ? ' (renumbered: no sequence number was left for an inserted line)' : ''}`);
            if (r.outcome !== 'unchanged') {
              await this.refreshMember?.(connection, library, m.file, m.member);
            }
          } catch (err) {
            if (isConflict(err)) {
              // Changed on the system between the check and the write.
              result.conflicts.push(c.rel);
              conflictSet.add(c.rel);
              this.deps.append(`Conflict ${c.rel}: ${label} changed on the system; not written`);
            } else {
              result.failed.push(c.rel);
              this.deps.append(`Failed   ${c.rel} → ${label}: ${errorText(err, connection)}`);
            }
          }
        }
      },
    );
    this.deps.projects.touch();
  }

  /** A member's `changed` now; undefined when it cannot be read. */
  private async memberChanged(connection: string, library: string, file: string, member: string): Promise<number | undefined> {
    try {
      const e = await this.deps.sessions.call(connection, 'member.list', { name: connection, library, file, pattern: member });
      return e.find((x) => x.member.toUpperCase() === member)?.changed;
    } catch {
      return undefined;
    }
  }

  /**
   * The conflicts among `items`, listed in the output before anything is
   * written, then resolved one by one. Pull fetches the system's copy into
   * the local file at once; Skip and Pull leave the file out of this
   * deploy. Each counts as a conflict.
   */
  private async resolveConflicts(
    p: UsableProject,
    items: { c: Candidate; at: string; label: string; now: number | string | undefined }[],
    result: DeployResult,
    state: ProjectState,
  ): Promise<Map<string, 'overwrite' | 'pull' | 'skip'>> {
    const choices = new Map<string, 'overwrite' | 'pull' | 'skip'>();
    const found = items.filter((x) => remoteChanged(baseline(x.c.record, x.at), x.now));
    const set = this.conflictSet(p);
    for (const x of found) {
      set.add(x.c.rel);
      this.deps.append(`Conflict ${x.label}: changed on the system at ${when(x.now)}, after the last deploy or pull at ${when(baseline(x.c.record, x.at))}`);
    }
    if (found.length > 0) {
      this.deps.projects.touch();
    }
    for (const x of found) {
      const choice = await this.deps.ui.conflict(x.c.rel, `${x.label} changed on the system at ${when(x.now)}. Overwrite replaces it with the local file; Pull replaces the local file with it; Skip leaves both.`);
      choices.set(x.c.rel, choice);
      if (choice === 'overwrite') {
        this.deps.append(`Overwrite ${x.c.rel}`);
        continue;
      }
      result.conflicts.push(x.c.rel);
      if (choice === 'pull') {
        try {
          await this.puller.pullOne(p, x.c.rel, { keepHash: true, state });
          set.delete(x.c.rel);
        } catch (err) {
          this.deps.append(`Failed   pull of ${x.c.rel}: ${errorText(err)}`);
        }
      } else {
        this.deps.append(`Skipped  ${x.c.rel}: in conflict`);
      }
    }
    return choices;
  }

  /**
   * The stream files of `candidates` under `target`: `ifs.info` of each
   * before anything is written, then `deploy.path` (the parent made when
   * missing, `ifs.upload` replace with `encoding.ifsCcsid`), with the
   * upload's progress and Cancel as Phase 3's.
   */
  private async toPath(p: UsableProject, connection: string, target: string, candidates: Candidate[], state: ProjectState, result: DeployResult): Promise<void> {
    const items: { c: Candidate; at: string; label: string; now: string | undefined }[] = [];
    for (const c of candidates) {
      const path = remotePathOf(target, c.rel);
      let now: string | undefined;
      try {
        now = (await this.deps.sessions.call(connection, 'ifs.info', { name: connection, path })).change;
      } catch (err) {
        if (serverMessage(err)?.status !== 'NotFound') {
          result.failed.push(c.rel);
          this.deps.append(`Failed   ${c.rel} → ${path}: ${errorText(err, connection)}`);
          continue;
        }
      }
      items.push({ c, at: path, label: `${c.rel} (${path})`, now });
    }
    const choices = await this.resolveConflicts(p, items, result, state);
    const conflictSet = this.conflictSet(p);
    const total = items.reduce((n, x) => n + x.c.bytes.byteLength, 0);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Deploy to ${target}`, cancellable: true },
      async (progress, token) => {
        let before = 0;
        let shown = 0;
        let current: string | undefined;
        const report = (done: number, file: string) => {
          const pct = total > 0 ? Math.min(100, ((before + done) * 100) / total) : 100;
          progress.report({ increment: pct - shown, message: `${file} · ${formatSize(before + done)} of ${formatSize(total)}` });
          shown = pct;
        };
        const subs = [
          this.deps.onProgress?.((e) => {
            if (e.transfer === current) {
              report(e.done, e.path);
            }
          }),
          token.onCancellationRequested(() => {
            if (current) {
              void this.deps.sessions.call(connection, 'ifs.cancel', { name: connection, transfer: current }).catch(() => undefined);
            }
          }),
        ];
        try {
          for (const x of items) {
            const choice = choices.get(x.c.rel);
            if (choice === 'skip' || choice === 'pull') {
              continue;
            }
            if (token.isCancellationRequested) {
              result.skipped.push(x.c.rel);
              continue;
            }
            const recorded = baseline(x.c.record, x.at);
            const expect = choice === 'overwrite' || recorded === undefined ? undefined : String(recorded);
            current = `d${process.pid.toString(36)}-${Date.now().toString(36)}-${++this.transfers}`;
            report(0, x.at);
            try {
              const r = await this.deps.sessions.call(connection, 'deploy.path', {
                name: connection,
                from: x.c.file,
                path: x.at,
                ccsid: p.config.ifsCcsid,
                expect,
                transfer: current,
              });
              state.files[x.c.rel] = { hash: x.c.hash, remote: r.change ?? recorded ?? '', at: x.at };
              conflictSet.delete(x.c.rel);
              this.remember(connection, { kind: 'path', path: x.at }, vscode.Uri.file(x.c.file));
              result.deployed.push(x.c.rel);
              this.deps.append(`${r.outcome === 'created' ? 'Created ' : 'Deployed'} ${x.c.rel} → ${x.at}`);
            } catch (err) {
              if (isConflict(err)) {
                result.conflicts.push(x.c.rel);
                conflictSet.add(x.c.rel);
                this.deps.append(`Conflict ${x.c.rel}: ${x.at} changed on the system; not written`);
              } else if (err instanceof HostRpcError && err.code === IfsErrorCodes.Cancelled) {
                result.skipped.push(x.c.rel);
                this.deps.append(`Cancelled ${x.c.rel} → ${x.at}: the system has part of it; deploy again to replace it`);
              } else {
                result.failed.push(x.c.rel);
                this.deps.append(`Failed   ${x.c.rel} → ${x.at}: ${errorText(err, connection)}`);
              }
            }
            before += x.c.bytes.byteLength;
          }
        } finally {
          current = undefined;
          for (const s of subs) {
            s?.dispose();
          }
        }
      },
    );
    this.deps.projects.touch();
  }

  dispose(): void {
    this.finished.dispose();
  }
}

/** What a deployed member or stream file is known by. */
export function remoteKey(connection: string, at: { kind: 'member'; library: string; file: string; member: string } | { kind: 'path'; path: string }): string {
  const c = connection.toLowerCase();
  return at.kind === 'member' ? `${c}|${qualifiedMember({ library: at.library.toUpperCase(), file: at.file.toUpperCase(), member: at.member.toUpperCase() })}` : `${c}|${at.path}`;
}
