// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * What the Spooled files view and the viewer show, without `vscode`: status
 * names, each file's and queue's label and description, the viewer's title
 * and path, save names and the delete question.
 */

import type { OutputQueue, SessionJob, SpoolStatus, SpooledFile, SpooledFileId } from '../host/protocol';
import { qualifiedJob, sameJob } from '../jobs/model';

/**
 * Each status as the tree shows it. The spec names them all; it describes
 * only `Message` (waiting for a reply) beyond its name, so the rest are
 * `WRKSPLF`'s words for the same states. QS/400 never sends `writing`.
 */
export const STATUS_LABELS: Record<SpoolStatus, string> = {
  ready: 'Ready',
  held: 'Held',
  open: 'Open',
  closed: 'Closed',
  writing: 'Writing',
  printing: 'Printing',
  message: 'Message waiting',
  pending: 'Pending',
  saved: 'Saved',
};

export function statusLabel(s: SpoolStatus | string): string {
  return STATUS_LABELS[s as SpoolStatus] ?? s;
}

/** `QSYSPRT (8)`. */
export function fileLabel(id: SpooledFileId): string {
  return `${id.file} (${id.number})`;
}

/** `FILE(number) nnnnnn/USER/NAME`. */
export function fileTitle(id: SpooledFileId): string {
  return `${id.file}(${id.number}) ${qualifiedJob(id.job)}`;
}

/** `status · pages · user data · form type · outq`, empty parts left out. */
export function fileDescription(f: SpooledFile): string {
  const pages = `${f.pages} ${f.pages === 1 ? 'page' : 'pages'}`;
  return [statusLabel(f.status), pages, f.userData, f.formType, `${f.outq.library}/${f.outq.name}`].filter((p) => p.trim() !== '').join(' · ');
}

/** `files · writer · held`. */
export function queueDescription(q: OutputQueue): string {
  const files = `${q.files} ${q.files === 1 ? 'file' : 'files'}`;
  return [files, q.writer ? `writer ${q.writer}` : 'no writer', q.held ? 'held' : ''].filter(Boolean).join(' · ');
}

/** The same spooled file. */
export function sameFile(a: SpooledFileId, b: SpooledFileId): boolean {
  return a.number === b.number && a.file.toUpperCase() === b.file.toUpperCase() && sameJob(a.job, b.job);
}

/** The name a download is offered under: `QSYSPRT-8-654321.pdf`. */
export function saveName(id: SpooledFileId, ext: 'txt' | 'pdf'): string {
  return `${id.file}-${id.number}-${id.job.number}.${ext}`;
}

/** The modal's text before a delete. */
export function deleteQuestion(id: SpooledFileId): string {
  return `Delete spooled file ${id.file} number ${id.number} of job ${qualifiedJob(id.job)}?`;
}

/** The user whose files are a job's: the connection's own job's are the signed-on profile's. */
export function jobFilesUser(job: SessionJob, own: SessionJob | undefined): string {
  return sameJob(job, own) ? '*CURRENT' : job.user;
}

/**
 * The listing file a compile command names: its `PRTFILE`, without its
 * library, else `QSYSPRT`.
 */
export function listingFile(command: string): string {
  const m = /\bPRTFILE\(\s*(?:[^/()\s]+\/)?([^/()\s]+)\s*\)/i.exec(command);
  const name = m?.[1]?.toUpperCase();
  return name && !name.startsWith('*') ? name : 'QSYSPRT';
}

/**
 * The listing of a run: the newest file named `file` of the job, numbered
 * after `before` (the highest number the job had before the run).
 */
export function newListing(files: readonly SpooledFile[], job: SessionJob, file: string, before: number): SpooledFile | undefined {
  return files
    .filter((f) => sameJob(f.id.job, job) && f.id.file.toUpperCase() === file.toUpperCase() && f.id.number > before)
    .sort((a, b) => b.id.number - a.id.number)[0];
}

/** The highest file number `job` has among `files`; 0 when none. */
export function highestNumber(files: readonly SpooledFile[], job: SessionJob): number {
  return files.filter((f) => sameJob(f.id.job, job)).reduce((n, f) => Math.max(n, f.id.number), 0);
}
