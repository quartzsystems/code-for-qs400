// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { serverMessage } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { IfsInfo } from '../host/protocol';
import { baseName, formatSize, isWithin, joinPath, parentPath } from '../ifs/paths';
import { IfsFsProvider } from '../ifs/provider';
import { countText, deleteWalked, walkBottomUp } from '../ifs/tree';
import { ifsUri } from '../ifs/uri';
import { IfsEntryNode, IfsNode, IfsProvider, isDirectoryNode } from '../views/ifs';
import { PROPERTIES_LANGUAGE } from './objects';
import { IfsCommandContext, connectionOf, ifsCommand, openIfsPath, promptPath } from './ifs';

/** The scheme of the read-only IFS Properties documents. */
export const IFS_PROPERTIES_SCHEME = 'qs400ifsinfo';

/** The CCSIDs New File offers, then Other…. */
export const CCSID_CHOICES: readonly { ccsid: number; label: string }[] = [
  { ccsid: 1208, label: 'UTF-8' },
  { ccsid: 37, label: 'EBCDIC US and Canada' },
  { ccsid: 500, label: 'EBCDIC international' },
  { ccsid: 819, label: 'ISO 8859-1' },
];

/** Asks a CCSID: the four, or Other… with a number. */
export async function pickCcsid(title: string): Promise<number | undefined> {
  const items: (vscode.QuickPickItem & { ccsid?: number })[] = [
    ...CCSID_CHOICES.map((c) => ({ label: String(c.ccsid), description: c.label, ccsid: c.ccsid })),
    { label: 'Other…', description: 'any CCSID the system has' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'CCSID of the new file', ignoreFocusOut: true });
  if (!picked) {
    return undefined;
  }
  if (picked.ccsid !== undefined) {
    return picked.ccsid;
  }
  const typed = await vscode.window.showInputBox({
    title,
    prompt: 'CCSID, 1 to 65535.',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const n = Number(v.trim());
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : 'Enter a number from 1 to 65535.';
    },
  });
  return typed === undefined ? undefined : Number(typed.trim());
}

/** A name for an entry in a directory: not empty, no `/`. */
function nameProblem(v: string): string | undefined {
  if (v.trim() === '') {
    return 'Enter a name.';
  }
  return v.includes('/') ? 'A name has no /.' : undefined;
}

function promptName(title: string, value = ''): Thenable<string | undefined> {
  const dot = value.lastIndexOf('.');
  return vscode.window
    .showInputBox({
      title,
      value,
      valueSelection: [0, dot > 0 ? dot : value.length],
      ignoreFocusOut: true,
      validateInput: nameProblem,
    })
    .then((v) => v?.trim());
}

function isExists(err: unknown): boolean {
  return serverMessage(err)?.status === 'Exists';
}

/** The `label: value` lines of an IFS Properties document. */
export function ifsPropertiesText(path: string, info: IfsInfo, resolved?: string): string {
  const kind = { file: 'Stream file', directory: 'Directory', symlink: 'Symbolic link', other: 'Other' }[info.kind];
  const lines: [string, string][] = [
    ['Path', path],
    ['Type', kind],
  ];
  if (info.kind === 'symlink') {
    lines.push(['Link target', info.target ?? '']);
    if (resolved !== undefined) {
      lines.push(['Resolves to', resolved]);
    }
  }
  lines.push(
    ['Size', `${info.size.toLocaleString('en-US')} bytes (${formatSize(info.size)})`],
    ['CCSID', String(info.ccsid)],
    ['Owner', info.owner],
    ['Last changed', new Date(info.modified).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')],
    ['Change counter', info.change.startsWith('m') ? 'not available before QAP version 6' : info.change],
  );
  const width = Math.max(...lines.map(([l]) => l.length));
  return lines.map(([l, v]) => `${`${l}:`.padEnd(width + 1)} ${v}`).join('\n') + '\n';
}

/** Serves IFS Properties documents from `ifs.info`; read-only by being a content provider. */
export class IfsPropertiesProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly sessions: SessionManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const name = uri.authority;
    const path = uri.path;
    const info = await this.sessions.call(name, 'ifs.info', { name, path });
    let resolved: string | undefined;
    if (info.kind === 'symlink') {
      resolved = await this.sessions
        .call(name, 'ifs.resolve', { name, path })
        .then((r) => r.path)
        .catch(() => '(broken)');
    }
    return ifsPropertiesText(path, info, resolved);
  }
}

/** The directory a node is, or is in. */
function directoryOf(n: IfsNode | undefined): string | undefined {
  if (!n || n.kind === 'message') {
    return undefined;
  }
  const path = n.path;
  return isDirectoryNode(n) ? path : parentPath(path);
}

/** The tree's own drag type. */
export const IFS_TREE_MIME = 'application/vnd.code.tree.code-for-qs400.ifs';

