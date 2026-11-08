// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { libraryName, sameName } from '../connections/config';
import { errorText, showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { ActionOutcome, ActionRunParams, SessionJob, SpooledFile } from '../host/protocol';
import { parseQualifiedJob, qualifiedJob } from '../jobs/model';
import { highestNumber, jobFilesUser, listingFile, newListing } from '../spool/model';
import { IFS_SCHEME, parseIfsUri } from '../ifs/uri';
import { typeForExtension } from '../members/types';
import { MEMBER_SCHEME, isReadonlyUri, parseMemberUri } from '../members/uri';
import { IfsProvider } from '../views/ifs';
import { ObjectsProvider } from '../views/objects';
import { Action, applies, kindOf } from './model';
import {
  JOB_LOG_LINE,
  LISTING_PREFIX,
  OUTPUT_CHANNEL,
  OUTPUT_LANGUAGE,
  blockJob,
  failureLines,
  headerLines,
  jobOnLine,
  linkConnection,
  listingLine,
  outcomeLines,
  parseListingLine,
  submittedJob,
} from './output';
import { ActionStore, connectionValues } from './store';
import { variablesIn } from './variables';
import {
  ActionTarget,
  ResolveContext,
  batchCommand,
  choiceKey,
  matchTarget,
  needsLibrary,
  resolveCommand,
  targetLabel,
  targetValue,
  usesCurrentLibrary,
} from './targets';

/** Workspace state key of the action last run, by `choiceKey`. */
export const LAST_ACTIONS_KEY = 'code-for-qs400.lastActions';

/** The job log command the output channel's links open. */
export const JOB_LOG_COMMAND = 'code-for-qs400.job.log';

/** What `Job:` and `Submitted:` open: the job in the Jobs view. */
export const JOB_REVEAL_COMMAND = 'code-for-qs400.jobs.reveal';

/** What `Listing: Open` opens: the spooled file viewer. */
export const LISTING_COMMAND = 'code-for-qs400.spool.open';

/** What a run did, for the tests and for the diagnostics. */
export interface RunResult {
  action: Action;
  target: ActionTarget;
  /** The command as sent. */
  command: string;
  outcome?: ActionOutcome;
  error?: unknown;
  /**
   * The compile listing, looked for after the run (a compile) or waited for
   * (a batch run); its line is written when it is found.
   */
  listing?: Promise<SpooledFile | undefined>;
  /** The local file the target was deployed from, for an action on a local file. */
  local?: vscode.Uri;
}

/** What a run needs of the document a target is open in. */
export interface SavableDocument {
  readonly isDirty: boolean;
  save(): Thenable<boolean>;
}

export interface RunnerOptions {
  /** Refreshed after an action whose `refresh` is not `none`. */
  objects?: ObjectsProvider;
  ifs?: IfsProvider;
  /** The open document of a target; `targetDocument` by default. */
  findDocument?: (t: ActionTarget) => SavableDocument | undefined;
  /** Where each output line goes; the output channel by default. */
  append?: (line: string) => void;
  /** How long a batch run's listing is waited for; the host's 10 minutes by default. */
  listingWaitMs?: number;
  /**
   * A local file of a project as a target: the member or stream file it
   * deploys to, the library its `&LIBRARY` is, and the deploy that comes
   * first. A message when the file cannot be deployed; undefined when it
   * is in no project.
   */
  local?: (uri: vscode.Uri) => Promise<LocalTarget | string | undefined>;
}

/** What `RunnerOptions.local` makes of a local file. */
export interface LocalTarget {
  target: ActionTarget;
  /** `&LIBRARY` and `&SRCLIB` of a member: the project's target library. */
  library?: string;
  uri: vscode.Uri;
  /** Deploys the file: true when the system now has it, else why not. */
  deploy(): Promise<true | string>;
}

/** A link in the output channel: where it is and the command it runs. */
export interface OutputLink {
  line: number;
  start: number;
  end: number;
  command: string;
  args: unknown[];
  tooltip: string;
}

/**
 * The output channel's links: `Job log: Show` to the block's job's log,
 * the job on `Job:` and `Submitted:` to the Jobs view, and `Listing: Open`
 * to the viewer.
 */
export function outputLinks(lines: readonly string[]): OutputLink[] {
  const links: OutputLink[] = [];
  lines.forEach((l, i) => {
    if (l === JOB_LOG_LINE) {
      const connection = linkConnection(lines, i);
      const job = blockJob(lines, i);
      const start = JOB_LOG_LINE.indexOf('Show');
      links.push({
        line: i,
        start,
        end: start + 4,
        command: JOB_LOG_COMMAND,
        args: [connection ?? null, job ?? null],
        tooltip: job ? `Job log of ${qualifiedJob(job)}${connection ? ` on ${connection}` : ''}` : 'Job log of the connection job',
      });
      return;
    }
    if (l.startsWith(LISTING_PREFIX)) {
      const p = parseListingLine(l);
      if (p) {
        const start = 'Listing: '.length;
        links.push({ line: i, start, end: start + 4, command: LISTING_COMMAND, args: [p], tooltip: `Open ${p.id.file}(${p.id.number}) ${qualifiedJob(p.id.job)} in the spooled file viewer` });
      }
      return;
    }
    const j = jobOnLine(l);
    const connection = j ? linkConnection(lines, i) : undefined;
    if (j && connection) {
      links.push({ line: i, start: j.start, end: j.end, command: JOB_REVEAL_COMMAND, args: [connection, j.job], tooltip: `Show ${qualifiedJob(j.job)} in the Jobs view` });
    }
  });
  return links;
}

/** What `action.run` is handed: a URI (editor title, palette), a tree node, or nothing (the active editor). */
type RunArg = vscode.Uri | { kind?: string; connection?: string; [k: string]: unknown } | undefined;

/** The action named by `action.run`'s second argument: a non-empty string, else none (the pick). */
export function actionNameArg(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** The target a URI names: a member or a stream file, its connection as saved. */
export function uriTarget(uri: vscode.Uri, store: ConnectionStore): ActionTarget | undefined {
  if (uri.scheme === MEMBER_SCHEME) {
    const p = parseMemberUri(uri);
    if (p?.kind !== 'member') {
      return undefined;
    }
    const connection = store.get(p.connection)?.name ?? p.connection;
    return { environment: 'member', connection, library: p.library, file: p.file, member: p.member, type: typeForExtension(p.ext), ext: p.ext };
  }
  if (uri.scheme === IFS_SCHEME) {
    const p = parseIfsUri(uri);
    if (!p) {
      return undefined;
    }
    return { environment: 'file', connection: store.get(p.connection)?.name ?? p.connection, path: p.path };
  }
  return undefined;
}

/** The target of a tree node: a member, an object, or a stream file. */
export function nodeTarget(n: Record<string, unknown>, store: ConnectionStore): ActionTarget | undefined {
  const connection = typeof n.connection === 'string' ? (store.get(n.connection)?.name ?? n.connection) : undefined;
  if (!connection) {
    return undefined;
  }
  const entry = n.entry as Record<string, string> | undefined;
  if (n.kind === 'member' && entry && typeof n.library === 'string' && typeof n.file === 'string') {
    return { environment: 'member', connection, library: n.library, file: n.file, member: entry.member, type: entry.type };
  }
  if (n.kind === 'object' && entry) {
    return { environment: 'object', connection, library: entry.library, object: entry.object, type: entry.type, attribute: entry.attribute };
  }
  if (n.kind === 'entry' && typeof n.path === 'string' && entry && entry.kind !== 'directory') {
    return { environment: 'file', connection, path: n.path };
  }
  return undefined;
}

/** The open document a member or a stream file target is edited in, if any (never a read-only one). */
export function targetDocument(t: ActionTarget): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => {
    if (t.environment === 'member' && d.uri.scheme === MEMBER_SCHEME && !isReadonlyUri(d.uri)) {
      const p = parseMemberUri(d.uri);
      return (
        p?.kind === 'member' &&
        sameName(p.connection, t.connection) &&
        p.library === t.library.toUpperCase() &&
        p.file === t.file.toUpperCase() &&
        p.member === t.member.toUpperCase()
      );
    }
    if (t.environment === 'file' && d.uri.scheme === IFS_SCHEME) {
      const p = parseIfsUri(d.uri);
      return p !== undefined && sameName(p.connection, t.connection) && p.path === t.path;
    }
    return false;
  });
}

