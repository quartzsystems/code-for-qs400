// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The Jobs view: the active connection's jobs under one filter node (My
 * jobs, `*ALL` or a profile's, saved per connection), grouped Active, On
 * job queue and On output queue in the order the server lists them. The
 * connection's own job is marked. The list is read when the filter node
 * opens and again on Refresh, or every 30 s while the view is shown and
 * `code-for-qs400.jobs.autoRefresh` is on. Other users' jobs are whatever
 * the server allows: a refusal is shown as its message.
 */

import * as vscode from 'vscode';
import { sameName } from '../connections/config';
import { errorText, showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import type { JobEntry, JobState, SessionJob } from '../host/protocol';
import type { JobLogProvider } from '../jobs/jobLog';
import {
  END_CHOICES,
  JobFilter,
  MY_JOBS,
  STATE_GROUPS,
  endQuestion,
  filterLabel,
  groupJobs,
  jobDescription,
  parseDelay,
  qualifiedJob,
  sameJob,
} from '../jobs/model';
import { isSignedOn } from './connections';

/** Workspace state key of each connection's Jobs filter. */
export const JOBS_FILTER_KEY = 'code-for-qs400.jobs.filter';

/** The setting that refreshes the view every [`AUTO_REFRESH_MS`] while it is shown. */
export const AUTO_REFRESH_SETTING = 'code-for-qs400.jobs.autoRefresh';

export const AUTO_REFRESH_MS = 30_000;

/** The QAP version the view needs: `Jobs`. */
export const QAP_JOBS = 8;

export type FilterNode = { kind: 'filter'; connection: string; user: JobFilter };
export type GroupNode = { kind: 'group'; connection: string; state: JobState; jobs: JobEntry[]; parent: FilterNode };
export type JobItemNode = { kind: 'job'; connection: string; entry: JobEntry; own: boolean; parent: GroupNode };
export type JobNode = { kind: 'message'; connection: string; text: string; parent?: FilterNode } | FilterNode | GroupNode | JobItemNode;

export function jobTreeItem(n: JobNode): vscode.TreeItem {
  switch (n.kind) {
    case 'message': {
      const i = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
      i.contextValue = 'jobs.message';
      return i;
    }
    case 'filter': {
      const i = new vscode.TreeItem(filterLabel(n.user), vscode.TreeItemCollapsibleState.Expanded);
      i.id = `${n.connection}/filter`;
      i.description = n.connection;
      i.iconPath = new vscode.ThemeIcon('filter');
      i.contextValue = 'jobs.filter';
      i.tooltip = `${filterLabel(n.user)} on ${n.connection}. Change Filter… shows another profile's jobs or *ALL.`;
      return i;
    }
    case 'group': {
      const g = STATE_GROUPS.find((x) => x.state === n.state)!;
      const i = new vscode.TreeItem(
        g.label,
        n.jobs.length ? (n.state === 'active' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None,
      );
      i.id = `${n.connection}/${n.state}`;
      i.description = String(n.jobs.length);
      i.iconPath = new vscode.ThemeIcon(g.icon);
      i.contextValue = 'jobs.group';
      return i;
    }
    case 'job': {
      const e = n.entry;
      const i = new vscode.TreeItem(e.job.name, vscode.TreeItemCollapsibleState.None);
      i.id = `${n.connection}/${qualifiedJob(e.job)}`;
      i.description = jobDescription(e, n.own);
      i.tooltip = [
        qualifiedJob(e.job),
        `Status: ${e.status}`,
        `Type: ${e.type}`,
        e.subsystem && `Subsystem: ${e.subsystem}`,
        e.function && `Function: ${e.function}`,
        `Entered: ${new Date(e.entered).toLocaleString()}`,
        n.own ? 'The connection job: actions and compiles run in it.' : '',
      ]
        .filter(Boolean)
        .join('\n');
      i.iconPath = new vscode.ThemeIcon(n.own ? 'plug' : 'gear');
      i.contextValue = n.own ? 'jobs.job.own' : 'jobs.job';
      return i;
    }
  }
}

export class JobsProvider implements vscode.TreeDataProvider<JobNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<JobNode | undefined>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChangeTreeData = this.changed.event;
  /** The filter node shown, and its groups once read. */
  private root: FilterNode | undefined;
  private groups: GroupNode[] | undefined;
  private timer: NodeJS.Timeout | undefined;
  private view: vscode.TreeView<JobNode> | undefined;

  constructor(
    store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly workspaceState: vscode.Memento,
  ) {
    this.subscriptions = [
      sessions.onDidChange((s) => {
        if (!s || s.name === this.connection() || (this.root && sameName(s.name, this.root.connection))) {
          this.refresh();
        }
      }),
      store.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(AUTO_REFRESH_SETTING)) {
          this.schedule();
        }
      }),
    ];
  }

  /** The view, for the auto-refresh while it is shown and for reveal. */
  attach(view: vscode.TreeView<JobNode>): vscode.Disposable {
    this.view = view;
    this.schedule();
    return view.onDidChangeVisibility(() => this.schedule());
  }

  private schedule(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    const on = vscode.workspace.getConfiguration().get<boolean>(AUTO_REFRESH_SETTING, false);
    if (on && this.view?.visible) {
      this.timer = setInterval(() => this.refresh(), AUTO_REFRESH_MS);
    }
  }

  /** The active connection when it is signed on. */
  connection(): string | undefined {
    const name = this.sessions.active;
    return name && isSignedOn(this.sessions.status(name)) ? name : undefined;
  }

  refresh(): void {
    this.root = undefined;
    this.groups = undefined;
    this.changed.fire(undefined);
  }

  /** The user saved for `name`: `*CURRENT` (My jobs) when none. */
  filter(name: string): JobFilter {
    const all = this.workspaceState.get<Record<string, string>>(JOBS_FILTER_KEY) ?? {};
    return all[name.toUpperCase()] ?? MY_JOBS;
  }

  async setFilter(name: string, user: JobFilter): Promise<void> {
    const all = { ...(this.workspaceState.get<Record<string, string>>(JOBS_FILTER_KEY) ?? {}) };
    const u = user.trim().toUpperCase();
    if (u === '' || u === MY_JOBS) {
      delete all[name.toUpperCase()];
    } else {
      all[name.toUpperCase()] = u;
    }
    await this.workspaceState.update(JOBS_FILTER_KEY, all);
    this.refresh();
  }

  getTreeItem(n: JobNode): vscode.TreeItem {
    return jobTreeItem(n);
  }

  getParent(n: JobNode): JobNode | undefined {
    return 'parent' in n ? n.parent : undefined;
  }

  async getChildren(n?: JobNode): Promise<JobNode[]> {
    if (!n) {
      return this.roots();
    }
    if (n.kind === 'filter') {
      try {
        return await this.read(n);
      } catch (err) {
        return [{ kind: 'message', connection: n.connection, text: errorText(err, n.connection), parent: n }];
      }
    }
    if (n.kind === 'group') {
      const own = this.sessions.status(n.connection).job;
      return n.jobs.map((entry) => ({ kind: 'job' as const, connection: n.connection, entry, own: sameJob(entry.job, own), parent: n }));
    }
    return [];
  }

  private roots(): JobNode[] {
    const name = this.connection();
    if (!name) {
      return [{ kind: 'message', connection: '', text: 'Connect to see jobs' }];
    }
    const qap = this.sessions.status(name).system?.qap;
    if (qap !== undefined && qap < QAP_JOBS) {
      return [{ kind: 'message', connection: name, text: 'QAP version 8 not available on this server' }];
    }
    this.root ??= { kind: 'filter', connection: name, user: this.filter(name) };
    return [this.root];
  }

  /** The filter's jobs, by state, read once per refresh. */
  private async read(f: FilterNode): Promise<GroupNode[]> {
    if (this.groups && this.root === f) {
      return this.groups;
    }
    const jobs = await this.sessions.call(f.connection, 'jobs.list', { name: f.connection, user: f.user });
    const groups = [...groupJobs(jobs)].map(([state, list]) => ({ kind: 'group' as const, connection: f.connection, state, jobs: list, parent: f }));
    if (this.root === f) {
      this.groups = groups;
    }
    return groups;
  }

  /** The node of `job` in the list shown, read first when it is not. */
  async find(job: SessionJob): Promise<JobItemNode | undefined> {
    const [root] = this.roots();
    if (root?.kind !== 'filter') {
      return undefined;
    }
    for (const g of await this.read(root)) {
      for (const c of await this.getChildren(g)) {
        if (c.kind === 'job' && sameJob(c.entry.job, job)) {
          return c;
        }
      }
    }
    return undefined;
  }

  /** Focuses the view on `job` of `connection`, making it the active connection first. */
  async reveal(connection: string, job: SessionJob): Promise<boolean> {
    const name = this.sessions.signedOn().find((s) => sameName(s.name, connection))?.name;
    if (!name) {
      void vscode.window.showInformationMessage(`Connect to ${connection} to see job ${qualifiedJob(job)}.`);
      return false;
    }
    if (!this.sessions.active || !sameName(this.sessions.active, name)) {
      await this.sessions.setActive(name);
      this.refresh();
    }
    await vscode.commands.executeCommand('code-for-qs400.jobs.focus');
    let node: JobItemNode | undefined;
    try {
      node = await this.find(job);
    } catch (err) {
      void showError(err, name);
      return false;
    }
    if (!node) {
      const log = 'Job Log';
      const picked = await vscode.window.showInformationMessage(
        `Job ${qualifiedJob(job)} is not in the list of ${filterLabel(this.filter(name))} on ${name}.`,
        log,
      );
      if (picked === log) {
        await vscode.commands.executeCommand('code-for-qs400.job.log', name, job);
      }
      return false;
    }
    await this.view?.reveal(node, { select: true, focus: true, expand: true });
    return true;
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.changed.dispose();
  }
}

