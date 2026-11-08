// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The SQL results page: a tab per run, a grid that draws only the rows in
 * view (a row is 22 px, so 500 rows draw at once), each column's SQL type
 * in its header, numbers to the right, `NULL` as a muted `-`, binary as hex
 * with a copy button, and a footer with the row count, **Load more**,
 * **Export CSV**, the elapsed time and the statement. Read-only. Colours
 * and fonts are VS Code's CSS variables only; nothing is loaded from
 * anywhere (the content security policy allows only this page's own
 * script and style, by nonce). No `vscode` import.
 *
 * Messages from the page: `ready`, `select`, `close`, `more`, `export`,
 * `copy`. To the page: `tabs` (the strip and the active tab, whole) and
 * `rows` (rows added to a tab by Load more).
 */

/** One tab as the page draws it. */
export interface PageTab {
  id: string;
  title: string;
  connection: string;
  sql: string;
  kind: 'query' | 'update' | 'ddl' | 'error';
  /** The outcome line: `12 rows`, `0 rows updated`, `SQL0104`. */
  summary: string;
  columns?: { name: string; label: string; type: string; nullable: boolean; numeric: boolean }[];
  rows?: unknown[][];
  /** More rows can be loaded. */
  more: boolean;
  /** Load more or an export is running. */
  busy: boolean;
  /** Export CSV is offered. */
  exportable: boolean;
  /** Why no more rows can be loaded, when it is not their end. */
  note?: string;
  elapsed: number;
  messages: { id: string; text: string; secondLevel?: string }[];
  error?: { messageId?: string; text: string; secondLevel?: string; sqlstate?: string; sqlcode?: number };
}

export type ToPage = { type: 'tabs'; tabs: Pick<PageTab, 'id' | 'title' | 'kind'>[]; active?: PageTab } | { type: 'rows'; id: string; rows: unknown[][]; more: boolean; summary: string; note?: string; busy: boolean };

export type FromPage =
  | { type: 'ready' }
  | { type: 'select'; id: string }
  | { type: 'close'; id: string }
  | { type: 'more'; id: string }
  | { type: 'export'; id: string }
  | { type: 'copy'; text: string };

