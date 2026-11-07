// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import {
  CONNECTIONS_SETTING,
  ConnectionConfig,
  DEFAULT_CONNECTION_SETTING,
  LibraryListConfig,
  SETTINGS_SECTION,
  parseConnections,
  sameName,
  secretKey,
  toSetting,
} from './config';

/**
 * Saved connections (user settings) and their passwords (secret storage).
 * Writes go to the user settings and touch only the entry named, so an
 * entry this release cannot read is kept as it is.
 */
export class ConnectionStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;
  private reported = '';

  /** Fires when the connections or the default change. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${SETTINGS_SECTION}.${CONNECTIONS_SETTING}`) ||
        e.affectsConfiguration(`${SETTINGS_SECTION}.${DEFAULT_CONNECTION_SETTING}`)
      ) {
        this.changed.fire();
      }
    });
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION);
  }

  /** Every connection that parses. Problems go to the output channel once. */
  list(): ConnectionConfig[] {
    const { connections, problems } = parseConnections(this.config().get<unknown>(CONNECTIONS_SETTING));
    const report = problems.join('\n');
    if (report !== this.reported) {
      this.reported = report;
      for (const p of problems) {
        this.output.warn(`settings: ${p}`);
      }
    }
    return connections;
  }

  get(name: string): ConnectionConfig | undefined {
    return this.list().find((c) => sameName(c.name, name));
  }

  /** The default connection's name, when it names one that exists. */
  defaultName(): string | undefined {
    const d = this.config().get<string>(DEFAULT_CONNECTION_SETTING, '');
    return d ? this.get(d)?.name : undefined;
  }

  async setDefault(name: string | undefined): Promise<void> {
    await this.config().update(DEFAULT_CONNECTION_SETTING, name ?? undefined, vscode.ConfigurationTarget.Global);
  }

  private raw(): unknown[] {
    const v = this.config().inspect<unknown>(CONNECTIONS_SETTING)?.globalValue;
    return Array.isArray(v) ? [...v] : [];
  }

  private async write(list: unknown[]): Promise<void> {
    await this.config().update(CONNECTIONS_SETTING, list, vscode.ConfigurationTarget.Global);
  }

  private static named(entry: unknown, name: string): boolean {
    return (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { name?: unknown }).name === 'string' &&
      sameName((entry as { name: string }).name, name)
    );
  }

  async add(c: ConnectionConfig): Promise<void> {
    if (this.get(c.name)) {
      throw new Error(`a connection named ${c.name} exists`);
    }
    await this.write([...this.raw(), toSetting(c)]);
  }

  /** Replaces the entry named `name` with `c`, which may carry a new name. */
  async replace(name: string, c: ConnectionConfig): Promise<void> {
    const list = this.raw();
    const i = list.findIndex((e) => ConnectionStore.named(e, name));
    if (i < 0) {
      throw new Error(`no connection named ${name} in the user settings`);
    }
    const wasDefault = sameName(this.config().get<string>(DEFAULT_CONNECTION_SETTING, ''), name);
    list[i] = toSetting(c);
    await this.write(list);
    if (name !== c.name) {
      const pw = await this.secrets.get(secretKey(name));
      await this.secrets.delete(secretKey(name));
      if (pw !== undefined) {
        await this.secrets.store(secretKey(c.name), pw);
      }
      if (wasDefault) {
        await this.setDefault(c.name);
      }
    }
  }

  /** Removes the connection and its saved password. */
  async remove(name: string): Promise<void> {
    await this.write(this.raw().filter((e) => !ConnectionStore.named(e, name)));
    await this.secrets.delete(secretKey(name));
    if (sameName(this.config().get<string>(DEFAULT_CONNECTION_SETTING, ''), name)) {
      await this.setDefault(undefined);
    }
  }

  /** Saves the library list to apply on the next connect. */
  async setLibraryList(name: string, libraryList: LibraryListConfig): Promise<void> {
    const c = this.get(name);
    if (!c) {
      return;
    }
    await this.replace(c.name, { ...c, libraryList });
  }

  password(name: string): Thenable<string | undefined> {
    return this.secrets.get(secretKey(name));
  }

  storePassword(name: string, password: string): Thenable<void> {
    return this.secrets.store(secretKey(name), password);
  }

  forgetPassword(name: string): Thenable<void> {
    return this.secrets.delete(secretKey(name));
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
