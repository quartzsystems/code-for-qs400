// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The `code-for-qs400.connections` setting: parsing, the secret key of a
 * connection's password, and what `session.connect` is sent. No `vscode`
 * import, so the rules can be tested on their own.
 */

import type { ConnectParams } from '../host/protocol';
import { FilterConfig, filterSetting, parseFilters } from '../objects/filters';

export const SETTINGS_SECTION = 'code-for-qs400';
export const CONNECTIONS_SETTING = 'connections';
export const DEFAULT_CONNECTION_SETTING = 'defaultConnection';

export interface TlsConfig {
  /** Must be absent or true; the host refuses false. */
  verify?: boolean;
  /** PEM file to trust beyond the platform's certificate store. */
  caFile?: string;
  /** PEM texts trusted for this connection alone, added by "Trust for this connection". */
  certificates?: string[];
}

/** What to apply to the session job on connect. */
export interface LibraryListConfig {
  current?: string;
  user?: string[];
}

export interface ConnectionConfig {
  /** Unique, the key everywhere. */
  name: string;
  host: string;
  /** Left out: `qap-client`'s default QAP port. */
  port?: number;
  /** User profile, upper case. */
  user: string;
  tls?: TlsConfig;
  libraryList?: LibraryListConfig;
  /** Object filters, shown under Filters in the Objects view. */
  filters?: FilterConfig[];
  /** IFS view roots, in order; the first is Home. Left out: `/home/<user>` and `/`. */
  ifsRoots?: string[];
  /**
   * This connection's actions, as written: the actions store reads them
   * (src/actions/model.ts) and reports entries that do not parse, which are
   * kept here as they are.
   */
  actions?: unknown[];
  /** Values of `&CUSTOM:NAME`, by upper-case name. */
  variables?: Record<string, string>;
}

export interface ParsedConnections {
  connections: ConnectionConfig[];
  /** One line per entry that was skipped or field that was dropped. */
  problems: string[];
}

/** The `SecretStorage` key of a connection's password. */
export function secretKey(name: string): string {
  return `code-for-qs400.password.${name}`;
}

/** Whether two connection names are the same key. Names compare without case. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

const LIBRARY = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;
const PROFILE = /^[A-Z$#@][A-Z0-9$#@_]{0,9}$/;

/** A library name upper-cased, or undefined when it is not one. */
export function libraryName(s: string): string | undefined {
  const n = s.trim().toUpperCase();
  return LIBRARY.test(n) ? n : undefined;
}

/** A user profile name upper-cased, or undefined when it is not one. */
export function profileName(s: string): string | undefined {
  const n = s.trim().toUpperCase();
  return PROFILE.test(n) ? n : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * The `ifsRoots` of a connection: absolute paths, each once. An entry that
 * is not one is skipped and reported; a value that is not an array is
 * dropped (the default roots apply).
 */
function parseRoots(raw: unknown, label: string, problems: string[]): string[] | undefined {
  if (!Array.isArray(raw)) {
    problems.push(`${label}: ifsRoots is not an array; the default roots are used`);
    return undefined;
  }
  const roots: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !r.trim().startsWith('/')) {
      problems.push(`${label}: ${JSON.stringify(r)} is not an absolute IFS path`);
    } else if (!roots.includes(r.trim())) {
      roots.push(r.trim());
    }
  }
  return roots;
}

