// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * Types for every method and notification `qs400-code-host` speaks.
 * Mirrors host/crates/code-host/src/lib.rs.
 */

/** Result of `host.version`. */
export interface HostVersionResult {
  /** Host semver, e.g. `1.0.0`. */
  host: string;
  /** QS/400 release, e.g. `V1R0M0`. */
  product: string;
  /** QAP protocol version. */
  qap: number;
}

/** Params and result of `host.ping`. */
export interface PingParams {
  nonce: string;
}

export type LogLevel = 'info' | 'warn' | 'error';

/** Params of the `host.log` notification. */
export interface LogParams {
  level: LogLevel;
  message: string;
}

export type SessionState = 'disconnected' | 'connecting' | 'connected' | 'stale';

/** The system a session is signed on to. */
export interface SystemInfo {
  /** System name, e.g. `QSHQ400`. */
  name: string;
  /** Operating system product, e.g. `QS00SS1`. */
  product: string;
  /** Release, e.g. `V1R0M0`. */
  version: string;
  serial?: string;
  model?: string;
  /** QAP version the connection agreed. */
  qap: number;
}

/** The session job: the QAP server job signed on as the user. */
export interface SessionJob {
  number: string;
  user: string;
  name: string;
}

/** `session.status`, `session.list` entries and `session.changed`. */
export interface SessionStatus {
  name: string;
  state: SessionState;
  /** The signed-on profile, as the server names it. */
  user?: string;
  system?: SystemInfo;
  job?: SessionJob;
}

export interface TlsParams {
  verify?: boolean;
  caFile?: string;
}

/**
 * Params of `session.connect`. The port is left out for the host's default.
 * Without a password the host resumes the stale session of the same name,
 * endpoint and user, or answers `NeedsPassword`.
 */
export interface ConnectParams {
  name: string;
  host: string;
  port?: number;
  user: string;
  password?: string;
  tls?: TlsParams;
}

export interface ChangePasswordParams {
  name: string;
  oldPassword: string;
  newPassword: string;
}

export interface NameParams {
  name: string;
}

/** Result of `libl.get` and `libl.set`. */
export interface LibraryList {
  current: string | null;
  system: string[];
  user: string[];
}

export interface LiblSetParams {
  name: string;
  current?: string | null;
  user: string[];
}

/**
 * `data` of a server refusal (`SessionErrorCodes.Server`, and
 * `NeedsPassword` when the server refused): exactly what QAP returned.
 */
export interface ServerMessageData {
  /** The QAP status, e.g. `SignOnFailed`, `PasswordExpired`. */
  status: string;
  messageId?: string;
  text?: string;
  secondLevel?: string;
}

/** A generic name: a name, a prefix ending in `*`, or `*ALL`; empty is `*ALL`. */
export type Pattern = string;

export interface LibrariesParams {
  name: string;
  pattern?: Pattern;
}

/** An `object.libraries` entry. */
export interface LibraryEntry {
  library: string;
  kind: 'production' | 'test';
  text: string;
}

export interface ObjectListParams {
  name: string;
  /** A library, or `*LIBL`, `*CURLIB`, `*USRLIBL`, `*ALL`. */
  library: string;
  pattern?: Pattern;
  /** Object types such as `*FILE`; absent or empty is every type. */
  types?: string[];
  /** Such as `PF-SRC` or `RPGLE`; absent is any. */
  attribute?: string;
}

/** An `object.list` entry. */
export interface ObjectEntry {
  library: string;
  object: string;
  type: string;
  attribute: string;
  text: string;
  /** Bytes. */
  size: number;
  /** Milliseconds since 1970-01-01 UTC. */
  changed: number;
  owner: string;
}

export interface ObjectPropertiesParams {
  name: string;
  library: string;
  object: string;
  type: string;
}

/** An `object.properties` line, the server's label and value. */
export interface ObjectProperty {
  name: string;
  value: string;
}

/** A member: `library` may be `*LIBL` or `*CURLIB` where a search applies. */
export interface MemberRef {
  library: string;
  file: string;
  member: string;
}

export interface MemberParams extends MemberRef {
  name: string;
}

export interface MemberListParams {
  name: string;
  library: string;
  file: string;
  pattern?: Pattern;
}

