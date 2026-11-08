// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The messages beyond LSP's own between the language servers and the
 * extension. Keep in step with `host/crates/lsp-common/src/protocol.rs`.
 * No `vscode` import.
 */

import type { DiagnosticAt } from '../host/protocol';

/** Server to client: the source a `/COPY` or `/INCLUDE` asks for. */
export const FETCH_INCLUDE = 'qs400/fetchInclude';
/** Server to client: a source file's members, for completion after `/COPY`. */
export const LIST_MEMBERS = 'qs400/listMembers';
/** Client to server: a member or stream file was saved. */
export const INCLUDES_CHANGED = 'qs400/includesChanged';
/** Client to server: a document's diagnostics as `analyze` returned them. */
export const DIAGNOSTICS = 'qs400/diagnostics';
/** Client to the SQL server: each statement's range, as its parser splits the script. */
export const SQL_STATEMENTS = 'qs400/sqlStatements';

/** One statement of `qs400/sqlStatements`: its first character to its last, the `;` left out. */
export interface SqlStatementRange {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

/** What a directive asks for. */
export interface IncludeRequest {
  /** `*LIBL` when not given; empty for a stream file. */
  library: string;
  /** The source file; for a stream file, the including stream file's directory. */
  file: string;
  /** Empty for a stream file. */
  member: string;
  /** The path as written, for a stream file. */
  path?: string;
}

export interface FetchIncludeParams {
  /** The document whose analysis asks. */
  uri: string;
  request: IncludeRequest;
}

/** The answer when found; `null` when not. */
export interface FetchedInclude {
  /** Where it opens: a member's read-only URI. */
  uri: string;
  /** Where it is: for `*LIBL`, the library it was found in. */
  at: DiagnosticAt;
  text: string;
}

export interface ListMembersParams {
  uri: string;
  library: string;
  file: string;
}

export interface MemberItem {
  member: string;
  type: string;
  text: string;
}

/** Nothing given is everything. */
export interface IncludesChangedParams {
  connection?: string;
  member?: DiagnosticAt;
}

/** One diagnostic as `analyze` returned it: the host's compile diagnostic shape. */
export interface AnalyzedDiagnostic {
  at: DiagnosticAt;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: number;
  id: string;
  text: string;
  help: string;
}
