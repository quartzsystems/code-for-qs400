// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * **Initialize Project…**: a `qs400project.json` for a folder that has
 * its source already (or none yet), without pulling anything. The same
 * file and `.gitignore` line a pull writes.
 */

import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { libraryName } from '../connections/config';
import { PROJECT_FILE, type ProjectTarget } from './config';
import { ProjectDeps, projectOfFolder } from './pull';

/** The questions only Initialize asks, so the tests can answer them. */
export interface InitUi {
  /** The connection the project deploys over: `names` in order, the first the suggestion. */
  connection(names: string[]): Promise<string | undefined>;
  /** Whether the project goes to a library or an IFS directory; `suggested` first. */
  targetKind(suggested: ProjectTarget['kind']): Promise<ProjectTarget['kind'] | undefined>;
  /** Opens the new project file. */
  open(file: vscode.Uri): Promise<void>;
}

export const initPrompts: InitUi = {
  async connection(names) {
    if (names.length === 1) {
      return names[0];
    }
    return vscode.window.showQuickPick(names, { title: 'Initialize Project (1/2)', placeHolder: 'The connection this folder deploys over', ignoreFocusOut: true });
  },
  async targetKind(suggested) {
    const items = [
      { label: '$(library) Library', description: 'a directory per source file, a file per member', target: 'library' as const },
      { label: '$(folder-library) IFS directory', description: 'stream files, as they are', target: 'path' as const },
    ];
    items.sort((a, b) => (a.target === suggested ? -1 : b.target === suggested ? 1 : 0));
    const picked = await vscode.window.showQuickPick(items, { title: 'Initialize Project (2/2)', placeHolder: 'Where this folder deploys to', ignoreFocusOut: true });
    return picked?.target;
  },
  async open(file) {
    await vscode.window.showTextDocument(file);
  },
};

/** A source file's directory by its name: up to 10 characters ending in `SRC` after something (`QRPGLESRC`, `qddssrc`, not `src`). */
const SOURCE_FILE_DIR = /^[A-Za-z$#@][A-Za-z0-9$#@_]{0,6}SRC$/i;

/** What the folder's top level suggests: a directory named like a source file, or nothing yet, is a library project. */
export async function suggestedKind(folder: string): Promise<ProjectTarget['kind']> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(folder));
    const visible = entries.filter(([n]) => !n.startsWith('.'));
    if (visible.length === 0 || visible.some(([n, t]) => t === vscode.FileType.Directory && SOURCE_FILE_DIR.test(n))) {
      return 'library';
    }
    return 'path';
  } catch {
    return 'library';
  }
}

/** The connection names, the active one (or the only signed-on one) first. */
function connectionOrder(deps: ProjectDeps): string[] {
  const names = deps.store.list().map((c) => c.name);
  const signed = deps.sessions.signedOn().map((s) => s.name);
  const first = deps.sessions.active ?? (signed.length === 1 ? signed[0] : undefined);
  return first && names.includes(first) ? [first, ...names.filter((n) => n !== first)] : names;
}

/**
 * Asks for the folder, the connection, and the target, and writes the
 * project file. A folder that has one already gets it opened instead. The
 * project file's URI when one was written.
 */
export async function initializeProject(deps: ProjectDeps, ui: InitUi = initPrompts, folderArg?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const folder = folderArg ?? (await deps.ui.folder());
  if (!folder) {
    return undefined;
  }
  const existing = await projectOfFolder(deps.projects, folder);
  if (existing) {
    deps.ui.info(`${nodePath.basename(folder.fsPath)} already has a qs400project.json.`);
    await ui.open(existing.file);
    return undefined;
  }
  const names = connectionOrder(deps);
  if (names.length === 0) {
    deps.ui.info('Add a connection first.');
    return undefined;
  }
  const connection = await ui.connection(names);
  if (!connection) {
    return undefined;
  }
  const kind = await ui.targetKind(await suggestedKind(folder.fsPath));
  if (!kind) {
    return undefined;
  }
  const base = nodePath.basename(folder.fsPath);
  let target: ProjectTarget;
  if (kind === 'library') {
    const library = await deps.ui.targetLibrary(libraryName(base) ?? '');
    if (!library) {
      return undefined;
    }
    target = { kind: 'library', library };
  } else {
    const user = deps.store.get(connection)?.user.toLowerCase() ?? 'user';
    const path = await deps.ui.targetPath(`/home/${user}/${base}`);
    if (!path) {
      return undefined;
    }
    target = { kind: 'path', path };
  }
  await deps.projects.create(folder, { connection, target });
  const file = vscode.Uri.joinPath(folder, PROJECT_FILE);
  deps.append(`Project  ${base} → ${target.kind === 'library' ? target.library : target.path} on ${connection}`);
  await ui.open(file);
  return file;
}
