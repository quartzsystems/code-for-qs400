// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { sameName } from '../connections/config';
import { propertiesUri } from '../commands/objects';
import { CompileDiagnostic } from '../host/protocol';
import { IFS_SCHEME, ifsUri, parseIfsUri } from '../ifs/uri';
import { MEMBER_SCHEME, isReadonlyUri, memberUri, parseMemberUri } from '../members/uri';
import { firstToken, kindOf } from './model';
import { END_OF_LINE, PlacedIn, placeIn, placeRange, targetPlace } from './placement';
import { RunResult } from './run';
import { problemSeverity } from './severity';
import { ActionTarget, targetLabel } from './targets';

/** The Problems panel's collection of compile diagnostics. */
export const DIAGNOSTICS_NAME = 'code-for-qs400';

const SEVERITY: Record<ReturnType<typeof problemSeverity>, vscode.DiagnosticSeverity> = {
  information: vscode.DiagnosticSeverity.Information,
  warning: vscode.DiagnosticSeverity.Warning,
  error: vscode.DiagnosticSeverity.Error,
};

/** An open document of the member, writable before read-only. */
function openMember(connection: string, library: string, file: string, member: string): vscode.TextDocument | undefined {
  const docs = vscode.workspace.textDocuments.filter((d) => {
    const p = d.uri.scheme === MEMBER_SCHEME ? parseMemberUri(d.uri) : undefined;
    return p?.kind === 'member' && sameName(p.connection, connection) && p.library === library && p.file === file && p.member === member;
  });
  return docs.find((d) => !isReadonlyUri(d.uri)) ?? docs[0];
}

function openFile(connection: string, path: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => {
    const p = d.uri.scheme === IFS_SCHEME ? parseIfsUri(d.uri) : undefined;
    return p !== undefined && sameName(p.connection, connection) && p.path === path;
  });
}

/**
 * The document a diagnostic lands on, and the open document if there is
 * one. A member is the open document of it when there is one; else the
 * target opens writable, and any other member (a `/COPY` member) opens
 * read-only on click.
 */
export function placedUri(p: PlacedIn, t: ActionTarget, local?: LocalFor): { uri: vscode.Uri; doc?: vscode.TextDocument } {
  // A member or stream file deployed from a local file: the local file.
  const at = p.kind === 'member' ? { kind: 'member' as const, library: p.library, file: p.file, member: p.member } : p.kind === 'path' ? { kind: 'path' as const, path: p.path } : undefined;
  const mapped = at ? local?.(t.connection, at) : undefined;
  if (mapped) {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === mapped.toString());
    return { uri: doc?.uri ?? mapped, doc };
  }
  switch (p.kind) {
    case 'member': {
      const doc = openMember(t.connection, p.library, p.file, p.member);
      if (doc) {
        return { uri: doc.uri, doc };
      }
      const type = t.environment === 'member' ? t.type : '';
      return { uri: memberUri(t.connection, p.library, p.file, p.member, type, !p.target) };
    }
    case 'path': {
      const doc = openFile(t.connection, p.path);
      return { uri: doc?.uri ?? ifsUri(t.connection, p.path), doc };
    }
    case 'object':
      return { uri: propertiesUri(t.connection, p.library, p.object, p.type) };
  }
}

/** The local file a deployed member or stream file came from (Phase 8's deploy fills it); undefined for any other. */
export type LocalFor = (
  connection: string,
  at: { kind: 'member'; library: string; file: string; member: string } | { kind: 'path'; path: string },
) => vscode.Uri | undefined;

/** A compiler's diagnostic as the Problems panel shows it. */
export function toDiagnostic(d: CompileDiagnostic, uri: vscode.Uri, source: string, doc?: vscode.TextDocument): vscode.Diagnostic {
  const r = placeRange(d);
  let end = r.endCharacter;
  if (doc && r.endLine < doc.lineCount && (end === END_OF_LINE || end > doc.lineAt(r.endLine).text.length)) {
    end = Math.max(doc.lineAt(r.endLine).text.length, r.endLine === r.startLine ? r.startCharacter + 1 : 0);
  }
  const range = new vscode.Range(r.startLine, r.startCharacter, r.endLine, end);
  const out = new vscode.Diagnostic(range, d.text, SEVERITY[problemSeverity(d.severity)]);
  out.code = d.id;
  out.source = source;
  if (d.help.trim() !== '') {
    out.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(uri, range), d.help)];
  }
  return out;
}

interface Placed {
  uri: vscode.Uri;
  diagnostics: vscode.Diagnostic[];
}

/**
 * Compile diagnostics in the Problems panel. A compile replaces what the
 * last compile of the same target reported, on every document either one
 * reported on (its own, and `/COPY` members), and leaves every other
 * target's alone; a document can carry several targets' diagnostics. A
 * document that is closed keeps its diagnostics until the next compile or
 * **Clear Compile Diagnostics**. Commands, batch runs and cancelled
 * compiles change nothing.
 */
export class CompileDiagnostics implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection(DIAGNOSTICS_NAME);
  /** By target, then by document URI. */
  private readonly byTarget = new Map<string, Map<string, Placed>>();

  /** `local`: where a member or stream file a deploy wrote came from, so its diagnostics go on the local file. */
  constructor(private readonly local?: LocalFor) {}

  /** Takes a run's outcome; the documents whose diagnostics changed. */
  apply(r: RunResult): vscode.Uri[] {
    const o = r.outcome;
    if (!o || r.action.runAs === 'batch' || kindOf(r.command) !== 'compile' || o.status === 'Cancelled') {
      return [];
    }
    const t = r.target;
    const key = `${t.connection.toLowerCase()}|${targetLabel(t)}`;
    const source = firstToken(r.command);
    const next = new Map<string, Placed>();
    // The target is always reported on, so a clean compile clears it.
    const own = placedUri(targetPlace(t), t, this.local);
    next.set(own.uri.toString(), { uri: own.uri, diagnostics: [] });
    for (const d of o.diagnostics) {
      const { uri, doc } = placedUri(placeIn(d, t), t, this.local);
      const k = uri.toString();
      const entry = next.get(k) ?? { uri, diagnostics: [] };
      entry.diagnostics.push(toDiagnostic(d, uri, source, doc));
      next.set(k, entry);
    }
    const before = this.byTarget.get(key) ?? new Map<string, Placed>();
    this.byTarget.set(key, next);
    const touched = new Map<string, vscode.Uri>();
    for (const [k, p] of [...before, ...next]) {
      touched.set(k, p.uri);
    }
    for (const [k, uri] of touched) {
      this.collection.set(uri, this.union(k));
    }
    return [...touched.values()];
  }

  /** Every target's diagnostics on one document. */
  private union(uri: string): vscode.Diagnostic[] {
    const out: vscode.Diagnostic[] = [];
    for (const m of this.byTarget.values()) {
      out.push(...(m.get(uri)?.diagnostics ?? []));
    }
    return out;
  }

  clear(): void {
    this.byTarget.clear();
    this.collection.clear();
  }

  register(): vscode.Disposable[] {
    return [this, vscode.commands.registerCommand('code-for-qs400.diagnostics.clear', () => this.clear())];
  }

  dispose(): void {
    this.collection.dispose();
  }
}
