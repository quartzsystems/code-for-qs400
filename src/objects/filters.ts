// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * Object filters (`code-for-qs400.connections[].filters`), generic names
 * and object types. No `vscode` import, so the rules can be tested on
 * their own.
 */

/** A saved filter: the objects of `library` matching `object`, `type` and `attribute`. */
export interface FilterConfig {
  name: string;
  /** A library, or `*LIBL`, `*CURLIB`, `*USRLIBL`, `*ALL`. */
  library: string;
  /** `*ALL` or a generic name. */
  object: string;
  /** `*ALL` or an object type such as `*FILE`. */
  type: string;
  /** Such as `PF-SRC`; absent is any. */
  attribute?: string;
}

/** The object types a library node shows, in order; then **All**. */
export const LIBRARY_TYPES = ['*FILE', '*PGM', '*SRVPGM', '*MODULE', '*CMD', '*DTAARA', '*MSGF', '*BNDDIR'] as const;

/** The attribute of a source physical file. */
export const SOURCE_FILE_ATTRIBUTE = 'PF-SRC';

const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/i;
const PREFIX = /^[A-Z$#@][A-Z0-9$#@_.]{0,8}\*$/i;
const TYPE = /^\*[A-Z]{2,9}$/i;
const SPECIAL_LIBRARIES = ['*LIBL', '*CURLIB', '*USRLIBL', '*ALL'];

/**
 * Whether `s` is one of the spec's three generic forms: a name, a prefix
 * ending in `*` (`ASSET*`), or `*ALL`. Case is the server's to fold.
 */
export function isPattern(s: string): boolean {
  const t = s.trim();
  return t.toUpperCase() === '*ALL' || NAME.test(t) || PREFIX.test(t);
}

/** Whether `s` is a library name or one of the special values a filter may name. */
export function isFilterLibrary(s: string): boolean {
  const t = s.trim();
  return SPECIAL_LIBRARIES.includes(t.toUpperCase()) || NAME.test(t);
}

/** Whether `s` is `*ALL` or an object type. */
export function isObjectType(s: string): boolean {
  return TYPE.test(s.trim());
}

/** The `types` of `object.list` for a filter's or a node's `type`: `*ALL` is every type. */
export function typesFor(type: string): string[] {
  return type.trim().toUpperCase() === '*ALL' ? [] : [type.trim().toUpperCase()];
}

/** Message for an input box, or undefined when the value is good. */
export function patternProblem(s: string): string | undefined {
  return isPattern(s) ? undefined : 'Enter a name, a name ending in * (ASSET*), or *ALL.';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** The filters of one connection entry. Bad ones are skipped and reported. */
export function parseFilters(raw: unknown, label: string, problems: string[]): FilterConfig[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    problems.push(`${label}: filters is not an array`);
    return [];
  }
  const out: FilterConfig[] = [];
  raw.forEach((f: unknown, i) => {
    const where = `${label}: filter ${i + 1}`;
    if (!isObject(f)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const name = text(f.name);
    const library = text(f.library);
    const object = text(f.object) ?? '*ALL';
    const type = text(f.type) ?? '*ALL';
    if (!name || !library) {
      problems.push(`${where}: name and library are required`);
      return;
    }
    if (out.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
      problems.push(`${where}: the name ${name} is used twice; the second is skipped`);
      return;
    }
    if (!isFilterLibrary(library)) {
      problems.push(`${where}: ${library} is not a library`);
      return;
    }
    if (!isPattern(object)) {
      problems.push(`${where}: ${object} is not a name, a name ending in *, or *ALL`);
      return;
    }
    if (type.toUpperCase() !== '*ALL' && !isObjectType(type)) {
      problems.push(`${where}: ${type} is not an object type`);
      return;
    }
    const filter: FilterConfig = { name, library, object, type };
    const attribute = text(f.attribute);
    if (attribute) {
      filter.attribute = attribute;
    }
    out.push(filter);
  });
  return out;
}

/** A filter as the setting keeps it. */
export function filterSetting(f: FilterConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { name: f.name, library: f.library, object: f.object, type: f.type };
  if (f.attribute) {
    out.attribute = f.attribute;
  }
  return out;
}
