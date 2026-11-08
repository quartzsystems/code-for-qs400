// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import { typedPath } from '../ifs/paths';
import { IfsNode, IfsProvider, isDirectoryNode, nodePath } from '../views/ifs';

/** What the IFS commands share. */
export interface IfsCommandContext {
  provider: IfsProvider;
  view: vscode.TreeView<IfsNode>;
  store: ConnectionStore;
  sessions: SessionManager;
}

/** Registers a command taking a node; errors are shown as `showError` shows them. */
export function ifsCommand(id: string, fn: (n: IfsNode | undefined) => Promise<unknown>): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (n?: IfsNode) => {
    try {
      return await fn(n);
    } catch (err) {
      void showError(err, n?.connection || undefined);
      return undefined;
    }
  });
}

/** The connection a command acts on: the node's, else the view's; a hint when there is none. */
export function connectionOf(provider: IfsProvider, n: IfsNode | undefined): string | undefined {
  const name = n?.connection || provider.connection();
  if (!name) {
    void vscode.window.showInformationMessage('Connect first: the IFS belongs to a session.');
  }
  return name;
}

/** Asks for an absolute path. */
export function promptPath(title: string, value: string, prompt = 'An absolute IFS path, such as /home/CWELLMAN/src.'): Thenable<string | undefined> {
  return vscode.window
    .showInputBox({
      title,
      prompt,
      value,
      ignoreFocusOut: true,
      validateInput: (v) => (typedPath(v) ? undefined : 'Enter a path that starts with /.'),
    })
    .then((v) => (v === undefined ? undefined : typedPath(v)));
}

/** Refresh, the roots, Go to Path and the hidden-entries toggle. */
export function registerIfsViewCommands(c: IfsCommandContext): vscode.Disposable[] {
  const { provider, view, store, sessions } = c;
  const saveRoots = (name: string, roots: string[]) => store.setIfsRoots(name, roots);

  return [
    ifsCommand('code-for-qs400.ifs.refresh', async (n) => {
      provider.refresh(n?.kind === 'message' ? undefined : n);
    }),
    ifsCommand('code-for-qs400.ifs.showHidden', () => provider.setShowHidden(true)),
    ifsCommand('code-for-qs400.ifs.hideHidden', () => provider.setShowHidden(false)),
    ifsCommand('code-for-qs400.ifs.addRoot', async (n) => {
      const name = connectionOf(provider, n);
      if (!name) {
        return undefined;
      }
      const path = isDirectoryNode(n) ? n.path : await promptPath('Add IFS Root', '/');
      if (!path) {
        return undefined;
      }
      const saved = provider.savedRoots(name);
      if (!saved.includes(path)) {
        await saveRoots(name, [...saved, path]);
      }
      provider.removeTransientRoot(name, path);
      return path;
    }),
    ifsCommand('code-for-qs400.ifs.removeRoot', async (n) => {
      if (n?.kind !== 'root') {
        return undefined;
      }
      if (n.transient) {
        provider.removeTransientRoot(n.connection, n.path);
      } else {
        await saveRoots(
          n.connection,
          provider.savedRoots(n.connection).filter((p) => p !== n.path),
        );
      }
      return n.path;
    }),
    ifsCommand('code-for-qs400.ifs.setHome', async (n) => {
      const name = connectionOf(provider, n);
      if (!name) {
        return undefined;
      }
      const path = isDirectoryNode(n) ? n.path : await promptPath('Set IFS Home', nodePath(n) ?? '/');
      if (!path) {
        return undefined;
      }
      await saveRoots(name, [path, ...provider.savedRoots(name).filter((p) => p !== path)]);
      provider.removeTransientRoot(name, path);
      return path;
    }),
    ifsCommand('code-for-qs400.ifs.goTo', async (n) => {
      const name = connectionOf(provider, n);
      if (!name) {
        return undefined;
      }
      const path = await promptPath('Go to IFS Path', nodePath(n) ?? provider.savedRoots(name)[0] ?? '/');
      if (!path) {
        return undefined;
      }
      const { path: target } = await sessions.call(name, 'ifs.resolve', { name, path });
      const info = await sessions.call(name, 'ifs.info', { name, path: target });
      if (info.kind === 'directory') {
        const root = provider.addTransientRoot(name, path);
        await view.reveal(root, { expand: true, select: true, focus: true });
        return root;
      }
      return vscode.commands.executeCommand('code-for-qs400.ifs.openPath', name, path);
    }),
  ];
}