/**
 * **Run Action…**: the actions that apply to a member, a stream file or an
 * object, last used first; the one picked is resolved, run in the
 * connection job (or submitted), and written to the **Code for QS/400**
 * output channel. `onOutcome` hands each outcome to the diagnostics.
 */
export class ActionRunner implements vscode.Disposable {
  private channel: vscode.OutputChannel | undefined;
  /** The **Code for QS/400** output channel, made on first use. */
  get output(): vscode.OutputChannel {
    this.channel ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL, OUTPUT_LANGUAGE);
    return this.channel;
  }
  private runs = 0;
  private readonly finished = new vscode.EventEmitter<RunResult>();
  /** Fires when a run ends, with or without an outcome. */
  readonly onDidRun = this.finished.event;

  private readonly objects?: ObjectsProvider;
  private readonly ifs?: IfsProvider;
  private readonly findDocument: (t: ActionTarget) => SavableDocument | undefined;
  private readonly append: (line: string) => void;
  private readonly listingWaitMs: number | undefined;
  private readonly local?: (uri: vscode.Uri) => Promise<LocalTarget | string | undefined>;

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly actions: ActionStore,
    private readonly state: vscode.Memento,
    options: RunnerOptions = {},
  ) {
    this.objects = options.objects;
    this.ifs = options.ifs;
    this.findDocument = options.findDocument ?? targetDocument;
    this.append = options.append ?? ((l) => this.output.appendLine(l));
    this.listingWaitMs = options.listingWaitMs;
    this.local = options.local;
  }

  /** `job`'s spooled files; the connection job's are the signed-on profile's. */
  private jobFiles(name: string, job: SessionJob): Promise<SpooledFile[]> {
    return this.sessions.call(name, 'spool.files', { name, user: jobFilesUser(job, this.sessions.status(name).job), job });
  }

  /** The highest spooled file number `job` has now; undefined when it cannot be read (no listing link then). */
  private async highestFile(name: string, job: SessionJob): Promise<number | undefined> {
    try {
      return highestNumber(await this.jobFiles(name, job), job);
    } catch {
      return undefined;
    }
  }

  /**
   * The listing a compile made in `job`: its newest file named for the
   * listing (the command's `PRTFILE`, else `QSYSPRT`) numbered after
   * `before`, the job's highest number before the run. Its line is written
   * when there is one.
   */
  private async compileListing(name: string, job: SessionJob, command: string, before: number): Promise<SpooledFile | undefined> {
    try {
      const f = newListing(await this.jobFiles(name, job), job, listingFile(command), before);
      if (f) {
        this.write([listingLine(f.id, name)]);
      }
      return f;
    } catch {
      return undefined;
    }
  }

  /** A batch run's listing: waited for with a one-shot watch the host drops after the first match or 10 minutes. */
  private async batchListing(name: string, job: SessionJob, command: string): Promise<SpooledFile | undefined> {
    try {
      const f = await this.sessions.call(name, 'spool.awaitFile', {
        name,
        job,
        file: listingFile(command),
        ...(this.listingWaitMs !== undefined ? { timeoutMs: this.listingWaitMs } : {}),
      });
      if (f && typeof f === 'object' && typeof f.id?.file === 'string') {
        this.write([listingLine(f.id, name)]);
        return f;
      }
    } catch {
      // No listing link; the run itself is done.
    }
    return undefined;
  }

  /** The target of what the command was handed, or of the active editor. */
  target(arg: RunArg): ActionTarget | undefined {
    if (arg instanceof vscode.Uri) {
      return uriTarget(arg, this.store);
    }
    if (arg && typeof arg === 'object') {
      return nodeTarget(arg as Record<string, unknown>, this.store);
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri ? uriTarget(uri, this.store) : undefined;
  }

  /** The actions that apply to `t`, the one last run on its kind first. */
  applicable(t: ActionTarget): Action[] {
    const match = matchTarget(t);
    const list = this.actions.actions(t.connection).filter((a) => applies(a, match));
    const last = this.state.get<Record<string, string>>(LAST_ACTIONS_KEY, {})[choiceKey(t)];
    const i = last ? list.findIndex((a) => sameName(a.name, last)) : -1;
    return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list;
  }

  private async remember(t: ActionTarget, a: Action): Promise<void> {
    const all = { ...this.state.get<Record<string, string>>(LAST_ACTIONS_KEY, {}) };
    all[choiceKey(t)] = a.name;
    await this.state.update(LAST_ACTIONS_KEY, all);
  }

  private async pick(t: ActionTarget, list: Action[]): Promise<Action | undefined> {
    const items = list.map((action) => {
      const mark = this.actions.mark(action);
      return {
        label: mark ? `$(warning) ${action.name}` : action.name,
        description: action.source.kind === 'default' ? 'default' : action.source.label,
        detail: mark ? `${mark} · ${action.command}` : action.command,
        action,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: `Run Action on ${targetLabel(t)}`,
      placeHolder: 'Action',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return picked?.action;
  }

  private write(lines: string[]): void {
    for (const l of lines) {
      this.append(l);
    }
  }

  /**
   * The compile that applies to what `arg` names: the action last run on
   * its kind when that is a compile, else the first compile in merge
   * order. Undefined when none applies.
   */
  async compileFor(arg: RunArg): Promise<string | undefined> {
    const uri = arg instanceof vscode.Uri ? arg : undefined;
    const got = uri?.scheme === 'file' && this.local ? await this.local(uri) : undefined;
    const t = typeof got === 'object' ? got.target : this.target(arg);
    if (!t) {
      return undefined;
    }
    await this.actions.ready;
    return this.applicable(t).find((a) => a.runAs !== 'batch' && kindOf(a.command) === 'compile')?.name;
  }

  /**
   * Runs an action: `arg` names the target, `actionName` the action (the
   * pick is shown when it is absent). `rewrite` changes the command once
   * its variables are resolved (the debugger's `DBGVIEW(*SOURCE)`).
   * Undefined when nothing was run.
   */
  async run(arg?: RunArg, actionName?: string, rewrite?: (command: string) => string): Promise<RunResult | undefined> {
    // A local file of a project runs against what it deploys to.
    const uri = arg instanceof vscode.Uri ? arg : arg === undefined ? vscode.window.activeTextEditor?.document.uri : undefined;
    const got = uri?.scheme === 'file' && this.local ? await this.local(uri) : undefined;
    if (typeof got === 'string') {
      void vscode.window.showErrorMessage(`Run Action: ${got}.`);
      return undefined;
    }
    const local = got;
    const t = local?.target ?? this.target(arg);
    if (!t) {
      void vscode.window.showInformationMessage(
        'Open a member, a stream file or a file of a project, or pick a member, a file or an object, to run an action on it.',
      );
      return undefined;
    }
    await this.actions.ready;
    const list = this.applicable(t);
    if (list.length === 0) {
      void vscode.window.showInformationMessage(`No action applies to ${targetLabel(t)}. Add one in .vscode/actions.json.`);
      return undefined;
    }
    const action = actionName ? list.find((a) => sameName(a.name, actionName)) : await this.pick(t, list);
    if (!action) {
      if (actionName) {
        void vscode.window.showErrorMessage(`No action named ${actionName} applies to ${targetLabel(t)}.`);
      }
      return undefined;
    }
    await this.remember(t, action);
    const name = t.connection;
    const notRun = (message: string): undefined => {
      this.write([...headerLines({ when: new Date(), action: action.name, target: targetLabel(t), connection: name, command: action.command }), ...failureLines(message, false)]);
      void vscode.window.showErrorMessage(`${action.name}: ${message}`);
      return undefined;
    };

    if (this.sessions.status(name).state === 'disconnected' && !(await this.sessions.connect(name))) {
      return undefined;
    }

    // A document with unsaved changes is saved first; a save that fails stops the run.
    const doc = this.findDocument(t);
    if (doc?.isDirty && !(await doc.save())) {
      return notRun(`${targetLabel(t)} could not be saved`);
    }
    // A local file is deployed first (saved, and checked for a conflict); the action runs only once the system has it.
    if (local) {
      const deployed = await local.deploy();
      if (deployed !== true) {
        return notRun(`${vscode.workspace.asRelativePath(local.uri)} was not deployed: ${deployed}`);
      }
    }

    const ctx: ResolveContext = { connection: connectionValues(this.store, this.sessions, name), library: local?.library };
    try {
      // A local file's &LIBRARY is its project's; the current library is read only for &CURLIB then.
      const curlibOnly = ctx.library !== undefined;
      if (curlibOnly ? variablesIn(action.command).some((v) => v.name === 'CURLIB') : usesCurrentLibrary(action.command, t.environment)) {
        ctx.curlib = (await this.sessions.call(name, 'libl.get', { name })).current ?? undefined;
      }
    } catch (err) {
      return notRun(`the current library could not be read: ${errorText(err, name)}`);
    }
    if (needsLibrary(action.command, t, ctx)) {
      const library = await vscode.window.showInputBox({
        title: `${action.name}: &LIBRARY`,
        prompt: `The job on ${name} has no current library. Library for ${targetLabel(t)}:`,
        ignoreFocusOut: true,
        validateInput: (v) => (libraryName(v) ? undefined : 'Enter a library name: up to 10 characters.'),
      });
      if (library === undefined) {
        return undefined;
      }
      ctx.library = libraryName(library);
    }
    const resolved = resolveCommand(action.command, t, ctx);
    if (!resolved.ok) {
      return notRun(`${resolved.unresolved.join(', ')} ${resolved.unresolved.length === 1 ? 'has' : 'have'} no value for ${targetLabel(t)}`);
    }
    const batch = action.runAs === 'batch';
    // SBMJOB's JOB is the target's name when that is a valid name, else the job description's (*JOBD).
    const jobName = libraryName(targetValue(t, ctx, 'NAME') ?? '') ?? '*JOBD';
    const own = rewrite ? rewrite(resolved.command) : resolved.command;
    const command = batch ? batchCommand(own, jobName) : own;
    const params: ActionRunParams = { name, command, kind: batch ? 'command' : kindOf(command), run: `a${++this.runs}-${Date.now()}` };

    // A compile's listing is the one numbered after the job's files before the run.
    const ownJob = this.sessions.status(name).job;
    const before = params.kind === 'compile' && ownJob ? await this.highestFile(name, ownJob) : undefined;
    this.write(headerLines({ when: new Date(), action: action.name, target: targetLabel(t), connection: name, command }));
    const result: RunResult = { action, target: t, command, local: local?.uri };
    try {
      result.outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: action.name, cancellable: true },
        async (progress, token) => {
          progress.report({ message: `${targetLabel(t)} on ${name}` });
          const cancel = token.onCancellationRequested(() => {
            void this.sessions.call(name, 'action.cancel', { name, run: params.run as string }).catch(() => undefined);
          });
          try {
            return await this.sessions.call(name, 'action.run', params);
          } finally {
            cancel.dispose();
          }
        },
      );
    } catch (err) {
      result.error = err;
      this.write(failureLines(errorText(err, name), true));
      void showError(err, name);
      this.finished.fire(result);
      return result;
    }
    const o = result.outcome;
    this.write(outcomeLines(o, batch));
    if (before !== undefined && o.job && o.status !== 'Cancelled') {
      result.listing = this.compileListing(name, o.job, resolved.command, before);
    } else if (batch && o.status === 'Ok') {
      const submitted = parseQualifiedJob(submittedJob(o.messages) ?? '');
      if (submitted) {
        result.listing = this.batchListing(name, submitted, resolved.command);
      }
    }
    this.finished.fire(result);
    if (action.refresh !== 'none') {
      if (t.environment === 'file') {
        this.ifs?.refresh();
      } else {
        this.objects?.refresh();
      }
    }
    this.announce(action, o);
    return result;
  }

  /** How a run ended, in a notification or the status bar. */
  private announce(action: Action, o: ActionOutcome): void {
    const show = 'Show Output';
    const open = (picked: string | undefined) => {
      if (picked === show) {
        this.output.show(true);
      }
    };
    if (o.status === 'Ok') {
      vscode.window.setStatusBarMessage(`$(check) ${action.name}: completed`, 5000);
      return;
    }
    if (o.status === 'Cancelled') {
      void vscode.window.showInformationMessage(`${action.name}: Cancelled`, show).then(open);
      return;
    }
    const m = o.escape;
    const text = m ? `${m.id}: ${m.text}` : `${action.name}: ${o.status}`;
    const errors = o.diagnostics.filter((d) => d.severity >= 20).length;
    const more = errors > 0 ? ` (${errors} in the Problems panel)` : '';
    void vscode.window.showErrorMessage(`${text}${more}`, show).then(open);
  }

  /** The command, and the links in the output channel. */
  register(): vscode.Disposable[] {
    return [
      this,
      // The second argument names an action only when it is a string: the
      // editor title passes its group context there, a tree its selection.
      vscode.commands.registerCommand('code-for-qs400.action.run', (arg?: RunArg, actionName?: unknown) => this.run(arg, actionNameArg(actionName))),
      vscode.languages.registerDocumentLinkProvider(
        { language: OUTPUT_LANGUAGE },
        {
          provideDocumentLinks: (doc) => {
            const links = outputLinks(doc.getText().split(/\r?\n/)).map((k) => {
              const link = new vscode.DocumentLink(
                new vscode.Range(k.line, k.start, k.line, k.end),
                vscode.Uri.parse(`command:${k.command}?${encodeURIComponent(JSON.stringify(k.args))}`),
              );
              link.tooltip = k.tooltip;
              return link;
            });
            return links;
          },
        },
      ),
    ];
  }

  dispose(): void {
    this.channel?.dispose();
    this.finished.dispose();
  }
}