/** A `member.list` entry. */
export interface MemberEntry {
  member: string;
  type: string;
  text: string;
  records: number;
  /** Milliseconds since 1970-01-01 UTC. */
  created: number;
  changed: number;
}

/**
 * A source record. `seq` is `"0001.00"` (at most `"9999.99"`), `date` is
 * `YYMMDD` (`"000000"` for none), `text` is UTF-8 without trailing blanks.
 */
export interface SourceLine {
  seq: string;
  date: string;
  text: string;
}

export interface MemberReadParams extends MemberParams {
  lock: boolean;
}

export interface MemberReadResult {
  type: string;
  text: string;
  /** The record's data length in the file's bytes. */
  width: number;
  ccsid: number;
  lines: SourceLine[];
}

export interface MemberWriteParams extends MemberParams {
  lines: SourceLine[];
  renumber: boolean;
}

export interface MemberCreateParams extends MemberParams {
  type: string;
  text: string;
}

export interface MemberCopyParams {
  name: string;
  from: MemberRef;
  to: MemberRef;
  replace: boolean;
}

export interface MemberRenameParams extends MemberParams {
  newName: string;
}

/** `type` and `text` left out keep each as it is. */
export interface MemberChangeTextParams extends MemberParams {
  type?: string;
  text?: string;
}

export type IfsKind = 'file' | 'directory' | 'symlink' | 'other';

/** An `ifs.list` entry. */
export interface IfsEntry {
  name: string;
  kind: IfsKind;
  /** Bytes. */
  size: number;
  /** Milliseconds since 1970-01-01 UTC. */
  modified: number;
  owner: string;
  ccsid: number;
  /** A symbolic link's target, as stored. */
  target?: string;
}

/**
 * What a copy of a file is checked against: `Stat`'s change counter as a
 * string (it is a u64), or `m` and `GetInfo`'s `modified` before QAP
 * version 6. Only compared.
 */
export type IfsChange = string;

/** Result of `ifs.info`: the entry (a link itself) and its change. */
export interface IfsInfo extends IfsEntry {
  change: IfsChange;
}

export interface IfsPathParams {
  name: string;
  path: string;
}

export interface IfsListParams extends IfsPathParams {
  /** `*` and `?` wildcards; absent for every entry. */
  pattern?: string;
}

/** Result of `ifs.readText`: the file converted by the server to UTF-8. */
export interface IfsText {
  text: string;
  /** The file's own CCSID. */
  ccsid: number;
  /** The file's size in its own bytes. */
  size: number;
  change: IfsChange;
}

export type IfsWriteMode = 'create' | 'replace';

export interface IfsWriteTextParams extends IfsPathParams {
  text: string;
  /** The CCSID of a file created; absent for 1208. An existing file keeps its own. */
  ccsid?: number;
  mode: IfsWriteMode;
  /** The change the text was read with; `IfsErrorCodes.Changed` when it differs now. */
  expect?: IfsChange;
}

export interface IfsWritten {
  /** The file's size in its own CCSID. */
  size: number;
  change: IfsChange;
}

export interface IfsMkdirParams extends IfsPathParams {
  parents: boolean;
}

export interface IfsFromToParams {
  name: string;
  from: string;
  to: string;
  replace: boolean;
}

export interface IfsDownloadParams extends IfsPathParams {
  /** The local file written, created or replaced. Deleted again when the download does not finish. */
  to: string;
  /** The ID progress, the end and `ifs.cancel` use; the host makes one when absent. */
  transfer?: string;
}

export type IfsUploadMode = 'create' | 'replace' | 'resume';

export interface IfsUploadParams extends IfsPathParams {
  /** The local file read. */
  from: string;
  /** The CCSID of a file created; absent for 1208. */
  ccsid?: number;
  /** `resume` goes on from the size the system has; `replace` starts again. */
  mode: IfsUploadMode;
  transfer?: string;
}

export interface IfsCancelParams {
  name: string;
  transfer: string;
}

/** `ifs.progress`, at most every 250 ms per transfer. */
export interface IfsProgress {
  transfer: string;
  path: string;
  /** Bytes the system (upload) or the local file (download) has. */
  done: number;
  total: number;
}

