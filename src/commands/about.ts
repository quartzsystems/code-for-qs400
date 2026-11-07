// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

import * as vscode from 'vscode';
import { HostClient } from '../host/client';
import { HostVersionResult } from '../host/protocol';

export const PRODUCT_NAME = 'Code for QS/400';

/** Formats the About line. Every value after the product name is the host's. */
export function formatAbout(v: HostVersionResult): string {
  return `${PRODUCT_NAME} ${v.product} · host ${v.host} · QAP v${v.qap}`;
}

/**
 * `code-for-qs400.about`: asks the host for its version and shows it.
 * Returns the line shown, so callers (and tests) can read it.
 */
export async function about(host: HostClient): Promise<string | undefined> {
  try {
    const line = formatAbout(await host.request('host.version'));
    void vscode.window.showInformationMessage(line);
    return line;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`${PRODUCT_NAME}: could not reach the host: ${message}`);
    return undefined;
  }
}
