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

/** Requests the extension sends, by method name. */
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
}

/** Notifications the host sends, by method name. */
export interface HostNotifications {
  'host.log': LogParams;
  'session.changed': SessionStatus;
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
