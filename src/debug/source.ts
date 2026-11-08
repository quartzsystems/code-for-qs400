// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import type { ObjectProperty } from '../host/protocol';
import { ifsUri } from '../ifs/uri';
import { memberUri } from '../members/uri';

/** The adapter's event, and the request that answers it. */
export const DEBUG_SOURCE = 'qs400/debugSource';

/** `object.properties` labels the system gives a compiled object's source (`DSPOBJD DETAIL(*FULL)`). */
export const SOURCE_FILE_LABEL = 'Source file';
export const SOURCE_MEMBER_LABEL = 'Source member';
export const ATTRIBUTE_LABEL = 'Attribute';

/** What resolving needs from the window. */
export interface DebugSourceDeps {
  /** `object.properties`; throws when the object is not there. */
  properties(connection: string, library: string, object: string, type: string): Promise<ObjectProperty[]>;
  /** The local project file a member deploys from: Phase 8's deploy map, else a project's layout. */
  localMember(connection: string, library: string, file: string, member: string): Promise<vscode.Uri | undefined>;
  /** The local project file a stream file deploys from. */
  localPath(connection: string, path: string): Promise<vscode.Uri | undefined>;
}

/** The answer's source: a file system path for a local file, a URI string otherwise. */
export interface DebugSourceAnswer {
  path: string;
  name: string;
}

function attribute(props: ObjectProperty[], label: string): string | undefined {
  const v = props.find((p) => p.name.trim().toLowerCase() === label.toLowerCase())?.value.trim();
  return v === '' ? undefined : v;
}

/** The path DAP is given for `uri`. */
export function sourcePath(uri: vscode.Uri): DebugSourceAnswer {
  const path = uri.scheme === 'file' ? uri.fsPath : uri.toString();
  return { path, name: nodePath.posix.basename(uri.path) };
}

/**
 * Where `program`'s `module` was compiled from: the `*MODULE`'s properties
 * (a bound program's own module is gone after `CRTBNDRPG`, so the `*PGM`'s
 * when the module has the program's name) name a source file and member,
 * or a stream file. In order: the local project file it deploys from, the
 * member read-only, the stream file. Null when nothing names one: the
 * adapter then shows the synthetic statements.
 */
export async function resolveDebugSource(
  deps: DebugSourceDeps,
  connection: string,
  program: string,
  module: string,
): Promise<DebugSourceAnswer | null> {
  const [library, name] = program.trim().toUpperCase().split('/', 2);
  const mod = module.trim().toUpperCase();
  if (!library || !name || !mod) {
    return null;
  }
  const tries: Array<[string, string]> = [[mod, '*MODULE']];
  if (mod === name) {
    tries.push([name, '*PGM'], [name, '*SRVPGM']);
  }
  for (const [object, objectType] of tries) {
    let props: ObjectProperty[];
    try {
      props = await deps.properties(connection, library, object, objectType);
    } catch {
      continue;
    }
    const file = attribute(props, SOURCE_FILE_LABEL);
    if (!file) {
      continue;
    }
    if (file.startsWith('/')) {
      const local = await deps.localPath(connection, file);
      return sourcePath(local ?? ifsUri(connection, file));
    }
    const member = attribute(props, SOURCE_MEMBER_LABEL);
    const [srcLib, srcFile] = file.toUpperCase().split('/', 2);
    if (!member || !srcLib || !srcFile) {
      continue;
    }
    const local = await deps.localMember(connection, srcLib, srcFile, member.toUpperCase());
    if (local) {
      return sourcePath(local);
    }
    const type = attribute(props, ATTRIBUTE_LABEL) ?? '';
    return sourcePath(memberUri(connection, srcLib, srcFile, member, type, true));
  }
  return null;
}
