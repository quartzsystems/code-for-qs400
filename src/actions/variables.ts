// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * Action variables: `&LIBRARY`, `&NAME` … and `&CUSTOM:NAME`, found in a
 * command and replaced. `&&` is a literal `&`. No `vscode` import.
 */

import { Environment } from './model';

/** Every variable an action may use, besides `&CUSTOM:NAME`. */
export const VARIABLES = [
  'LIBRARY',
  'NAME',
  'TYPE',
  'EXT',
  'SRCFILE',
  'SRCLIB',
  'CURLIB',
  'USERNAME',
  'HOST',
  'FULLPATH',
  'PARENT',
  'BASENAME',
  'BASENAMEEXT',
] as const;

export type VariableName = (typeof VARIABLES)[number];

/** `CUSTOM:` and the name of a connection's own variable. */
export const CUSTOM_PREFIX = 'CUSTOM:';

/** A custom variable's name: letters, digits, `_`, `$`, `#`, `@`. */
export const CUSTOM_NAME = /^[A-Z0-9_$#@]+$/;

/** One `&…` in a command, by its offset in the command. */
export interface VariableUse {
  /** Upper case, without the `&`: `LIBRARY`, `CUSTOM:TGTRLS`. */
  name: string;
  offset: number;
  length: number;
  known: boolean;
}

const USE = /&&|&(CUSTOM:[A-Za-z0-9_$#@]+|[A-Za-z]+)/g;

/** Every variable a command uses, in order; `&&` is not one. */
export function variablesIn(command: string): VariableUse[] {
  const out: VariableUse[] = [];
  for (const m of command.matchAll(USE)) {
    if (m[0] === '&&') {
      continue;
    }
    const name = m[1].toUpperCase();
    const known = name.startsWith(CUSTOM_PREFIX) || (VARIABLES as readonly string[]).includes(name);
    out.push({ name, offset: m.index ?? 0, length: m[0].length, known });
  }
  return out;
}

/** The variables of `command` that are not variables at all. */
export function unknownVariables(command: string): string[] {
  return [...new Set(variablesIn(command).filter((v) => !v.known).map((v) => `&${v.name}`))];
}

export type Substituted = { ok: true; command: string } | { ok: false; unresolved: string[] };

/**
 * `command` with each variable replaced by `value(name)`; every variable
 * `value` has none for is listed instead, and nothing is replaced.
 */
export function substitute(command: string, value: (name: string) => string | undefined): Substituted {
  const unresolved: string[] = [];
  const out = command.replace(USE, (whole: string, name: string | undefined) => {
    if (whole === '&&') {
      return '&';
    }
    const n = (name ?? '').toUpperCase();
    const v = value(n);
    if (v === undefined) {
      if (!unresolved.includes(`&${n}`)) {
        unresolved.push(`&${n}`);
      }
      return whole;
    }
    return v;
  });
  return unresolved.length > 0 ? { ok: false, unresolved } : { ok: true, command: out };
}

/** What a connection gives every target: its user, host and own variables. */
export interface ConnectionValues {
  user: string;
  host: string;
  /** Upper-case names, without `CUSTOM:`. */
  custom: Readonly<Record<string, string>>;
}

/**
 * The sample a command is checked with when an `actions.json` is saved:
 * names that are valid, for the environment and the first extension the
 * action names, so that `CheckCommand` checks the command's syntax and
 * nothing else.
 */
export function sampleValue(name: string, environment: Environment, extensions: string[], c: ConnectionValues): string | undefined {
  if (name.startsWith(CUSTOM_PREFIX)) {
    return c.custom[name.slice(CUSTOM_PREFIX.length)] ?? 'SAMPLE';
  }
  const ext = extensions[0] ?? (environment === 'object' ? 'PGM' : environment === 'file' ? 'SQL' : 'RPGLE');
  switch (name as VariableName) {
    case 'LIBRARY':
    case 'SRCLIB':
    case 'CURLIB':
      return 'QTEMP';
    case 'NAME':
      return 'SAMPLE';
    case 'TYPE':
      return environment === 'object' ? `*${ext}` : ext;
    case 'EXT':
      return ext.toLowerCase();
    case 'SRCFILE':
      return 'QSRC';
    case 'USERNAME':
      return c.user;
    case 'HOST':
      return c.host;
    case 'FULLPATH':
      return `/tmp/sample.${ext.toLowerCase()}`;
    case 'PARENT':
      return '/tmp';
    case 'BASENAME':
      return 'sample';
    case 'BASENAMEEXT':
      return `sample.${ext.toLowerCase()}`;
    default:
      return undefined;
  }
}
