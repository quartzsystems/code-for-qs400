// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

// The `qs400` debug configuration: its fields, the CALL it runs and the
// defaults the provider fills in. No `vscode` import.

/** The debugger's type in `launch.json`. */
export const DEBUG_TYPE = 'qs400';

/** A parameter of the program, as `launch.json` gives it. */
export type CallParameter = string | number;

/** A `qs400` configuration as `launch.json` holds it, and what the provider adds. */
export interface Qs400DebugConfiguration {
  type: string;
  request: 'launch' | 'attach';
  name: string;
  /** The saved connection; the active one when left out. */
  connection?: string;
  /** `call` (the default for `launch`) or `serviceEntry`. */
  mode?: 'call' | 'serviceEntry';
  /** `LIB/PGM`, or `PGM` for `*LIBL`. */
  program?: string;
  /** The program's parameters, for the CALL. */
  parameters?: CallParameter[];
  /** More programs under debug, for breakpoints in programs it calls. */
  programs?: string[];
  /** Service entry: whose jobs stop, `*CURRENT` or a profile. */
  user?: string;
  /** Attach: the job, `nnnnnn/USER/NAME`. */
  job?: string;
  /** Added by the provider: the CALL, parameters quoted. */
  command?: string;
  /** Added by the provider: the extension offers the recompile for CPF9C15. */
  recompileOffer?: boolean;
  /** Added by the provider: the sign-on the adapter uses. Never in launch.json. */
  qs400?: unknown;
  [key: string]: unknown;
}

/** A parameter as CL writes it: a number as typed, anything else a quoted string with its quotes doubled. */
export function clParameter(v: CallParameter): string {
  if (typeof v === 'number') {
    const s = String(v);
    // CL has no exponent, and no infinity.
    if (!Number.isFinite(v) || /e/i.test(s)) {
      throw new Error(`parameter ${s} is not a number CL can pass; give it as a string`);
    }
    return s;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** `CALL PGM(LIB/PGM) PARM(...)`; no `PARM` without parameters. */
export function callCommand(program: string, parameters: readonly CallParameter[] = []): string {
  const parm = parameters.length > 0 ? ` PARM(${parameters.map(clParameter).join(' ')})` : '';
  return `CALL PGM(${program})${parm}`;
}

const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

/** `LIB/PGM` upper case, `PGM` as `*LIBL/PGM`; undefined when it is not a program name. */
export function programName(s: string): string | undefined {
  const t = s.trim().toUpperCase();
  const [lib, pgm] = t.includes('/') ? t.split('/', 2) : ['*LIBL', t];
  const libOk = NAME.test(lib) || ['*LIBL', '*CURLIB'].includes(lib);
  return libOk && pgm !== undefined && NAME.test(pgm) && t.split('/').length <= 2 ? `${lib}/${pgm}` : undefined;
}

/** `nnnnnn/USER/NAME`, names upper case; undefined when it is not a qualified job name. */
export function jobName(s: string): string | undefined {
  const parts = s.trim().split('/');
  if (parts.length !== 3 || !/^\d{6}$/.test(parts[0])) {
    return undefined;
  }
  const [number, user, name] = parts;
  return NAME.test(user.toUpperCase()) && NAME.test(name.toUpperCase()) ? `${number}/${user.toUpperCase()}/${name.toUpperCase()}` : undefined;
}

/** The message ID of a program compiled `DBGVIEW(*NONE)`, which `AddProgram` refuses. */
export const NO_DEBUG_DATA = 'CPF9C15';

/**
 * A compile command with `DBGVIEW(*SOURCE)` forced: the keyword's value
 * replaced wherever it is, in any case and spacing, or the keyword added
 * at the end.
 */
export function withDebugView(command: string): string {
  // DBGVIEW's value is one word (*NONE, *ALL, *STMT, *SOURCE, *LIST, *COPY).
  const kw = /\bDBGVIEW\s*\(\s*[^()]*\)/gi;
  if (kw.test(command)) {
    return command.replace(kw, 'DBGVIEW(*SOURCE)');
  }
  return `${command.trimEnd()} DBGVIEW(*SOURCE)`;
}

/** What the provider can fill in from the window. */
export interface DebugDefaults {
  /** The active connection. */
  connection?: string;
  /** `LIB/PGM` of the active member or the Objects view's selected program. */
  program?: string;
}

/**
 * The configuration completed: the connection and program filled in when
 * left out, names checked, a bare F5 (no `launch.json`) taken as Call.
 * A string is what is wrong with it.
 */
export function completeConfiguration(c: Qs400DebugConfiguration, d: DebugDefaults): Qs400DebugConfiguration | string {
  const out: Qs400DebugConfiguration = { ...c };
  if (!out.type && !out.request) {
    // F5 with no launch.json: Call on what is selected.
    out.type = DEBUG_TYPE;
    out.request = 'launch';
    out.name = 'Call';
  }
  out.connection ??= d.connection;
  if (!out.connection) {
    return 'No connection: name one in "connection", or connect and make it the active one.';
  }
  if (out.request === 'attach') {
    const job = out.job ? jobName(out.job) : undefined;
    if (!job) {
      return `"job" must be a qualified job name, nnnnnn/USER/NAME${out.job ? `, not ${out.job}` : ''}.`;
    }
    out.job = job;
  } else {
    out.mode ??= 'call';
    if (out.mode !== 'call' && out.mode !== 'serviceEntry') {
      return `"mode" is "call" or "serviceEntry", not ${String(out.mode)}.`;
    }
    out.program ??= d.program;
    if (!out.program) {
      return 'No program: name one in "program" (LIB/PGM), or open its member or select it in the Objects view.';
    }
  }
  if (out.program !== undefined) {
    const p = programName(out.program);
    if (!p) {
      return `"program" must be LIB/PGM, not ${out.program}.`;
    }
    out.program = p;
  }
  const programs: string[] = [];
  for (const p of out.programs ?? []) {
    const n = programName(p);
    if (!n) {
      return `"programs" must be LIB/PGM names, not ${p}.`;
    }
    programs.push(n);
  }
  out.programs = programs;
  if (out.mode === 'serviceEntry') {
    out.user = (out.user ?? '*CURRENT').trim().toUpperCase() || '*CURRENT';
  }
  if (out.request === 'launch' && out.mode === 'call') {
    try {
      out.command = callCommand(out.program as string, out.parameters ?? []);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  out.recompileOffer = true;
  return out;
}

/** The snippets `launch.json` is offered, as the plan names them. */
export function initialConfigurations(connection = 'QSHQ400'): Qs400DebugConfiguration[] {
  return [
    {
      type: DEBUG_TYPE,
      request: 'launch',
      name: 'Call HLINV/ASSETS',
      connection,
      program: 'HLINV/ASSETS',
      parameters: [],
      programs: [],
    },
    {
      type: DEBUG_TYPE,
      request: 'attach',
      name: 'Attach to job',
      connection,
      job: '123456/CWELLMAN/QPADEV0001',
      programs: ['HLINV/ASSETS'],
    },
    {
      type: DEBUG_TYPE,
      request: 'launch',
      name: 'Service entry',
      connection,
      mode: 'serviceEntry',
      program: 'HLINV/ASSETS',
      user: '*CURRENT',
    },
  ];
}
