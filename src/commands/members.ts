// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { showError } from '../connections/prompts';
import { MemberFsProvider } from '../members/provider';
import { MEMBER_SCHEME, memberUri } from '../members/uri';
import { MemberNode, ObjectsNode } from '../views/objects';

/** The URI a member node opens. */
export function nodeUri(n: MemberNode, readonly = false): vscode.Uri {
  return memberUri(n.connection, n.library, n.file, n.entry.member, n.entry.type, readonly);
}

/** Registers the member commands; once per window. */
export function registerMemberCommands(fs: MemberFsProvider): vscode.Disposable[] {
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
  ];
}
