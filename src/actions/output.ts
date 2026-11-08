// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The block each run writes to the **Code for QS/400** output channel, and
 * where its `Job log: Show` link points. No `vscode` import.
 *
 * ```
 * ── 2026-11-07 23:59:01 · Compile (CRTBNDRPG) · HLINV/QTMPSRC(ASSETS42) · QSHQ400
 * Command: CRTBNDRPG PGM(CWELLMAN/ASSETS42) SRCFILE(HLINV/QTMPSRC) …
 * Job:     123456/QUSER/QAPCNN
 * RNF7030  ASSETQTY is not defined.
 * RNS9310  Program ASSETS42 was not created in library CWELLMAN.
 * Ended:   Error
 * Job log: Show
 * ```
 */

import type { ActionOutcome, CommandMessage, SessionJob } from '../host/protocol';

/** The output channel's name. */
export const OUTPUT_CHANNEL = 'Code for QS/400';

/** The output channel's language, which carries the `Job log: Show` links. */
export const OUTPUT_LANGUAGE = 'code-for-qs400-output';

/** The text of the link line. */
export const JOB_LOG_LINE = 'Job log: Show';

/** The rule each block starts with. */
export const BLOCK_START = '── ';

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:MM:SS`, local time. */
export function timestamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `nnnnnn/USER/NAME`. */
export function jobText(j: SessionJob): string {
  return `${j.number}/${j.user}/${j.name}`;
}

/** `ID  text`, or the text alone for a message without an ID. */
export function messageLine(m: CommandMessage): string {
  return m.id ? `${m.id}  ${m.text}` : m.text;
}

/** The job a `SBMJOB` submitted, from its completion message (`CPC1221`: "Job 123456/CWELLMAN/ASSETS submitted …"). */
export function submittedJob(messages: CommandMessage[]): string | undefined {
  for (const m of messages) {
    const found = /\b(\d{6}\/[^/\s]+\/[^/\s.]+)/.exec(m.text);
    if (m.id === 'CPC1221' && found) {
      return found[1];
    }
  }
  return undefined;
}

export interface RunHeader {
  when: Date;
  action: string;
  target: string;
  connection: string;
  command: string;
}

/** The lines a run starts with, before it is sent. */
export function headerLines(h: RunHeader): string[] {
  return [`${BLOCK_START}${timestamp(h.when)} · ${h.action} · ${h.target} · ${h.connection}`, `Command: ${h.command}`];
}

/** The status line's word for how a run ended. */
export function endedText(status: string): string {
  switch (status) {
    case 'Ok':
      return 'Completed';
    case 'Cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

/**
 * The lines of an outcome: the job, the messages oldest first, the escape
 * message last (once, when it is also the last message), how it ended, and
 * the link to the job log. A batch run names the job it submitted and says
 * that diagnostics do not come back.
 */
export function outcomeLines(o: ActionOutcome, batch: boolean): string[] {
  const out: string[] = [];
  if (o.job) {
    out.push(`Job:     ${jobText(o.job)}`);
  }
  const same = (a: CommandMessage, b: CommandMessage) => a.id === b.id && a.text === b.text;
  const messages = o.escape ? o.messages.filter((m) => !same(m, o.escape as CommandMessage)) : o.messages;
  for (const m of messages) {
    out.push(messageLine(m));
  }
  if (o.escape) {
    out.push(messageLine(o.escape));
  }
  if (batch) {
    const job = submittedJob(o.messages);
    if (job) {
      out.push(`Submitted: ${job}`);
    }
    out.push('Diagnostics are not returned for batch runs: the job runs outside the connection job.');
  }
  out.push(`Ended:   ${endedText(o.status)}`);
  out.push(JOB_LOG_LINE);
  return out;
}

/** The lines of a run that failed before it had an outcome. */
export function failureLines(message: string, sent: boolean): string[] {
  return sent ? [`Failed:  ${message}`, JOB_LOG_LINE] : [`Not run: ${message}`];
}

/**
 * The connection whose job log a `Job log: Show` line at `line` opens: the
 * one its block's first line names.
 */
export function linkConnection(lines: readonly string[], line: number): string | undefined {
  for (let i = line; i >= 0; i--) {
    if (lines[i].startsWith(BLOCK_START)) {
      const parts = lines[i].split(' · ');
      return parts.length >= 4 ? parts[parts.length - 1].trim() : undefined;
    }
  }
  return undefined;
}
