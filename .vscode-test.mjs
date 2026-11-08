// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

// Integration tests run inside VS Code via @vscode/test-electron, driven by
// @vscode/test-cli. The version is the lowest one engines.vscode allows.
import { defineConfig } from '@vscode/test-cli';

// A run started from a terminal inside a portable VS Code inherits
// VSCODE_PORTABLE, which makes the test instance use that installation's
// own user data (its settings.json) instead of .vscode-test/user-data, and
// the tests write `code-for-qs400.connections` there. The test instance
// must only ever see its own profile.
delete process.env.VSCODE_PORTABLE;

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: '1.143.0',
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'tdd', timeout: 60000 },
});
