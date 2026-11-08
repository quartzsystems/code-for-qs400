// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { ProjectDeps, Puller } from './pull';

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
