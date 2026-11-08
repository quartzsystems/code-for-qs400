// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * Where a compiler's diagnostic goes: which document, and which range of
 * it. No `vscode` import.
 *
 * - `at` `member` is that member (the one compiled, or a `/COPY` member);
 *   `path` that stream file; `none` the action's target, at line 1.
 * - Lines and columns come 1-based (0 unknown) and leave 0-based. Line 0
 *   is line 1. Column 0 is the whole line. `endLine` 0 is `line`.
 *   `endColumn` is the last column covered; 0 runs to the end of the line.
 */

import type { CompileDiagnostic } from '../host/protocol';
import type { ActionTarget } from './targets';

/** The end of the line, whatever its length. */
export const END_OF_LINE = Number.MAX_SAFE_INTEGER;

export type PlacedIn =
  | { kind: 'member'; library: string; file: string; member: string; target: boolean }
  | { kind: 'path'; path: string; target: boolean }
  | { kind: 'object'; library: string; object: string; type: string };

/** A 0-based range; `endCharacter` may be `END_OF_LINE`. */
export interface PlacedRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** The document the target itself is. */
export function targetPlace(t: ActionTarget): PlacedIn {
  switch (t.environment) {
    case 'member':
      return { kind: 'member', library: t.library, file: t.file, member: t.member, target: true };
    case 'file':
      return { kind: 'path', path: t.path, target: true };
    case 'object':
      return { kind: 'object', library: t.library, object: t.object, type: t.type };
  }
}

const same = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/** The document a diagnostic belongs to. */
export function placeIn(d: CompileDiagnostic, t: ActionTarget): PlacedIn {
  const at = d.at;
  switch (at.kind) {
    case 'member': {
      const isTarget =
        t.environment === 'member' && same(at.library, t.library) && same(at.file, t.file) && same(at.member, t.member);
      return { kind: 'member', library: at.library.toUpperCase(), file: at.file.toUpperCase(), member: at.member.toUpperCase(), target: isTarget };
    }
    case 'path':
      return { kind: 'path', path: at.path, target: t.environment === 'file' && at.path === t.path };
    case 'none':
      return targetPlace(t);
  }
}

/** The range a diagnostic covers. */
export function placeRange(d: CompileDiagnostic): PlacedRange {
  if (d.at.kind === 'none') {
    return { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: END_OF_LINE };
  }
  const line = Math.max(d.line, 1);
  const endLine = Math.max(d.endLine === 0 ? line : d.endLine, line);
  if (d.column === 0) {
    return { startLine: line - 1, startCharacter: 0, endLine: endLine - 1, endCharacter: END_OF_LINE };
  }
  const startCharacter = d.column - 1;
  let endCharacter = d.endColumn === 0 ? END_OF_LINE : d.endColumn;
  if (endLine === line && endCharacter <= startCharacter) {
    endCharacter = startCharacter + 1;
  }
  return { startLine: line - 1, startCharacter, endLine: endLine - 1, endCharacter };
}
