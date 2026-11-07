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

/** Requests the extension sends, by method name. */
export interface HostMethods {
  'host.version': { params: undefined; result: HostVersionResult };
  'host.ping': { params: PingParams; result: PingParams };
  'host.shutdown': { params: undefined; result: null };
}

/** Notifications the host sends, by method name. */
export interface HostNotifications {
  'host.log': LogParams;
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
