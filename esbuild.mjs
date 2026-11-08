// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

// Bundles src/ into one CommonJS file, dist/extension.js.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  // jsonc-parser's UMD build (its `main`) loads its parts with a require
  // esbuild cannot follow; its ES module build bundles whole.
  mainFields: ['module', 'main'],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'info',
});
