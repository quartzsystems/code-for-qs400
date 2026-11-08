// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * The language servers: one `qs400-code-host lsp <lang>` per language
 * per window, started when the first document of the language opens, on
 * `qs400mbr`, `qs400ifs` and local files alike. The servers' includes
 * come through `includes.ts`; saving a member or stream file, or a
 * session signing on again, tells every server its fetched copies may be
 * stale.
 */

import * as vscode from 'vscode';
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { IFS_SCHEME, parseIfsUri } from '../ifs/uri';
import { MEMBER_SCHEME, parseMemberUri } from '../members/uri';
import { type IncludeDeps, fetchInclude, listMembers } from './includes';
import {
  DIAGNOSTICS,
  FETCH_INCLUDE,
  INCLUDES_CHANGED,
  LIST_MEMBERS,
  type AnalyzedDiagnostic,
  type FetchIncludeParams,
  type IncludesChangedParams,
  type ListMembersParams,
} from './protocol';

/** Each language with a server, and the host's `lsp` argument for it. */
export const SERVERS: Readonly<Record<string, string>> = {
  'qs400-rpgle': 'rpgle',
};

/** The schemes a server's documents may be on. */
export const SCHEMES = [MEMBER_SCHEME, IFS_SCHEME, 'file'] as const;

export class LanguageServers implements vscode.Disposable {
  private readonly clients = new Map<string, Promise<LanguageClient>>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly binary: () => string,
    private readonly deps: IncludeDeps,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  /** Start servers for open documents and for each one that opens. */
  start(): void {
    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.opened(d)),
      vscode.workspace.onDidSaveTextDocument((d) => this.saved(d)),
    );
    for (const d of vscode.workspace.textDocuments) {
      this.opened(d);
    }
  }

  /** The client of `language`, started on first use. */
  client(language: string): Promise<LanguageClient> | undefined {
    const lang = SERVERS[language];
    if (!lang) {
      return undefined;
    }
    let c = this.clients.get(language);
    if (!c) {
      c = this.launch(language, lang);
      this.clients.set(language, c);
      c.catch((err) => {
        this.clients.delete(language);
        this.output.error(`${language} language server did not start: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return c;
  }

  /** `qs400/diagnostics` of a document: what `analyze` returned, or `null` while it is being analyzed. */
  async analyzed(doc: vscode.TextDocument): Promise<AnalyzedDiagnostic[] | null> {
    const c = await this.client(doc.languageId);
    if (!c) {
      return null;
    }
    return c.sendRequest<AnalyzedDiagnostic[] | null>(DIAGNOSTICS, { uri: doc.uri.toString() });
  }

  /** Tell every running server that `params` changed. */
  async includesChanged(params: IncludesChangedParams): Promise<void> {
    for (const c of this.clients.values()) {
      try {
        await (await c).sendNotification(INCLUDES_CHANGED, params);
      } catch {
        // A server that did not start has nothing cached.
      }
    }
  }

  private opened(d: vscode.TextDocument): void {
    if (SERVERS[d.languageId] && (SCHEMES as readonly string[]).includes(d.uri.scheme)) {
      void this.client(d.languageId);
    }
  }

  private saved(d: vscode.TextDocument): void {
    const m = parseMemberUri(d.uri);
    if (m?.kind === 'member') {
      void this.includesChanged({
        connection: this.deps.canonical(m.connection),
        member: { kind: 'member', library: m.library, file: m.file, member: m.member },
      });
      return;
    }
    const i = parseIfsUri(d.uri);
    if (i) {
      void this.includesChanged({ connection: this.deps.canonical(i.connection), member: { kind: 'path', path: i.path } });
    }
  }

  private async launch(language: string, lang: string): Promise<LanguageClient> {
    const command = this.binary();
    const server: ServerOptions = { command, args: ['lsp', lang], options: { env: process.env } };
    const options: LanguageClientOptions = {
      documentSelector: SCHEMES.map((scheme) => ({ scheme, language })),
      outputChannel: this.output,
    };
    const client = new LanguageClient(`code-for-qs400.${lang}`, `QS/400 ${lang.toUpperCase()}`, server, options);
    client.onRequest(FETCH_INCLUDE, (p: FetchIncludeParams) => fetchInclude(this.deps, p));
    client.onRequest(LIST_MEMBERS, (p: ListMembersParams) => listMembers(this.deps, p));
    this.output.info(`starting ${command} lsp ${lang}`);
    await client.start();
    return client;
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    for (const c of this.clients.values()) {
      void c.then((client) => client.stop()).catch(() => undefined);
    }
    this.clients.clear();
  }
}
