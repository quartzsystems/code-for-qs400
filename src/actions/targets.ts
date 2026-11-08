// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * What an action runs against, and the value of each variable for it. No
 * `vscode` import.
 *
 * | Variable | member | file (IFS) | object |
 * | --- | --- | --- | --- |
 * | `&LIBRARY` | the current library, or the one asked for | the same | the object's library |
 * | `&NAME` | the member | the file's name without its extension, upper case | the object |
 * | `&TYPE` | the member's source type | the extension, upper case | the object type (`*PGM`) |
 * | `&EXT` | the extension of its URI | the extension | the object's attribute, lower case |
 * | `&SRCFILE`, `&SRCLIB` | its file and library | — | — |
 * | `&FULLPATH`, `&PARENT`, `&BASENAME`, `&BASENAMEEXT` | — | the path, its folder, the name without and with its extension | — |
 *
 * `&CURLIB`, `&USERNAME`, `&HOST` and `&CUSTOM:NAME` come from the
 * connection for every target. A variable with no value is unresolved.
 */

import { baseName, parentPath } from '../ifs/paths';
import { extensionOf } from '../ifs/types';
import { memberType } from '../members/types';
import { Environment, MatchTarget } from './model';
import { CUSTOM_PREFIX, ConnectionValues, Substituted, substitute, variablesIn } from './variables';

export type ActionTarget =
  | { environment: 'member'; connection: string; library: string; file: string; member: string; type: string; ext?: string }
  | { environment: 'file'; connection: string; path: string }
  | { environment: 'object'; connection: string; library: string; object: string; type: string; attribute: string };

/** What the connection and the run give every target. */
export interface ResolveContext {
  connection: ConnectionValues;
  /** The connection job's current library; none when it has none. */
  curlib?: string;
  /** The library a member's or a file's `&LIBRARY` was given when there is no current library. */
  library?: string;
}

/** A member's URI extension: the one it was opened with, else its type's. */
function memberExt(t: Extract<ActionTarget, { environment: 'member' }>): string {
  return (t.ext ?? memberType(t.type).ext).toLowerCase();
}

/** The names an action's `extensions` are matched against. */
export function matchTarget(t: ActionTarget): MatchTarget {
  switch (t.environment) {
    case 'member':
      return { environment: 'member', names: [t.type, memberExt(t)].filter((n) => n !== '') };
    case 'file':
      return { environment: 'file', names: [extensionOf(t.path)].filter((n) => n !== '') };
    case 'object':
      return { environment: 'object', names: [t.type] };
  }
}

/** What the remembered choice is kept under: the connection, the environment and the member type, extension or object type. */
export function choiceKey(t: ActionTarget): string {
  const kind =
    t.environment === 'member'
      ? t.type.toUpperCase() || memberExt(t)
      : t.environment === 'file'
        ? extensionOf(t.path)
        : t.type.toUpperCase();
  return `${t.connection.toLowerCase()}|${t.environment}|${kind}`;
}

/** How the target is named in the output channel and in messages: `HLINV/QRPGLESRC(ASSETS)`, a path, `HLINV/ASSETS *PGM`. */
export function targetLabel(t: ActionTarget): string {
  switch (t.environment) {
    case 'member':
      return `${t.library}/${t.file}(${t.member})`;
    case 'file':
      return t.path;
    case 'object':
      return `${t.library}/${t.object} ${t.type}`;
  }
}

/** Whether `&LIBRARY` must be asked for: a member or a file, the command uses it, and the job has no current library. */
export function needsLibrary(command: string, t: ActionTarget, ctx: ResolveContext): boolean {
  return (
    t.environment !== 'object' &&
    !ctx.curlib &&
    !ctx.library &&
    variablesIn(command).some((v) => v.name === 'LIBRARY')
  );
}

/** Whether the command uses `&CURLIB`, or `&LIBRARY` of a member or a file: the current library must be read first. */
export function usesCurrentLibrary(command: string, environment: Environment): boolean {
  return variablesIn(command).some((v) => v.name === 'CURLIB' || (v.name === 'LIBRARY' && environment !== 'object'));
}

/** The value of each variable for `t`; undefined for one it has none for. */
export function targetValue(t: ActionTarget, ctx: ResolveContext, name: string): string | undefined {
  const c = ctx.connection;
  if (name.startsWith(CUSTOM_PREFIX)) {
    return c.custom[name.slice(CUSTOM_PREFIX.length)];
  }
  const nonEmpty = (s: string | undefined) => (s === undefined || s === '' ? undefined : s);
  switch (name) {
    case 'CURLIB':
      return nonEmpty(ctx.curlib);
    case 'USERNAME':
      return nonEmpty(c.user);
    case 'HOST':
      return nonEmpty(c.host);
  }
  switch (t.environment) {
    case 'member':
      switch (name) {
        case 'LIBRARY':
          return nonEmpty(ctx.library ?? ctx.curlib);
        case 'NAME':
          return t.member;
        case 'TYPE':
          return nonEmpty(t.type);
        case 'EXT':
          return memberExt(t);
        case 'SRCFILE':
          return t.file;
        case 'SRCLIB':
          return t.library;
      }
      return undefined;
    case 'file': {
      const base = baseName(t.path);
      const ext = extensionOf(t.path);
      const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
      switch (name) {
        case 'LIBRARY':
          return nonEmpty(ctx.library ?? ctx.curlib);
        case 'NAME':
          return nonEmpty(stem.toUpperCase());
        case 'TYPE':
          return nonEmpty(ext.toUpperCase());
        case 'EXT':
          return nonEmpty(ext);
        case 'FULLPATH':
          return t.path;
        case 'PARENT':
          return parentPath(t.path);
        case 'BASENAME':
          return nonEmpty(stem);
        case 'BASENAMEEXT':
          return base;
      }
      return undefined;
    }
    case 'object':
      switch (name) {
        case 'LIBRARY':
          return t.library;
        case 'NAME':
          return t.object;
        case 'TYPE':
          return t.type;
        case 'EXT':
          return nonEmpty(t.attribute.toLowerCase());
      }
      return undefined;
  }
}

/**
 * The command with every variable replaced for `t`; the unresolved ones
 * listed instead, so nothing is sent with a variable left in it.
 */
export function resolveCommand(command: string, t: ActionTarget, ctx: ResolveContext): Substituted {
  return substitute(command, (name) => targetValue(t, ctx, name));
}

/**
 * `runAs: batch`: the command submitted to `QBATCH` as a job named after the
 * target. `SBMJOB` itself runs as a command in the connection job.
 */
export function batchCommand(resolved: string, jobName: string): string {
  return `SBMJOB CMD(${resolved}) JOB(${jobName}) JOBQ(QBATCH)`;
}