/** `ifs.transferEnded`, once per transfer, before its answer. */
export interface IfsTransferEnded {
  transfer: string;
  outcome: 'done' | 'cancelled' | 'error';
  message?: string;
  /** An upload's bytes confirmed when it stopped. */
  offset?: number;
}

/**
 * A message as a command or compile sent it: the server's own, with its
 * second-level text when it has one.
 */
export interface CommandMessage {
  id: string;
  severity: number;
  text: string;
  secondLevel?: string;
}

export interface ActionCheckParams {
  name: string;
  command: string;
}

/** Result of `action.check`: `CheckCommand`'s outcome. */
export interface ActionCheckResult {
  /** `Ok`, `Error` or `NotFound`. */
  status: string;
  valid: boolean;
  /** The check's messages; none when the command is valid. */
  messages: CommandMessage[];
}

/**
 * `compile` runs `Develop.Compile`, whose outcome carries the compiler's
 * diagnostics; `command` runs `RunCommand`.
 */
export type ActionKind = 'compile' | 'command';

export interface ActionRunParams {
  /** The connection. */
  name: string;
  command: string;
  kind: ActionKind;
  /** The ID `action.cancel` names; the host makes one when absent. */
  run?: string;
}

export interface ActionCancelParams {
  name?: string;
  run: string;
}

/** Where a diagnostic points: the member compiled or a `/COPY` member, a stream file, or nowhere. */
export type DiagnosticAt =
  | { kind: 'member'; library: string; file: string; member: string }
  | { kind: 'path'; path: string }
  | { kind: 'none' };

/**
 * A compiler's message, as the spec's `Diagnostic`: lines and columns from
 * 1, 0 unknown; `endLine` 0 is `line`. `help` is the second-level text.
 */
