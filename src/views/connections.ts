// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';

/** A node in the Connections view. Phase 1 fills this in. */
export type ConnectionNode = never;

/** The Connections view. Empty until connections exist (Phase 1). */
export class ConnectionsProvider implements vscode.TreeDataProvider<ConnectionNode> {
  private readonly changed = new vscode.EventEmitter<ConnectionNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  getTreeItem(element: ConnectionNode): vscode.TreeItem {
    return element;
  }

  getChildren(): ConnectionNode[] {
    return [];
  }

  dispose(): void {
    this.changed.dispose();
  }
}
