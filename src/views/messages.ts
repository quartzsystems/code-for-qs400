// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The Messages view: the active connection's **My messages** (`own`),
 * **System operator** when `messages.canRead` says the profile may read
 * `QSYSOPR`, and any named queue the user adds (saved per connection).
 * Inquiries waiting for a reply come first, then the rest newest first.
 *
 * Every signed-on connection's own queue is watched for the life of its
 * session (`messages.watch { queue: own }`, again after each new sign-on),
 * not only while the view is shown. A `messages.arrived` refreshes the
 * queue, counts on the view's badge (the inquiries waiting on the active
 * connection's queue, and arrivals not yet seen), and, as
 * `code-for-qs400.messages.notify` says, shows a notification: with
 * **Reply** and **Show** for an inquiry.
 */

import * as vscode from 'vscode';
import { sameName } from '../connections/config';
import { errorText, showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import type { HostClient } from '../host/client';
import type { MessageArrived, MessageQueue, MessageRecipient, QueuedMessage } from '../host/protocol';
import { qualifiedJob } from '../jobs/model';
import {
  NOTIFY_SETTING,
  NotifySetting,
  answeredKeys,
  messageDescription,
  messageTooltip,
  notifies,
  orderMessages,
  parseQueue,
  queueKey,
  queueLabel,
  waiting,
} from '../messages/model';
import { isSignedOn } from './connections';

/** Workspace state key of each connection's named queues, `LIB/QUEUE`. */
export const NAMED_QUEUES_KEY = 'code-for-qs400.messages.queues';

/** The QAP version the view needs: `Messages`. */
export const QAP_MESSAGES = 6;

export type MessageNode =
  | { kind: 'info'; connection: string; text: string }
  | { kind: 'queue'; connection: string; queue: MessageQueue }
  | { kind: 'message'; connection: string; queue: MessageQueue; message: QueuedMessage; parent: Extract<MessageNode, { kind: 'queue' }> };

type QueueNode = Extract<MessageNode, { kind: 'queue' }>;
type MessageItemNode = Extract<MessageNode, { kind: 'message' }>;

function messageIcon(m: QueuedMessage): vscode.ThemeIcon {
  if (waiting(m)) {
    return new vscode.ThemeIcon('question', new vscode.ThemeColor('notificationsWarningIcon.foreground'));
  }
  switch (m.kind) {
    case 'inquiry':
    case 'senderCopy':
      return new vscode.ThemeIcon('pass');
    case 'reply':
      return new vscode.ThemeIcon('reply');
    case 'escape':
      return new vscode.ThemeIcon('error');
    case 'diagnostic':
      return new vscode.ThemeIcon('warning');
    case 'completion':
      return new vscode.ThemeIcon('check');
    default:
      return new vscode.ThemeIcon('mail');
  }
}

export function messageTreeItem(n: MessageNode): vscode.TreeItem {
  switch (n.kind) {
    case 'info': {
      const i = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
      i.contextValue = 'messages.info';
      i.iconPath = new vscode.ThemeIcon('info');
      return i;
    }
    case 'queue': {
      const i = new vscode.TreeItem(queueLabel(n.queue), n.queue === 'own' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      i.id = `${n.connection}/${queueKey(n.queue)}`;
      i.description = n.queue === 'sysopr' ? 'QSYSOPR' : n.queue === 'own' ? n.connection : undefined;
      i.iconPath = new vscode.ThemeIcon(n.queue === 'sysopr' ? 'server' : n.queue === 'own' ? 'inbox' : 'mail');
      i.contextValue = typeof n.queue === 'string' ? `messages.queue.${n.queue}` : 'messages.queue.named';
      return i;
    }
    case 'message': {
      const m = n.message;
      const i = new vscode.TreeItem(m.text.replace(/\s*\r?\n\s*/g, ' '), vscode.TreeItemCollapsibleState.None);
      i.id = `${n.connection}/${queueKey(n.queue)}/${m.key}`;
      i.description = `${messageDescription(m)} · ${m.key}`;
      i.tooltip = messageTooltip(m);
      i.iconPath = messageIcon(m);
      i.contextValue = waiting(m) ? 'messages.message.waiting' : 'messages.message';
      return i;
    }
  }
}

/** What a reply needs: where the inquiry is and its key. */
export interface InquiryRef {
  connection: string;
  queue: MessageQueue;
  message: QueuedMessage;
}

/** The host events the view listens to; a `HostClient`, or a test's fake. */
export type MessageEvents = Pick<HostClient, 'onDidArriveMessage'>;

/** One connection's watch and what it counts. */
interface Watched {
  /** The session job the watch was sent for: a new sign-on is a new job. */
  job: string | undefined;
  /** Keys of the inquiries waiting on its own queue. */
  waiting: Set<string>;
  /** Arrivals not yet seen in the view. */
  unseen: number;
}

export class MessagesProvider implements vscode.TreeDataProvider<MessageNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<MessageNode | undefined>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChangeTreeData = this.changed.event;
  private view: vscode.TreeView<MessageNode> | undefined;
  private queueNodes = new Map<string, QueueNode>();
  /** Each queue's messages as last listed, by `connection/queue`. */
  private listed = new Map<string, QueuedMessage[]>();
  /** Whether each connection's profile may read QSYSOPR, by `connection job`. */
  private sysopr = new Map<string, boolean>();
  private readonly watched = new Map<string, Watched>();
  private readonly arrived = new vscode.EventEmitter<MessageArrived>();
  /** Fires after an arrival was taken in (the tests wait on it). */
  readonly onDidArrive = this.arrived.event;

  constructor(
    store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly workspaceState: vscode.Memento,
    events: MessageEvents,
    private readonly notify: (a: MessageArrived) => void = (a) => void this.showArrival(a),
  ) {
    this.subscriptions = [
      sessions.onDidChange(() => {
        void this.syncWatches();
        this.refresh();
      }),
      store.onDidChange(() => this.refresh()),
      events.onDidArriveMessage((a) => this.took(a)),
    ];
  }

  attach(view: vscode.TreeView<MessageNode>): vscode.Disposable {
    this.view = view;
    void this.syncWatches();
    return view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.seen();
      }
    });
  }

  /** The active connection when it is signed on. */
  connection(): string | undefined {
    const name = this.sessions.active;
    return name && isSignedOn(this.sessions.status(name)) ? name : undefined;
  }

  /** Watches the own queue of every signed-on connection once per session job; forgets the others. */
  async syncWatches(): Promise<void> {
    const on = this.sessions.signedOn().filter((s) => (s.system?.qap ?? 0) >= QAP_MESSAGES);
    for (const name of [...this.watched.keys()]) {
      if (!on.some((s) => sameName(s.name, name))) {
        this.watched.delete(name);
      }
    }
    for (const s of on) {
      const job = s.job ? qualifiedJob(s.job) : undefined;
      const w = this.watched.get(s.name);
      if (w && w.job === job) {
        continue;
      }
      const entry: Watched = { job, waiting: new Set(), unseen: 0 };
      this.watched.set(s.name, entry);
      try {
        await this.sessions.call(s.name, 'messages.watch', { name: s.name, queue: 'own' });
        // What waits already counts on the badge.
        const list = await this.sessions.call(s.name, 'messages.list', { name: s.name, queue: 'own', newestFirst: true });
        for (const m of list.filter(waiting)) {
          entry.waiting.add(m.key);
        }
      } catch {
        this.watched.delete(s.name);
      }
      this.showBadge();
    }
  }

  /** The badge: the active connection's inquiries waiting and arrivals not yet seen. */
  badgeCount(): number {
    const name = this.connection();
    const w = name ? this.watched.get(name) : undefined;
    return w ? w.waiting.size + w.unseen : 0;
  }

  private showBadge(): void {
    if (!this.view) {
      return;
    }
    const n = this.badgeCount();
    const w = this.connection() ? this.watched.get(this.connection() as string) : undefined;
    const inquiries = w?.waiting.size ?? 0;
    this.view.badge = n ? { value: n, tooltip: inquiries ? `${inquiries} ${inquiries === 1 ? 'inquiry waits' : 'inquiries wait'} for a reply` : `${n} new ${n === 1 ? 'message' : 'messages'}` } : undefined;
  }

  /** The view was looked at: arrivals are seen; inquiries still wait. */
  seen(): void {
    for (const w of this.watched.values()) {
      w.unseen = 0;
    }
    this.showBadge();
  }

  /** A message arrived on a watched queue. */
  private took(a: MessageArrived): void {
    const name = this.sessions.signedOn().find((s) => sameName(s.name, a.name))?.name ?? a.name;
    const w = this.watched.get(name);
    if (w && a.queue === 'own') {
      if (waiting(a.message)) {
        w.waiting.add(a.message.key);
      }
      if (a.message.kind === 'reply' && a.message.answers) {
        w.waiting.delete(a.message.answers);
      }
      if (!waiting(a.message) && !(this.view?.visible && sameName(name, this.connection() ?? ''))) {
        w.unseen++;
      }
    }
    this.showBadge();
    const node = this.queueNodes.get(`${name}/${queueKey(a.queue)}`.toUpperCase());
    this.listed.delete(`${name}/${queueKey(a.queue)}`.toUpperCase());
    this.changed.fire(node);
    if (notifies(vscode.workspace.getConfiguration().get<NotifySetting>(NOTIFY_SETTING, 'inquiries'), a.message)) {
      this.notify({ ...a, name });
    }
    this.arrived.fire({ ...a, name });
  }

  /** The notification of an arrival: **Reply** for an inquiry waiting, and **Show**. */
  private async showArrival(a: MessageArrived): Promise<void> {
    const m = a.message;
    const reply = 'Reply';
    const show = 'Show';
    const buttons = waiting(m) ? [reply, show] : [show];
    const from = m.fromUser ? ` from ${m.fromUser}` : '';
    const picked = await vscode.window.showInformationMessage(`${a.name} · ${queueLabel(a.queue)}${from}: ${m.text}`, ...buttons);
    if (picked === reply) {
      await vscode.commands.executeCommand('code-for-qs400.messages.reply', { connection: a.name, queue: a.queue, message: m } satisfies InquiryRef);
    } else if (picked === show) {
      await this.show(a.name, a.queue, m.key);
    }
  }

  /** Focuses the view on a message. */
  async show(connection: string, queue: MessageQueue, key: string): Promise<boolean> {
    if (!this.sessions.active || !sameName(this.sessions.active, connection)) {
      await this.sessions.setActive(connection);
    }
    await vscode.commands.executeCommand('code-for-qs400.messages.focus');
    const roots = await this.getChildren();
    const q = roots.find((r): r is QueueNode => r.kind === 'queue' && queueKey(r.queue) === queueKey(queue));
    if (!q) {
      return false;
    }
    const node = (await this.getChildren(q)).find((c): c is MessageItemNode => c.kind === 'message' && c.message.key === key);
    if (node) {
      await this.view?.reveal(node, { select: true, focus: true });
    }
    return !!node;
  }

  /** An inquiry was answered or messages removed here: the badge and the list follow. */
  answered(connection: string, queue: MessageQueue, keys: string[]): void {
    const w = this.watched.get(connection);
    if (w && queue === 'own') {
      for (const k of keys) {
        w.waiting.delete(k);
      }
    }
    this.showBadge();
    this.listed.delete(`${connection}/${queueKey(queue)}`.toUpperCase());
    this.changed.fire(this.queueNodes.get(`${connection}/${queueKey(queue)}`.toUpperCase()));
  }

  refresh(): void {
    this.queueNodes = new Map();
    this.listed = new Map();
    this.changed.fire(undefined);
  }

  /** The named queues saved for `name`. */
  named(name: string): MessageQueue[] {
    const all = this.workspaceState.get<Record<string, string[]>>(NAMED_QUEUES_KEY) ?? {};
    return (all[name.toUpperCase()] ?? []).map(parseQueue).filter((q): q is MessageQueue => q !== undefined);
  }

  async setNamed(name: string, queues: MessageQueue[]): Promise<void> {
    const all = { ...(this.workspaceState.get<Record<string, string[]>>(NAMED_QUEUES_KEY) ?? {}) };
    const keys = [...new Set(queues.map(queueKey))];
    if (keys.length) {
      all[name.toUpperCase()] = keys;
    } else {
      delete all[name.toUpperCase()];
    }
    await this.workspaceState.update(NAMED_QUEUES_KEY, all);
    this.refresh();
  }

  /** The messages of `queue` as last listed. */
  messagesOf(connection: string, queue: MessageQueue): QueuedMessage[] | undefined {
    return this.listed.get(`${connection}/${queueKey(queue)}`.toUpperCase());
  }

  getTreeItem(n: MessageNode): vscode.TreeItem {
    return messageTreeItem(n);
  }

  getParent(n: MessageNode): MessageNode | undefined {
    return n.kind === 'message' ? n.parent : undefined;
  }

  async getChildren(n?: MessageNode): Promise<MessageNode[]> {
    if (!n) {
      return this.roots();
    }
    if (n.kind !== 'queue') {
      return [];
    }
    try {
      const key = `${n.connection}/${queueKey(n.queue)}`.toUpperCase();
      let list = this.listed.get(key);
      if (!list) {
        list = await this.sessions.call(n.connection, 'messages.list', { name: n.connection, queue: n.queue, newestFirst: true });
        this.listed.set(key, list);
      }
      if (sameName(n.connection, this.connection() ?? '') && this.view?.visible) {
        this.seen();
      }
      return list.length
        ? orderMessages(list).map((message) => ({ kind: 'message' as const, connection: n.connection, queue: n.queue, message, parent: n }))
        : [{ kind: 'info', connection: n.connection, text: 'No messages' }];
    } catch (err) {
      return [{ kind: 'info', connection: n.connection, text: errorText(err, n.connection) }];
    }
  }

  private async roots(): Promise<MessageNode[]> {
    const name = this.connection();
    if (!name) {
      return [{ kind: 'info', connection: '', text: 'Connect to see messages' }];
    }
    const st = this.sessions.status(name);
    if ((st.system?.qap ?? QAP_MESSAGES) < QAP_MESSAGES) {
      return [{ kind: 'info', connection: name, text: 'QAP version 6 not available on this server' }];
    }
    const queues: MessageQueue[] = ['own'];
    const at = `${name} ${st.job ? qualifiedJob(st.job) : ''}`;
    if (!this.sysopr.has(at)) {
      try {
        this.sysopr.set(at, (await this.sessions.call(name, 'messages.canRead', { name, queue: 'sysopr' })).ok);
      } catch {
        this.sysopr.set(at, false);
      }
    }
    if (this.sysopr.get(at)) {
      queues.push('sysopr');
    }
    queues.push(...this.named(name));
    return queues.map((queue) => {
      const key = `${name}/${queueKey(queue)}`.toUpperCase();
      let node = this.queueNodes.get(key);
      if (!node) {
        node = { kind: 'queue', connection: name, queue };
        this.queueNodes.set(key, node);
      }
      return node;
    });
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.changed.dispose();
    this.arrived.dispose();
  }
}

