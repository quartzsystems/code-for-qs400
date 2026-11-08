// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { serverMessage, showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { MemberRef } from '../host/protocol';
import { MemberFsProvider } from '../members/provider';
import { memberType } from '../members/types';
import { MEMBER_SCHEME, memberUri, qualifiedMember } from '../members/uri';
import { MemberNode, ObjectsNode, ObjectsProvider, isSourceFile } from '../views/objects';

/** The URI a member node opens. */
export function nodeUri(n: MemberNode, readonly = false): vscode.Uri {
  return memberUri(n.connection, n.library, n.file, n.entry.member, n.entry.type, readonly);
}

const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

/** A member name upper-cased, or undefined when it is not one. */
export function memberName(s: string): string | undefined {
  const n = s.trim().toUpperCase();
  return NAME.test(n) ? n : undefined;
}

/** `LIB/FILE(MEMBER)`, or just `MEMBER` in `within`'s file; undefined when it is neither. */
export function parseQualified(s: string, within: { library: string; file: string }): MemberRef | undefined {
  const t = s.trim().toUpperCase();
  const m = /^([^/()\s]+)\/([^/()\s]+)\(([^/()\s]+)\)$/.exec(t);
  if (m) {
    const [library, file, member] = [m[1], m[2], m[3]];
    return NAME.test(library) && NAME.test(file) && NAME.test(member) ? { library, file, member } : undefined;
  }
  const member = memberName(t);
  return member ? { library: within.library, file: within.file, member } : undefined;
}

/** Source types offered by New Member. */
const NEW_MEMBER_TYPES = ['RPGLE', 'SQLRPGLE', 'CLLE', 'PF', 'LF', 'DSPF', 'PRTF', 'CMD', 'SQL', 'C', 'CPP', 'TXT', 'BND', 'RPG', 'CLP'];

const NAME_PROBLEM = 'Enter a member name: up to 10 characters, starting with a letter, $, # or @.';

