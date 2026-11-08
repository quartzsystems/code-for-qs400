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
import { MEMBER_SCHEME, isReadonlyUri, parseMemberUri } from './members/uri';
import { ConnectionsProvider } from './views/connections';
import { IfsNode, IfsProvider } from './views/ifs';
import { ObjectsProvider } from './views/objects';
import { SessionStatusBar } from './views/sessionStatusBar';
import { SqlNode, SqlProvider, registerSqlViewCommands } from './views/sql';
import { JobNode, JobsProvider, registerJobsViewCommands } from './views/jobs';
import { SpoolNode, SpoolProvider, nodeRef, registerSpoolViewCommands } from './views/spool';
import { SpoolViewer } from './spool/viewer';
import { MessageNode, MessagesProvider, registerMessagesViewCommands } from './views/messages';
import { LanguageServers } from './languages/client';
import { ProjectStore } from './projects/store';
import { ProjectDeps, Puller } from './projects/pull';
import { ProjectPrompts } from './projects/ui';
import { registerDeployCommands, registerPullCommands } from './projects/commands';
import { Deployer } from './projects/deploy';
import { GitApiChanges } from './projects/git';
import { LocalActions } from './projects/local';
import { WorkspaceIncludes } from './projects/includes';
import { ProjectView, registerProjectViewCommands } from './views/project';
import { sameName } from './connections/config';
import { DdsGuides } from './languages/ddsGuides';
import { FixedFormRpg } from './languages/fixedForm';
import type { SpecForm } from './languages/rpgColumns';
import { SQL_STATEMENTS, type SqlStatementRange } from './languages/protocol';
import { Exporter } from './sql/export';
import { SqlHistory } from './sql/history';
import { ResultPanel } from './sql/results';
import { SqlRunner } from './sql/run';
import { SqlSessions } from './sql/session';
import { Debugging } from './debug/debugging';
import { DebugCommands, attachToJob } from './debug/commands';
import { DebugStatusBar } from './debug/statusBar';
import { programOfDocument, programOfEntry } from './debug/programs';
import { memberUri } from './members/uri';
import type { ObjectsNode } from './views/objects';

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
  readonly languages: LanguageServers;
  readonly rpg: FixedFormRpg;
  readonly dds: DdsGuides;
  readonly sql: SqlSessions;
  readonly sqlRunner: SqlRunner;
  readonly results: ResultPanel;
  readonly exporter: Exporter;
  readonly sqlTree: SqlProvider;
  readonly sqlView: vscode.TreeView<SqlNode>;
  readonly history: SqlHistory;
  readonly jobs: JobsProvider;
  readonly jobsView: vscode.TreeView<JobNode>;
  readonly spool: SpoolProvider;
  readonly spoolView: vscode.TreeView<SpoolNode>;
  readonly viewer: SpoolViewer;
  readonly messages: MessagesProvider;
  readonly messagesView: vscode.TreeView<MessageNode>;
  readonly projects: ProjectStore;
  readonly puller: Puller;
  readonly deployer: Deployer;
  readonly projectView: ProjectView;
  readonly debugging: Debugging;
  readonly debugCommands: DebugCommands;
  readonly objectsView: vscode.TreeView<ObjectsNode>;
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
  const objectsView = vscode.window.createTreeView('code-for-qs400.objects', { treeDataProvider: objects });
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
  const projects = new ProjectStore(store, output);
  const workspaceIncludes = new WorkspaceIncludes(projects);
  const runner = new ActionRunner(store, sessions, actions, context.workspaceState, {
    objects,
    ifs,
    local: (uri) => localActions.resolve(uri),
  });
  const projectDeps: ProjectDeps = {
    store,
    sessions,
    projects,
    ui: new ProjectPrompts(),
    append: (line) => runner.output.appendLine(line),
    showOutput: () => runner.output.show(true),
    onProgress: host.onDidProgress,
  };
  const puller = new Puller(projectDeps);
  const deployer = new Deployer(projectDeps, puller, new GitApiChanges(), async (connection, library, file, member) => {
    // A member written under an open editor: read it again (and lock it again), so its next save diffs the new lines.
    for (const d of vscode.workspace.textDocuments) {
      const m = d.uri.scheme === MEMBER_SCHEME && !isReadonlyUri(d.uri) ? parseMemberUri(d.uri) : undefined;
      if (m?.kind === 'member' && sameName(m.connection, connection) && m.library === library && m.file === file && m.member === member && members.member(d.uri)) {
        await members.refresh(d.uri).catch(() => undefined);
      }
    }
  });
  const localActions = new LocalActions(projectDeps, deployer);
  const projectView = new ProjectView(projectDeps, deployer);
  const projectTree = vscode.window.createTreeView('code-for-qs400.project', { treeDataProvider: projectView, showCollapseAll: true });
  const hasProject = () => void vscode.commands.executeCommand('setContext', 'code-for-qs400.hasProject', projects.usable().length > 0);
  const diagnostics = new CompileDiagnostics((connection, at) => deployer.localFor(connection, at));
  const jobLog = new JobLogProvider(store, sessions, vscode.Uri.joinPath(context.extensionUri, 'media'));
  const languagesOutput = vscode.window.createOutputChannel('Code for QS/400 Languages', { log: true });
  const languages = new LanguageServers(
    () => host.resolveBinary(),
    {
      call: (name, method, params) => sessions.call(name, method, params),
      canonical: (name) => store.get(name)?.name ?? name,
      active: () => sessions.active,
      log: (line) => languagesOutput.warn(line),
      local: (uri, request, connection) => workspaceIncludes.find(uri, request, connection),
      projectConnection: (uri) => workspaceIncludes.connectionOf(uri),
      localChanged: (uri) => workspaceIncludes.changed(uri),
    },
    languagesOutput,
  );
  languages.start();
  const rpg = new FixedFormRpg(() => languages.request<SpecForm[]>('qs400-rpgle', 'qs400/specForms'));
  rpg.start();
  const dds = new DdsGuides();
  dds.start();
  const sql =new SqlSessions(host, store, sessions);
  const sqlRunner = new SqlRunner(host, store, sessions, sql, (doc) =>
    languages.request<SqlStatementRange[] | null>('qs400-sql', SQL_STATEMENTS, { textDocument: { uri: doc.uri.toString() } }),
  );
  const results = new ResultPanel(sessions, sqlRunner, sql);
  const exporter = new Exporter(host, sessions, results);
  const history = new SqlHistory(context.workspaceState, sqlRunner, sql, sessions);
  const sqlTree = new SqlProvider(store, sessions, context.workspaceState);
  const sqlView = vscode.window.createTreeView('code-for-qs400.sql', { treeDataProvider: sqlTree, showCollapseAll: true });
  const jobs = new JobsProvider(store, sessions, context.workspaceState);
  const jobsView = vscode.window.createTreeView('code-for-qs400.jobs', { treeDataProvider: jobs, showCollapseAll: true });
  const spool = new SpoolProvider(store, sessions, context.workspaceState, host);
  const spoolView = vscode.window.createTreeView('code-for-qs400.spool', { treeDataProvider: spool, showCollapseAll: true });
  const viewer = new SpoolViewer(store, sessions, spool);
  const messages = new MessagesProvider(store, sessions, context.workspaceState, host);
  const messagesView = vscode.window.createTreeView('code-for-qs400.messages', { treeDataProvider: messages, showCollapseAll: true });
  const debugSource = {
    properties: (connection: string, library: string, object: string, type: string) =>
      sessions.call(connection, 'object.properties', { name: connection, library, object, type }),
    localMember: async (connection: string, library: string, file: string, member: string) => {
      const deployed = deployer.localFor(connection, { kind: 'member', library, file, member });
      if (deployed) {
        return deployed;
      }
      const found = await workspaceIncludes.find(memberUri(connection, library, file, member, '').toString(), { library, file, member }, connection);
      return found ? vscode.Uri.parse(found.uri) : undefined;
    },
    localPath: async (connection: string, path: string) => deployer.localFor(connection, { kind: 'path', path }),
  };
  const debugCommands = new DebugCommands({
    store,
    sessions,
    projects,
    source: debugSource,
    local: (uri) => localActions.resolve(uri),
    compileFor: (uri) => runner.compileFor(uri),
    run: (uri, action, rewrite) => runner.run(uri, action, rewrite),
  });
  const debugging = new Debugging({
    store,
    sessions,
    noDebugData: (config, message) => void debugCommands.noDebugData(config, message),
    binary: () => host.resolveBinary(),
    log: (line) => output.warn(line),
    programOf: async (uri) => (await programOfDocument(uri, sessions, projects))?.program,
    selectedProgram: () => {
      const n = objectsView.selection[0];
      return n?.kind === 'object' ? programOfEntry(n.entry) : undefined;
    },
    source: debugSource,
  });

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
    projects,
    actions.setProjectActions(
      (name) => (name ? projects.usable().filter((p) => sameName(projects.connectionOf(p), name)).map((p) => projects.actions(p)) : []),
      projects.onDidChange,
    ),
    ...registerPullCommands(projectDeps, puller),
    ...registerDeployCommands(projectDeps, deployer),
    deployer,
    projectView,
    projectTree,
    ...registerProjectViewCommands(projectView, projectDeps, puller),
    projects.onDidChange(hasProject),
    host.onDidChangeState(showState),
    vscode.window.registerTreeDataProvider('code-for-qs400.connections', connections),
    objectsView,
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
    languagesOutput,
    languages,
    rpg,
    dds,
    sql,
    sqlRunner,
    results,
    sqlTree,
    sqlView,
    history,
    ...history.register(),
    ...registerSqlViewCommands(sqlTree, sql, sqlRunner, sessions),
    ...sql.register(),
    ...sqlRunner.register(),
    jobs,
    jobsView,
    jobs.attach(jobsView),
    ...registerJobsViewCommands(jobs, sessions, jobLog),
    spool,
    spoolView,
    spool.attach(spoolView),
    ...registerSpoolViewCommands(spool, spoolView, sessions, host, (arg) => nodeRef(arg) ?? viewer.refOf(arg)),
    ...viewer.register(),
    messages,
    messagesView,
    messages.attach(messagesView),
    ...registerMessagesViewCommands(messages, sessions),
    debugging,
    ...debugging.register(),
    new DebugStatusBar(),
    ...debugCommands.register(),
    vscode.commands.registerCommand('code-for-qs400.debug.attach', (n?: JobNode) =>
      n?.kind === 'job' ? attachToJob(n.connection, n.entry.job, context.workspaceState) : undefined,
    ),
    // A session signed on again: includes it could not read may be there now.
    sessions.onDidChange((st) => {
      if (st?.state === 'connected') {
        void languages.includesChanged({ connection: st.name });
      }
    }),
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

  return { host, store, sessions, connections, libraryList, statusBar, objects, members, ifs, ifsView, ifsFs, transfers, actions, runner, diagnostics, jobLog, languages, rpg, dds, sql, sqlRunner, results, exporter, sqlTree, sqlView, history, jobs, jobsView, spool, spoolView, viewer, messages, messagesView, projects, puller, deployer, projectView, debugging, debugCommands, objectsView };
}

export function deactivate(): void {
  // Disposables registered in activate stop the host.
}
