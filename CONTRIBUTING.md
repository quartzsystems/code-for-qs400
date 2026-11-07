# Contributing to Code for QS/400

The build plan is the authority for scope and phase order. This file covers
how the repository is laid out, how to build and test it, and what was
decided along the way.

## Layout

| Path | What it is |
| --- | --- |
| `package.json`, `src/` | Extension manifest and TypeScript sources, bundled by `esbuild.mjs` to `dist/extension.js` |
| `src/host/client.ts` | Spawns `qs400-code-host`, frames and correlates JSON-RPC, supervises the process |
| `src/host/protocol.ts` | Types for every host method and notification; keep in step with `host/crates/code-host/src/lib.rs` |
| `src/views/`, `src/commands/` | Tree views and commands |
| `syntaxes/`, `languages/` | Grammars and language configuration (Phase 5) |
| `schemas/actions.json` | Schema for `.vscode/actions.json` (Phase 4) |
| `media/` | Activity bar icon (placeholder until Phase 10) |
| `bin/` | Host binary for the current platform, copied in by `scripts/package.sh`; gitignored |
| `host/` | Cargo workspace: `crates/host-rpc` (framing, registry, error codes; no QS/400 knowledge) and `crates/code-host` (the `qs400-code-host` binary) |
| `test/` | Extension integration tests, run inside VS Code |
| `scripts/` | `check-naming.sh`, `package.sh`, `package.ps1` |
| `.github/workflows/ci.yml` | CI for Windows and Linux |
| `docs/` | User documentation |

## Prerequisites

- Rust via rustup. `host/rust-toolchain.toml` pins 1.98.0 with rustfmt,
  clippy and both targets; rustup installs it on first use.
- Node.js 22.13 or later, and npm.
- Linux only: `musl-tools` (the host links statically against musl, and
  `ring` needs `musl-gcc`).
- Windows: the MSVC build tools. The C runtime is linked statically
  (`host/.cargo/config.toml`), so the binary needs no redistributable.

## Build and test

```sh
# Host
cd host
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cd ..

# Extension: the tests spawn the real host from bin/, so put it there first
npm ci
npm run lint
scripts/package.sh --host-only      # or scripts\package.ps1 -HostOnly
npm test                            # on Linux without a display: xvfb-run -a npm test
```

`npm test` downloads VS Code 1.143.0 (the lowest version `engines.vscode`
allows) into `.vscode-test/` and runs `test/*.test.ts` in it.

## Package

```sh
scripts/package.sh       # Linux, or Git Bash on Windows
scripts\package.ps1      # Windows PowerShell
```

The script builds the host in release mode for the current platform
(`x86_64-pc-windows-msvc` or `x86_64-unknown-linux-musl`), empties `bin/`,
copies in that one binary, checks the VSIX file list, and runs
`vsce package --pre-release --target <win32-x64|linux-x64>`. The output is
`code-for-qs400-<target>.vsix`. There is no universal VSIX; each platform's
file is built on that platform (CI runs both).

## Rules

- **Naming.** `scripts/check-naming.sh` must pass. It checks every file,
  file name and commit message, case-insensitively, against the patterns
  in the script. If it fires, rename. Never add an exception. The names in
  use are QS/400, Quartz Systems, QAP, QS/400 Access and Navigator for
  QS/400.
- **Transport.** The extension never touches the network. Every remote
  operation is a host JSON-RPC method that the host turns into QAP.
- **Native UI.** Tree views, commands, status bar, output channels and the
  Problems panel. No webviews except where the plan names one.
- **Dependencies.** Crates from other Quartz repositories are git
  dependencies pinned by commit, never copied in.
- **License header.** Every source file starts with:

  ```
  // Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
  // licensed under the terms of the MIT license which can be found in the
  // root directory of this project.
  ```

  Use `#` comments in shell, PowerShell, TOML and YAML files. JSON files
  cannot carry comments and go without.
- **Ids.** Settings are `code-for-qs400.*`; commands are
  `code-for-qs400.<area>.<verb>`.
- **Commits.** One-line conventional messages (`feat(host): ...`), one per
  section of work.

## Adding a host method

1. Add the params/result types and register the handler in
   `host/crates/code-host/src/lib.rs`, with a test.
2. Add the method to `HostMethods` in `src/host/protocol.ts`. The client's
   `request()` is typed from that map.

## Decisions made in Phase 0

1. **`engines.vscode` is `^1.143.0`.** VS Code stable on 2026-11-07 was
   1.145.2; two minors back is 1.143. `@types/vscode` has no 1.143 release,
   so it is pinned to 1.140.0: types may be older than the engine, never
   newer.
2. **Method names are `host.version`, `host.ping`, `host.shutdown`**, as the
   Phase 0 prompt specifies, rather than the plan's `host/<area>.<verb>`
   notation.
3. **Activation events are the three the prompt lists.** The plan's
   `onLanguage` events wait for Phase 5, when the languages exist.
4. **The host starts lazily**, on the first request (About in Phase 0).
   Opening the Connections view does not start it, because nothing in the
   view needs it yet.
5. **Logging.** The host writes every log line to stderr as
   `[info|warn|error] message` and also sends `host.log`. The output channel
   shows the stderr lines at their level. `host.log` fires an extension
   event and is not written again, so nothing appears twice. Stderr lines
   without a prefix (a panic, say) are shown as errors.