/** Registers the member commands; once per window. */
export function registerMemberCommands(
  fs: MemberFsProvider,
  objects: ObjectsProvider,
  sessions: SessionManager,
): vscode.Disposable[] {
  const reg = (id: string, fn: (n: ObjectsNode | undefined) => Promise<unknown>) =>
    vscode.commands.registerCommand(id, async (n?: ObjectsNode) => {
      try {
        return await fn(n);
      } catch (err) {
        void showError(err, n?.connection);
        return undefined;
      }
    });
  const open = async (n: ObjectsNode | undefined, readonly: boolean) =>
    n?.kind === 'member' ? vscode.window.showTextDocument(nodeUri(n, readonly)) : undefined;
  const ref = (n: MemberNode) => ({ name: n.connection, library: n.library, file: n.file, member: n.entry.member });
  const qualified = (n: MemberNode) => qualifiedMember({ library: n.library, file: n.file, member: n.entry.member });
  /** This window's own lock would stand in the way of renaming or deleting. */
  const releaseOwn = async (n: MemberNode) => {
    await fs.release(nodeUri(n));
    await fs.release(nodeUri(n, true));
  };

  return [
    reg('code-for-qs400.member.open', (n) => open(n, false)),
    reg('code-for-qs400.member.openReadOnly', (n) => open(n, true)),

    reg('code-for-qs400.member.renumber', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc?.uri.scheme !== MEMBER_SCHEME) {
        void vscode.window.showInformationMessage('Open a member to renumber it.');
        return undefined;
      }
      if (doc.isDirty && !(await doc.save())) {
        return undefined;
      }
      return fs.renumber(doc.uri, doc.getText());
    }),

    reg('code-for-qs400.member.create', async (n) => {
      if (n?.kind !== 'object' || !isSourceFile(n.entry)) {
        return undefined;
      }
      const { library, object: file } = n.entry;
      const title = `New Member in ${library}/${file}`;
      const name = await vscode.window.showInputBox({
        title: `${title} (1/3)`,
        prompt: 'Member name.',
        ignoreFocusOut: true,
        validateInput: (v) => (memberName(v) ? undefined : NAME_PROBLEM),
      });
      const member = name === undefined ? undefined : memberName(name);
      if (!member) {
        return undefined;
      }
      const other = 'Other…';
      const picked = await vscode.window.showQuickPick(
        [...NEW_MEMBER_TYPES.map((t) => ({ label: t, description: `.${memberType(t).ext}` })), { label: other }],
        { title: `${title} (2/3)`, placeHolder: 'Source type', ignoreFocusOut: true },
      );
      if (!picked) {
        return undefined;
      }
      let type = picked.label;
      if (type === other) {
        const typed = await vscode.window.showInputBox({
          title: `${title} (2/3)`,
          prompt: 'Source type.',
          ignoreFocusOut: true,
          validateInput: (v) => (/^[A-Z0-9]{1,10}$/i.test(v.trim()) ? undefined : 'Enter a source type: up to 10 letters and digits.'),
        });
        if (typed === undefined) {
          return undefined;
        }
        type = typed.trim().toUpperCase();
      }
      const text = await vscode.window.showInputBox({ title: `${title} (3/3)`, prompt: 'Text (optional).', ignoreFocusOut: true });
      if (text === undefined) {
        return undefined;
      }
      await sessions.call(n.connection, 'member.create', { name: n.connection, library, file, member, type, text });
      objects.refresh(n);
      return vscode.window.showTextDocument(memberUri(n.connection, library, file, member, type));
    }),

    reg('code-for-qs400.member.copy', async (n) => {
      if (n?.kind !== 'member') {
        return undefined;
      }
      const from = { library: n.library, file: n.file, member: n.entry.member };
      const input = await vscode.window.showInputBox({
        title: `Copy ${qualified(n)}`,
        prompt: `To: a member name in ${n.library}/${n.file}, or LIBRARY/FILE(MEMBER).`,
        value: qualified(n),
        ignoreFocusOut: true,
        validateInput: (v) => (parseQualified(v, n) ? undefined : 'Enter a member name, or LIBRARY/FILE(MEMBER).'),
      });
      const to = input === undefined ? undefined : parseQualified(input, n);
      if (!to) {
        return undefined;
      }
      const copy = (replace: boolean) => sessions.call(n.connection, 'member.copy', { name: n.connection, from, to, replace });
      try {
        await copy(false);
      } catch (err) {
        if (serverMessage(err)?.status !== 'Exists') {
          throw err;
        }
        const replace = 'Replace';
        const picked = await vscode.window.showWarningMessage(
          `${qualifiedMember(to)} exists. Replace it with ${qualified(n)}?`,
          { modal: true, detail: serverMessage(err)?.text },
          replace,
        );
        if (picked !== replace) {
          return undefined;
        }
        await copy(true);
      }
      objects.refresh();
      return to;
    }),

    reg('code-for-qs400.member.rename', async (n) => {
      if (n?.kind !== 'member') {
        return undefined;
      }
      const input = await vscode.window.showInputBox({
        title: `Rename ${qualified(n)}`,
        prompt: 'New member name.',
        value: n.entry.member,
        ignoreFocusOut: true,
        validateInput: (v) => {
          const m = memberName(v);
          if (!m) {
            return NAME_PROBLEM;
          }
          return m === n.entry.member ? 'Enter a different name.' : undefined;
        },
      });
      const newName = input === undefined ? undefined : memberName(input);
      if (!newName) {
        return undefined;
      }
      await releaseOwn(n);
      await sessions.call(n.connection, 'member.rename', { ...ref(n), newName });
      objects.refresh();
      return newName;
    }),

    reg('code-for-qs400.member.delete', async (n) => {
      if (n?.kind !== 'member') {
        return undefined;
      }
      const del = 'Delete';
      const picked = await vscode.window.showWarningMessage(
        `Delete member ${n.entry.member} from ${n.library}/${n.file}?`,
        { modal: true, detail: `${qualified(n)} is removed from the system (RMVM). This cannot be undone.` },
        del,
      );
      if (picked !== del) {
        return undefined;
      }
      await releaseOwn(n);
      await sessions.call(n.connection, 'member.delete', ref(n));
      objects.refresh();
      return qualified(n);
    }),

    reg('code-for-qs400.member.changeText', async (n) => {
      if (n?.kind !== 'member') {
        return undefined;
      }
      const text = await vscode.window.showInputBox({
        title: `Change Text of ${qualified(n)}`,
        prompt: 'Member text.',
        value: n.entry.text,
        ignoreFocusOut: true,
      });
      if (text === undefined) {
        return undefined;
      }
      await sessions.call(n.connection, 'member.changeText', { ...ref(n), text });
      objects.refresh();
      return text;
    }),

    reg('code-for-qs400.member.compare', async (n) => {
      if (n?.kind !== 'member') {
        return undefined;
      }
      const members = await sessions.call(n.connection, 'member.list', { name: n.connection, library: n.library, file: n.file });
      type Pick = vscode.QuickPickItem & { uri?: vscode.Uri; other?: 'member' | 'file' };
      const items: Pick[] = [
        ...members
          .filter((m) => m.member !== n.entry.member)
          .map((m) => ({
            label: m.member,
            description: m.type,
            detail: m.text || undefined,
            uri: memberUri(n.connection, n.library, n.file, m.member, m.type, true),
          })),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(file-code) Member in another source file…', other: 'member' },
        { label: '$(file) Local file…', other: 'file' },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: `Compare ${n.entry.member} with…`,
        placeHolder: `A member of ${n.library}/${n.file}, a member elsewhere, or a local file`,
        matchOnDescription: true,
      });
      if (!picked) {
        return undefined;
      }
      let other = picked.uri;
      let label = picked.label;
      if (picked.other === 'member') {
        const input = await vscode.window.showInputBox({
          title: `Compare ${n.entry.member} with…`,
          prompt: 'LIBRARY/FILE(MEMBER).',
          ignoreFocusOut: true,
          validateInput: (v) => (parseQualified(v, n) ? undefined : 'Enter LIBRARY/FILE(MEMBER).'),
        });
        const to = input === undefined ? undefined : parseQualified(input, n);
        if (!to) {
          return undefined;
        }
        // Its type, for the extension and the language.
        const theirs = await sessions.call(n.connection, 'member.list', {
          name: n.connection,
          library: to.library,
          file: to.file,
          pattern: to.member,
        });
        const type = theirs.find((m) => m.member === to.member)?.type ?? n.entry.type;
        other = memberUri(n.connection, to.library, to.file, to.member, type, true);
        label = qualifiedMember(to);
      } else if (picked.other === 'file') {
        const files = await vscode.window.showOpenDialog({ canSelectMany: false, title: `Compare ${n.entry.member} with` });
        if (!files?.[0]) {
          return undefined;
        }
        other = files[0];
        label = vscode.workspace.asRelativePath(other);
      }
      if (!other) {
        return undefined;
      }
      // Both sides read-only: comparing takes no lock.
      return vscode.commands.executeCommand('vscode.diff', other, nodeUri(n, true), `${label} ↔ ${n.entry.member}`);
    }),
  ];
}
