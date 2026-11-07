// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { about } from './commands/about';
import { registerConnectionCommands } from './commands/connection';
import { LibraryListController } from './connections/libraryList';
import { SessionManager } from './connections/sessions';
import { ConnectionStore } from './connections/store';
import { HostClient, HostState } from './host/client';
import { ConnectionsProvider } from './views/connections';
import { SessionStatusBar } from './views/sessionStatusBar';

/** What `activate` returns; used by the integration tests. */
export interface ExtensionApi {
  readonly host: HostClient;
  readonly store: ConnectionStore;
  readonly sessions: SessionManager;
  readonly connections: ConnectionsProvider;
  readonly libraryList: LibraryListController;
  readonly statusBar: SessionStatusBar;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const output = vscode.window.createOutputChannel('Code for QS/400 Host', { log: true });
  const host = new HostClient(context.extensionPath, output);

  const status = vscode.window.createStatusBarItem('code-for-qs400.host', vscode.StatusBarAlignment.Left, 0);
  status.name = 'QS/400 host';
  status.text = '$(warning) QS/400 host stopped';
  status.tooltip = 'The QS/400 host process stopped. It restarts on the next command, or click to restart it now.';
  status.command = 'code-for-qs400.host.restart';
  status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  const showState = (state: HostState) => (state === 'stopped' ? status.show() : status.hide());

  const store = new ConnectionStore(context.secrets, output);
  const sessions = new SessionManager(host, store, context.workspaceState, output);
  const libraryList = new LibraryListController(store, sessions, output);
  const connections = new ConnectionsProvider(store, sessions, libraryList);
  const statusBar = new SessionStatusBar(store, sessions);

  context.subscriptions.push(
    output,
    host,
    store,
    sessions,
    libraryList,
    status,
    connections,
    statusBar,
    host.onDidChangeState(showState),
    vscode.window.registerTreeDataProvider('code-for-qs400.connections', connections),
    vscode.commands.registerCommand('code-for-qs400.about', () => about(host)),
    ...registerConnectionCommands(store, sessions),
    ...libraryList.registerCommands(),
    vscode.commands.registerCommand('code-for-qs400.host.restart', async () => {
      try {
        await host.restart();
        output.info('host restarted on request');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Code for QS/400: could not restart the host: ${message}`);
      }
    }),
  );

  return { host, store, sessions, connections, libraryList, statusBar };
}

export function deactivate(): void {
  // Disposables registered in activate stop the host.
}
