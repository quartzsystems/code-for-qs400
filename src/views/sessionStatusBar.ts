// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { ConnectionConfig, sameName } from '../connections/config';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { SessionStatus } from '../host/protocol';
import { isSignedOn, qualifiedJob } from './connections';

export const SWITCH_COMMAND = 'code-for-qs400.connection.switchActive';

/** The item's text: connected `$(plug) name · user`, stale `$(debug-disconnect) name`, else none. */
export function statusBarText(name: string, s: SessionStatus): string | undefined {
  if (s.state === 'connected') {
    return `$(plug) ${name} · ${s.user ?? ''}`;
  }
  if (s.state === 'stale') {
    return `$(debug-disconnect) ${name}`;
  }
  return undefined;
}

/** The tooltip: host, session job, system version. */
export function statusBarTooltip(c: ConnectionConfig, s: SessionStatus): vscode.MarkdownString {
  const tip = new vscode.MarkdownString(undefined, true);
  tip.appendMarkdown(`**${c.name}** · ${s.user ?? c.user}@${c.host}${c.port !== undefined ? `:${c.port}` : ''}\n\n`);
  if (s.job) {
    tip.appendMarkdown(`Session job ${qualifiedJob(s.job)}\n\n`);
  }
  if (s.system) {
    tip.appendMarkdown(`${s.system.name} · ${s.system.product} ${s.system.version}\n\n`);
  }
  if (s.state === 'stale') {
    tip.appendMarkdown('The server closed the connection. It reconnects on the next request.\n\n');
  }
  tip.appendMarkdown('Click to switch the active connection.');
  return tip;
}

/** The connection the item shows: the active one when signed on, else the first signed on. */
export function shownConnection(active: string | undefined, signedOn: SessionStatus[]): SessionStatus | undefined {
  return signedOn.find((s) => active !== undefined && sameName(s.name, active)) ?? signedOn[0];
}

/** The active connection in the status bar, left side. */
export class SessionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {
    this.item = vscode.window.createStatusBarItem('code-for-qs400.session', vscode.StatusBarAlignment.Left, 1);
    this.item.name = 'QS/400 connection';
    this.item.command = SWITCH_COMMAND;
    this.subscriptions = [
      sessions.onDidChange(() => this.render()),
      store.onDidChange(() => this.render()),
      vscode.commands.registerCommand(SWITCH_COMMAND, () => this.switchActive()),
    ];
    this.render();
  }

  /** What the item shows now, for tests. */
  get text(): string | undefined {
    return this.item.text === '' ? undefined : this.item.text;
  }

  render(): void {
    const s = shownConnection(this.sessions.active, this.sessions.signedOn());
    const c = s ? this.store.get(s.name) : undefined;
    const text = s && c ? statusBarText(c.name, s) : undefined;
    if (!s || !c || !text) {
      this.item.text = '';
      this.item.hide();
      return;
    }
    this.item.text = text;
    this.item.tooltip = statusBarTooltip(c, s);
    this.item.show();
  }

  /** The quick pick: a signed-on connection becomes active; another connects. */
  async switchActive(): Promise<string | undefined> {
    const active = this.sessions.active;
    const items = this.store.list().map((c) => {
      const s = this.sessions.status(c.name);
      const current = active !== undefined && sameName(active, c.name);
      return {
        label: `${isSignedOn(s) ? '$(plug)' : '$(vm-outline)'} ${c.name}`,
        description: `${s.user ?? c.user}@${c.host}${current ? ' · active' : ''}`,
        detail: isSignedOn(s) ? (s.job ? `Session job ${qualifiedJob(s.job)}` : s.state) : 'Not connected: picking it connects',
        c,
        signedOn: isSignedOn(s),
      };
    });
    items.sort((a, b) => Number(b.signedOn) - Number(a.signedOn));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Active QS/400 connection' });
    if (!picked) {
      return undefined;
    }
    if (picked.signedOn) {
      await this.sessions.setActive(picked.c.name);
    } else {
      await this.sessions.connect(picked.c.name);
    }
    return this.sessions.active;
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.item.dispose();
  }
}
