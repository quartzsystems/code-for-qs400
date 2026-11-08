// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * Fixed-form RPG in the editor: guides at each line's own specification
 * boundaries, and the specification column under the cursor in the
 * status bar. A `**FREE` member gets neither.
 *
 * VS Code 1.143 has no API for an editor's rulers (`TextEditorOptions`
 * has none, and `editor.rulers` is set per language, not per document),
 * and a `[qs400-rpgle]` default would put rulers on `**FREE` members too.
 * So the guides are decorations: a line in the ruler colour at the start
 * of each field, on the lines long enough to reach it.
 */

import * as vscode from 'vscode';
import { type SpecForm, boundaries, columnOf, describe, formOf, isFree, offsetOf } from './rpgColumns';

const LANGUAGE = 'qs400-rpgle';

export class FixedFormRpg implements vscode.Disposable {
  private forms: readonly SpecForm[] | undefined;
  private loading: Promise<void> | undefined;
  private readonly guide = vscode.window.createTextEditorDecorationType({
    borderColor: new vscode.ThemeColor('editorRuler.foreground'),
    borderStyle: 'solid',
    borderWidth: '0 0 0 1px',
  });
  private readonly status = vscode.window.createStatusBarItem('code-for-qs400.rpgColumn', vscode.StatusBarAlignment.Right, 100);
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly load: () => Promise<readonly SpecForm[] | undefined>) {
    this.status.name = 'RPG column';
  }

  start(): void {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.refresh()),
      vscode.window.onDidChangeTextEditorSelection((e) => this.showColumn(e.textEditor)),
      vscode.workspace.onDidChangeTextDocument(() => this.refresh()),
    );
    this.refresh();
  }

  /** Whether an editor shows fixed-form RPG. */
  static isFixed(doc: vscode.TextDocument): boolean {
    return doc.languageId === LANGUAGE && !isFree(doc.lineAt(0).text);
  }

  /** The table, once the RPG server has given it. */
  async table(): Promise<readonly SpecForm[] | undefined> {
    if (!this.forms) {
      this.loading ??= this.load()
        .then((f) => {
          this.forms = f;
        })
        .catch(() => undefined)
        .finally(() => {
          this.loading = undefined;
        });
      await this.loading;
    }
    return this.forms;
  }

  private refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.paint(), 50);
  }

  /** Draw the guides in every visible editor, now. */
  async paint(): Promise<void> {
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document.languageId === LANGUAGE);
    if (editors.length === 0) {
      this.status.hide();
      return;
    }
    const forms = await this.table();
    for (const e of vscode.window.visibleTextEditors) {
      e.setDecorations(this.guide, forms && FixedFormRpg.isFixed(e.document) ? guides(e, forms) : []);
    }
    const active = vscode.window.activeTextEditor;
    if (active) {
      this.showColumn(active);
    }
  }

  private showColumn(editor: vscode.TextEditor): void {
    if (!this.forms || !FixedFormRpg.isFixed(editor.document) || editor !== vscode.window.activeTextEditor) {
      if (editor === vscode.window.activeTextEditor) {
        this.status.hide();
      }
      return;
    }
    const pos = editor.selection.active;
    const line = editor.document.lineAt(pos.line).text;
    const form = formOf(line, this.forms);
    const column = columnOf(line, pos.character);
    this.status.text = describe(form, column);
    this.status.tooltip = form ? `${form.title} specification, column ${column}` : `Column ${column}`;
    this.status.show();
  }

  /** The status bar's text (for tests). */
  get statusText(): string {
    return this.status.text;
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
export function guides(editor: vscode.TextEditor, forms: readonly SpecForm[]): vscode.Range[] {
  const out: vscode.Range[] = [];
  const doc = editor.document;
  for (const visible of editor.visibleRanges) {
    const last = Math.min(visible.end.line + 1, doc.lineCount - 1);
    for (let n = Math.max(visible.start.line - 1, 0); n <= last; n++) {
      out.push(...lineGuides(doc.lineAt(n).text, n, forms));
    }
  }
  return out;
}

/** One line's guides: a one-character range at each boundary the line reaches. */
export function lineGuides(text: string, line: number, forms: readonly SpecForm[]): vscode.Range[] {
  const form = formOf(text, forms);
  if (!form) {
    return [];
  }
  const chars = Array.from(text);
  const out: vscode.Range[] = [];
  for (const col of boundaries(form)) {
    const at = offsetOf(text, col);
    if (at !== undefined) {
      out.push(new vscode.Range(line, at, line, at + chars[col - 1].length));
    }
  }
  return out;
}