/** The page, with `nonce` on its script and style and `csp` the webview's own source. */
export function resultsHtml(nonce: string, csp: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SQL results</title>
<style nonce="${nonce}">
  :root { --row: 22px; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  #tabs { display: flex; flex-wrap: nowrap; overflow-x: auto; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border)); flex: none; }
  .tab { display: flex; align-items: center; gap: 4px; padding: 4px 8px; cursor: pointer; white-space: nowrap; max-width: 260px;
    color: var(--vscode-tab-inactiveForeground); background: var(--vscode-tab-inactiveBackground); border-right: 1px solid var(--vscode-tab-border, transparent); }
  .tab.active { color: var(--vscode-tab-activeForeground); background: var(--vscode-tab-activeBackground); }
  .tab .label { overflow: hidden; text-overflow: ellipsis; }
  .tab.error .label { color: var(--vscode-errorForeground); }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 2px 10px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.icon { color: inherit; background: transparent; padding: 0 4px; }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  #body { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  #empty { padding: 12px; color: var(--vscode-descriptionForeground); }
  #grid { flex: 1; overflow: auto; position: relative; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  #head { position: sticky; top: 0; z-index: 1; display: grid; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border)); }
  .th { padding: 2px 6px; overflow: hidden; white-space: nowrap; border-right: 1px solid var(--vscode-panel-border, transparent); }
  .th .name { font-weight: 600; }
  .th .type { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .th.num { text-align: right; }
  #rows { position: relative; }
  .tr { position: absolute; left: 0; display: grid; height: var(--row); line-height: var(--row); }
  .tr:nth-child(odd) { background: var(--vscode-list-hoverBackground, transparent); }
  .td { padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: pre; border-right: 1px solid var(--vscode-panel-border, transparent); }
  .td.num { text-align: right; }
  .td.null { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
  .td.rownum { color: var(--vscode-editorLineNumber-foreground); text-align: right; }
  #outcome { padding: 12px; }
  #outcome .big { font-size: 1.2em; }
  .err { color: var(--vscode-errorForeground); }
  .muted { color: var(--vscode-descriptionForeground); }
  #messages { padding: 0 8px; flex: none; }
  #messages div { padding: 2px 0; }
  #foot { flex: none; display: flex; align-items: center; gap: 12px; padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border)); flex-wrap: wrap; }
  #foot details { flex: 1 1 200px; min-width: 0; }
  #foot summary { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  pre { margin: 4px 0; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
<div id="tabs" role="tablist"></div>
<div id="body"><div id="empty">Run a statement to see its results here.</div></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const ROW = 22;
  let tabs = [];
  let active = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function cell(v) {
    if (v === null || v === undefined) return { text: '-', cls: 'null', title: 'NULL' };
    if (typeof v === 'object' && v !== null && typeof v.hex === 'string') return { text: v.hex, cls: 'hex', title: 'X\\'' + v.hex + '\\'', hex: v.hex };
    return { text: String(v), cls: '', title: String(v) };
  }

  function widths(t) {
    const cols = t.columns || [];
    const sample = (t.rows || []).slice(0, 200);
    const ch = 7.5;
    const w = cols.map((c, i) => {
      let n = Math.max(c.name.length, c.type.length + (c.nullable ? 2 : 0));
      for (const r of sample) n = Math.max(n, Math.min(60, cell(r[i]).text.length));
      return Math.round(Math.min(420, Math.max(56, n * ch + 16)));
    });
    const num = Math.max(36, String((t.rows || []).length).length * ch + 16);
    return [num].concat(w).map((x) => x + 'px').join(' ');
  }

  function drawTabs() {
    const strip = document.getElementById('tabs');
    strip.textContent = '';
    for (const t of tabs) {
      const b = el('div', 'tab' + (active && t.id === active.id ? ' active' : '') + (t.kind === 'error' ? ' error' : ''));
      b.setAttribute('role', 'tab');
      b.title = t.title;
      b.appendChild(el('span', 'label', t.title));
      const x = el('button', 'icon', '×');
      x.title = 'Close';
      x.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'close', id: t.id }); });
      b.appendChild(x);
      b.addEventListener('click', () => vscode.postMessage({ type: 'select', id: t.id }));
      strip.appendChild(b);
    }
  }

  function drawRows(grid, rowsEl, t, template) {
    const rows = t.rows || [];
    const top = grid.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW) - 20);
    const last = Math.min(rows.length, Math.ceil((top + grid.clientHeight) / ROW) + 20);
    rowsEl.textContent = '';
    for (let r = first; r < last; r++) {
      const tr = el('div', 'tr');
      tr.style.top = r * ROW + 'px';
      tr.style.gridTemplateColumns = template;
      tr.appendChild(el('div', 'td rownum', String(r + 1)));
      const row = rows[r];
      (t.columns || []).forEach((c, i) => {
        const v = cell(row[i]);
        const td = el('div', 'td' + (c.numeric ? ' num' : '') + (v.cls ? ' ' + v.cls : ''), v.text);
        td.title = v.title;
        if (v.hex !== undefined) {
          const copy = el('button', 'icon', '⧉');
          copy.title = 'Copy hex';
          copy.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: v.hex }));
          td.prepend(copy);
        }
        tr.appendChild(td);
      });
      rowsEl.appendChild(tr);
    }
  }

  function drawBody() {
    const body = document.getElementById('body');
    body.textContent = '';
    const t = active;
    if (!t) {
      body.appendChild(el('div', '', 'Run a statement to see its results here.')).id = 'empty';
      return;
    }
    if (t.kind === 'query') {
      const grid = el('div');
      grid.id = 'grid';
      const template = widths(t);
      const head = el('div');
      head.id = 'head';
      head.style.gridTemplateColumns = template;
      head.appendChild(el('div', 'th', '#'));
      for (const c of t.columns || []) {
        const th = el('div', 'th' + (c.numeric ? ' num' : ''));
        th.appendChild(el('div', 'name', c.name));
        th.appendChild(el('div', 'type', c.type + (c.nullable ? ' ?' : '')));
        th.title = c.label + ' · ' + c.type + (c.nullable ? ' · nullable' : ' · not null');
        head.appendChild(th);
      }
      grid.appendChild(head);
      const rowsEl = el('div');
      rowsEl.id = 'rows';
      rowsEl.style.height = (t.rows || []).length * ROW + 'px';
      grid.appendChild(rowsEl);
      body.appendChild(grid);
      grid.addEventListener('scroll', () => drawRows(grid, rowsEl, t, template));
      requestAnimationFrame(() => drawRows(grid, rowsEl, t, template));
      t.redraw = () => { rowsEl.style.height = (t.rows || []).length * ROW + 'px'; drawRows(grid, rowsEl, t, template); };
    } else {
      const o = el('div');
      o.id = 'outcome';
      if (t.error) {
        const line = el('div', 'big err');
        line.textContent = (t.error.messageId ? t.error.messageId + ': ' : '') + t.error.text;
        o.appendChild(line);
        const meta = [];
        if (t.error.sqlstate) meta.push('SQLSTATE ' + t.error.sqlstate);
        if (t.error.sqlcode !== undefined) meta.push('SQLCODE ' + t.error.sqlcode);
        if (meta.length) o.appendChild(el('div', 'muted', meta.join(' · ')));
        if (t.error.secondLevel) o.appendChild(el('pre', 'muted', t.error.secondLevel));
      } else {
        o.appendChild(el('div', 'big', t.summary));
      }
      body.appendChild(o);
    }
    if (t.messages && t.messages.length) {
      const m = el('div');
      m.id = 'messages';
      for (const x of t.messages) {
        const d = el('div', '', (x.id ? x.id + '  ' : '') + x.text);
        if (x.secondLevel) d.title = x.secondLevel;
        m.appendChild(d);
      }
      body.appendChild(m);
    }
    const foot = el('div');
    foot.id = 'foot';
    const count = el('span', '', t.summary);
    count.id = 'count';
    foot.appendChild(count);
    if (t.kind === 'query') {
      const more = el('button', '', 'Load more');
      more.id = 'more';
      more.hidden = !t.more;
      more.disabled = t.busy;
      more.addEventListener('click', () => vscode.postMessage({ type: 'more', id: t.id }));
      foot.appendChild(more);
      const exp = el('button', '', 'Export CSV');
      exp.id = 'export';
      exp.hidden = !t.exportable;
      exp.disabled = t.busy;
      exp.addEventListener('click', () => vscode.postMessage({ type: 'export', id: t.id }));
      foot.appendChild(exp);
    }
    const note = el('span', 'muted', t.note || '');
    note.id = 'note';
    foot.appendChild(note);
    foot.appendChild(el('span', 'muted', t.elapsed + ' ms · ' + t.connection));
    const det = el('details');
    det.appendChild(el('summary', 'muted', t.sql.split(/\\r?\\n/)[0]));
    det.appendChild(el('pre', '', t.sql));
    foot.appendChild(det);
    body.appendChild(foot);
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'tabs') {
      tabs = m.tabs;
      active = m.active || null;
      drawTabs();
      drawBody();
    } else if (m.type === 'rows' && active && active.id === m.id) {
      active.rows = (active.rows || []).concat(m.rows);
      active.more = m.more;
      active.busy = m.busy;
      active.summary = m.summary;
      active.note = m.note;
      document.getElementById('count').textContent = m.summary;
      const more = document.getElementById('more');
      if (more) { more.hidden = !m.more; more.disabled = m.busy; }
      const exp = document.getElementById('export');
      if (exp) exp.disabled = m.busy;
      document.getElementById('note').textContent = m.note || '';
      if (active.redraw) active.redraw();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