const VARIABLE = /^[A-Z0-9_$#@]+$/;

/**
 * The `variables` of a connection: names (upper-cased) to string values.
 * An entry that is not one is skipped and reported.
 */
function parseVariables(raw: unknown, label: string, problems: string[]): Record<string, string> | undefined {
  if (!isObject(raw)) {
    problems.push(`${label}: variables is not an object; it is ignored`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const name = k.trim().toUpperCase();
    if (!VARIABLE.test(name)) {
      problems.push(`${label}: ${JSON.stringify(k)} is not a variable name (letters, digits, _, $, #, @)`);
    } else if (typeof v !== 'string') {
      problems.push(`${label}: variable ${name} is not a string`);
    } else {
      out[name] = v;
    }
  }
  return out;
}

/** Reads the setting's value. Bad entries are skipped and reported, never thrown. */
export function parseConnections(raw: unknown): ParsedConnections {
  const connections: ConnectionConfig[] = [];
  const problems: string[] = [];
  if (raw === undefined || raw === null) {
    return { connections, problems };
  }
  if (!Array.isArray(raw)) {
    return { connections, problems: ['code-for-qs400.connections is not an array'] };
  }
  raw.forEach((entry: unknown, i) => {
    const where = `connection ${i + 1}`;
    if (!isObject(entry)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const name = text(entry.name);
    const host = text(entry.host);
    const userText = text(entry.user);
    if (!name || !host || !userText) {
      problems.push(`${where}: name, host and user are required`);
      return;
    }
    const label = `connection ${name}`;
    if (connections.some((c) => sameName(c.name, name))) {
      problems.push(`${label}: the name is used twice; the second is skipped`);
      return;
    }
    const user = profileName(userText);
    if (!user) {
      problems.push(`${label}: ${userText} is not a user profile name`);
      return;
    }
    const c: ConnectionConfig = { name, host, user };
    if (entry.port !== undefined) {
      const port = entry.port;
      if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) {
        c.port = port;
      } else {
        problems.push(`${label}: port ${JSON.stringify(port)} is not a port number; the default is used`);
      }
    }
    if (isObject(entry.tls)) {
      const tls: TlsConfig = {};
      if (typeof entry.tls.verify === 'boolean') {
        tls.verify = entry.tls.verify;
      }
      const caFile = text(entry.tls.caFile);
      if (caFile) {
        tls.caFile = caFile;
      }
      if (entry.tls.certificates !== undefined) {
        if (Array.isArray(entry.tls.certificates)) {
          const pems = entry.tls.certificates.filter((p): p is string => typeof p === 'string' && p.includes('-----BEGIN CERTIFICATE-----'));
          if (pems.length < entry.tls.certificates.length) {
            problems.push(`${label}: an entry of tls.certificates is not a PEM certificate; it is ignored`);
          }
          if (pems.length > 0) {
            tls.certificates = pems;
          }
        } else {
          problems.push(`${label}: tls.certificates is not an array; it is ignored`);
        }
      }
      if (Object.keys(tls).length > 0) {
        c.tls = tls;
      }
    }
    if (isObject(entry.libraryList)) {
      const libl: LibraryListConfig = {};
      const current = text(entry.libraryList.current);
      if (current) {
        const n = libraryName(current);
        if (n) {
          libl.current = n;
        } else {
          problems.push(`${label}: ${current} is not a library name`);
        }
      }
      if (Array.isArray(entry.libraryList.user)) {
        const user: string[] = [];
        for (const l of entry.libraryList.user) {
          const n = typeof l === 'string' ? libraryName(l) : undefined;
          if (!n) {
            problems.push(`${label}: ${JSON.stringify(l)} is not a library name`);
          } else if (!user.includes(n)) {
            user.push(n);
          }
        }
        libl.user = user;
      }
      if (libl.current !== undefined || libl.user !== undefined) {
        c.libraryList = libl;
      }
    }
    const filters = parseFilters(entry.filters, label, problems);
    if (filters.length > 0) {
      c.filters = filters;
    }
    if (entry.ifsRoots !== undefined) {
      const roots = parseRoots(entry.ifsRoots, label, problems);
      if (roots) {
        c.ifsRoots = roots;
      }
    }
    if (entry.actions !== undefined) {
      if (Array.isArray(entry.actions)) {
        c.actions = [...entry.actions];
      } else {
        problems.push(`${label}: actions is not an array; it is ignored`);
      }
    }
    if (entry.variables !== undefined) {
      const variables = parseVariables(entry.variables, label, problems);
      if (variables) {
        c.variables = variables;
      }
    }
    connections.push(c);
  });
  return { connections, problems };
}

/** The setting's JSON for a connection: no empty or undefined fields. */
export function toSetting(c: ConnectionConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { name: c.name, host: c.host };
  if (c.port !== undefined) {
    out.port = c.port;
  }
  out.user = c.user;
  if (c.tls && (c.tls.verify !== undefined || c.tls.caFile || c.tls.certificates?.length)) {
    const tls: Record<string, unknown> = {};
    if (c.tls.verify !== undefined) {
      tls.verify = c.tls.verify;
    }
    if (c.tls.caFile) {
      tls.caFile = c.tls.caFile;
    }
    if (c.tls.certificates?.length) {
      tls.certificates = [...c.tls.certificates];
    }
    out.tls = tls;
  }
  if (c.libraryList && (c.libraryList.current || c.libraryList.user?.length)) {
    const libl: Record<string, unknown> = {};
    if (c.libraryList.current) {
      libl.current = c.libraryList.current;
    }
    if (c.libraryList.user?.length) {
      libl.user = [...c.libraryList.user];
    }
    out.libraryList = libl;
  }
  if (c.filters?.length) {
    out.filters = c.filters.map(filterSetting);
  }
  if (c.ifsRoots) {
    out.ifsRoots = [...c.ifsRoots];
  }
  if (c.actions) {
    out.actions = [...c.actions];
  }
  if (c.variables && Object.keys(c.variables).length > 0) {
    out.variables = { ...c.variables };
  }
  return out;
}

/** What `session.connect` is sent for `c`; no password resumes a stale session. */
export function connectParams(c: ConnectionConfig, password?: string): ConnectParams {
  const p: ConnectParams = { name: c.name, host: c.host, user: c.user };
  if (password !== undefined) {
    p.password = password;
  }
  if (c.port !== undefined) {
    p.port = c.port;
  }
  if (c.tls) {
    p.tls = { ...c.tls };
    if (c.tls.certificates) {
      p.tls.certificates = [...c.tls.certificates];
    }
  }
  return p;
}
