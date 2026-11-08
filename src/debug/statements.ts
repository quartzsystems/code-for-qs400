// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';

/** The scheme of a module's synthetic document: `qs400dbg:/LIB/PROGRAM/MODULE`. */
export const STATEMENTS_SCHEME = 'qs400dbg';

/** Lines a synthetic document has at least. */
const MIN_LINES = 200;

/** Line `n` of a module's synthetic document. */
export function statementLine(program: string, module: string, n: number): string {
  return `${program} ${module}  statement ${n}`;
}

/** The program and module a synthetic URI names. */
export function parseStatementsUri(uri: vscode.Uri): { program: string; module: string } | undefined {
  const parts = uri.path.split('/').filter((p) => p !== '');
  return uri.scheme === STATEMENTS_SCHEME && parts.length === 3 ? { program: `${parts[0]}/${parts[1]}`, module: parts[2] } : undefined;
}

/**
 * The read-only document a frame stands on when its module has no source
 * view (`DBGVIEW(*STMT)` or `*LIST`) or its line is not known: line *n* is
 * statement *n*, so the frame's line is its statement. It grows to the
 * highest statement a stack has shown.
 */
export class StatementsProvider implements vscode.TextDocumentContentProvider {
  private readonly lines = new Map<string, number>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const at = parseStatementsUri(uri);
    if (!at) {
      return '';
    }
    const n = Math.max(MIN_LINES, this.lines.get(uri.toString()) ?? 0);
    const out: string[] = [];
    for (let i = 1; i <= n; i++) {
      out.push(statementLine(at.program, at.module, i));
    }
    return out.join('\n');
  }

  /** A frame on `path` at `line`: the document reaches it. */
  grow(path: string, line: number): void {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(path, true);
    } catch {
      return;
    }
    if (uri.scheme !== STATEMENTS_SCHEME) {
      return;
    }
    const k = uri.toString();
    if (line > (this.lines.get(k) ?? MIN_LINES)) {
      this.lines.set(k, line);
      this.changed.fire(uri);
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}
