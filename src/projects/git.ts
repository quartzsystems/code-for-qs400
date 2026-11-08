// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import type { GitChanges } from './deploy';
import { relativeTo } from './store';

/** The part of the built-in git extension's API (`vscode.git`, `getAPI(1)`) that **Deploy git-changed** reads. */
export interface GitApi {
  readonly repositories: readonly GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly workingTreeChanges: readonly { readonly uri: vscode.Uri }[];
    readonly indexChanges: readonly { readonly uri: vscode.Uri }[];
    readonly untrackedChanges?: readonly { readonly uri: vscode.Uri }[];
    readonly mergeChanges?: readonly { readonly uri: vscode.Uri }[];
  };
  /** Reads the working tree again; a `git stash` outside VS Code shows after it. */
  status?(): Promise<void>;
}

/**
 * The files git reports changed (staged, unstaged, in a merge) or
 * untracked under a folder, relative to it. The API comes from the
 * built-in git extension when it is enabled; a folder in no repository,
 * or no git at all, is undefined.
 */
export class GitApiChanges implements GitChanges {
  constructor(private readonly api: () => Promise<GitApi | undefined> = builtInGit) {}

  async changed(folder: vscode.Uri): Promise<string[] | undefined> {
    const api = await this.api();
    const repo = api?.getRepository(folder) ?? api?.repositories.find((r) => relativeTo(r.rootUri, folder) !== undefined || r.rootUri.fsPath === folder.fsPath);
    if (!repo) {
      return undefined;
    }
    try {
      await repo.status?.();
    } catch {
      // What the extension knows already.
    }
    const s = repo.state;
    const rels = new Set<string>();
    for (const c of [...s.workingTreeChanges, ...s.indexChanges, ...(s.untrackedChanges ?? []), ...(s.mergeChanges ?? [])]) {
      const rel = relativeTo(folder, c.uri);
      if (rel !== undefined) {
        rels.add(rel);
      }
    }
    return [...rels].sort();
  }
}

/** `vscode.git`'s API, activated if it is not yet; undefined when the extension is disabled. */
async function builtInGit(): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi; enabled?: boolean }>('vscode.git');
  if (!ext) {
    return undefined;
  }
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports.enabled === false ? undefined : exports.getAPI(1);
  } catch {
    return undefined;
  }
}