6. **No JSON-RPC batches.** A JSON array is answered with `-32600 Invalid
   Request`. Requests are handled one at a time, in order.
7. **Timeouts.** A request fails after 30 s without a reply. Stop and
   restart send `host.shutdown`, wait 2 s for the process to exit, then kill
   it.
8. **Tests use `@vscode/test-cli` on top of `@vscode/test-electron`**, mocha
   `tdd` UI, against VS Code 1.143.0. `activate()` returns `{ host }`, so the
   tests can kill the process and read its pid. The About command returns
   the line it shows. mocha is 11.x because `@vscode/test-cli` 0.0.15
   requires it, and ESLint is 9.x with typescript-eslint 8, which supports
   TypeScript up to 6.0. TypeScript is pinned to 5.9.
9. **Static C runtime on Windows** (`+crt-static`). musl builds are static
   anyway (static-pie).
10. **Rust 1.98.0, edition 2024**, the minimum `qap-client` declares.
11. **`qap-client` is pinned to `quartz-systems-access` commit
    `1afe1b41bd1a02af1276d81e64885054e8c54d6e`** (main on 2026-11-07,
    Access 1.1.0). That commit in turn pins `quartz-systems-400` at
    `93c6350f69e4327163bc1357284785e5490388c0`. It builds for both targets.
    The host reports `qap: 1` as Phase 0 specifies, although the pinned
    Access tree already tests QAP versions 1 and 2 as fallbacks to a newer
    one. Phase 1 should settle which version the host advertises.
12. **VSIX file names** are `code-for-qs400-<target>.vsix`, the same as the
    CI artifact names, with no version in the file name.
13. **`package.sh --host-only`** (`package.ps1 -HostOnly`) builds the host
    and copies it into `bin/` without packaging. CI uses it before
    `npm test`. Before packaging, the script also fails if `vsce ls` shows
    sources, tests or anything other than the one host binary.
14. **`.vscodeignore` denies everything and allows named files**, with
    explicit globs (`syntaxes/*.json`, not `syntaxes/**`), because vsce
    applies `!` patterns after all ignores and would otherwise ship the
    `.gitkeep` placeholders.
15. **Naming check details.**
    - Each pattern in the script has one letter in brackets
      (`i[b]m`), so the script does not match itself without needing an
      exception.
    - It lists files with `git ls-files --cached --others
      --exclude-standard`, which is every file git would see. That covers
      `.git/`, `node_modules/` and `target/`, plus other ignored build
      output such as `.vscode-test/`, which holds a full VS Code
      download. Outside a git checkout it falls back to a plain walk that
      skips only those three directories.
    - Binary files are skipped.
    - Subresource-integrity hashes (`sha512-<base64>`) are blanked before
      matching. `package-lock.json` carries hundreds of them, six matched
      by chance, `npm ci` needs the lockfile, and random base64 cannot be
      renamed. Everything else on those lines is still checked.
    - File names and commit messages are checked too, so CI checks out
      with full history.
16. **Line endings.** `.gitattributes` forces LF, so the shell scripts run on
    Linux CI from a Windows checkout with `core.autocrlf`. `.ps1` files are
    CRLF.
17. **LICENSE was already in the repository** (MIT, from the initial
    commit), so it was left as it is instead of being emptied.
18. **`code-for-qs400.host.path` has machine scope**, so a workspace cannot
    point the extension at an arbitrary executable.
19. **The status bar item** has a warning background, appears only while the
    host is stopped unexpectedly, and runs Restart Host when clicked.
20. **Files beyond the specified layout:** `eslint.config.mjs`,
    `.vscode-test.mjs`, `.gitattributes`, `.gitignore`,
    `host/.cargo/config.toml`, `scripts/package.ps1`, `media/qs400.svg`,
    and `.gitkeep` files in `bin/`, `syntaxes/` and `languages/`.
21. **The Linux VSIX was built locally in Docker** (`rust:1.98-bookworm`
    with `musl-tools` and Node 22), running the same `scripts/package.sh`.
    The Windows VSIX was built natively.

## Phase 0 exit test

> VSIX installs on Windows and Linux; About shows `V1R0M0` from the host.

**Windows x64: passed, 2026-11-07.** Windows 11 (10.0.26100), with VS Code
1.143.0 downloaded by `@vscode/test-electron` and a fresh, empty
`--user-data-dir` and `--extensions-dir`:

1. `code --install-extension code-for-qs400-win32-x64.vsix`: "Extension
   'code-for-qs400-win32-x64.vsix' was successfully installed."
2. In that clean instance, `code-for-qs400.about` was run against the
   installed extension (not the development checkout). It showed and
   returned `Code for QS/400 V1R0M0 · host 1.0.0 · QAP v1`. The host ran
   from the installed extension's `bin\qs400-code-host.exe`.

The first attempt failed with "command 'code-for-qs400.about' not found".
Two more runs on clean profiles passed, the last with brand-new directories
and the extension present at once. The failure did not happen again.

**Linux x64: not yet run by hand.** `code-for-qs400-linux-x64.vsix` was
built (static-pie musl host), and CI runs the same About round-trip test on
`ubuntu-latest`. Installing the VSIX on a Linux desktop is still to do.
