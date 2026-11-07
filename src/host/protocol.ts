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

/** Params of `session.connect`. The port is left out for the host's default. */
export interface ConnectParams {
  name: string;
  host: string;
  port?: number;
  user: string;
  password: string;
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

/** Error codes of `session.*` and `libl.*` (host/crates/code-host/src/session.rs). */
export const SessionErrorCodes = {
  /** `libl.*`: the server has no `library_list` service. */
  LibraryListUnavailable: -32001,
  NotConnected: -32002,
  /** Sign on again: the kept password was refused, or none is kept. */
  NeedsPassword: -32003,
  /** The server refused; `data` is a `ServerMessageData`. */
  Server: -32010,
  /** Name lookup, TCP, TLS, a closed connection, no reply in time. */
  Transport: -32011,
} as const;