/** The inquiry a command was handed: a tree node, or a notification's. */
function inquiryOf(arg: unknown): InquiryRef | undefined {
  const a = arg as Partial<InquiryRef & { kind: string }> | undefined;
  return a?.connection && a.queue && a.message ? { connection: a.connection, queue: a.queue, message: a.message } : undefined;
}

/** **Reply…**: the reply typed, not empty, sent to the inquiry. Undefined when dismissed. */
export async function askReply(m: QueuedMessage): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Reply to ${m.id || 'inquiry'} from ${m.fromUser}`,
    prompt: m.text,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() === '' ? 'Type a reply.' : undefined),
  });
}

/** What **Send Message…** asks: the recipient, the text and whether it is an inquiry. */
export async function askSend(): Promise<{ to: MessageRecipient; text: string; inquiry: boolean } | undefined> {
  const kind = await vscode.window.showQuickPick(
    [
      { label: 'User profile…', description: 'its message queue', to: 'profile' as const },
      { label: 'Message queue…', description: 'LIBRARY/QUEUE', to: 'queue' as const },
      { label: 'System operator', description: 'QSYSOPR', to: 'sysopr' as const },
    ],
    { title: 'Send Message: to' },
  );
  if (!kind) {
    return undefined;
  }
  let to: MessageRecipient;
  if (kind.to === 'sysopr') {
    to = { queue: 'sysopr' };
  } else if (kind.to === 'profile') {
    const v = await vscode.window.showInputBox({
      prompt: 'User profile',
      validateInput: (t) => (/^[A-Za-z$#@][A-Za-z0-9$#@_]{0,9}$/.test(t.trim()) ? undefined : 'A user profile name: up to 10 characters.'),
    });
    if (v === undefined) {
      return undefined;
    }
    to = { profile: v.trim().toUpperCase() };
  } else {
    const v = await vscode.window.showInputBox({ prompt: 'Message queue, LIBRARY/QUEUE', validateInput: (t) => (parseQueue(t) ? undefined : 'LIBRARY/QUEUE') });
    const q = v === undefined ? undefined : parseQueue(v);
    if (!q) {
      return undefined;
    }
    to = { queue: q };
  }
  const text = await vscode.window.showInputBox({ prompt: 'Message text', validateInput: (t) => (t.trim() === '' ? 'Type the message.' : undefined) });
  if (text === undefined) {
    return undefined;
  }
  const type = await vscode.window.showQuickPick(
    [
      { label: 'Informational', inquiry: false },
      { label: 'Inquiry', description: 'the reply comes to your own queue', inquiry: true },
    ],
    { title: 'Send Message: type' },
  );
  return type ? { to, text, inquiry: type.inquiry } : undefined;
}

/** The Messages view's commands. */
export function registerMessagesViewCommands(provider: MessagesProvider, sessions: SessionManager): vscode.Disposable[] {
  const guard =
    <T>(f: (arg: T) => Promise<unknown>) =>
    async (arg: T): Promise<unknown> => {
      try {
        return await f(arg);
      } catch (err) {
        const n = arg as { connection?: string } | undefined;
        void showError(err, n?.connection ?? provider.connection() ?? '');
        return undefined;
      }
    };
  return [
    vscode.commands.registerCommand('code-for-qs400.messages.refresh', () => provider.refresh()),
    vscode.commands.registerCommand(
      'code-for-qs400.messages.reply',
      guard(async (arg: unknown) => {
        const r = inquiryOf(arg);
        if (!r || !waiting(r.message)) {
          return undefined;
        }
        const reply = await askReply(r.message);
        if (reply === undefined) {
          return undefined;
        }
        await sessions.call(r.connection, 'messages.reply', { name: r.connection, queue: r.queue, key: r.message.key, reply });
        provider.answered(r.connection, r.queue, [r.message.key]);
        vscode.window.setStatusBarMessage(`$(check) Replied ${reply}`, 5000);
        return reply;
      }),
    ),
    vscode.commands.registerCommand(
      'code-for-qs400.messages.remove',
      guard(async (n?: MessageNode) => {
        if (n?.kind !== 'message') {
          return undefined;
        }
        await sessions.call(n.connection, 'messages.remove', { name: n.connection, queue: n.queue, keys: [n.message.key] });
        provider.answered(n.connection, n.queue, [n.message.key]);
        return n.message.key;
      }),
    ),
    vscode.commands.registerCommand(
      'code-for-qs400.messages.copyText',
      guard(async (n?: MessageNode) => {
        if (n?.kind !== 'message') {
          return undefined;
        }
        const text = n.message.secondLevel ? `${n.message.text}\n\n${n.message.secondLevel}` : n.message.text;
        await vscode.env.clipboard.writeText(text);
        return text;
      }),
    ),
    vscode.commands.registerCommand(
      'code-for-qs400.messages.send',
      guard(async (n?: MessageNode) => {
        const name = n?.connection || provider.connection();
        if (!name) {
          return undefined;
        }
        const what = await askSend();
        if (!what) {
          return undefined;
        }
        const sent = await sessions.call(name, 'messages.send', { name, ...what });
        vscode.window.setStatusBarMessage(`$(check) Message sent${sent.key ? `, key ${sent.key}` : ''}`, 5000);
        provider.refresh();
        return sent;
      }),
    ),
    vscode.commands.registerCommand(
      'code-for-qs400.messages.removeAnswered',
      guard(async (n?: MessageNode) => {
        if (n?.kind !== 'queue') {
          return undefined;
        }
        const list = provider.messagesOf(n.connection, n.queue) ?? (await sessions.call(n.connection, 'messages.list', { name: n.connection, queue: n.queue, newestFirst: true }));
        const keys = answeredKeys(list);
        if (keys.length === 0) {
          void vscode.window.showInformationMessage(`${queueLabel(n.queue)} has no answered messages.`);
          return [];
        }
        const remove = 'Remove';
        const q = `Remove ${keys.length} answered ${keys.length === 1 ? 'message' : 'messages'} from ${queueLabel(n.queue)} on ${n.connection}?`;
        if ((await vscode.window.showWarningMessage(q, { modal: true }, remove)) !== remove) {
          return undefined;
        }
        await sessions.call(n.connection, 'messages.remove', { name: n.connection, queue: n.queue, keys });
        provider.answered(n.connection, n.queue, keys);
        return keys;
      }),
    ),
    vscode.commands.registerCommand('code-for-qs400.messages.addQueue', async () => {
      const name = provider.connection();
      if (!name) {
        return undefined;
      }
      const v = await vscode.window.showInputBox({ prompt: `Message queue to show on ${name}, LIBRARY/QUEUE`, validateInput: (t) => (parseQueue(t) ? undefined : 'LIBRARY/QUEUE') });
      const q = v === undefined ? undefined : parseQueue(v);
      if (q) {
        await provider.setNamed(name, [...provider.named(name), q]);
      }
      return q;
    }),
    vscode.commands.registerCommand('code-for-qs400.messages.removeQueue', async (n?: MessageNode) => {
      if (n?.kind !== 'queue' || typeof n.queue === 'string') {
        return undefined;
      }
      await provider.setNamed(
        n.connection,
        provider.named(n.connection).filter((q) => queueKey(q) !== queueKey(n.queue)),
      );
      return n.queue;
    }),
  ];
}
