// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * Actions: what `.vscode/actions.json`, the defaults shipped with the
 * extension and a connection's `actions` hold, how they are read and
 * merged, which apply to a target, and which QAP call runs each. No
 * `vscode` import, so the rules can be tested on their own.
 */

import { ParseError, Node as JsonNode, findNodeAtLocation, parseTree, printParseErrorCode } from 'jsonc-parser';

export type Environment = 'member' | 'file' | 'object';
export type Refresh = 'none' | 'parent' | 'library';
export type RunAs = 'connection' | 'batch';

export const ENVIRONMENTS: readonly Environment[] = ['member', 'file', 'object'];
const REFRESHES: readonly Refresh[] = ['none', 'parent', 'library'];
const RUN_AS: readonly RunAs[] = ['connection', 'batch'];

/** Where an action was defined. */
export interface ActionSource {
  kind: 'default' | 'workspace' | 'connection';
  /** `default`, the workspace folder's name, or the connection's name. */
  label: string;
  /** The file it is in (`default` and `workspace`), as a URI string. */
  file?: string;
  /** Its index in that file's array, or in the connection's `actions`. */
  index: number;
}

export interface Action {
  name: string;
  command: string;
  environment: Environment;
  /**
   * Member types or file extensions (or object types, `*PGM` or `PGM`),
   * upper case and without a leading `*`; empty applies to every target
   * of the environment.
   */
  extensions: string[];
  refresh: Refresh;
  runAs: RunAs;
  source: ActionSource;
}

/** An action without its source, as read from one array. */
export type ActionEntry = Omit<Action, 'source'> & { index: number };

/** A problem with one entry (`index`), or with the whole array. */
export interface ActionProblem {
  index?: number;
  message: string;
}

/**
 * The commands `Develop.Compile` reports diagnostics for, from the spec
 * ("Service 9 `Develop`", `Compile`'s rule). Any other command is run with
 * `RunCommand`.
 */
export const COMPILE_COMMANDS: readonly string[] = [
  'CRTBNDRPG',
  'CRTRPGMOD',
  'CRTSQLRPGI',
  'CRTBNDCL',
  'CRTCLMOD',
  'CRTPF',
  'CRTLF',
  'CRTDSPF',
  'CRTPRTF',
  'CRTCMD',
  'RUNSQLSTM',
  'CRTPGM',
  'CRTSRVPGM',
];