/** What **End…** asks: `*CNTRLD` with a delay or `*IMMED`, then a modal naming the job. Undefined when dismissed. */
export async function askEnd(job: SessionJob): Promise<{ how: 'controlled' | 'immediate'; delay?: number } | undefined> {
  const pick = await vscode.window.showQuickPick(
    END_CHOICES.map((c) => ({ label: c.label, detail: c.detail, how: c.how })),
    { title: `End job ${qualifiedJob(job)}`, placeHolder: 'How to end it' },
  );
  if (!pick) {
    return undefined;
  }
  let delay: number | undefined;
  if (pick.how === 'controlled') {
    const v = await vscode.window.showInputBox({
      title: `End job ${qualifiedJob(job)} *CNTRLD`,
      prompt: 'Delay in seconds before the job is ended immediately; empty for the job’s default.',
      validateInput: (t) => (parseDelay(t) === 'invalid' ? 'A number of seconds from 1 to 999999, or empty.' : undefined),
    });
    if (v === undefined) {
      return undefined;
    }
    const d = parseDelay(v);
    delay = d === 'invalid' ? undefined : d;
  }
  const end = 'End Job';
  const ok = await vscode.window.showWarningMessage(endQuestion(job, pick.how, delay), { modal: true }, end);
  return ok === end ? { how: pick.how, delay } : undefined;
}

