// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * `qs400project.json`: a workspace folder mapped to a library or an IFS
 * path. How the file is read (JSON with comments, every problem at its
 * place), what it holds, and the ignore globs. No `vscode` import.
 */

import { Node as JsonNode, ParseError, findNodeAtLocation, parseTree, printParseErrorCode } from 'jsonc-parser';
import { libraryName } from '../connections/config';
import type { Span } from '../actions/model';

/** The project file, in the root of a workspace folder. */
export const PROJECT_FILE = 'qs400project.json';
/** The folder of the project's only local state. */
export const STATE_DIR = '.qs400';
/** The state file, relative to the folder. */
export const STATE_FILE = `${STATE_DIR}/state.json`;
/** The CCSID a stream file is created with when `encoding.ifsCcsid` is not given. */
export const DEFAULT_IFS_CCSID = 1208;
/** What is never deployed, whatever `ignore` says: the project's own files and the tools'. */
export const ALWAYS_IGNORED: readonly string[] = ['.git/**', `${STATE_DIR}/**`, '.vscode/**', PROJECT_FILE];

export type ProjectTarget = { kind: 'library'; library: string } | { kind: 'path'; path: string };

export interface ProjectConfig {
  connection: string;
  target: ProjectTarget;
  layout: 'sourceFiles';
  ifsCcsid: number;
  ignore: string[];
  /** Member text by local path, as written (the key is matched without case). */
  texts: Record<string, string>;
  /** The `actions` array as written, read by Phase 4's parser. */
  actions: unknown;
}

export interface ProjectProblem {
  /** Where in the file; the whole file when absent. */
  span?: Span;
  message: string;
}

