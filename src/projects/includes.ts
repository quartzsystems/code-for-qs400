// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { sameName } from '../connections/config';
import { includePath } from '../languages/includes';
import type { FetchedInclude, IncludeRequest, IncludesChangedParams } from '../languages/protocol';
import { ProjectConfig, isIgnored } from './config';
import { isMember, memberOf, relativeToTarget, remotePathOf } from './layout';
import { Project, ProjectStore, relativeTo } from './store';

type Usable = Project & { config: ProjectConfig };

/**
 * A directory's subdirectories named `name` without case, as they are on
 * disk. On a case-sensitive file system `QRPGLESRC/` and `qrpglesrc/` are
 * two directories that both stand for the source file, so each is searched.
 */
async function directoriesNamed(dir: string, name: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const upper = name.toUpperCase();
  return entries.filter((e) => e.isDirectory() && e.name.toUpperCase() === upper).map((e) => e.name);
}

/**
 * Includes from the workspace first: Phase 5's `qs400/fetchInclude` asks
 * here before the system. A `/COPY FILE,MEMBER` (or `/INCLUDE`) is
 * answered from `<folder>/FILE/MEMBER.*` of a library project on the
 * document's connection, the document's own project first; from a local
 * document the library is ignored, from a member or stream file it must
 * be `*LIBL`, `*CURLIB`, none, or the project's target library. A stream
 * file include is answered from an IFS project whose target holds the
 * path. Ignored files are not answers.
 */
export class WorkspaceIncludes {
  constructor(private readonly projects: ProjectStore) {}

  /** The connection a document's includes come from: its own, or its project's for a local file. */
  connectionOf(uri: vscode.Uri): string | undefined {
    const p = this.projects.projectFor(uri);
    return p ? this.projects.connectionOf(p) : undefined;
  }

  /** The projects to look in for a document, its own first; none for a document of another connection. */
  private candidates(doc: vscode.Uri, connection: string | undefined): { list: Usable[]; local: boolean } {
    const own = this.projects.projectFor(doc);
    const local = doc.scheme === 'file';
    const conn = own ? this.projects.connectionOf(own) : connection;
    const others = this.projects
      .usable()
      .filter((p) => p !== own && (conn === undefined || sameName(this.projects.connectionOf(p), conn)));
    return { list: own ? [own, ...others] : others, local };
  }

  /** The local file that answers `request` from document `uri`; null when no project has it. */
  async find(uri: string, request: IncludeRequest, connection: string | undefined): Promise<FetchedInclude | null> {
    let doc: vscode.Uri;
    try {
      doc = vscode.Uri.parse(uri, true);
    } catch {
      return null;
    }
    const { list, local } = this.candidates(doc, connection);
    if (request.path !== undefined && request.path !== null) {
      return this.findPath(doc, request, list);
    }
    const library = request.library.trim().toUpperCase();
    const file = request.file.trim().toUpperCase();
    const member = request.member.trim().toUpperCase();
    for (const p of list) {
      const t = p.config.target;
      if (t.kind !== 'library') {
        continue;
      }
      if (!local && library !== '' && !library.startsWith('*') && library !== t.library) {
        continue;
      }
      for (const dir of await directoriesNamed(p.folder.uri.fsPath, file)) {
        const found = await this.memberIn(p, dir, member);
        if (found !== undefined) {
          return { uri: vscode.Uri.file(found.at).toString(), at: { kind: 'member', library: t.library, file, member }, text: found.text };
        }
      }
    }
    return null;
  }

  /** The file of `member` in the project's directory `dir`, with its text; undefined when there is none. */
  private async memberIn(p: Usable, dir: string, member: string): Promise<{ at: string; text: string } | undefined> {
    let entries: string[];
    try {
      entries = (await fs.readdir(nodePath.join(p.folder.uri.fsPath, dir), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return undefined;
    }
    const hit = entries
      .map((n) => ({ n, m: memberOf(`${dir}/${n}`) }))
      .find((x) => isMember(x.m) && x.m.member === member && !isIgnored(`${dir}/${x.n}`, p.config.ignore));
    if (!hit) {
      return undefined;
    }
    const at = nodePath.join(p.folder.uri.fsPath, dir, hit.n);
    try {
      return { at, text: await fs.readFile(at, 'utf8') };
    } catch {
      return undefined;
    }
  }

  private async findPath(doc: vscode.Uri, r: IncludeRequest, list: Usable[]): Promise<FetchedInclude | null> {
    const path = r.path as string;
    for (const p of list) {
      const t = p.config.target;
      if (t.kind !== 'path') {
        continue;
      }
      let rel: string | undefined;
      if (doc.scheme === 'file' && !path.startsWith('/')) {
        // Relative to the including local file's directory.
        const local = vscode.Uri.file(nodePath.join(nodePath.dirname(doc.fsPath), path));
        rel = relativeTo(p.folder.uri, local);
      } else {
        const remote = includePath(path, doc.scheme === 'file' ? '' : r.file);
        rel = relativeToTarget(t.path, remote);
      }
      if (!rel || isIgnored(rel, p.config.ignore)) {
        continue;
      }
      const at = nodePath.join(p.folder.uri.fsPath, ...rel.split('/'));
      try {
        const text = await fs.readFile(at, 'utf8');
        return { uri: vscode.Uri.file(at).toString(), at: { kind: 'path', path: remotePathOf(t.path, rel) }, text };
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * What a save of a local file tells the language servers: the member or
   * stream file it stands for, so every document that included it reads
   * it again. Undefined for a file in no project.
   */
  changed(uri: vscode.Uri): IncludesChangedParams | undefined {
    const p = this.projects.projectFor(uri);
    const rel = p ? relativeTo(p.folder.uri, uri) : undefined;
    if (!p || !rel) {
      return undefined;
    }
    const connection = this.projects.connectionOf(p);
    const t = p.config.target;
    if (t.kind === 'path') {
      return { connection, member: { kind: 'path', path: remotePathOf(t.path, rel) } };
    }
    const m = memberOf(rel);
    return isMember(m) ? { connection, member: { kind: 'member', library: t.library, file: m.file, member: m.member } } : undefined;
  }
}
