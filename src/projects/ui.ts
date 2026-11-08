// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { libraryName } from '../connections/config';
import { BLOCK_START, timestamp } from '../actions/output';

/** What a conflict is resolved with: the local file replaces the member, the member replaces the local file, or nothing. */
export type ConflictChoice = 'overwrite' | 'pull' | 'skip';

/**
 * The questions deploy and pull ask, behind one interface so the tests
 * can answer them. `ProjectPrompts` asks them with VS Code's own modal
 * messages and input boxes.
 */
export interface ProjectUi {
  /** A local file in conflict: the system changed it since the last deploy or pull. */
  conflict(label: string, detail: string): Promise<ConflictChoice>;
  /** A pull over a local file changed since the last deploy or pull: true replaces it. */
  overwriteLocal(rel: string): Promise<boolean>;
  /** Source files a deploy would create first, with `CRTSRCPF`: true creates them. */
  createSourceFiles(library: string, files: string[]): Promise<boolean>;
  /** The target library of a new project, offered `suggested`. */
  targetLibrary(suggested: string): Promise<string | undefined>;
  /** The target IFS directory of a new project, offered `suggested`. */
  targetPath(suggested: string): Promise<string | undefined>;
  /** The workspace folder a pull or a new project goes to. */
  folder(): Promise<vscode.Uri | undefined>;
  info(message: string): void;
  error(message: string): void;
}

export class ProjectPrompts implements ProjectUi {
  async conflict(label: string, detail: string): Promise<ConflictChoice> {
    const picked = await vscode.window.showWarningMessage(
      `${label} changed on the system since it was last deployed or pulled.`,
      { modal: true, detail },
      'Overwrite',
      'Pull',
      'Skip',
    );
    return picked === 'Overwrite' ? 'overwrite' : picked === 'Pull' ? 'pull' : 'skip';
  }

  async overwriteLocal(rel: string): Promise<boolean> {
    const picked = await vscode.window.showWarningMessage(
      `${rel} has local changes since the last deploy or pull.`,
      { modal: true, detail: 'Overwrite replaces it with the system’s copy. Keep leaves it as it is.' },
      'Overwrite',
      'Keep',
    );
    return picked === 'Overwrite';
  }

  async createSourceFiles(library: string, files: string[]): Promise<boolean> {
    const picked = await vscode.window.showWarningMessage(
      `Create ${files.length === 1 ? 'source file' : `${files.length} source files`} in ${library}?`,
      { modal: true, detail: files.map((f) => `CRTSRCPF FILE(${library}/${f}) RCDLEN(112)`).join('\n') },
      'Create',
    );
    return picked === 'Create';
  }

  async targetLibrary(suggested: string): Promise<string | undefined> {
    const v = await vscode.window.showInputBox({
      title: 'Project target library',
      prompt: 'The library this folder deploys to',
      value: suggested,
      ignoreFocusOut: true,
      validateInput: (s) => (libraryName(s) ? undefined : 'Enter a library name: up to 10 characters.'),
    });
    return v === undefined ? undefined : libraryName(v);
  }

  async targetPath(suggested: string): Promise<string | undefined> {
    const v = await vscode.window.showInputBox({
      title: 'Project target directory',
      prompt: 'The IFS directory this folder deploys to',
      value: suggested,
      ignoreFocusOut: true,
      validateInput: (s) => (s.trim().startsWith('/') ? undefined : 'Enter an absolute IFS path.'),
    });
    return v?.trim();
  }

  async folder(): Promise<vscode.Uri | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    if (folders.length === 1) {
      return folders[0].uri;
    }
    if (folders.length > 1) {
      const picked = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
        { title: 'Workspace folder', placeHolder: 'The folder the project is in' },
      );
      return picked?.folder.uri;
    }
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use Folder' });
    return picked?.[0];
  }

  info(message: string): void {
    void vscode.window.showInformationMessage(message);
  }

  error(message: string): void {
    void vscode.window.showErrorMessage(message);
  }
}

/** The output block's first line, as Phase 4's: the time, what ran, on what, and the connection last. */
export function blockHeader(when: Date, what: string, target: string, connection: string): string {
  return `${BLOCK_START}${timestamp(when)} · ${what} · ${target} · ${connection}`;
}