/** Drag and drop in the IFS view: dropping entries on a directory copies them there. */
export class IfsDragAndDrop implements vscode.TreeDragAndDropController<IfsNode> {
  readonly dragMimeTypes = [IFS_TREE_MIME];
  readonly dropMimeTypes = [IFS_TREE_MIME, 'text/uri-list'];
  /** Set by the upload commands: local files dropped on a directory. */
  uploadDropped?: (target: IfsNode, files: vscode.Uri[]) => Promise<unknown>;

  constructor(private readonly provider: IfsProvider) {}

  handleDrag(source: readonly IfsNode[], data: vscode.DataTransfer): void {
    const entries = source.filter((n): n is IfsEntryNode => n.kind === 'entry');
    if (entries.length > 0) {
      data.set(IFS_TREE_MIME, new vscode.DataTransferItem(entries));
    }
  }

  async handleDrop(target: IfsNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const dir = directoryOf(target);
    if (!target || !dir) {
      return;
    }
    const dragged = data.get(IFS_TREE_MIME)?.value as IfsEntryNode[] | undefined;
    if (dragged?.length) {
      await copyInto(this.provider, target.connection, dragged, dir);
      return;
    }
    const list = await data.get('text/uri-list')?.asString();
    const files = (list ?? '')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '' && !l.startsWith('#'))
      .map((l) => vscode.Uri.parse(l.trim()))
      .filter((u) => u.scheme === 'file');
    if (files.length > 0 && this.uploadDropped) {
      await this.uploadDropped(target, files);
    }
  }
}

/** Copies entries into `dir`, each under its own name, asking before replacing a file. */
async function copyInto(provider: IfsProvider, connection: string, nodes: IfsEntryNode[], dir: string): Promise<void> {
  for (const n of nodes.filter((x) => x.connection === connection)) {
    const to = joinPath(dir, n.entry.name);
    if (to === n.path) {
      continue;
    }
    await copyEntry(connection, n.path, to);
  }
  provider.refresh();
}

/** One copy through the provider (`workspace.fs`), asking once before replacing. */
async function copyEntry(connection: string, from: string, to: string): Promise<boolean> {
  const a = ifsUri(connection, from);
  const b = ifsUri(connection, to);
  try {
    await vscode.workspace.fs.copy(a, b, { overwrite: false });
    return true;
  } catch (err) {
    const exists = err instanceof vscode.FileSystemError && err.code === 'FileExists';
    if (!exists) {
      throw err;
    }
    const replace = await vscode.window.showWarningMessage(`${to} exists. Replace it?`, { modal: true }, 'Replace');
    if (replace !== 'Replace') {
      return false;
    }
    await vscode.workspace.fs.copy(a, b, { overwrite: true });
    return true;
  }
}

