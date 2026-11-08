// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * What the Messages view shows and when it notifies, without `vscode`:
 * the order (inquiries waiting first, then the rest newest first), each
 * message's description, the answered messages Remove all answered takes,
 * queue names, and the `code-for-qs400.messages.notify` rule.
 */

import type { MessageQueue, QueuedMessage } from '../host/protocol';

/** The setting: which arrivals get a notification. Every arrival counts on the badge. */
export type NotifySetting = 'inquiries' | 'all' | 'none';

export const NOTIFY_SETTING = 'code-for-qs400.messages.notify';

/** Whether a message waits for a reply: an inquiry still unanswered. */
export function waiting(m: QueuedMessage): boolean {
  return m.kind === 'inquiry' && m.needsReply;
}

/** Inquiries waiting first, newest first; then every other message newest first. Ties keep the server's order. */
export function orderMessages(list: readonly QueuedMessage[]): QueuedMessage[] {
  const byNewest = (a: QueuedMessage, b: QueuedMessage) => b.sent - a.sent;
  return [...list.filter(waiting).sort(byNewest), ...list.filter((m) => !waiting(m)).sort(byNewest)];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:MM:SS`, local time. */
export function sentText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `ID · from user · time`, the ID left out for an impromptu message. */
export function messageDescription(m: QueuedMessage): string {
  return [m.id, m.fromUser, sentText(m.sent)].filter((p) => p.trim() !== '').join(' · ');
}

/** Each type as the tree's tooltip names it. */
export const KIND_LABELS: Record<QueuedMessage['kind'], string> = {
  informational: 'Information',
  inquiry: 'Inquiry',
  reply: 'Reply',
  completion: 'Completion',
  diagnostic: 'Diagnostic',
  escape: 'Escape',
  notify: 'Notify',
  senderCopy: 'Sender’s copy',
};

/** The tooltip: the text, the type, the key, the sender, the reply and the second-level text. */
export function messageTooltip(m: QueuedMessage): string {
  return [
    m.text,
    '',
    `${KIND_LABELS[m.kind] ?? m.kind}${m.id ? ` ${m.id}` : ''} · severity ${m.severity} · key ${m.key}`,
    `From ${m.fromUser}, job ${m.fromJob.number}/${m.fromJob.user}/${m.fromJob.name}, ${sentText(m.sent)}`,
    waiting(m) ? 'Waiting for a reply.' : m.reply !== undefined ? `Reply: ${m.reply}` : '',
    m.secondLevel ? `\n${m.secondLevel}` : '',
  ]
    .filter((l, i) => i === 1 || l !== '')
    .join('\n');
}

/** The keys Remove all answered removes: answered inquiries and sender's copies, and the replies. */
export function answeredKeys(list: readonly QueuedMessage[]): string[] {
  return list.filter((m) => m.kind === 'reply' || ((m.kind === 'inquiry' || m.kind === 'senderCopy') && !m.needsReply)).map((m) => m.key);
}

/** Whether an arrival gets a notification. */
export function notifies(setting: NotifySetting | string | undefined, m: QueuedMessage): boolean {
  switch (setting) {
    case 'none':
      return false;
    case 'all':
      return true;
    default:
      return waiting(m);
  }
}

/** A queue as text: `own`, `sysopr` or `LIB/QUEUE`, for keys and comparisons. */
export function queueKey(q: MessageQueue): string {
  return typeof q === 'string' ? q : `${q.library}/${q.queue}`.toUpperCase();
}

/** The queue node's label. */
export function queueLabel(q: MessageQueue): string {
  return q === 'own' ? 'My messages' : q === 'sysopr' ? 'System operator' : `${q.library}/${q.queue}`.toUpperCase();
}

/** `LIB/QUEUE` as typed, or undefined. */
export function parseQueue(s: string): MessageQueue | undefined {
  const m = /^\s*([A-Za-z$#@][A-Za-z0-9$#@_.]{0,9})\/([A-Za-z$#@][A-Za-z0-9$#@_.]{0,9})\s*$/.exec(s);
  return m ? { library: m[1].toUpperCase(), queue: m[2].toUpperCase() } : undefined;
}
