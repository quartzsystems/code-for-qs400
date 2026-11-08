// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * Member types: the one table from a source type to the file extension of
 * a `qs400mbr` URI and the VS Code language of its document. No `vscode`
 * import.
 */

export interface MemberType {
  /** The extension, without the dot. */
  ext: string;
  /** The VS Code language id. */
  language: string;
}

/** The languages this extension registers (no grammar until Phase 5). */
export const LANGUAGES = ['qs400-rpgle', 'qs400-cl', 'qs400-dds', 'qs400-sql', 'qs400-cmd'] as const;

const TABLE: Readonly<Record<string, MemberType>> = {
  RPGLE: { ext: 'rpgle', language: 'qs400-rpgle' },
  SQLRPGLE: { ext: 'sqlrpgle', language: 'qs400-rpgle' },
  RPG: { ext: 'rpg', language: 'qs400-rpgle' },
  CLLE: { ext: 'clle', language: 'qs400-cl' },
  CLP: { ext: 'clp', language: 'qs400-cl' },
  CL: { ext: 'cl', language: 'qs400-cl' },
  PF: { ext: 'pf', language: 'qs400-dds' },
  LF: { ext: 'lf', language: 'qs400-dds' },
  DSPF: { ext: 'dspf', language: 'qs400-dds' },
  PRTF: { ext: 'prtf', language: 'qs400-dds' },
  ICFF: { ext: 'icff', language: 'qs400-dds' },
  CMD: { ext: 'cmd', language: 'qs400-cmd' },
  SQL: { ext: 'sql', language: 'qs400-sql' },
  C: { ext: 'c', language: 'c' },
  CPP: { ext: 'cpp', language: 'cpp' },
  TXT: { ext: 'txt', language: 'plaintext' },
  BND: { ext: 'bnd', language: 'plaintext' },
  PNLGRP: { ext: 'pnlgrp', language: 'plaintext' },
  MENU: { ext: 'menu', language: 'plaintext' },
};

/** The extension a member with no source type gets. */
export const NO_TYPE_EXT = 'mbr';

/** A source type's extension and language; an unknown type is its own name in lower case, plain text. */
export function memberType(type: string): MemberType {
  const t = type.trim().toUpperCase();
  return TABLE[t] ?? { ext: t === '' ? NO_TYPE_EXT : t.toLowerCase(), language: 'plaintext' };
}

/** The source type an extension stands for: the table's, else the extension in upper case. */
export function typeForExtension(ext: string): string {
  const e = ext.trim().toLowerCase();
  if (e === NO_TYPE_EXT) {
    return '';
  }
  return Object.keys(TABLE).find((t) => TABLE[t].ext === e) ?? e.toUpperCase();
}
