// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { errorText } from '../connections/prompts';
import { ifsUri } from '../ifs/uri';
import { memberUri } from '../members/uri';
import { Deployer, UsableProject, fileNames } from '../projects/deploy';
import { contentHash, isMember, memberKey, memberOf, remotePathOf } from '../projects/layout';
import { FileRow, STATUS_ICON, STATUS_LABEL, fileRows, groupByDir, pendingCount, statusBarText } from '../projects/model';
import { ProjectDeps, Puller } from '../projects/pull';
import { relativeTo } from '../projects/store';

export type ProjectNode =
  | { kind: 'message'; text: string }
  | { kind: 'project'; project: UsableProject; folder: vscode.Uri }
  | { kind: 'info'; label: string; description: string; icon: string }
  | { kind: 'dir'; project: UsableProject; folder: vscode.Uri; dir: string; rows: FileRow[] }
  | { kind: 'ignored'; project: UsableProject; folder: vscode.Uri; rows: FileRow[] }
  | { kind: 'file'; project: UsableProject; folder: vscode.Uri; rel: string; row: FileRow };

interface Scan {
  rows: FileRow[];
  /** The system's timestamps, by local path, as the last Refresh read them. */
  remote: Map<string, number | string>;
}

/** A project's member or stream file on the system, read-only for a diff. */
export function remoteUri(p: UsableProject, connection: string, rel: string, readonly: boolean): vscode.Uri | undefined {
  const t = p.config.target;
  if (t.kind === 'path') {
    return ifsUri(connection, remotePathOf(t.path, rel));
  }
  const m = memberOf(rel);
  return isMember(m) ? memberUri(connection, t.library, m.file, m.member, m.type, readonly) : undefined;
}

/**
 * The **Project** view: each workspace folder with a `qs400project.json`,
 * its connection and target, then its files by directory with their
 * state (Deployed, Changed, New, Conflict) and the ignored ones folded
 * away. **Refresh** also reads the system's timestamps, so a change made
 * there shows as Conflict before a deploy finds it. The status bar counts
 * the active folder's files to deploy.
 */
