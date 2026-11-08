// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * **Export CSV** of a result tab: the host writes the rows the tab shows,
 * then fetches the rest of the cursor in pages straight to the file
 * (`sql.export`), with progress by rows and Cancel. A cancelled or failed
 * export leaves no file. Rows past those shown are not kept, so after an
 * export that read further the tab says so and loads no more.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { HostClient, HostRpcError } from '../host/client';
import { SqlErrorCodes } from '../host/protocol';
import type { ResultPanel, ResultTab } from './results';

/** The file name offered: the statement's table, else `result`. */
export function exportName(sql: string): string {
  const m = /\bFROM\s+("?[\w#@$]+"?[./])?"?([\w#@$]+)"?/i.exec(sql);
  return m ? `${m[2].toUpperCase()}.csv` : 'result.csv';
}

export class Exporter {
  private next = 0;

  constructor(
    private readonly host: HostClient,
    private readonly sessions: SessionManager,
    panel: ResultPanel,
  ) {
    panel.exporter = (t) => this.ask(t, panel).then(() => undefined);
  }

  /** Asks where, then exports. The rows written, or undefined. */
  async ask(tab: ResultTab, panel: ResultPanel): Promise<number | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const to = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(folder, exportName(tab.run.sql))),
      filters: { CSV: ['csv'] },
      saveLabel: 'Export',
    });
    return to ? this.export(tab, panel, to.fsPath) : undefined;
  }

  /** `sql.export` of `tab` to `file`, with progress and Cancel. */
  async export(tab: ResultTab, panel: ResultPanel, file: string): Promise<number | undefined> {
    if (tab.cursor === undefined) {
      return undefined;
    }
    const id = `x${++this.next}`;
    const name = tab.run.connection;
    const cursor = tab.cursor;
    tab.busy = true;
    panel.refresh(tab);
    try {
      const rows = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting to ${path.basename(file)}`, cancellable: true },
        async (progress, token) => {
          const sub = this.host.onDidExportProgress((p) => {
            if (p.export === id) {
              progress.report({ message: `${p.rows} rows` });
            }
          });
          const stop = token.onCancellationRequested(() => void this.host.request('sql.cancel', { name, id }).catch(() => undefined));
          try {
            return (await this.sessions.call(name, 'sql.export', { name, cursor, to: file, format: 'csv', export: id })).rows;
          } finally {
            sub.dispose();
            stop.dispose();
          }
        },
      );
      tab.busy = false;
      if (!tab.end) {
        tab.end = true;
        if (rows > tab.rows.length) {
          tab.note = `${rows} rows exported to ${path.basename(file)}; the ${tab.rows.length} shown are kept`;
        }
      }
      panel.refresh(tab);
      void vscode.window.showInformationMessage(`Code for QS/400: ${rows} rows exported to ${file}.`);
      return rows;
    } catch (err) {
      tab.busy = false;
      if (err instanceof HostRpcError && err.code === SqlErrorCodes.Cancelled) {
        // The cancel closed the cursor.
        tab.end = true;
        tab.note = 'Export cancelled: no file written, no more rows';
        void vscode.window.showInformationMessage('Code for QS/400: export cancelled; no file was written.');
      } else {
        void showError(err, name);
      }
      panel.refresh(tab);
      return undefined;
    }
  }
}