/** The Jobs view's commands. */
export function registerJobsViewCommands(provider: JobsProvider, sessions: SessionManager, jobLog: JobLogProvider): vscode.Disposable[] {
  const onJob =
    (f: (n: JobItemNode) => Promise<unknown>) =>
    async (n?: JobNode): Promise<unknown> => {
      if (n?.kind !== 'job') {
        return undefined;
      }
      try {
        return await f(n);
      } catch (err) {
        void showError(err, n.connection);
        return undefined;
      }
    };
  const act = (verb: 'hold' | 'release', done: string) =>
    onJob(async (n) => {
      await sessions.call(n.connection, `jobs.${verb}`, { name: n.connection, job: n.entry.job });
      vscode.window.setStatusBarMessage(`$(check) Job ${qualifiedJob(n.entry.job)} ${done}`, 5000);
      provider.refresh();
    });
  return [
    vscode.commands.registerCommand('code-for-qs400.jobs.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('code-for-qs400.jobs.filter', async () => {
      const name = provider.connection();
      if (!name) {
        return undefined;
      }
      const items = [
        { label: 'My jobs', description: '*CURRENT', user: MY_JOBS },
        { label: 'All jobs', description: '*ALL: needs *JOBCTL', user: '*ALL' },
        { label: 'Another profile’s jobs…', description: 'needs *JOBCTL', user: '' },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: `Jobs on ${name}`, placeHolder: filterLabel(provider.filter(name)) });
      if (!pick) {
        return undefined;
      }
      let user = pick.user;
      if (user === '') {
        const v = await vscode.window.showInputBox({
          prompt: 'User profile whose jobs to show',
          validateInput: (t) => (/^[A-Za-z$#@][A-Za-z0-9$#@_]{0,9}$/.test(t.trim()) ? undefined : 'A user profile name: up to 10 characters.'),
        });
        if (v === undefined) {
          return undefined;
        }
        user = v.trim().toUpperCase();
      }
      await provider.setFilter(name, user);
      return user;
    }),
    vscode.commands.registerCommand(
      'code-for-qs400.jobs.log',
      onJob((n) => jobLog.open(n.connection, n.entry.job)),
    ),
    vscode.commands.registerCommand('code-for-qs400.jobs.hold', act('hold', 'held')),
    vscode.commands.registerCommand('code-for-qs400.jobs.release', act('release', 'released')),
    vscode.commands.registerCommand(
      'code-for-qs400.jobs.end',
      onJob(async (n) => {
        const how = await askEnd(n.entry.job);
        if (!how) {
          return undefined;
        }
        await sessions.call(n.connection, 'jobs.end', { name: n.connection, job: n.entry.job, ...how });
        vscode.window.setStatusBarMessage(`$(check) Job ${qualifiedJob(n.entry.job)}: end requested`, 5000);
        provider.refresh();
        return how;
      }),
    ),
    vscode.commands.registerCommand(
      'code-for-qs400.jobs.copyName',
      onJob(async (n) => {
        const text = qualifiedJob(n.entry.job);
        await vscode.env.clipboard.writeText(text);
        return text;
      }),
    ),
    vscode.commands.registerCommand('code-for-qs400.jobs.reveal', (connection: string, job: SessionJob) => provider.reveal(connection, job)),
  ];
}
