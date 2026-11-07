// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

// Integration tests run inside VS Code via @vscode/test-electron, driven by
// @vscode/test-cli. The version is the lowest one engines.vscode allows.
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: '1.143.0',
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'tdd', timeout: 60000 },
});
