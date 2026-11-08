// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * What the Jobs view and the job log show, without `vscode`: the groups by
 * state, each job's description, qualified job names, the filter's label,
 * the end choices and the job log's gutter glyphs.
 */

import type { JobEntry, JobLogEntry, JobState, MessageType, SessionJob } from '../host/protocol';

/** The Jobs view's groups, in the server's order. */
export const STATE_GROUPS: readonly { state: JobState; label: string; icon: string }[] = [
  { state: 'active', label: 'Active', icon: 'play-circle' },
  { state: 'onJobQueue', label: 'On job queue', icon: 'clock' },
  { state: 'onOutputQueue', label: 'On output queue', icon: 'output' },
];

/** `nnnnnn/USER/NAME`. */
export function qualifiedJob(j: SessionJob): string {
  return `${j.number}/${j.user}/${j.name}`;
}

/** The job `nnnnnn/USER/NAME` names, or undefined. */
export function parseQualifiedJob(s: string): SessionJob | undefined {
  const m = /^\s*(\d{6})\/([^/\s]+)\/([^/\s]+)\s*$/.exec(s);
  return m ? { number: m[1], user: m[2], name: m[3] } : undefined;
}

/** The same job: the number and both names, the names without case. */
export function sameJob(a: SessionJob | undefined, b: SessionJob | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.number === b.number &&
    a.user.toUpperCase() === b.user.toUpperCase() &&
    a.name.toUpperCase() === b.name.toUpperCase()
  );
}

/** Each state's jobs, in the order the server listed them; every state present. */
export function groupJobs(jobs: readonly JobEntry[]): Map<JobState, JobEntry[]> {
  const out = new Map<JobState, JobEntry[]>(STATE_GROUPS.map((g) => [g.state, []]));
  for (const j of jobs) {
    out.get(j.state)?.push(j);
  }
  return out;
}

/** `nnnnnn/USER · status · type · subsystem · function`, empty parts left out; `· this connection` on the connection's own job. */
export function jobDescription(e: JobEntry, own: boolean): string {
  const parts = [`${e.job.number}/${e.job.user}`, e.status, e.type, e.subsystem, e.function].filter((p) => p.trim() !== '');
  if (own) {
    parts.push('this connection');
  }
  return parts.join(' · ');
}

/** The user `jobs.list` is asked for: `*CURRENT` (My jobs), `*ALL` or a profile. */
export type JobFilter = string;

export const MY_JOBS: JobFilter = '*CURRENT';

/** The filter node's label. */
export function filterLabel(f: JobFilter): string {
  const u = f.trim().toUpperCase();
  if (u === '' || u === '*CURRENT') {
    return 'My jobs';
  }
  return u === '*ALL' ? 'All jobs (*ALL)' : `Jobs of ${u}`;
}

/** How `End…` ends a job: `ENDJOB OPTION`. */
export const END_CHOICES: readonly { how: 'controlled' | 'immediate'; label: string; detail: string }[] = [
  { how: 'controlled', label: '*CNTRLD', detail: 'Controlled: the job is told to end and given a delay to end on its own.' },
  { how: 'immediate', label: '*IMMED', detail: 'Immediately: the job ends now, without cleanup.' },
];

/** The modal's text before ending a job. */
export function endQuestion(j: SessionJob, how: 'controlled' | 'immediate', delay?: number): string {
  const option = how === 'immediate' ? '*IMMED' : `*CNTRLD${delay !== undefined ? ` DELAY(${delay})` : ''}`;
  return `End job ${qualifiedJob(j)} ${option}?`;
}

/** A controlled end's delay as typed: empty is the job's default (undefined), else 1 to 999999 seconds. */
export function parseDelay(v: string): number | undefined | 'invalid' {
  const t = v.trim();
  if (t === '') {
    return undefined;
  }
  if (!/^\d{1,6}$/.test(t) || Number(t) === 0) {
    return 'invalid';
  }
  return Number(t);
}

/** The job log's gutter glyphs, by kind. */
export type Glyph = 'escape' | 'diagnostic' | 'completion' | 'inquiry' | 'info';

export const GLYPHS: readonly Glyph[] = ['escape', 'diagnostic', 'completion', 'inquiry', 'info'];

export function kindGlyph(kind: MessageType): Glyph {
  switch (kind) {
    case 'escape':
      return 'escape';
    case 'diagnostic':
      return 'diagnostic';
    case 'completion':
      return 'completion';
    case 'inquiry':
    case 'reply':
    case 'senderCopy':
      return 'inquiry';
    default:
      return 'info';
  }
}

/** The lines of each glyph: line n is entry n. */
export function glyphLines(entries: readonly JobLogEntry[]): Map<Glyph, number[]> {
  const out = new Map<Glyph, number[]>(GLYPHS.map((g) => [g, []]));
  entries.forEach((e, i) => out.get(kindGlyph(e.kind))?.push(i));
  return out;
}