export interface ProjectText {
  /** Undefined when the file cannot be used: no connection or target. */
  config?: ProjectConfig;
  problems: ProjectProblem[];
  /** The span of the `actions` array's elements, by index, and of each one's `command`. */
  actionSpans: { elements: Span[]; commands: (Span | undefined)[] };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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

const KNOWN = new Set(['$schema', 'connection', 'target', 'layout', 'encoding', 'ignore', 'texts', 'actions']);

/** Reads a `qs400project.json` text: JSON with comments and trailing commas, each problem at its place. */
export function parseProjectText(text: string): ProjectText {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  const problems: ProjectProblem[] = errors.map((e) => ({
    span: { offset: e.offset, length: e.length },
    message: printParseErrorCode(e.error),
  }));
  const actionSpans: ProjectText['actionSpans'] = { elements: [], commands: [] };
  if (!root) {
    problems.push({ message: `${PROJECT_FILE} is empty` });
    return { problems, actionSpans };
  }
  const at = (path: (string | number)[]): Span | undefined => {
    const n = findNodeAtLocation(root, path);
    return n ? { offset: n.offset, length: n.length } : undefined;
  };
  const key = (name: string): Span | undefined => {
    const p = (root.children ?? []).find((c) => c.children?.[0]?.value === name)?.children?.[0];
    return p ? { offset: p.offset, length: p.length } : undefined;
  };
  const value = nodeValue(root);
  if (!isObject(value)) {
    problems.push({ span: { offset: root.offset, length: root.length }, message: `${PROJECT_FILE} must be an object` });
    return { problems, actionSpans };
  }
  for (const k of Object.keys(value)) {
    if (!KNOWN.has(k)) {
      problems.push({ span: key(k), message: `${k} is not a project property` });
    }
  }
  const whole = { offset: root.offset, length: 1 };

  let connection: string | undefined;
  if (typeof value.connection === 'string' && value.connection.trim() !== '') {
    connection = value.connection.trim();
  } else {
    problems.push({ span: at(['connection']) ?? whole, message: 'connection is required: the name of a saved connection' });
  }

  let target: ProjectTarget | undefined;
  const t = value.target;
  if (!isObject(t)) {
    problems.push({ span: at(['target']) ?? whole, message: 'target is required: { "library": "LIB" } or { "path": "/dir" }' });
  } else if ('library' in t && 'path' in t) {
    problems.push({ span: at(['target']), message: 'target names a library or a path, not both' });
  } else if ('library' in t) {
    const lib = typeof t.library === 'string' ? libraryName(t.library) : undefined;
    if (lib && !lib.startsWith('*')) {
      target = { kind: 'library', library: lib };
    } else {
      problems.push({ span: at(['target', 'library']), message: `${String(t.library)} is not a library name` });
    }
  } else if ('path' in t) {
    if (typeof t.path === 'string' && t.path.startsWith('/')) {
      const p = t.path.replace(/\/+$/, '');
      target = { kind: 'path', path: p === '' ? '/' : p };
    } else {
      problems.push({ span: at(['target', 'path']), message: 'target.path must be an absolute IFS path' });
    }
  } else {
    problems.push({ span: at(['target']), message: 'target needs library or path' });
  }

  if (value.layout !== undefined && value.layout !== 'sourceFiles') {
    problems.push({ span: at(['layout']), message: 'layout must be sourceFiles' });
  }

  let ifsCcsid = DEFAULT_IFS_CCSID;
  if (value.encoding !== undefined) {
    if (!isObject(value.encoding)) {
      problems.push({ span: at(['encoding']), message: 'encoding must be an object' });
    } else {
      for (const k of Object.keys(value.encoding)) {
        if (k !== 'ifsCcsid') {
          problems.push({ span: at(['encoding', k]), message: `encoding.${k} is not an encoding property` });
        }
      }
      const c = value.encoding.ifsCcsid;
      if (c !== undefined) {
        if (typeof c === 'number' && Number.isInteger(c) && c >= 1 && c <= 65535) {
          ifsCcsid = c;
        } else {
          problems.push({ span: at(['encoding', 'ifsCcsid']), message: 'encoding.ifsCcsid must be a CCSID, 1 to 65535' });
        }
      }
    }
  }

  const ignore: string[] = [];
  if (value.ignore !== undefined) {
    if (!Array.isArray(value.ignore)) {
      problems.push({ span: at(['ignore']), message: 'ignore must be an array of globs' });
    } else {
      value.ignore.forEach((g, i) => {
        if (typeof g === 'string' && g.trim() !== '') {
          ignore.push(g.trim());
        } else {
          problems.push({ span: at(['ignore', i]), message: 'an ignore entry must be a glob' });
        }
      });
    }
  }

  const texts: Record<string, string> = {};
  if (value.texts !== undefined) {
    if (!isObject(value.texts)) {
      problems.push({ span: at(['texts']), message: 'texts must be an object of local paths and member texts' });
    } else {
      const seen = new Map<string, string>();
      for (const [k, v] of Object.entries(value.texts)) {
        if (typeof v !== 'string') {
          problems.push({ span: at(['texts', k]), message: `the text of ${k} must be a string` });
          continue;
        }
        if (v.length > 50) {
          problems.push({ span: at(['texts', k]), message: `the text of ${k} is ${v.length} characters; a member's text is at most 50` });
        }
        const norm = k.replace(/\\/g, '/').toUpperCase();
        if (seen.has(norm)) {
          problems.push({ span: at(['texts', k]), message: `${k} is given twice (paths compare without case); ${seen.get(norm)} is kept` });
          continue;
        }
        seen.set(norm, k);
        texts[k] = v;
      }
    }
  }

  const actions = value.actions;
  if (actions !== undefined) {
    const node = findNodeAtLocation(root, ['actions']);
    if (node?.type === 'array') {
      (node.children ?? []).forEach((child, i) => {
        actionSpans.elements.push({ offset: child.offset, length: child.length });
        const c = findNodeAtLocation(root, ['actions', i, 'command']);
        actionSpans.commands.push(c ? { offset: c.offset, length: c.length } : undefined);
      });
    }
  }

  if (!connection || !target) {
    return { problems, actionSpans };
  }
  return {
    config: { connection, target, layout: 'sourceFiles', ifsCcsid, ignore, texts, actions: actions ?? [] },
    problems,
    actionSpans,
  };
}

/** The member text `texts` gives a local path, matched without case. */
export function textFor(config: ProjectConfig, rel: string): string | undefined {
  const want = rel.toUpperCase();
  const k = Object.keys(config.texts).find((t) => t.replace(/\\/g, '/').toUpperCase() === want);
  return k === undefined ? undefined : config.texts[k];
}

/** A new project's file text, two-space indented as the generator writes it. */
export function projectText(config: {
  connection: string;
  target: ProjectTarget;
  ifsCcsid?: number;
  ignore?: string[];
  texts?: Record<string, string>;
}): string {
  const out: Record<string, unknown> = {
    connection: config.connection,
    target: config.target.kind === 'library' ? { library: config.target.library } : { path: config.target.path },
    layout: 'sourceFiles',
    encoding: { ifsCcsid: config.ifsCcsid ?? DEFAULT_IFS_CCSID },
    ignore: config.ignore ?? ['.git/**', 'node_modules/**', '*.md'],
    texts: sortedTexts(config.texts ?? {}),
    actions: [],
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** `texts` in path order, so a pull's additions diff cleanly. */
export function sortedTexts(texts: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(texts).sort((a, b) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0))) {
    out[k] = texts[k];
  }
  return out;
}

/**
 * A glob as a regular expression over a path relative to the folder,
 * `/`-separated: `**` any number of directories, `*` and `?` within one
 * name. A glob without a `/` matches a name in any directory; one ending
 * in `/` or `/**` matches everything under it.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (g.endsWith('/')) {
    g = `${g}**`;
  }
  const anywhere = !g.includes('/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      // `**/` is zero or more directories; a trailing `**` is anything.
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(anywhere ? `^(?:.*/)?${re}$` : `^${re}$`, 'i');
}

/** Whether a relative path is ignored by the project: its own globs, and the ones always ignored. */
export function isIgnored(rel: string, globs: readonly string[]): boolean {
  const p = rel.replace(/\\/g, '/');
  return [...ALWAYS_IGNORED, ...globs].some((g) => globToRegExp(g).test(p));
}
