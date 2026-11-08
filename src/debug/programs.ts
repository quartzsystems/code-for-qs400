// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import type { SessionManager } from '../connections/sessions';
import type { ObjectEntry } from '../host/protocol';
import { parseMemberUri } from '../members/uri';
import { isMember, memberOf } from '../projects/layout';
import { ProjectStore, relativeTo } from '../projects/store';

/** The program a document compiles to, and on which connection. */
export interface ProgramOf {
  connection: string;
  /** `LIB/PGM`. */
  program: string;
}

/**
 * `LIB/PGM` the default compile makes of a document: a member's program
 * is in the current library (`&LIBRARY`, Phase 4), `*LIBL` when there is
 * none; a library project's file's in the project's target library.
 */
export async function programOfDocument(uri: vscode.Uri, sessions: SessionManager, projects: ProjectStore): Promise<ProgramOf | undefined> {
  const m = parseMemberUri(uri);
  if (m?.kind === 'member') {
    let current: string | null = null;
    try {
      current = (await sessions.call(m.connection, 'libl.get', { name: m.connection })).current;
    } catch {
      current = null;
    }
    return { connection: m.connection, program: `${current ?? '*LIBL'}/${m.member}` };
  }
  const p = projects.projectFor(uri);
  if (p && p.config.target.kind === 'library') {
    const rel = relativeTo(p.folder.uri, uri);
    const lm = rel ? memberOf(rel) : undefined;
    if (lm && isMember(lm)) {
      return { connection: projects.connectionOf(p), program: `${p.config.target.library}/${lm.member}` };
    }
  }
  return undefined;
}

/** `LIB/PGM` of an Objects view entry that is a program. */
export function programOfEntry(entry: Pick<ObjectEntry, 'library' | 'object' | 'type'>): string | undefined {
  return entry.type.toUpperCase() === '*PGM' ? `${entry.library}/${entry.object}` : undefined;
}
