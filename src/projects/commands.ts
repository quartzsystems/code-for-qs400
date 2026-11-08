// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { DeployScope, Deployer, UsableProject } from './deploy';
import { ProjectDeps, Puller } from './pull';
import { relativeTo } from './store';

type Node = Record<string, unknown> & { kind?: string; connection?: string };

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * The pull commands, from the palette and from the Objects and IFS views:
 * **Pull Library…** (a library node, or the pick), **Pull Source File**
 * (a source file node), **Pull Member** (a member node), **Pull into
 * Project** (a stream file, a directory or an IFS root).
 */
export function registerPullCommands(deps: ProjectDeps, puller: Puller): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('code-for-qs400.pull.library', (n?: Node) =>
      puller.pullLibrary(n?.kind === 'library' ? { connection: str(n.connection), library: str(n.library) } : undefined),
    ),
    vscode.commands.registerCommand('code-for-qs400.pull.sourceFile', (n?: Node) => {
      const e = n?.entry as { library?: string; object?: string } | undefined;
      const connection = str(n?.connection);
      if (n?.kind !== 'object' || !connection || !e?.library || !e.object) {
        deps.ui.info('Pick a source file in the Objects view to pull it.');
        return undefined;
      }
      return puller.pullSourceFiles(deps.store.get(connection)?.name ?? connection, e.library, [e.object]);
    }),
    vscode.commands.registerCommand('code-for-qs400.pull.member', (n?: Node, many?: Node[]) => {
      const nodes = (many && many.length > 0 ? many : n ? [n] : []).filter((x) => x.kind === 'member');
      const first = nodes[0];
      const connection = str(first?.connection);
      if (!first || !connection) {
        deps.ui.info('Pick a member in the Objects view to pull it.');
        return undefined;
      }
      const library = String(first.library);
      const items = nodes
        .filter((x) => x.connection === first.connection && x.library === first.library)
        .map((x) => ({ library, file: String(x.file), entry: x.entry as never }));
      return puller.pullMembers(deps.store.get(connection)?.name ?? connection, library, items);
    }),
    vscode.commands.registerCommand('code-for-qs400.pull.path', (n?: Node) => {
      const connection = str(n?.connection);
      const path = str(n?.path);
      if (!n || !connection || !path || (n.kind !== 'root' && n.kind !== 'entry')) {
        deps.ui.info('Pick a file or a folder in the IFS view to pull it.');
        return undefined;
      }
      const kind = n.kind === 'root' || (n.entry as { kind?: string } | undefined)?.kind === 'directory' ? 'directory' : 'file';
      return puller.pullPath(deps.store.get(connection)?.name ?? connection, path, kind);
    }),
  ];
}

/** What a deploy command is handed: a file URI (editor title, Explorer), a Project view node, or nothing. */
export type ProjectArg = vscode.Uri | { kind?: string; folder?: vscode.Uri; rel?: string } | undefined;

/**
 * The project a command acts on, and the local file it names if any: the
 * one handed in, else the active editor's, else the only project, else the
 * pick.
 */
export async function projectOf(deps: ProjectDeps, arg: ProjectArg): Promise<{ project: UsableProject; rel?: string } | undefined> {
  const projects = deps.projects;
  await projects.ready;
  const fromUri = (uri: vscode.Uri) => {
    const project = projects.projectFor(uri);
    return project ? { project, rel: relativeTo(project.folder.uri, uri) } : undefined;
  };
  if (arg instanceof vscode.Uri) {
    return fromUri(arg);
  }
  if (arg && typeof arg === 'object' && arg.folder instanceof vscode.Uri) {
    const project = projects.usable().find((p) => p.folder.uri.toString() === (arg.folder as vscode.Uri).toString());
    return project ? { project, rel: arg.rel } : undefined;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const a = active ? fromUri(active) : undefined;
  if (a) {
    return a;
  }
  const all = projects.usable();
  if (all.length === 1) {
    return { project: all[0] };
  }
  if (all.length === 0) {
    deps.ui.info('No workspace folder has a qs400project.json. Pull a library into a folder to make one.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    all.map((p) => ({ label: p.folder.name, description: p.config.target.kind === 'library' ? p.config.target.library : p.config.target.path, p })),
    { title: 'Project', placeHolder: 'The project to deploy' },
  );
  return picked ? { project: picked.p } : undefined;
}

/** **Deploy changed**, **Deploy all**, **Deploy git-changed** and **Deploy** of one file. */
export function registerDeployCommands(deps: ProjectDeps, deployer: Deployer): vscode.Disposable[] {
  const run = (scope: DeployScope) => async (arg?: ProjectArg) => {
    const got = await projectOf(deps, arg);
    if (!got) {
      return undefined;
    }
    if (scope === 'file') {
      const rel = got.rel ?? (vscode.window.activeTextEditor ? relativeTo(got.project.folder.uri, vscode.window.activeTextEditor.document.uri) : undefined);
      if (!rel) {
        deps.ui.info('Open a file of the project to deploy it.');
        return undefined;
      }
      deps.showOutput?.();
      return deployer.deploy(got.project, 'file', rel);
    }
    deps.showOutput?.();
    return deployer.deploy(got.project, scope);
  };
  return [
    vscode.commands.registerCommand('code-for-qs400.deploy.changed', run('changed')),
    vscode.commands.registerCommand('code-for-qs400.deploy.all', run('all')),
    vscode.commands.registerCommand('code-for-qs400.deploy.git', run('git')),
    vscode.commands.registerCommand('code-for-qs400.deploy.file', run('file')),
  ];
}