export class ProjectView implements vscode.TreeDataProvider<ProjectNode>, vscode.Disposable {
  private readonly scans = new Map<string, Scan>();
  private readonly emitter = new vscode.EventEmitter<ProjectNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly statusBar = vscode.window.createStatusBarItem('code-for-qs400.project', vscode.StatusBarAlignment.Left, 1);
  private readonly subscriptions: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: ProjectDeps,
    private readonly deployer: Deployer,
  ) {
    this.statusBar.name = 'QS/400 project';
    this.statusBar.command = 'code-for-qs400.deploy.changed';
    this.subscriptions.push(
      this.statusBar,
      deps.projects.onDidChange(() => this.soon()),
      deployer.onDidDeploy(() => this.soon()),
      vscode.window.onDidChangeActiveTextEditor(() => this.showStatus()),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (deps.projects.projectFor(d.uri)) {
          this.soon();
        }
      }),
    );
    this.soon();
  }

  /** Scans again shortly: saves, deploys and file events come in bursts. */
  private soon(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.rescan(), 150);
  }

  /** Each project's files and their state, from the disk and state.json; nothing is asked of the system. */
  async rescan(): Promise<void> {
    this.timer = undefined;
    const projects = this.deps.projects.usable();
    this.rewatch(projects);
    for (const p of projects) {
      await this.scan(p, this.scans.get(p.folder.uri.toString())?.remote ?? new Map());
    }
    for (const k of [...this.scans.keys()]) {
      if (!projects.some((p) => p.folder.uri.toString() === k)) {
        this.scans.delete(k);
      }
    }
    this.emitter.fire(undefined);
    this.showStatus();
  }

  private rewatch(projects: UsableProject[]): void {
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = projects.flatMap((p) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(p.folder.uri, '**/*'), false, true, false);
      return [w, w.onDidCreate(() => this.soon()), w.onDidDelete(() => this.soon())];
    });
  }

  private async scan(p: UsableProject, remote: Map<string, number | string>): Promise<Scan> {
    const { files, ignored } = await this.deps.projects.files(p);
    const state = await this.deps.projects.readState(p);
    const kind = p.config.target.kind === 'library' ? 'member' : 'path';
    const hashes = new Map<string, string>();
    for (const rel of files) {
      try {
        hashes.set(rel, contentHash(await fs.readFile(nodePath.join(p.folder.uri.fsPath, ...rel.split('/'))), kind));
      } catch {
        // Gone since the walk.
      }
    }
    const conflicts = this.deployer.conflicts.get(p.folder.uri.toString()) ?? new Set<string>();
    const scan = { rows: fileRows(p.config.target, files, ignored, hashes, state, remote, conflicts), remote };
    this.scans.set(p.folder.uri.toString(), scan);
    return scan;
  }

  /** **Refresh**: scans again and reads the system's timestamps of each signed-on project. */
  async refresh(): Promise<void> {
    for (const p of this.deps.projects.usable()) {
      const connection = this.deps.projects.connectionOf(p);
      const remote = new Map<string, number | string>();
      if (this.deps.sessions.status(connection).state === 'connected') {
        try {
          await this.readRemote(p, connection, remote);
        } catch (err) {
          this.deps.append(`Project ${p.folder.name}: the system's timestamps could not be read: ${errorText(err, connection)}`);
        }
      }
      await this.scan(p, remote);
    }
    this.emitter.fire(undefined);
    this.showStatus();
  }

  private async readRemote(p: UsableProject, connection: string, remote: Map<string, number | string>): Promise<void> {
    const { files } = await this.deps.projects.files(p);
    const t = p.config.target;
    if (t.kind === 'library') {
      const byDir = new Map<string, string[]>();
      for (const rel of files) {
        const m = memberOf(rel);
        if (isMember(m)) {
          byDir.set(m.file, [...(byDir.get(m.file) ?? []), rel]);
        }
      }
      const sourceFiles = await fileNames(this.deps.sessions, connection, t.library);
      for (const [file, rels] of byDir) {
        if (!sourceFiles.has(file)) {
          continue;
        }
        const changed = new Map((await this.deps.sessions.call(connection, 'member.list', { name: connection, library: t.library, file })).map((e) => [memberKey(file, e.member), e.changed]));
        for (const rel of rels) {
          const m = memberOf(rel);
          const c = isMember(m) ? changed.get(memberKey(m.file, m.member)) : undefined;
          if (c !== undefined) {
            remote.set(rel, c);
          }
        }
      }
      return;
    }
    for (const rel of files) {
      try {
        remote.set(rel, (await this.deps.sessions.call(connection, 'ifs.info', { name: connection, path: remotePathOf(t.path, rel) })).change);
      } catch {
        // Not there: new.
      }
    }
  }

  /** The project the status bar counts: the active editor's, else the only one. */
  private statusProject(): UsableProject | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const own = uri ? this.deps.projects.projectFor(uri) : undefined;
    const all = this.deps.projects.usable();
    return own ?? (all.length === 1 ? all[0] : undefined);
  }

  private showStatus(): void {
    const p = this.statusProject();
    const scan = p ? this.scans.get(p.folder.uri.toString()) : undefined;
    if (!p || !scan) {
      this.statusBar.hide();
      return;
    }
    const t = p.config.target;
    this.statusBar.text = statusBarText(scan.rows);
    this.statusBar.tooltip = `${p.folder.name}: ${pendingCount(scan.rows)} files to deploy to ${t.kind === 'library' ? t.library : t.path} on ${this.deps.projects.connectionOf(p)}. Click to deploy them.`;
    this.statusBar.show();
  }

  /** The rows of a project, as last scanned. */
  rows(p: UsableProject): FileRow[] {
    return this.scans.get(p.folder.uri.toString())?.rows ?? [];
  }

  getTreeItem(n: ProjectNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (n.kind) {
      case 'message':
        return new vscode.TreeItem(n.text, C.None);
      case 'project': {
        const t = n.project.config.target;
        const i = new vscode.TreeItem(n.project.folder.name, C.Expanded);
        i.id = `project:${n.folder.toString()}`;
        i.description = `${this.deps.projects.connectionOf(n.project)} · ${t.kind === 'library' ? t.library : t.path}`;
        i.iconPath = new vscode.ThemeIcon('root-folder');
        i.contextValue = 'project.project';
        i.tooltip = n.folder.fsPath;
        return i;
      }
      case 'info': {
        const i = new vscode.TreeItem(n.label, C.None);
        i.description = n.description;
        i.iconPath = new vscode.ThemeIcon(n.icon);
        i.contextValue = 'project.info';
        return i;
      }
      case 'dir': {
        const i = new vscode.TreeItem(n.dir === '' ? '(folder)' : n.dir, C.Expanded);
        i.id = `project:${n.folder.toString()}:dir:${n.dir}`;
        const pending = pendingCount(n.rows);
        i.description = pending > 0 ? `${pending} to deploy` : undefined;
        i.iconPath = vscode.ThemeIcon.Folder;
        i.contextValue = 'project.dir';
        return i;
      }
      case 'ignored': {
        const i = new vscode.TreeItem('Ignored', C.Collapsed);
        i.id = `project:${n.folder.toString()}:ignored`;
        i.description = String(n.rows.length);
        i.iconPath = new vscode.ThemeIcon(STATUS_ICON.ignored);
        i.contextValue = 'project.ignored';
        return i;
      }
      case 'file': {
        const r = n.row;
        const i = new vscode.TreeItem(n.row.status === 'ignored' ? r.rel : r.name, C.None);
        i.id = `project:${n.folder.toString()}:file:${r.rel}`;
        i.description = STATUS_LABEL[r.status];
        const color =
          r.status === 'conflict'
            ? new vscode.ThemeColor('list.warningForeground')
            : r.status === 'changed'
              ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
              : r.status === 'new'
                ? new vscode.ThemeColor('gitDecoration.untrackedResourceForeground')
                : undefined;
        i.iconPath = new vscode.ThemeIcon(STATUS_ICON[r.status], color);
        i.resourceUri = vscode.Uri.file(nodePath.join(n.folder.fsPath, ...r.rel.split('/')));
        i.tooltip = `${r.rel} · ${STATUS_LABEL[r.status]}${r.at ? ` · ${r.at}` : ''}`;
        i.command = { command: 'vscode.open', title: 'Open', arguments: [i.resourceUri] };
        i.contextValue = r.status === 'ignored' ? 'project.file.ignored' : r.at ? 'project.file.remote' : 'project.file';
        return i;
      }
    }
  }

  getChildren(n?: ProjectNode): ProjectNode[] {
    if (!n) {
      const all = this.deps.projects.usable();
      if (all.length === 0) {
        return [];
      }
      return all.map((project) => ({ kind: 'project' as const, project, folder: project.folder.uri }));
    }
    if (n.kind === 'project') {
      const t = n.project.config.target;
      const rows = this.rows(n.project);
      const groups = groupByDir(rows);
      const ignored = rows.filter((r) => r.status === 'ignored');
      return [
        { kind: 'info', label: 'Connection', description: this.deps.projects.connectionOf(n.project), icon: 'plug' },
        { kind: 'info', label: t.kind === 'library' ? 'Library' : 'Path', description: t.kind === 'library' ? t.library : t.path, icon: t.kind === 'library' ? 'library' : 'folder-library' },
        ...groups.map((g) => ({ kind: 'dir' as const, project: n.project, folder: n.folder, dir: g.dir, rows: g.rows })),
        ...(ignored.length > 0 ? [{ kind: 'ignored' as const, project: n.project, folder: n.folder, rows: ignored }] : []),
      ];
    }
    if (n.kind === 'dir' || n.kind === 'ignored') {
      return n.rows.map((row) => ({ kind: 'file' as const, project: n.project, folder: n.folder, rel: row.rel, row }));
    }
    return [];
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const w of this.watchers) {
      w.dispose();
    }
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.emitter.dispose();
  }
}

