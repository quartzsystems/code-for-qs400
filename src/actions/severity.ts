// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The one table from a compiler message's severity (0 to 99) to the
 * Problems panel's. No `vscode` import.
 */

import table from '../../host/crates/severity/severity.json';

export type ProblemSeverity = 'information' | 'warning' | 'error';

/**
 * Each row covers severities below `below`, from the previous row's
 * `below`. The rows are `host/crates/severity/severity.json`, which the
 * language servers read too, so the two cannot disagree.
 */
export const SEVERITY_TABLE: readonly { below: number; severity: ProblemSeverity }[] = (
  table as { below: number | null; severity: ProblemSeverity }[]
).map((r) => ({ below: r.below ?? Infinity, severity: r.severity }));

/** `< 10` information, `10–19` warning, `≥ 20` error. */
export function problemSeverity(severity: number): ProblemSeverity {
  return (SEVERITY_TABLE.find((r) => severity < r.below) ?? SEVERITY_TABLE[SEVERITY_TABLE.length - 1]).severity;
}