/** The command's name, upper case, without a library qualifier: `QSYS/CRTBNDRPG` is `CRTBNDRPG`. */
export function firstToken(command: string): string {
  const word = command.trim().split(/[\s(]/, 1)[0] ?? '';
  const slash = word.lastIndexOf('/');
  return (slash >= 0 ? word.slice(slash + 1) : word).toUpperCase();
}

/** Which host call runs a command: `compile` for the spec's compile list, `command` for anything else. */
export function kindOf(command: string): 'compile' | 'command' {
  return COMPILE_COMMANDS.includes(firstToken(command)) ? 'compile' : 'command';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An extension or type as matched: upper case, no leading `*`; `*` and `*ALL` mean any. */
export function normalizeExtension(e: string): string {
  const t = e.trim().toUpperCase();
  if (t === '*' || t === '*ALL') {
    return '*';
  }
  return t.replace(/^\*/, '').replace(/^\./, '');
}

/**
 * Reads one array of actions. Entries that do not parse are skipped and
 * reported by index, never thrown; `label` names the array in messages.
 */
export function parseActions(raw: unknown, label: string): { entries: ActionEntry[]; problems: ActionProblem[] } {
  const entries: ActionEntry[] = [];
  const problems: ActionProblem[] = [];
  if (raw === undefined || raw === null) {
    return { entries, problems };
  }
  if (!Array.isArray(raw)) {
    return { entries, problems: [{ message: `${label}: actions must be an array` }] };
  }
  raw.forEach((item: unknown, index) => {
    const bad = (message: string) => problems.push({ index, message });
    if (!isObject(item)) {
      bad(`${label}: action ${index + 1} is not an object`);
      return;
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const where = name ? `${label}: ${name}` : `${label}: action ${index + 1}`;
    if (!name) {
      bad(`${where}: name is required`);
      return;
    }
    const command = typeof item.command === 'string' ? item.command.trim() : '';
    if (!command) {
      bad(`${where}: command is required`);
      return;
    }
    const environment = item.environment;
    if (typeof environment !== 'string' || !ENVIRONMENTS.includes(environment as Environment)) {
      bad(`${where}: environment must be member, file or object`);
      return;
    }
    let extensions: string[] = [];
    if (item.extensions !== undefined) {
      if (!Array.isArray(item.extensions) || item.extensions.some((e) => typeof e !== 'string' || e.trim() === '')) {
        bad(`${where}: extensions must be an array of names`);
        return;
      }
      extensions = [...new Set((item.extensions as string[]).map(normalizeExtension))];
    }
    const refresh = item.refresh ?? 'none';
    if (typeof refresh !== 'string' || !REFRESHES.includes(refresh as Refresh)) {
      bad(`${where}: refresh must be none, parent or library`);
      return;
    }
    const runAs = item.runAs ?? 'connection';
    if (typeof runAs !== 'string' || !RUN_AS.includes(runAs as RunAs)) {
      bad(`${where}: runAs must be connection or batch`);
      return;
    }
    if (entries.some((e) => sameActionName(e.name, name))) {
      bad(`${where}: the name is used twice; the second is skipped`);
      return;
    }
    entries.push({
      name,
      command,
      environment: environment as Environment,
      extensions: extensions.includes('*') ? [] : extensions,
      refresh: refresh as Refresh,
      runAs: runAs as RunAs,
      index,
    });
  });
  return { entries, problems };
}

/** Action names compare without case, as connection names do. */
export function sameActionName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Entries with their source. */
export function withSource(entries: ActionEntry[], source: Omit<ActionSource, 'index'>): Action[] {
  return entries.map(({ index, ...a }) => ({ ...a, source: { ...source, index } }));
}

/**
 * The actions in effect: `layers` from the lowest (the defaults) to the
 * highest (the connection), each overriding the ones before it by name. An
 * action keeps the place of the one it overrides; new names follow in their
 * layer's order.
 */
export function mergeActions(layers: Action[][]): Action[] {
  const out: Action[] = [];
  for (const layer of layers) {
    for (const a of layer) {
      const i = out.findIndex((o) => sameActionName(o.name, a.name));
      if (i >= 0) {
        out[i] = a;
      } else {
        out.push(a);
      }
    }
  }
  return out;
}

/** What an action is run against, for matching. */
export interface MatchTarget {
  environment: Environment;
  /** Member type and extension, file extension, or object type: each matched without case. */
  names: string[];
}

/** Whether `a` applies to the target. */
export function applies(a: Action, t: MatchTarget): boolean {
  if (a.environment !== t.environment) {
    return false;
  }
  if (a.extensions.length === 0) {
    return true;
  }
  const names = t.names.map(normalizeExtension);
  return a.extensions.some((e) => names.includes(e));
}

/** A span of text, by offset. */
export interface Span {
  offset: number;
  length: number;
}

/** What an `actions.json` text holds, with where each part is. */
export interface ActionsText {
  /** The array, or undefined when the text is not JSON. */
  value: unknown;
  /** Syntax errors, at their place. */
  syntax: (Span & { message: string })[];
  /** The span of each element, by index. */
  elements: Span[];
  /** The span of each element's `command` value, by index, when it has one. */
  commands: (Span | undefined)[];
}

/** Reads an `actions.json` text: JSON with comments and trailing commas, as VS Code's settings files are. */
export function parseActionsText(text: string): ActionsText {
  const errors: ParseError[] = [];
  const root: JsonNode | undefined = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  const syntax = errors.map((e) => ({ offset: e.offset, length: e.length, message: printParseErrorCode(e.error) }));
  const elements: Span[] = [];
  const commands: (Span | undefined)[] = [];
  let value: unknown = undefined;
  if (root) {
    value = nodeValue(root);
    if (root.type === 'array') {
      (root.children ?? []).forEach((child, i) => {
        elements.push({ offset: child.offset, length: child.length });
        const c = findNodeAtLocation(root, [i, 'command']);
        commands.push(c ? { offset: c.offset, length: c.length } : undefined);
      });
    }
  }
  return { value, syntax, elements, commands };
}

function nodeValue(n: JsonNode): unknown {
  switch (n.type) {
    case 'array':
      return (n.children ?? []).map(nodeValue);
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const p of n.children ?? []) {
        const [k, v] = p.children ?? [];
        if (k && v) {
          o[String(k.value)] = nodeValue(v);
        }
      }
      return o;
    }
    default:
      return n.value;
  }
}
