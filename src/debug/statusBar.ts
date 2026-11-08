// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { DEBUG_TYPE } from './config';

/** The adapter's event naming a job as it becomes a thread. */
export const THREAD_EVENT = 'qs400/thread';

/** What the status bar shows of a debug session. */
export interface DebugStatus {
  /** `nnnnnn/USER/NAME` of the job debugged, once known. */
  job?: string;
  /** The program of a service entry session. */
  serviceEntry?: string;
  connection?: string;
}

/** `$(debug) nnnnnn/USER/NAME`, with the service entry program in that mode; waiting before a job calls it. */
export function debugStatusText(s: DebugStatus): string | undefined {
  if (s.job) {
    return `$(debug) ${s.job}${s.serviceEntry ? ` · ${s.serviceEntry}` : ''}`;
  }
  if (s.serviceEntry) {
    return `$(debug) waiting for ${s.serviceEntry}`;
  }
  return undefined;
}

/**
 * The debugged job in the status bar while a `qs400` session is active:
 * the job of the first thread the adapter names (`qs400/thread`), and for
 * a service entry the program it waits on.
 */
export class DebugStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('code-for-qs400.debug', vscode.StatusBarAlignment.Left, 1);
  private readonly states = new Map<string, DebugStatus>();
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.item.name = 'QS/400 debug';
    this.item.command = 'workbench.view.debug';
    this.subscriptions = [
      vscode.debug.onDidStartDebugSession((s) => {
        if (s.type === DEBUG_TYPE) {
          const c = s.configuration;
          this.states.set(s.id, {
            connection: String(c.connection ?? ''),
            serviceEntry: c.mode === 'serviceEntry' ? String(c.program ?? '') : undefined,
          });
          this.show();
        }
      }),
      vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
        if (e.session.type === DEBUG_TYPE && e.event === THREAD_EVENT) {
          const st = this.states.get(e.session.id) ?? {};
          st.job ??= String((e.body as { job?: string }).job ?? '');
          this.states.set(e.session.id, st);
          this.show();
        }
      }),
      vscode.debug.onDidTerminateDebugSession((s) => {
        this.states.delete(s.id);
        this.show();
      }),
      vscode.debug.onDidChangeActiveDebugSession(() => this.show()),
    ];
  }

  /** What a session shows; for tests. */
  status(id: string): DebugStatus | undefined {
    return this.states.get(id);
  }

  private show(): void {
    const active = vscode.debug.activeDebugSession;
    const id = active?.type === DEBUG_TYPE ? active.id : [...this.states.keys()].pop();
    const st = id ? this.states.get(id) : undefined;
    const text = st ? debugStatusText(st) : undefined;
    if (!text || !st) {
      this.item.hide();
      return;
    }
    this.item.text = text;
    this.item.tooltip = st.serviceEntry
      ? `Debugging on ${st.connection}: the service entry for ${st.serviceEntry}${st.job ? `, attached to ${st.job}` : ', waiting for a job to call it'}`
      : `Debugging on ${st.connection}: ${st.job}`;
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.item.dispose();
  }
}
