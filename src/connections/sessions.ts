// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { HostClient } from '../host/client';
import { SessionStatus } from '../host/protocol';
import { ConnectionConfig, connectParams, sameName } from './config';
import { PasswordAnswer, promptNewPassword, promptPassword, serverMessage, showError } from './prompts';
import { ConnectionStore } from './store';

/** Workspace state key of the active connection's name. */
export const ACTIVE_CONNECTION_KEY = 'code-for-qs400.activeConnection';

export const CHANGE_PASSWORD = 'Change password';

/**
 * The extension's view of the host's sessions, and the active connection:
 * one connection name, kept in workspace state, set by connect and by the
 * status bar pick. Later phases act on the active connection.
 */
export class SessionManager implements vscode.Disposable {
  private readonly statuses = new Map<string, SessionStatus>();
  private readonly changed = new vscode.EventEmitter<SessionStatus | undefined>();
  private readonly subscriptions: vscode.Disposable[];

  /** Fires with a session's new status, or undefined when several changed. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly host: HostClient,
    private readonly store: ConnectionStore,
    private readonly workspaceState: vscode.Memento,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.subscriptions = [
      host.onDidChangeSession((s) => this.update(s)),
      // A host that stopped took its sessions with it.
      host.onDidChangeState((state) => {
        if (state !== 'running') {
          this.resetAll();
        }
      }),
    ];
  }

  status(name: string): SessionStatus {
    return this.statuses.get(name) ?? { name, state: 'disconnected' };
  }

  /** Sessions that are signed on, connected or stale. */
  signedOn(): SessionStatus[] {
    return [...this.statuses.values()].filter((s) => s.state === 'connected' || s.state === 'stale');
  }

  /** The active connection's name, when it names a saved connection. */
  get active(): string | undefined {
    const name = this.workspaceState.get<string>(ACTIVE_CONNECTION_KEY);
    return name ? this.store.get(name)?.name : undefined;
  }

  async setActive(name: string | undefined): Promise<void> {
    await this.workspaceState.update(ACTIVE_CONNECTION_KEY, name);
    this.changed.fire(undefined);
  }

  update(s: SessionStatus): void {
    this.statuses.set(s.name, s);
    this.changed.fire(s);
  }

  private resetAll(): void {
    if (this.statuses.size === 0) {
      return;
    }
    for (const name of this.statuses.keys()) {
      this.statuses.set(name, { name, state: 'disconnected' });
    }
    this.changed.fire(undefined);
  }

  private connection(name: string): ConnectionConfig {
    const c = this.store.get(name);
    if (!c) {
      throw new Error(`no connection named ${name}`);
    }
    return c;
  }

  /**
   * Connects: the saved password, else a prompt. Errors are shown here;
   * the status when connected, undefined otherwise.
   */
  async connect(name: string): Promise<SessionStatus | undefined> {
    const c = this.connection(name);
    const saved = await this.store.password(c.name);
    let answer: PasswordAnswer | undefined;
    if (saved === undefined) {
      answer = await promptPassword(c);
      if (!answer) {
        return undefined;
      }
    }
    return this.signOn(c, answer ?? { password: saved as string, save: false }, saved !== undefined);
  }

  /**
   * `session.connect` with `answer`. `usedSaved`: the password came from
   * secret storage.
   */
  async signOn(c: ConnectionConfig, answer: PasswordAnswer, usedSaved: boolean): Promise<SessionStatus | undefined> {
    try {
      const s = await this.host.request('session.connect', connectParams(c, answer.password));
      if (answer.save) {
        await this.store.storePassword(c.name, answer.password);
      }
      return await this.afterSignOn(c, s);
    } catch (err) {
      const m = serverMessage(err);
      if (m?.status === 'PasswordExpired') {
        const picked = await showError(err, c.name, CHANGE_PASSWORD);
        return picked === CHANGE_PASSWORD ? this.changeExpired(c, answer.password, usedSaved || answer.save) : undefined;
      }
      if (usedSaved && (m?.status === 'SignOnFailed' || m?.status === 'NotAuthorized')) {
        // Trying it again would count against QMAXSIGN.
        await this.store.forgetPassword(c.name);
        this.output.warn(`${c.name}: the server refused the saved password; it was removed from secret storage`);
      }
      void showError(err, c.name);
      return undefined;
    }
  }

  /** After `PasswordExpired`: a new password, `session.changePassword`. */
  private async changeExpired(c: ConnectionConfig, old: string, save: boolean): Promise<SessionStatus | undefined> {
    const next = await promptNewPassword(c);
    if (next === undefined) {
      return undefined;
    }
    try {
      const s = await this.host.request('session.changePassword', { name: c.name, oldPassword: old, newPassword: next });
      if (save) {
        await this.store.storePassword(c.name, next);
      }
      return await this.afterSignOn(c, s);
    } catch (err) {
      void showError(err, c.name);
      return undefined;
    }
  }

  /** Called once a sign-on succeeded. */
  protected async afterSignOn(c: ConnectionConfig, s: SessionStatus): Promise<SessionStatus> {
    this.update(s);
    await this.setActive(c.name);
    this.output.info(`${c.name}: signed on as ${s.user ?? c.user}`);
    return s;
  }

  async disconnect(name: string): Promise<void> {
    await this.host.request('session.disconnect', { name });
    this.update({ name, state: 'disconnected' });
    if (this.active && sameName(this.active, name)) {
      const other = this.signedOn().find((s) => !sameName(s.name, name));
      if (other) {
        await this.setActive(other.name);
      }
    }
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.changed.dispose();
  }
}
