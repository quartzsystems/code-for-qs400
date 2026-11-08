// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * DDS column guides, and the field under the cursor in the status bar
 * (`A · Name 19–28 · col 21`), as fixed-form RPG has. `editor.rulers` runs every ruler the full height of
 * the editor, past the last line of the source, so the guides are
 * decorations as fixed-form RPG's are: a line in the ruler colour at the
 * start of each field, on the lines long enough to reach it.
 */

import * as vscode from 'vscode';
import { offsetOf } from './rpgColumns';

const LANGUAGE = 'qs400-dds';

/**
 * The 1-based columns a guide starts: the start of each DDS field
 * (form type 6, conditioning 7, name type 17, name 19, reference 29,
 * length 30, data type 35, decimals 36, usage 38, line 39, position 42,
 * keywords 45) and the end of the 80-column record.
 */
export const DDS_GUIDE_COLUMNS: readonly number[] = [6, 7, 8, 17, 18, 19, 29, 30, 35, 36, 38, 39, 42, 45, 81];

/** A field of a DDS line: its columns, 1-based and inclusive. */
export interface DdsField {
  from: number;
  to: number;
  name: string;
}

/** The fields of a DDS line, as every DDS type (PF, LF, DSPF, PRTF, ICFF) lays them out. */
export const DDS_FIELDS: readonly DdsField[] = [
  { from: 1, to: 5, name: 'Sequence' },
  { from: 6, to: 6, name: 'Form type' },
  { from: 7, to: 7, name: 'And/Or, comment' },
  { from: 8, to: 16, name: 'Condition' },
  { from: 17, to: 17, name: 'Name type' },
  { from: 18, to: 18, name: 'Reserved' },
  { from: 19, to: 28, name: 'Name' },
  { from: 29, to: 29, name: 'Reference' },
  { from: 30, to: 34, name: 'Length' },
  { from: 35, to: 35, name: 'Data type' },
  { from: 36, to: 37, name: 'Decimals' },
  { from: 38, to: 38, name: 'Usage' },
  { from: 39, to: 41, name: 'Line' },
  { from: 42, to: 44, name: 'Position' },
  { from: 45, to: 80, name: 'Keywords' },
];

/** The field at a 1-based column, if the column is inside the 80. */
export function ddsFieldAt(column: number): DdsField | undefined {
  return DDS_FIELDS.find((f) => column >= f.from && column <= f.to);
}

/**
 * What the status bar shows for a DDS line at a 1-based column:
 * `A · Name 19–28 · col 21`, `A* · Comment · col 30` on a comment line,
 * `col 85` past the 80.
 */
export function describeDds(line: string, column: number): string {
  const chars = Array.from(line);
  if (chars[6] === '*') {
    return column <= 5 ? `A* · Sequence 1–5 · col ${column}` : `A* · Comment · col ${column}`;
  }
  const f = ddsFieldAt(column);
  if (!f) {
    return `col ${column}`;
  }
  const span = f.from === f.to ? `${f.from}` : `${f.from}–${f.to}`;
  return `A · ${f.name} ${span} · col ${column}`;
}

export class DdsGuides implements vscode.Disposable {
  private readonly guide = vscode.window.createTextEditorDecorationType({
    borderColor: new vscode.ThemeColor('editorRuler.foreground'),
    borderStyle: 'solid',
    borderWidth: '0 0 0 1px',
  });
  private readonly status = vscode.window.createStatusBarItem('code-for-qs400.ddsColumn', vscode.StatusBarAlignment.Right, 100);
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    this.status.name = 'DDS column';
  }

  start(): void {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        this.showColumn(e);
        this.refresh();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.refresh()),
      vscode.window.onDidChangeTextEditorSelection((e) => this.showColumn(e.textEditor)),
      vscode.workspace.onDidChangeTextDocument(() => this.refresh()),
    );
    this.refresh();
    this.showColumn(vscode.window.activeTextEditor);
  }

  /** The field under the cursor of the active DDS editor; hidden for any other editor. */
  private showColumn(editor: vscode.TextEditor | undefined): void {
    if (editor && editor !== vscode.window.activeTextEditor) {
      return;
    }
    if (!editor || editor.document.languageId !== LANGUAGE) {
      this.status.hide();
      return;
    }
    const pos = editor.selection.active;
    const line = editor.document.lineAt(pos.line).text;
    const column = Array.from(line.slice(0, pos.character)).length + 1;
    this.status.text = describeDds(line, column);
    const f = ddsFieldAt(column);
    this.status.tooltip = f ? `DDS ${f.name}, columns ${f.from}–${f.to}; cursor at column ${column}` : `Column ${column}`;
    this.status.show();
  }

  /** The status bar's text (for tests). */
  get statusText(): string {
    return this.status.text;
  }

  private refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.paint(), 50);
  }

  /** Draw the guides in every visible DDS editor, now. */
  paint(): void {
    for (const e of vscode.window.visibleTextEditors) {
      if (e.document.languageId === LANGUAGE) {
        e.setDecorations(this.guide, ddsGuides(e));
      }
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.guide.dispose();
    this.status.dispose();
  }
}

/** The guide ranges of an editor's visible lines. */
export function ddsGuides(editor: vscode.TextEditor): vscode.Range[] {
  const out: vscode.Range[] = [];
  const doc = editor.document;
  for (const visible of editor.visibleRanges) {
    const last = Math.min(visible.end.line + 1, doc.lineCount - 1);
    for (let n = Math.max(visible.start.line - 1, 0); n <= last; n++) {
      out.push(...columnGuides(doc.lineAt(n).text, n, DDS_GUIDE_COLUMNS));
    }
  }
  return out;
}

/** One line's guides: a one-character range at each column the line reaches. */
export function columnGuides(text: string, line: number, columns: readonly number[]): vscode.Range[] {
  const chars = Array.from(text);
  const out: vscode.Range[] = [];
  for (const col of columns) {
    const at = offsetOf(text, col);
    if (at !== undefined) {
      out.push(new vscode.Range(line, at, line, at + chars[col - 1].length));
    }
  }
  return out;
}
