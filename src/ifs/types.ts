// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * How a stream file opens: as bytes for VS Code's own viewers, or as text
 * the server converts to UTF-8; and the language of a source stream file,
 * from Phase 2's member type table. No `vscode` import.
 */

import { memberType, typeForExtension } from '../members/types';
import { baseName } from './paths';

/** The most bytes a document holds: 10 MiB, text (file bytes) and binary alike. */
export const DOCUMENT_LIMIT = 10 * 1024 * 1024;

/**
 * Extensions read as bytes, never converted: images VS Code previews, and
 * known binary formats (PDF, archives, save files, Java classes, shared
 * and static libraries).
 */
export const BINARY_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'webp',
  'pdf',
  'zip',
  'savf',
  'jar',
  'class',
  'so',
  'a',
];

/** The extension of a path's last component, lower case, without the dot; empty for none (and for `.profile`). */
export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Whether a path is read and written as bytes. */
export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.includes(extensionOf(path));
}

/**
 * The `qs400-*` language a source stream file gets: the one its extension
 * maps to in the member type table (`.rpgle`, `.sqlrpgle`, `.clle`, `.pf`,
 * `.dspf`, `.sql`, `.cmd` …). Other extensions are left to VS Code.
 */
export function languageForPath(path: string): string | undefined {
  const ext = extensionOf(path);
  if (ext === '') {
    return undefined;
  }
  const language = memberType(typeForExtension(ext)).language;
  return language.startsWith('qs400-') ? language : undefined;
}