type FileArg = { kind?: string; project?: UsableProject; folder?: vscode.Uri; rel?: string } | vscode.Uri | undefined;

/** The project and local path a file command is handed: a Project view node, or a file URI. */
function fileOf(deps: ProjectDeps, arg: FileArg): { project: UsableProject; rel: string } | undefined {
  if (arg instanceof vscode.Uri) {
    const project = deps.projects.projectFor(arg);
    const rel = project ? relativeTo(project.folder.uri, arg) : undefined;
    return project && rel ? { project, rel } : undefined;
  }
  return arg?.project && arg.rel ? { project: arg.project, rel: arg.rel } : undefined;
}

/** The Project view's commands: Refresh and Pull on its title bar, Pull, Diff with System and Open on System on a file. */
export function registerProjectViewCommands(view: ProjectView, deps: ProjectDeps, puller: Puller): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('code-for-qs400.project.refresh', () => view.refresh()),
    vscode.commands.registerCommand('code-for-qs400.project.pull', async (arg?: { project?: UsableProject }) => {
      const all = deps.projects.usable();
      const p =
        arg?.project ??
        (all.length === 1
          ? all[0]
          : (await vscode.window.showQuickPick(all.map((x) => ({ label: x.folder.name, x })), { title: 'Pull into project' }))?.x);
      if (!p) {
        return undefined;
      }
      const connection = deps.projects.connectionOf(p);
      const t = p.config.target;
      if (t.kind === 'path') {
        return puller.pullPath(connection, t.path, 'directory', p.folder.uri);
      }
      try {
        const files = await deps.sessions.call(connection, 'object.list', { name: connection, library: t.library, pattern: '*ALL', types: ['*FILE'], attribute: 'PF-SRC' });
        return await puller.pullSourceFiles(connection, t.library, files.map((f) => f.object), p.folder.uri);
      } catch (err) {
        deps.ui.error(errorText(err, connection));
        return undefined;
      }
    }),
    vscode.commands.registerCommand('code-for-qs400.project.pullFile', async (arg?: FileArg) => {
      const f = fileOf(deps, arg);
      if (!f) {
        return;
      }
      try {
        await puller.pullOne(f.project, f.rel, { keepHash: false });
      } catch (err) {
        deps.ui.error(`${f.rel}: ${errorText(err)}`);
      }
    }),
    vscode.commands.registerCommand('code-for-qs400.project.diff', async (arg?: FileArg) => {
      const f = fileOf(deps, arg);
      const connection = f ? deps.projects.connectionOf(f.project) : undefined;
      const remote = f && connection ? remoteUri(f.project, connection, f.rel, true) : undefined;
      if (!f || !remote) {
        return;
      }
      const local = vscode.Uri.file(nodePath.join(f.project.folder.uri.fsPath, ...f.rel.split('/')));
      await vscode.commands.executeCommand('vscode.diff', remote, local, `${f.rel} (system ↔ local)`);
    }),
    vscode.commands.registerCommand('code-for-qs400.project.openRemote', async (arg?: FileArg) => {
      const f = fileOf(deps, arg);
      const connection = f ? deps.projects.connectionOf(f.project) : undefined;
      const remote = f && connection ? remoteUri(f.project, connection, f.rel, false) : undefined;
      if (remote) {
        await vscode.commands.executeCommand('vscode.open', remote);
      }
    }),
  ];
}