export interface CompileDiagnostic {
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

/** Result of `action.run`: the command's or the compile's outcome as QAP returned it. */
export interface ActionOutcome {
  /** `Ok`, `Error`, `NotFound`, `NotAuthorized` or `Cancelled`. */
  status: string;
  /** The escape message that ended it, when one did. */
  escape?: CommandMessage;
  /** The job it ran in; absent when it was cancelled while it waited in the lane. */
  job?: SessionJob;
  /** Every message it sent its caller, oldest first. */
  messages: CommandMessage[];
  /** The compiler's; always empty for `command`. */
  diagnostics: CompileDiagnostic[];
}

export interface JobLogParams {
  /** The connection. */
  name: string;
  /** The job; absent for the connection's own. */
  job?: SessionJob;
}

/** One message of a job log. */
export interface JobLogEntry {
  /** When it was sent, milliseconds since 1970-01-01 UTC. */
  sent: number;
  /** Empty for an impromptu message. */
  id: string;
  severity: number;
  /** `informational`, `completion`, `diagnostic`, `escape` … */
  kind: string;
  text: string;
  secondLevel?: string;
  fromProgram: string;
  toProgram: string;
}

/** Result of `job.log`: the whole log, oldest first. */
export interface JobLogResult {
  job: SessionJob;
  entries: JobLogEntry[];
}

/** Requests the extension sends, by method name. */
/** `sql.*`'s commit level: the spec's `CommitLevel` (`*NONE`, `*CHG`, `*CS`, `*ALL`, `*RR`). */
export type SqlCommit = 'none' | 'readUncommitted' | 'readCommitted' | 'repeatableRead' | 'serializable';
/** `sql.*`'s naming: `schema.table` or `library/file`. */
export type SqlNaming = 'sql' | 'system';

/** The session's SQL options, and whether changes wait for a commit or rollback. */
export interface SqlOptions {
  commit: SqlCommit;
  naming: SqlNaming;
  defaultSchema?: string;
  uncommitted: boolean;
}

export interface SqlOptionsSetParams {
  name: string;
  commit?: SqlCommit;
  naming?: SqlNaming;
  /** Empty: none. */
  defaultSchema?: string;
}

/** A result column or a table's column, as the spec's `Column`. */
export interface SqlColumn {
  name: string;
  label: string;
  /** The SQL type (`DECIMAL`). */
  type: string;
  length: number;
  scale: number;
  nullable: boolean;
  /** 65535 for binary character data, 0 for non-character. */
  ccsid: number;
}

/**
 * One value as the host sends it: `null`; a number (an integer within
 * 53 bits); a string (a larger integer, a decimal or float's exact text,
 * text, an ISO date, time or timestamp); a boolean; or `{ hex }` bytes.
 */
export type SqlCell = null | number | string | boolean | { hex: string };

export interface SqlRunParams {
  name: string;
  sql: string;
  maxRows?: number;
  /** The ID `sql.cancel` names. */
  run?: string;
}

export interface SqlRunResult {
  kind: 'query' | 'update' | 'ddl';
  columns?: SqlColumn[];
  rows?: SqlCell[][];
  /** The cursor has no more rows. */
  end?: boolean;
  /** The result's ID for `sql.fetch`, `sql.export` and `sql.close`. */
  cursor?: number;
  updated?: number;
  /** Cancelled while it ran. */
  cancelled?: boolean;
  messages: CommandMessage[];
  uncommitted: boolean;
}

export interface SqlFetchParams {
  name: string;
  cursor: number;
  maxRows?: number;
}

export interface SqlFetchResult {
  rows: SqlCell[][];
  end: boolean;
}

export interface SqlCursorParams {
  name: string;
  cursor: number;
}

export interface SqlExportParams {
  name: string;
  cursor: number;
  /** A local file, written whole: CSV, UTF-8 with no byte order mark. */
  to: string;
  format?: 'csv';
  /** The ID `sql.progress` and `sql.cancel` use. */
  export?: string;
}

/** `sql.progress`: rows written so far, at most every 250 ms. */
export interface SqlProgress {
  export: string;
  rows: number;
}

export interface SqlCancelParams {
  name?: string;
  /** A run's or an export's ID. */
  id: string;
}

/** `sql.lost`: uncommitted changes and open cursors went with the connection. */
export interface SqlLost {
  name: string;
  message: string;
}

/** `data` of an SQL error, beside a `ServerMessageData`'s fields. */
export interface SqlErrorData {
  status?: string;
  messageId?: string;
  text?: string;
  secondLevel?: string;
  sqlstate?: string;
  sqlcode?: number;
  /** The failing parameter row. */
  row?: number;
}

/** Error codes of `sql.*` (host/crates/code-host/src/sql/mod.rs). */
export const SqlErrorCodes = {
  /** A run or an export was cancelled. `data` is `{ id, rows }`. */
  Cancelled: -32030,
  /** No result has that cursor, or its rows are no longer held. */
  NoResult: -32031,
} as const;

export interface HostMethods {
  'host.version': { params: undefined; result: HostVersionResult };
  'host.ping': { params: PingParams; result: PingParams };
  'host.shutdown': { params: undefined; result: null };
  'session.connect': { params: ConnectParams; result: SessionStatus };
  'session.changePassword': { params: ChangePasswordParams; result: SessionStatus };
  'session.disconnect': { params: NameParams; result: null };
  'session.status': { params: NameParams; result: SessionStatus };
  'session.list': { params: undefined; result: SessionStatus[] };
  'libl.get': { params: NameParams; result: LibraryList };
  'libl.set': { params: LiblSetParams; result: LibraryList };
  'object.libraries': { params: LibrariesParams; result: LibraryEntry[] };
  'object.list': { params: ObjectListParams; result: ObjectEntry[] };
  'object.properties': { params: ObjectPropertiesParams; result: ObjectProperty[] };
  'member.list': { params: MemberListParams; result: MemberEntry[] };
  'member.read': { params: MemberReadParams; result: MemberReadResult };
  'member.write': { params: MemberWriteParams; result: { lines: number } };
  'member.unlock': { params: MemberParams; result: null };
  'member.create': { params: MemberCreateParams; result: null };
  'member.copy': { params: MemberCopyParams; result: null };
  'member.rename': { params: MemberRenameParams; result: null };
  'member.delete': { params: MemberParams; result: null };
  'member.changeText': { params: MemberChangeTextParams; result: null };
  'ifs.list': { params: IfsListParams; result: IfsEntry[] };
  'ifs.info': { params: IfsPathParams; result: IfsInfo };
  'ifs.readText': { params: IfsPathParams; result: IfsText };
  'ifs.writeText': { params: IfsWriteTextParams; result: IfsWritten };
  'ifs.mkdir': { params: IfsMkdirParams; result: null };
  'ifs.delete': { params: IfsPathParams; result: null };
  'ifs.rename': { params: IfsFromToParams; result: null };
  'ifs.copy': { params: IfsFromToParams; result: null };
  'ifs.resolve': { params: IfsPathParams; result: { path: string } };
  /** Answered when the transfer ends: no request timeout. */
  'ifs.download': { params: IfsDownloadParams; result: { size: number } };
  /** Answered when the transfer ends: no request timeout. */
  'ifs.upload': { params: IfsUploadParams; result: { size: number } };
  'ifs.cancel': { params: IfsCancelParams; result: null };
  /** Waits in the connection job's lane; the host bounds the wait. */
  'action.check': { params: ActionCheckParams; result: ActionCheckResult };
  /** Answered when the command ends, however long it runs: no request timeout. */
  'action.run': { params: ActionRunParams; result: ActionOutcome };
  'action.cancel': { params: ActionCancelParams; result: null };
  'job.log': { params: JobLogParams; result: JobLogResult };
  'sql.options.get': { params: NameParams; result: SqlOptions };
  'sql.options.set': { params: SqlOptionsSetParams; result: SqlOptions };
  /** Waits in the connection job's lane until the statement ends: no request timeout. */
  'sql.run': { params: SqlRunParams; result: SqlRunResult };
  /** Waits in the lane: no request timeout. */
  'sql.fetch': { params: SqlFetchParams; result: SqlFetchResult };
  'sql.close': { params: SqlCursorParams; result: null };
  /** Waits in the lane: no request timeout. */
  'sql.commit': { params: NameParams; result: SqlOptions };
  /** Waits in the lane: no request timeout. */
  'sql.rollback': { params: NameParams; result: SqlOptions };
  'sql.cancel': { params: SqlCancelParams; result: null };
  /** Answered when the export ends: no request timeout. */
  'sql.export': { params: SqlExportParams; result: { rows: number } };
}

/** Notifications the host sends, by method name. */
export interface HostNotifications {
  'host.log': LogParams;
  'session.changed': SessionStatus;
  'ifs.progress': IfsProgress;
  'ifs.transferEnded': IfsTransferEnded;
  'sql.lost': SqlLost;
  'sql.progress': SqlProgress;
}

export type MethodName = keyof HostMethods;
export type ParamsOf<M extends MethodName> = HostMethods[M]['params'];
export type ResultOf<M extends MethodName> = HostMethods[M]['result'];

/** A JSON-RPC 2.0 error object. */
export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** Standard JSON-RPC 2.0 error codes. */
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** `data` of `SessionErrorCodes.QapUnavailable`: the version the connection agreed. */
export interface QapUnavailableData {
  version: number;
}

/** Error codes of the host's session methods (host/crates/code-host/src/session.rs). */
export const SessionErrorCodes = {
  /**
   * `libl.*`, `object.*`, `member.*`: the connection agreed a QAP version
   * below 8, which has no `Develop` service. `data` is a `QapUnavailableData`.
   */
  QapUnavailable: -32001,
  NotConnected: -32002,
  /** Sign on again: the kept password was refused, or none is kept. */
  NeedsPassword: -32003,
  /** The server refused; `data` is a `ServerMessageData`. */
  Server: -32010,
  /** Name lookup, TCP, TLS, a closed connection, no reply in time. */
  Transport: -32011,
  /** A local file a transfer reads or writes failed. */
  Local: -32012,
} as const;

/** Error codes of `ifs.*` (host/crates/code-host/src/ifs.rs). */
export const IfsErrorCodes = {
  /** `ifs.writeText` with `expect`: changed on the system since. `data` is `{ change: IfsChange | null }`. */
  Changed: -32020,
  /** `ifs.readText` over the text limit. `data` is `{ size, limit }`. */
  TooLarge: -32021,
  /** A transfer was cancelled. `data` is `{ transfer, offset }`. */
  Cancelled: -32022,
  /** `ifs.resolve`: too many symbolic links in a row. */
  LinkLoop: -32023,
} as const;
