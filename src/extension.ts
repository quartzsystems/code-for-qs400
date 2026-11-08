// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { CompileDiagnostics } from './actions/diagnostics';
import { ActionRunner } from './actions/run';
import { ActionStore } from './actions/store';
import { about } from './commands/about';
import { registerConnectionCommands } from './commands/connection';
import { IfsDragAndDrop, registerIfsFileCommands } from './commands/ifsFiles';
import { registerIfsOpenCommands, registerIfsViewCommands } from './commands/ifs';
import { registerMemberCommands } from './commands/members';
import { registerObjectCommands } from './commands/objects';
import { LibraryListController } from './connections/libraryList';
import { SessionManager } from './connections/sessions';
import { ConnectionStore } from './connections/store';
import { HostClient, HostState } from './host/client';
import { IfsFsProvider } from './ifs/provider';
import { IFS_SCHEME } from './ifs/uri';
import { Transfers, registerTransferCommands } from './ifs/transfers';
import { JobLogProvider } from './jobs/jobLog';
import { MemberFsProvider } from './members/provider';
import { MEMBER_SCHEME } from './members/uri';
import { ConnectionsProvider } from './views/connections';
import { IfsNode, IfsProvider } from './views/ifs';
import { ObjectsProvider } from './views/objects';
import { SessionStatusBar } from './views/sessionStatusBar';

/** What `activate` returns; used by the integration tests. */
export interface ExtensionApi {
  readonly host: HostClient;
  readonly store: ConnectionStore;
  readonly sessions: SessionManager;
  readonly connections: ConnectionsProvider;
  readonly libraryList: LibraryListController;
  readonly objects: ObjectsProvider;
  readonly members: MemberFsProvider;
  readonly ifs: IfsProvider;
  readonly ifsView: vscode.TreeView<IfsNode>;
  readonly ifsFs: IfsFsProvider;
  readonly transfers: Transfers;
  readonly statusBar: SessionStatusBar;
  readonly actions: ActionStore;
  readonly runner: ActionRunner;
  readonly diagnostics: CompileDiagnostics;
  readonly jobLog: JobLogProvider;
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
  const objects = new ObjectsProvider(store, sessions, libraryList);
  const members = new MemberFsProvider(sessions, store, output);
  const ifs = new IfsProvider(store, sessions, context.workspaceState);
  const ifsDrop = new IfsDragAndDrop(ifs);
  const ifsView = vscode.window.createTreeView('code-for-qs400.ifs', {
    treeDataProvider: ifs,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: ifsDrop,
  });
  const ifsFs = new IfsFsProvider(sessions, store, output);
  const transfers = new Transfers(host, sessions, ifs, ifsFs);
  const actions = new ActionStore(context.extensionPath, store, sessions, output);
  const runner = new ActionRunner(store, sessions, actions, context.workspaceState, { objects, ifs });
  const diagnostics = new CompileDiagnostics();
  const jobLog = new JobLogProvider(store, sessions);

  context.subscriptions.push(
    output,
    host,
    store,
    sessions,
    libraryList,
    status,
    connections,
    statusBar,
    objects,
    members,
    ifs,
    ifsView,
    ifsFs,
    actions,
    host.onDidChangeState(showState),
    vscode.window.registerTreeDataProvider('code-for-qs400.connections', connections),
    vscode.window.registerTreeDataProvider('code-for-qs400.objects', objects),
    vscode.workspace.registerFileSystemProvider(MEMBER_SCHEME, members, { isCaseSensitive: false }),
    vscode.workspace.registerFileSystemProvider(IFS_SCHEME, ifsFs, { isCaseSensitive: true }),
    vscode.commands.registerCommand('code-for-qs400.about', () => about(host)),
    ...registerConnectionCommands(store, sessions),
    ...libraryList.registerCommands(),
    ...registerObjectCommands(objects, store, sessions),
    ...registerMemberCommands(members, objects, sessions),
    ...registerIfsViewCommands({ provider: ifs, view: ifsView, store, sessions }),
    ...registerIfsOpenCommands({ provider: ifs, view: ifsView, store, sessions }),
    ...registerIfsFileCommands({ provider: ifs, view: ifsView, store, sessions }, ifsFs),
    ...runner.register(),
    ...diagnostics.register(),
    ...jobLog.register(),
    runner.onDidRun((r) => diagnostics.apply(r)),
    ...registerTransferCommands({ provider: ifs, view: ifsView, store, sessions }, transfers, (f) => (ifsDrop.uploadDropped = f)),
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

  return { host, store, sessions, connections, libraryList, statusBar, objects, members, ifs, ifsView, ifsFs, transfers, actions, runner, diagnostics, jobLog };
}

export function deactivate(): void {
  // Disposables registered in activate stop the host.
}
