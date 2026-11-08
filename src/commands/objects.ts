// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { sameName } from '../connections/config';
import { showError } from '../connections/prompts';
import { SessionManager } from '../connections/sessions';
import { ConnectionStore } from '../connections/store';
import {
  FilterConfig,
  isFilterLibrary,
  isObjectType,
  patternProblem,
} from '../objects/filters';
import { ObjectsNode, ObjectsProvider } from '../views/objects';

/** The scheme of the read-only Properties documents. */
export const PROPERTIES_SCHEME = 'qs400obj';

/** Language of the Properties documents: plain text, shown in Courier. */
export const PROPERTIES_LANGUAGE = 'qs400-properties';

/** `qs400obj://<connection>/<LIB>/<OBJ> (<TYPE>)`: the document is named `<LIB>/<OBJ> (<TYPE>)`. */
export function propertiesUri(connection: string, library: string, object: string, type: string): vscode.Uri {
  return vscode.Uri.from({ scheme: PROPERTIES_SCHEME, authority: connection, path: `/${library}/${object} (${type})` });
}

/** The parts of a Properties URI; undefined when it is not one. */
export function parsePropertiesUri(uri: vscode.Uri): { connection: string; library: string; object: string; type: string } | undefined {
  const m = /^\/([^/]+)\/([^/ ]+) \(([^)]+)\)$/.exec(uri.path);
  return uri.scheme === PROPERTIES_SCHEME && m ? { connection: uri.authority, library: m[1], object: m[2], type: m[3] } : undefined;
}

/** The lines of a Properties document: `name: value`, in the server's order. */
export function propertiesText(props: { name: string; value: string }[]): string {
  return props.map((p) => `${p.name}: ${p.value}`).join('\n') + '\n';
}

/** Serves Properties documents from `object.properties`; read-only by being a content provider. */
export class PropertiesProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly sessions: SessionManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const p = parsePropertiesUri(uri);
    if (!p) {
      throw new Error(`not a properties document: ${uri.toString()}`);
    }
    const props = await this.sessions.call(p.connection, 'object.properties', {
      name: p.connection,
      library: p.library,
      object: p.object,
      type: p.type,
    });
    return propertiesText(props);
  }
}

/** Add and Edit: one box per field. Undefined when cancelled. */
async function promptFilter(existing: FilterConfig | undefined, taken: string[]): Promise<FilterConfig | undefined> {
  const title = existing ? `Edit Filter ${existing.name}` : 'Add Filter';
  const box = (step: number, options: vscode.InputBoxOptions) =>
    vscode.window.showInputBox({ title: `${title} (${step}/5)`, ignoreFocusOut: true, ...options });
  const name = await box(1, {
    prompt: 'Filter name.',
    value: existing?.name,
    validateInput: (v) => {
      if (v.trim() === '') {
        return 'Enter a name.';
      }
      return taken.some((t) => t.toLowerCase() === v.trim().toLowerCase()) ? `A filter named ${v.trim()} exists.` : undefined;
    },
  });
  if (name === undefined) {
    return undefined;
  }
  const library = await box(2, {
    prompt: 'Library: a library name, or *LIBL, *CURLIB, *USRLIBL or *ALL.',
    value: existing?.library,
    validateInput: (v) => (isFilterLibrary(v) ? undefined : 'Enter a library name, or *LIBL, *CURLIB, *USRLIBL or *ALL.'),
  });
  if (library === undefined) {
    return undefined;
  }
  const object = await box(3, {
    prompt: 'Object: a name, a name ending in * (ASSET*), or *ALL.',
    value: existing?.object ?? '*ALL',
    validateInput: patternProblem,
  });
  if (object === undefined) {
    return undefined;
  }
  const type = await box(4, {
    prompt: 'Object type, such as *FILE or *PGM, or *ALL.',
    value: existing?.type ?? '*ALL',
    validateInput: (v) =>
      v.trim().toUpperCase() === '*ALL' || isObjectType(v) ? undefined : 'Enter an object type such as *FILE, or *ALL.',
  });
  if (type === undefined) {
    return undefined;
  }
  const attribute = await box(5, {
    prompt: 'Attribute, such as PF-SRC or RPGLE. Leave empty for any.',
    value: existing?.attribute ?? '',
  });
  if (attribute === undefined) {
    return undefined;
  }
  const f: FilterConfig = {
    name: name.trim(),
    library: library.trim().toUpperCase(),
    object: object.trim().toUpperCase(),
    type: type.trim().toUpperCase(),
  };
  if (attribute.trim() !== '') {
    f.attribute = attribute.trim().toUpperCase();
  }
  return f;
}

/** Registers Refresh, Properties and the filter commands; once per window. */
export function registerObjectCommands(
  provider: ObjectsProvider,
  store: ConnectionStore,
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
  const connectionOf = (n: ObjectsNode | undefined): string | undefined => {
    const name = n?.connection || provider.connection();
    if (!name) {
      void vscode.window.showInformationMessage('Connect first: objects belong to a session.');
    }
    return name;
  };
  const filtersOf = (name: string) => store.get(name)?.filters ?? [];

  return [
    vscode.workspace.registerTextDocumentContentProvider(PROPERTIES_SCHEME, new PropertiesProvider(sessions)),
    reg('code-for-qs400.objects.refresh', async (n) => {
      if (!n || n.kind === 'message') {
        await provider.refreshLibraryList();
      } else {
        provider.refresh(n);
      }
    }),
    reg('code-for-qs400.object.properties', async (n) => {
      if (n?.kind !== 'object') {
        return undefined;
      }
      const o = n.entry;
      const uri = propertiesUri(n.connection, o.library, o.object, o.type);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(doc, PROPERTIES_LANGUAGE);
      return vscode.window.showTextDocument(doc, { preview: true });
    }),
    reg('code-for-qs400.filter.add', async (n) => {
      const name = connectionOf(n);
      if (!name) {
        return undefined;
      }
      const filters = filtersOf(name);
      const f = await promptFilter(
        undefined,
        filters.map((x) => x.name),
      );
      if (f) {
        await store.setFilters(name, [...filters, f]);
      }
      return f;
    }),
    reg('code-for-qs400.filter.edit', async (n) => {
      if (n?.kind !== 'filter') {
        return undefined;
      }
      const filters = filtersOf(n.connection);
      const i = filters.findIndex((x) => sameName(x.name, n.filter.name));
      if (i < 0) {
        return undefined;
      }
      const f = await promptFilter(
        filters[i],
        filters.filter((_, j) => j !== i).map((x) => x.name),
      );
      if (f) {
        await store.setFilters(n.connection, filters.map((x, j) => (j === i ? f : x)));
      }
      return f;
    }),
    reg('code-for-qs400.filter.remove', async (n) => {
      if (n?.kind !== 'filter') {
        return undefined;
      }
      const filters = filtersOf(n.connection);
      await store.setFilters(
        n.connection,
        filters.filter((x) => !sameName(x.name, n.filter.name)),
      );
      return undefined;
    }),
  ];
}
