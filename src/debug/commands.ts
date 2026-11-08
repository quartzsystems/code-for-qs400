// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import type { SessionJob } from '../host/protocol';
import { DEBUG_TYPE, programName } from './config';

/** Workspace state of the programs last attached with, per connection. */
const ATTACH_PROGRAMS_KEY = 'code-for-qs400.debug.attachPrograms';

/** `LIB/PGM` names typed with commas or blanks between them; the first that is no name, as an error. */
export function parsePrograms(text: string): string[] | string {
  const out: string[] = [];
  for (const word of text.split(/[\s,]+/).filter((w) => w !== '')) {
    const p = programName(word);
    if (!p) {
      return `${word} is not a program name (LIB/PGM)`;
    }
    out.push(p);
  }
  return out;
}

/** **Attach to Job…**: the programs to debug in the job, then an `attach` session. */
export async function attachToJob(connection: string, job: SessionJob, state: vscode.Memento): Promise<boolean> {
  const qualified = `${job.number}/${job.user}/${job.name}`;
  const remembered = state.get<Record<string, string>>(ATTACH_PROGRAMS_KEY, {});
  const typed = await vscode.window.showInputBox({
    title: `Attach to ${qualified}`,
    prompt: 'Programs to debug in the job (LIB/PGM), separated by commas or blanks. Breakpoints are set in their sources.',
    value: remembered[connection.toUpperCase()] ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const p = parsePrograms(v);
      return typeof p === 'string' ? p : undefined;
    },
  });
  if (typed === undefined) {
    return false;
  }
  const programs = parsePrograms(typed) as string[];
  await state.update(ATTACH_PROGRAMS_KEY, { ...remembered, [connection.toUpperCase()]: programs.join(', ') });
  return vscode.debug.startDebugging(undefined, {
    type: DEBUG_TYPE,
    request: 'attach',
    name: `Attach to ${qualified}`,
    connection,
    job: qualified,
    programs,
  });
}