/** New file, New folder, Rename, Copy to…, Delete, Properties and Change CCSID. */
export function registerIfsFileCommands(c: IfsCommandContext, fs: IfsFsProvider): vscode.Disposable[] {
  const { provider, sessions } = c;

  return [
    vscode.workspace.registerTextDocumentContentProvider(IFS_PROPERTIES_SCHEME, new IfsPropertiesProvider(sessions)),
    ifsCommand('code-for-qs400.ifs.newFile', async (n) => {
      const name = connectionOf(provider, n);
      const dir = directoryOf(n) ?? (name ? await promptPath('New File in', provider.savedRoots(name)[0] ?? '/') : undefined);
      if (!name || !dir) {
        return undefined;
      }
      const file = await promptName(`New File in ${dir}`);
      if (!file) {
        return undefined;
      }
      const ccsid = await pickCcsid(`New File ${file}`);
      if (ccsid === undefined) {
        return undefined;
      }
      const path = joinPath(dir, file);
      await sessions.call(name, 'ifs.writeText', { name, path, text: '', ccsid, mode: 'create' });
      provider.refresh();
      await openIfsPath(name, path);
      return path;
    }),
    ifsCommand('code-for-qs400.ifs.newFolder', async (n) => {
      const name = connectionOf(provider, n);
      const dir = directoryOf(n);
      if (!name || !dir) {
        return undefined;
      }
      const folder = await promptName(`New Folder in ${dir}`);
      if (!folder) {
        return undefined;
      }
      const path = joinPath(dir, folder);
      await sessions.call(name, 'ifs.mkdir', { name, path, parents: false });
      provider.refresh();
      return path;
    }),
    ifsCommand('code-for-qs400.ifs.rename', async (n) => {
      if (n?.kind !== 'entry') {
        return undefined;
      }
      const newName = await promptName(`Rename ${n.path}`, n.entry.name);
      if (!newName || newName === n.entry.name) {
        return undefined;
      }
      const to = joinPath(parentPath(n.path), newName);
      const params = { name: n.connection, from: n.path, to, replace: false };
      try {
        await sessions.call(n.connection, 'ifs.rename', params);
      } catch (err) {
        if (!isExists(err)) {
          throw err;
        }
        const replace = await vscode.window.showWarningMessage(`${to} exists. Replace it?`, { modal: true }, 'Replace');
        if (replace !== 'Replace') {
          return undefined;
        }
        await sessions.call(n.connection, 'ifs.rename', { ...params, replace: true });
      }
      fs.changed(ifsUri(n.connection, n.path), vscode.FileChangeType.Deleted);
      provider.refresh();
      return to;
    }),
    ifsCommand('code-for-qs400.ifs.copy', async (n) => {
      if (n?.kind !== 'entry') {
        return undefined;
      }
      const to = await promptPath(`Copy ${n.path} to`, n.path, 'The full path of the copy.');
      if (!to || to === n.path) {
        return undefined;
      }
      if (n.entry.kind === 'directory' && isWithin(to, n.path)) {
        void vscode.window.showErrorMessage(`${n.path} cannot be copied into itself.`);
        return undefined;
      }
      const copied = await copyEntry(n.connection, n.path, to);
      provider.refresh();
      return copied ? to : undefined;
    }),
    ifsCommand('code-for-qs400.ifs.delete', async (n) => {
      if (n?.kind !== 'entry') {
        return undefined;
      }
      const name = n.connection;
      if (n.entry.kind !== 'directory') {
        const what = n.entry.kind === 'symlink' ? 'the symbolic link' : '';
        const ok = await vscode.window.showWarningMessage(
          `Delete ${what ? `${what} ` : ''}${n.path}?`,
          { modal: true, detail: n.entry.kind === 'symlink' ? 'What it points to is not deleted.' : undefined },
          'Delete',
        );
        if (ok !== 'Delete') {
          return undefined;
        }
        await sessions.call(name, 'ifs.delete', { name, path: n.path });
        fs.changed(ifsUri(name, n.path), vscode.FileChangeType.Deleted);
        provider.refresh();
        return [n.path];
      }
      const walked = await walkBottomUp(n.path, (dir) => sessions.call(name, 'ifs.list', { name, path: dir }));
      const inside = walked.length - 1;
      const ok = await vscode.window.showWarningMessage(
        inside === 0
          ? `Delete the empty folder ${n.path}?`
          : `Delete ${n.path} and the ${inside} ${inside === 1 ? 'entry' : 'entries'} in it (${countText(walked)})?`,
        { modal: true, detail: inside === 0 ? undefined : 'Everything in it is deleted, deepest first. Symbolic links are deleted, not what they point to.' },
        'Delete',
      );
      if (ok !== 'Delete') {
        return undefined;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Deleting ${n.path}` },
        async (progress) => {
          await deleteWalked(
            walked,
            async (path) => {
              await sessions.call(name, 'ifs.delete', { name, path });
              fs.forget(ifsUri(name, path));
            },
            () => progress.report({ increment: 100 / walked.length }),
          );
        },
      );
      provider.refresh();
      return walked.map((w) => w.path);
    }),
    ifsCommand('code-for-qs400.ifs.properties', async (n) => {
      if (!n || n.kind === 'message') {
        return undefined;
      }
      const uri = vscode.Uri.from({ scheme: IFS_PROPERTIES_SCHEME, authority: n.connection, path: n.path });
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(doc, PROPERTIES_LANGUAGE);
      return vscode.window.showTextDocument(doc, { preview: true });
    }),
    ifsCommand('code-for-qs400.ifs.changeCcsid', async (n) => {
      if (n?.kind !== 'entry' || n.entry.kind !== 'file') {
        return undefined;
      }
      const name = n.connection;
      const info = await sessions.call(name, 'ifs.info', { name, path: n.path });
      if (info.size > 0) {
        void vscode.window.showInformationMessage(
          `${baseName(n.path)} holds ${info.size.toLocaleString('en-US')} bytes in CCSID ${info.ccsid}. A new CCSID would only tag those bytes; the data would need re-encoding, which this command does not do. To change the encoding, copy the text into a new file made with the CCSID you want.`,
          { modal: true },
        );
        return undefined;
      }
      const ccsid = await pickCcsid(`Change CCSID of ${baseName(n.path)} (now ${info.ccsid})`);
      if (ccsid === undefined || ccsid === info.ccsid) {
        return undefined;
      }
      const ok = await vscode.window.showWarningMessage(
        `Make ${n.path} again, empty, with CCSID ${ccsid}?`,
        {
          modal: true,
          detail: 'QAP has no operation that sets a CCSID, so the empty file is deleted and created again: its owner and authorities become those of a new file in the folder.',
        },
        'Change CCSID',
      );
      if (ok !== 'Change CCSID') {
        return undefined;
      }
      await sessions.call(name, 'ifs.delete', { name, path: n.path });
      await sessions.call(name, 'ifs.writeText', { name, path: n.path, text: '', ccsid, mode: 'create' });
      fs.changed(ifsUri(name, n.path));
      fs.forget(ifsUri(name, n.path));
      provider.refresh();
      return ccsid;
    }),
  ];
}
