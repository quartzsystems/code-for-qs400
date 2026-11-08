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
| `src/connections/` | The connections setting (`config.ts`, no `vscode` import), store and secrets, prompts, the session manager, the library list |
| `src/objects/filters.ts` | Object filters, generic names and object types (no `vscode` import) |
| `src/members/` | `types.ts` (the one source type → extension and language table), `uri.ts` (`qs400mbr` URIs), `provider.ts` (the file system provider, locks, the cache), `diff.ts` (the save diff; no `vscode` import) |
| `src/ifs/` | `paths.ts` (paths, sorting, roots), `types.ts` (the binary table and languages), `tree.ts` (the delete and copy walks; none of the three imports `vscode`), `uri.ts` (`qs400ifs` URIs), `provider.ts` (the file system provider), `transfers.ts` (uploads and downloads) |
| `src/views/`, `src/commands/` | The Connections, Objects and IFS trees, the status bar item and commands |
| `src/actions/` | `model.ts` (the action fields, merge order, matching and the compile list), `variables.ts`, `targets.ts` (each variable's value per target), `output.ts` (the output channel's block), `placement.ts` and `severity.ts` (where a diagnostic goes, the one severity table); none of these imports `vscode`. `store.ts` (the three layers, the check on save), `run.ts` (**Run Action…**), `diagnostics.ts` (the Problems panel) |
| `src/jobs/` | `model.ts` (the Jobs view's groups, descriptions, qualified names, End's choices, the log's glyphs; no `vscode` import), `jobLog.ts` (the Job log document, its hover and gutter) |
| `src/spool/` | `model.ts` (statuses, labels, the listing's name and match) and `layout.ts` (the viewer's page markers), neither importing `vscode`; `viewer.ts` (the `qs400spl` viewer) |
| `src/messages/model.ts` | The Messages view's order, descriptions, answered keys and the notify rule (no `vscode` import) |
| `src/languages/` | `client.ts` (one language client per language, the include notifications), `includes.ts` (`qs400/fetchInclude` and `qs400/listMembers` through the host), `protocol.ts` (keep in step with `host/crates/lsp-common/src/protocol.rs`), `rpgColumns.ts` (the fixed-form columns; no `vscode` import), `fixedForm.ts` (the guides and the column in the status bar) |
| `src/projects/` | `config.ts` (`qs400project.json` and the ignore globs), `layout.ts` (the `sourceFiles` layout, names and types both ways, the hash), `state.ts` (`.qs400/state.json` and each file's state), `model.ts` (the Project view's rows), none of which imports `vscode`; `store.ts` (the projects, validation, state on disk, the generator), `ui.ts` (the questions), `pull.ts`, `deploy.ts`, `git.ts` (the git extension's changes), `local.ts` (actions on local files), `includes.ts` (includes from the workspace), `commands.ts` |
| `src/views/project.ts` | The Project tree, its commands and status bar item |
| `src/debug/` | The `qs400` debugger: `config.ts` (the configuration, the CALL's quoting, the defaults, `DBGVIEW(*SOURCE)` forced; no `vscode` import), `debugging.ts` (the provider, the adapter factory, the `qs400/debugSource` answer, the tracker), `adapter.ts` (the adapter process, inline, with the sign-on put into `launch`), `source.ts` (where a module's source is), `statements.ts` (the `qs400dbg` document), `programs.ts`, `commands.ts` (the debug commands, Attach to Job…, the recompile), `statusBar.ts` |
| `src/sql/` | `statements.ts` (the split and the statement under the cursor), `format.ts` (labels), `generate.ts` (the SQL the tree writes), none of which imports `vscode`; `resultsHtml.ts` (the results page; no `vscode` import), `session.ts` (each document's connection, the options, the status bar, Commit, Rollback, the disconnect question), `run.ts` (**Run Statement**, the Problems panel), `results.ts` (the **SQL results** panel), `export.ts` (Export CSV), `history.ts` |
| `src/views/sql.ts` | The SQL tree and its commands |
| `src/views/jobs.ts`, `spool.ts`, `messages.ts` | The Jobs, Spooled files and Messages trees, their watches, badges and commands |
| `syntaxes/`, `languages/` | The five TextMate grammars and language configurations |
| `schemas/actions.json`, `defaults/actions.json` | The schema of `.vscode/actions.json`, and the default actions shipped |
| `schemas/qs400project.json` | The schema of a project's `qs400project.json` |
| `media/` | Activity bar icon (placeholder until Phase 10) |
| `bin/` | Host binary for the current platform, copied in by `scripts/package.sh`; gitignored |
| `host/` | Cargo workspace: `crates/host-rpc` (framing, registry, error codes; no QS/400 knowledge) and `crates/code-host` (the `qs400-code-host` binary) |
| `host/crates/code-host/src/session.rs` | Sessions: one per connection name, the state machine, `session.*` and `libl.*`, and `DevelopBackend` |
| `host/crates/code-host/src/objects.rs`, `members.rs` | `object.*` and `member.*`, thin over `qap-client`'s `Develop`; `members::codec` is the one place `seq` and `date` convert |
| `host/crates/code-host/src/ifs.rs` | `ifs.*`, thin over `qap-client`'s `Files`, `read` and `write`; the transfers and their threads |
| `host/crates/code-host/src/actions.rs`, `jobs.rs` | `action.*` over `Command` and `Develop::compile`, each run on a thread of its own; `job.log` and `jobs.*` over `Jobs` |
| `host/crates/code-host/src/spool.rs`, `messages.rs`, `watches.rs`, `codec.rs` | `spool.*` and `messages.*` over `Client`'s `Spool` and `Messages` through `WorkBackend`; the watches the extension and the one-shot waits hold, and their events as notifications; `codec.rs` the one place keys, job names, queues and enum names convert |
| `host/crates/code-host/src/deploy.rs` | `deploy.member` and `deploy.path`: the existing `member.*` and `ifs.*` calls in sequence behind a `Steps` trait, and `deploy::plan`, the save diff's rules in Rust |
| `host/crates/code-host/src/sql/` | `sql.*` over one `SqlConnection` per session and the `Sql` catalog; `values.rs` is the one place a `SqlValue` becomes JSON or CSV text, `csv.rs` the CSV writer |
| `host/crates/dap` | `qs400-code-host dap`: the Debug Adapter Protocol (`protocol.rs`, hand-written types) over `backend::DebugBackend` (the `Debug` service as an object-safe trait), the adapter itself in `adapter.rs`; `code-host`'s `src/debug.rs` is its `qap-client` connection |
| `host/crates/lsp-common` | What the language servers share: the loop (`server.rs`), positions (`position.rs`), the URI's source (`uri.rs`), the include cache (`includes.rs`), the features (`features.rs`), the custom messages (`protocol.rs`) and a test client (`testing.rs`) |
| `host/crates/lsp-rpgle`, `lsp-cl`, `lsp-dds`, `lsp-sql`, `lsp-cmd` | One `Language` each over its front end's `analyze`: options, folding, completion words |
| `host/crates/severity` | `severity.json`, the one severity table, read by the servers and by `src/actions/severity.ts` |
| `host/fixtures/parity/` | Recorded compiles for the offline parity test; the members' text is gitignored |
| `test/` | Extension tests, run inside VS Code; `live.test.ts` and `parity.test.ts` against a real system; `grammar/` the grammar samples and their snapshots |
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
allows) into `.vscode-test/` and runs `test/*.test.ts` in it. Before that,
`pretest` runs `npm run test:grammar`, the grammar snapshot tests
(`vscode-tmgrammar-snap` over `test/grammar/`); after changing a grammar,
run `npx vscode-tmgrammar-snap -u` on the samples it affects and read the
snapshot's diff before committing it.

### Language server tests

Each `lsp-<lang>` crate's `tests/` drives its server over an in-memory
connection with `lsp_common::testing::Client`, which answers
`qs400/fetchInclude` and `qs400/listMembers` from closures. The front ends'
behaviour is asserted as it is at the pinned commit; when a pin moves,
those expectations move with it. `cargo test -p code-host --test parity`
compares the recorded compiles in `host/fixtures/parity/` (see its
README); with none recorded it passes and says so.

### Session tests

`qap-client` has no transport trait: `Client` opens its own connection
from a `Target`. So `session.rs` puts a small `Backend` trait of its own in
front of `Client` (`QapBackend` is one `qap-client` call per method), and
`host/crates/code-host/tests/session.rs` tests the state machine at the
method-registry level with a fake backend and canned replies:
`Registry::dispatch` one call at a time, reading the `session.changed`
notifications back. The canned refusals use the IDs and texts QS/400's
sign-on sends. One test drives the real `qap-client` against a closed
port. `host_rpc::Context::new` exists so these tests can act between
calls.

`host/crates/code-host/tests/develop.rs` does the same for `object.*` and
`member.*`: a fake `DevelopBackend` serves canned `qap-client` replies and
refusals (`CPF1002`, `TCP1A5A`, `TCP1A61`, `CPF9801`, `CPF7306`,
`TCP1A62`), which must come back unchanged with their second-level text.

`host/crates/code-host/tests/ifs.rs` does it for `ifs.*` one level lower:
the fake implements `qap-client`'s `Files` itself, and `ifs_request` goes
over a real `qap_client::Connection` on an in-memory transport, so
`qap-client`'s paging, stamps, chunked reads and writes run unchanged
against a canned server (Phase 3 decision 19).

`host/crates/code-host/tests/actions.rs` does it for `action.*` and
`job.log` the same way: the fake implements `qap-client`'s `Requests` over
a real `Connection` on an in-memory transport, whose canned server can
hold a request in the lane until it is cancelled. The canned messages use
QS/400's own IDs and texts (`RNF7030`, `RNS9304`, `RNS9310`, `CPF9812`,
`CPD0030`, `CPF1321`).

`host/crates/code-host/tests/work.rs` does it for `jobs.*`, `spool.*` and
`messages.*` with a fake `WorkBackend` (`tests/common/mod.rs`) whose
spooled-file reads and actions go over a real `Connection` on an in-memory
transport, and checks `spool.changed` and `messages.arrived` against the
events the fake hands the watcher (Phase 7 decision 17). The canned
messages use QS/400's IDs and texts (`CPF1321`, `CPF1343`, `CPF1362`,
`CPF2204`, `CPF2403`, `CPF2422`, `CPF3337`, `CPF9802`, `TCP1A56`,
`TCP1A57`).

`host/crates/code-host/tests/sql.rs` does it for `sql.*`. `qap-client`'s
`SqlConnection` needs an `Attached`, which opens a TCP connection of its
own, so the host reaches it through the object-safe `sql::SqlConn` (each
method the one of the same name). The fake sends every statement request
over a real `qap_client::Connection` on an in-memory transport and reads
the replies with `qap-client`'s own `ExecuteOutcome` and `FetchOutcome`,
so `SqlError`, `Cancelled` and `end` come back as shipped. The canned
messages use QS/400's IDs and texts (`SQL0104`, `SQL0551`, `SQL0752`,
`SQL0803`, `SQL0952`). The same file tests `sql::values` and `sql::csv` at
their edges.

### Debug adapter tests

`host/crates/dap/tests/` drive `dap::serve` over in-memory pipes with a
DAP client (`tests/common/mod.rs`) and a canned `DebugBackend` that
records every `Debug` call and sends the events a test asks for. The
client answers `qs400/debugSource` as the extension would, from a table.
`adapter.rs` covers launch, events and the stack; `stepping.rs`
breakpoints, sources, stepping and terminate; `inspect.rs` scopes,
variables, evaluate, the `setVariable` probe both ways and events while a
`Stack` waits; `modes.rs` attach and service entry. The canned refusals
use the IDs `docs/QAP.md` at `7f82a43f` names (`CPF9C15`, `TCP1A72`,
`CPF3501`, `CPF3502`, `CPF3503`, `CPF3520`, `CPF9C59`, `CPD9CCC`,
`CPF7E12`, `TCP1A75`). `code-host`'s `tests/process.rs` runs the real
`qs400-code-host dap` through `initialize`, a launch that cannot connect,
and `disconnect`.

### Live tests

`test/live.test.ts` runs the automatic steps of the Phase 1, 2, 3, 4, 6, 7,
8 and 9 exit tests against a real system. Phase 9 compiles `ASSETS` (with
`DBGVIEW(*SOURCE)`) and `NODEBUG` (with `DBGVIEW(*NONE)`) from
`QS400_PROJECT_SOURCE/QRPGLESRC(ASSETS)` into `QS400_PROJECT_LIBRARY`,
debugs them through the real adapter, and deletes the library; it needs a
server at QAP version 9. Phase 8 makes the library
`QS400_PROJECT_LIBRARY` with `CRTLIB`, pulls `QS400_PROJECT_SOURCE` into a
temporary folder, deploys, compiles and makes a conflict there, and
deletes the library with `DLTLIB`; its git steps need `git` on `PATH`. Phase 7 compiles its own member
`QS4SPL7` in `QS400_TEST_SRCPF` (the program stays in the current
library), submits `CODETEST` and ends it, and sends itself an inquiry and
a message, which it removes. Phase 6 makes and drops the table
`HLINV.QS4SQL6`; `HLINV` must be journaled for its commit level step. Phase 3 makes and removes
`/home/<QS400_TEST_USER>/code-test`. Phase 4 makes and removes the member
`QS4ACT42` in `QS400_TEST_SRCPF`, compiles it into `QS400_TEST_CURLIB`
(the program stays there) and calls the program `QS400_TEST_SOURCE`
names. It is skipped unless these are set:

| Variable | Meaning |
| --- | --- |
| `QS400_TEST_HOST`, `QS400_TEST_USER`, `QS400_TEST_PASSWORD` | Required. |
| `QS400_TEST_PORT` | QAP port, when not the default. |
| `QS400_TEST_CA_FILE` | PEM file to trust (CI writes `QS400_TEST_CA_PEM` to one). |
| `QS400_TEST_LIBRARY` | Library to add and move to the top. Default `QGPL`. |
| `QS400_TEST_CURLIB` | Library to set as current; Phase 4 compiles into it. Default the user profile. |
| `QS400_TEST_SRCPF` | Source file Phase 2 makes and removes its `QS4*` members in. Default `HLINV/QTMPSRC`; it must exist. |
| `QS400_TEST_SOURCE` | Member Phase 2 copies (and only reads). Default `HLINV/QRPGLESRC(ASSETS)`. |
| `QS400_PROJECT_SOURCE` | Library Phase 8 pulls (and only reads). Default `HLINV`. |
| `QS400_PROJECT_LIBRARY` | Scratch library Phase 8 creates, deploys to and deletes. Default `HLINVDEV`; anything in it is lost. |

In CI the last two are repository variables, not secrets.

`test/parity.test.ts` runs the automatic steps of the Phase 5 exit test
with the same three required variables. It opens every member of the four
source files read-only, runs each one's default compile (the objects stay
in `QS400_TEST_CURLIB`), and prints a table of every difference. Two more
variables apply to it:

| Variable | Meaning |
| --- | --- |
| `QS400_PARITY_LIBRARY` | Library whose source files are compared. Default `HLINV`. |
| `QS400_PARITY_RECORD` | `1` writes each compile, and the members' text, to `host/fixtures/parity/`. |

`QS400_PARITY_SRC`, for the offline Rust test, names a folder of members
laid out as `<FILE>/<MEMBER>.<ext>` when their text is not beside the
records.

It never signs on with a wrong password, so it cannot count against
`QMAXSIGN`. When the server has no `library_list` service, the library list
step is skipped and says so. In CI the `live tests` job runs only when the
repository secrets of the same names exist; otherwise it is green and its
summary says "live tests skipped". The runner must be able to reach the
system's QAP port.

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
   `host/crates/code-host/src/lib.rs` (or the area's module, as
   `session.rs`), with a test.
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

## Decisions made in Phase 1

1. **`library_list` is not in the pinned `qap-client`.** At
   `quartz-systems-access` `1afe1b4` (with `qap-proto` from
   `quartz-systems-400` `93c6350`) QAP has 49 operations in the services
   Connection, SignOn, System, Command, Spool, Sql, Ifs and Messages, and
   none for a library list. `libl.get` and `libl.set` take the plan's
   proposed shape (the user part and the current library), check their
   params, bring the session back if it went stale, and then answer
   `-32001 "library_list not available on this server"`. Both, and the
   request they would send, are marked `// QAP v2: library_list`. Nothing
   emulates the service with remote commands.
2. **`session.changePassword` is a seventh session method.** `qap-client`
   has `Client::change_password`, so an expired password gets a **Change
   password** button. After `PasswordExpired` the host keeps the connection
   open for the change, as `qap-client` expects.
3. **`session.connect` takes an optional password.** Without one it
   resumes the stale session of the same name, endpoint and user, as the
   first call after a drop would, or answers `needs_password`. Connect on a
   stale connection uses it, so it keeps the session job instead of signing
   on again.
4. **Error codes.** `-32001` library list unavailable, `-32002` not
   connected, `-32003` `needs_password`, `-32010` a server refusal,
   `-32011` transport (name lookup, TCP, TLS, closed connection, no reply).
   A refusal's `message` is `qap-client`'s own text, which for a server
   message is `messageId: text`; `data` is
   `{ status, messageId, text, secondLevel? }` as QAP returned them.
   `needs_password` carries the same `data` when the server refused the
   kept password. Severity and substitution data are not passed on.
5. **TLS is QS/400 Access's.** `qsa-net` has no switch to skip
   verification, so `tls.verify: false` is refused with `-32602`, and the
   setting's description says so. `tls.caFile` is read into
   `qsa_net::Trust` as Access reads its CA list's files. An untrusted
   certificate is a `-32011` error with `data: { kind: "untrusted", reason }`;
   there is no "trust this certificate" flow yet.
6. **The host reports QAP v6**, the newest version `qap-client` offers in
   `Hello` (`qap_client::proto::VERSION`), which settles Phase 0 decision
   11. About shows `QAP v6`; each session's `system.qap` is the version its
   server agreed.
7. **Status fields beyond the method table:** `user` (the signed-on
   profile), `system.name`, `system.model` and `system.qap`.
   `system.product` is the first product `SystemInfo` lists (`QS00SS1`).
   `job` is left out for a server older than QAP 4, which has no `JobInfo`.
8. **Noticing the idle close.** A watcher thread looks at every session
   when `qap-client` calls the target's `wake` (on a close or an event) and
   every 5 s. It only looks: `connected` with a closed connection becomes
   `stale` and is sent as `session.changed`. It never reconnects, and it
   skips a session a request is using.
9. **Signing on again.** The host keeps the password as a `qap-client`
   `Secret` in memory only. When the server refuses it on a re-sign-on, the
   host forgets it and answers `needs_password`; it never tries it twice,
   so it never counts against `QMAXSIGN` twice. The extension, likewise,
   deletes a saved password the server refuses, prompts once however many
   calls are waiting, and repeats each waiting call once.
10. **Disconnect** signs off only when the connection is open. A stale
    session is left to the server's idle timeout rather than reconnecting
    just to end it.
11. **Settings.** `code-for-qs400.connections` has `application` scope, so
    a workspace cannot add a connection that asks for a password. Names
    compare without case. Users are upper-cased. An entry that does not
    parse is skipped and reported in the host output channel, and writes
    replace only the named entry, so such an entry is kept as written.
12. **Set as Default Connection** writes `code-for-qs400.defaultConnection`
    (also `application` scope). The default is offered first when a
    command asks for a connection and is marked in the tree's tooltip.
13. **Switch Active Connection** (`code-for-qs400.connection.switchActive`)
    is an eighth connection command, for the status bar click. The active
    connection is kept in workspace state under
    `code-for-qs400.activeConnection`; Disconnect moves it to another
    signed-on connection when there is one.
14. **Add and Edit ask five boxes:** name, host, port, user, CA file.
    `tls.verify` is not asked, since only `true` works.
15. **The status bar item** shows the active connection when it is signed
    on, else the first signed-on one, else nothing. It is separate from the
    host-stopped warning item.
16. **Library list node.** The system part is not shown. **Set as Current
    Library** takes the library out of the user part. **Add** puts the
    library at the end of the user part. The saved list is applied each
    time a session gets a new job (connect, or signing on again after the
    server ended the session), and saved only after the server took an
    edit.
17. **`qsa-net` is a direct dependency** at the same commit as
    `qap-client`, for `Trust` and for its log sink. `qap-client`'s log lines
    at info and above go to `host.log`; it never logs a password, a token
    or a body.
18. **`host_rpc::Context::new` is public**, so tests can call
    `Registry::dispatch` and act between calls.

Decisions 1 and 6 are superseded by Phase 2 decisions 1 and 2.

## Decisions made in Phase 2

1. **`qap-client` is pinned to `quartz-systems-access` `90d9bba`**
   (`90d9bba2a0f84d88e749e15cf8ed974540c905eb`, main on 2026-11-07), with
   `qsa-net` at the same commit. It pins `qap-proto` at `quartz-systems-400`
   `7f82a43f`, the commit whose `docs/QAP.md` is this phase's spec. Every
   connection asks for QAP version 9 (`Target::with_max_version`), the
   newest `qap-proto` defines, so `host.version`, `--version` and About now
   say `QAP v9`; each session's `system.qap` is still the version its
   server agreed.
2. **`libl.*` call `get_library_list` and `set_library_list`.** The
   Phase 1 stubs are gone. The shape is the one Phase 1 proposed, which
   matches the spec's `LibraryList` and `SetLibraryList`; `current` null
   is `CURLIB(*CRTDFT)` and an empty `user` is `LIBL(*NONE)`.
3. **`-32001` now means "QAP version 8 not available on this server"**,
   for `libl.*`, `object.*` and `member.*` alike, with
   `data: { version }`, the version agreed. The host checks the agreed
   version before sending anything, and `qap-client`'s own `Unsupported`
   refusal maps to the same error. In the extension the code is
   `SessionErrorCodes.QapUnavailable`.
4. **`Develop` behind a trait object.** `qap_client::Develop`'s methods are
   generic over `Requests`, so they cannot be called through
   `Box<dyn Backend>`. `session::DevelopBackend` is the same operations as
   an object-safe trait, implemented for every `Requests` type by calling
   `qap_client::Develop`, and reached with `Backend::develop`. Tests
   implement it with canned replies. `Sessions::develop` brings a stale
   session back, checks the version, makes the call and reports a drop
   the call met; it adds no ordering (the host already answers one request
   at a time, Phase 0 decision 6).
5. **Where `qap-client`'s types and the prompt's method shapes differ, the
   prompt's JSON shapes were followed** and the host renames at the JSON
   layer: `Library.name` is `library`, `ObjectEntry.name` is `object`,
   `MemberEntry.name` and `srctype` are `member` and `type`,
   `MemberData.srctype` is `type`, `SourceRecord.data` is `text`. The types
   the prompt left open follow the spec: `changed` and `created` are QAP's
   i64 milliseconds since 1970 as JSON numbers, `size` is bytes. Error
   `data` keeps Phase 1's `status` beside `messageId`, `text` and
   `secondLevel`.
6. **Names and patterns are passed as typed.** The host trims `library`,
   `file`, `member`, `object` and `type` and refuses an empty one with
   `-32602`; it checks no name syntax and folds no case (the server
   does). An absent `pattern` is sent empty, which the spec defines as
   `*ALL`. `seq` must be one to four digits, a point and two digits;
   `date` six digits; anything else is `-32602` before anything is sent.
7. **Paging** asks for pages of 500 from `start` 0 until the entries reach
   `total`, or a page comes back empty (the list shrank while it was read).
8. **Objects view roots are the current library and the user part**, the
   same libraries the Library list node shows (Phase 1 decision 16); the
   system part is not shown. The list comes from the Library list node's
   controller, which reads it once per session job; Refresh on the view's
   title bar reads it again. A session whose `system.qap` is below 8 gets
   the one line without a call; the host's `-32001` gives the same line.
9. **Properties** is a `TextDocumentContentProvider` on the `qs400obj`
   scheme, read-only by being one. The document's path is
   `/<LIB>/<OBJ> (<TYPE>)`; VS Code shows the last segment on the tab, so
   the tab reads `ASSETS (*PGM)` with `HLINV` beside it, a constraint of
   the editor. The Courier style is a language of its own,
   `qs400-properties`, with `editor.fontFamily` set through
   `configurationDefaults`.
10. **Filter values are upper-cased** when entered through the input
    boxes, and `library` may be `*LIBL`, `*CURLIB`, `*USRLIBL` or `*ALL`,
    which `ListObjects` accepts. A filter whose fields do not parse is
    skipped and reported in the host output channel, like a connection.
11. **The first `stat` of a member reads it.** VS Code takes an editor's
    read-only state from `stat`, before `readFile`, so the lock attempt
    (and the `CPF1002` fallback to `lock: false`) happens there. The cache
    is per URI string.
12. **Open Read-Only uses the same URI with the query `readonly`**: it never
    locks, `stat` reports it read-only, and Compare opens both sides that
    way so comparing holds nothing. It is a separate document from the
    writable one.
13. **The language is set when the document opens**
    (`setTextDocumentLanguage`, from the type the server sent, else from
    the extension). The languages register no file extensions, so local
    `.cmd`, `.cl` or `.pf` files are left to whatever claims them; Phase 5
    decides. A member with no source type gets the extension `mbr`.
14. **Unlock follows tabs**, `window.tabGroups.onDidChangeTabs`: when no
    tab (text or diff) shows the URI any more, `member.unlock`. Document
    close events are not used, because setting a document's language
    closes and reopens it.
15. **The URI's connection is matched without case.** `Uri.toString`
    lower-cases the authority, so a restored editor may name `qshq400`;
    the provider maps it to the saved connection's name, as everywhere
    else (Phase 1 decision 11).
16. **The save diff.** Common prefix and suffix are trimmed, then a
    standard LCS table over the middle (over 8 million cells, the middle
    counts as changed line by line). In each run of differences, deleted
    and inserted lines are paired in order: a pair is a changed line and
    keeps the old `seq` and `date`. `k` unpaired inserts between `lo` and
    `hi` get `lo + floor((hi − lo)·j/(k+1))`; after the last line they step
    by `0001.00` while that fits, as SEU numbers. Trailing blanks are
    removed and CRLF is read as LF before comparing, so neither counts as
    a change.
17. **A renumbered write still sends the old `seq` of every kept and
    changed line**, because the spec keeps a record's date when its data
    equals the member's record with the same `seq` "before renumbering".
    Inserted lines carry `0000.00`, which no record has, so the server
    dates them today. This is the one place the extension relies on the
    server accepting non-ascending numbers with `renumber`.
18. **After a successful write** the lock is taken again with `member.read`
    (`lock: true`), which also refreshes the cache. If another job took
    the member in between, it turns read-only and a warning says so.
19. **Reconnect.** When a session goes `stale` or `disconnected` its locks
    are counted as gone. When it is `connected` again after any other
    state, each writable member open on it is read again with
    `lock: true`. Members that could not be locked turn read-only and
    members whose lines changed meanwhile are both reported, in one
    notification each.
20. **Renumber Member saves a dirty document first**, then sends its text
    with `renumber: true`, so what is renumbered is what the editor shows.
21. **Member commands.** Rename and Delete first release this window's own
    lock on the member. Copy asks before replacing when the server says
    `Exists`. New Member opens the member it made. Saving into a member
    that does not exist (Save As) creates it with the type the extension
    names.
22. **Prompt and spec differences.** The prompt has the live test create
    and delete `HLINV/QTMPSRC`; no host method creates a file in this phase
    (and `createDirectory` refuses by design), so the test makes and
    removes only its own `QS4*` members in it, and the file must exist.
    The exit test's `CPYSRCF` is `member.copy`, which the spec defines as
    `CPYSRCF` of one member.
23. **Deferred:** "Open in 5250" on objects and members, as the prompt
    says.

## Decisions made in Phase 3

1. **No new pins.** `qap-client` stays at `quartz-systems-access`
   `90d9bba`; every IFS operation is its `Files` trait, `Listing`,
   `stamp`, `checked`, `resolve`, `resume_offset`, `read` and `write`, with
   no protocol code or chunking here. The prompt calls the spec section
   "Service 7 `Ifs`"; `docs/QAP.md` at `7f82a43f` numbers it **Service 6
   `Ifs`** (version 5, `Stat` version 6), and Service 7 is `Messages`.
2. **Error codes.** The prompt asks for `-32002 "changed on the system"`
   and `-32003` for a file over the limit, but those are already
   `NotConnected` and `NeedsPassword` (Phase 1 decision 4), and
   `SessionManager.call` answers `-32003` with a password prompt. So
   `ifs.*` uses `-32020` changed (`data: { change }`, null when the file is
   gone), `-32021` too large (`data: { size, limit }`), `-32022` cancelled
   (`data: { transfer, offset }`) and `-32023` too many links in a row
   (more than 16). `-32012` is a local file a transfer could not read or
   write (`qap-client`'s `Error::Read` and `Error::Write`).
3. **`change` is a string.** `Stat`'s counter is a u64, which a JSON number
   cannot always hold. Before QAP version 6 `Files::stamp` falls back to
   `GetInfo`'s `modified`, sent as `m<ms>`. The extension only compares it.
4. **The stamp is taken before the data.** `ifs.readText` calls
   `Files::checked` (a link is stamped by its target) and then reads, so a
   change in between shows as a conflict at the next save, never as a
   lost edit. After a write the host stamps again: a change someone else
   makes between the write and that `Stat` would be taken as ours, since
   `WriteFile`'s reply has no counter.
5. **Transfers are deferred methods.** The serve loop answers one request
   at a time (Phase 0 decision 6), so a transfer answered in line would
   hold `ifs.cancel` until it ended. `host-rpc` gained
   `Registry::register_deferred` and `Responder`: `ifs.download` and
   `ifs.upload` start a thread and return, and the thread answers when the
   transfer ends, after `ifs.transferEnded`. The session is held only to
   send each request (`Sessions::ifs` per chunk), so the connection's other
   requests go on. The extension does not apply its 30 s timeout to these
   two (`UNTIMED_METHODS`).
6. **Transfer IDs.** `ifs.download` and `ifs.upload` take an optional
   `transfer`, which the extension always sends so it can cancel before the
   first `ifs.progress`; without one the host makes `t<n>`. An ID already
   running is `-32602`. `ifs.cancel` of an unknown ID answers null. IDs are
   the host's, not per connection; `name` is taken and not checked.
7. **A cancelled transfer** is answered `-32022` with the offset
   confirmed, and `ifs.transferEnded` says `cancelled` with that offset
   for an upload. A request in flight when the cancel came may still land,
   so the system can have more than the offset; `mode: "resume"` asks the
   system (`resume_offset`), never the offset. Resume with nothing on the
   system sends the whole file with `Replace`; resume of a file the system
   has whole sends nothing and answers its size.
8. **A cancelled upload stays at its own name**, not a temporary one, so
   resuming and replacing keep the file's owner, authorities and CCSID. The
   tree marks it `partial upload: <done> of <size>` until it is resumed,
   replaced or deleted, and the notification offers **Resume** and **Delete
   Partial File**. A cancelled or failed download deletes its local file.
9. **`ifs.resolve`.** `Files::resolve` takes a directory and an entry, not a
   path, and follows one link. The host does `GetInfo` of the path, then
   one `Files::resolve` per link, up to 16, a relative target joined to the
   link's directory. A path that is not a link comes back as typed; a
   broken link is the server's `NotFound`.
10. **Text in more than one request.** `write` converts per request and
    sends about 1 MiB a request; `TCP1A5A` in a later request leaves the
    earlier ones written (`Replace` emptied the file first). "Nothing
    written" holds for text that fits one request, as every exit-test file
    does. A temporary file and a rename would avoid it but lose the file's
    owner and authorities, so it is not done.
11. **The 10 MiB cap** counts the file's bytes (`size`), not the converted
    text, for text and binary alike. Text the server sends that is not
    valid UTF-8 is shown with replacement characters, not refused.
12. **The editor's times.** `stat` of a text file the provider holds
    answers the time it was read or saved here, not the system's
    `modified`, so VS Code's own "the file is newer" check never decides a
    save before `expect` does. **Reload** lets the save go without writing,
    then 100 ms later reads the file again with a newer time and fires
    `Changed`, so the saved editor reloads the system's text; dismissing
    the question fails the save and keeps the document dirty.
13. **Bytes go through a temporary local file.** No host method returns
    bytes, so binary `readFile` is `ifs.download` into `os.tmpdir()` and
    binary `writeFile` is `ifs.upload` from there; the file is removed
    either way. The binary list is the prompt's plus `.jpeg`, `.bmp`, `.ico`
    and `.webp`, which VS Code also previews.
14. **The CCSID of an upload** is 1208, or 65535 for the binary list; the
    bytes are sent as they are either way. **Change CCSID** has no QAP
    operation behind it, so an empty file is deleted and created again
    with the new CCSID (its owner and authorities become a new file's, and
    the confirmation says so); a file with data gets the explanation only.
15. **Languages.** A document on `qs400ifs` gets a language only when its
    extension is in the member type table and maps to a `qs400-*` id; any
    other extension is left to VS Code. The provider is registered
    case-sensitive, since some file systems under `/` are. The activation
    event `onFileSystem:qs400ifs` is added so restored editors open.
16. **The tree.** Node IDs include the root, so a path shown under two
    roots is two nodes. A link sorts with the files (what it points to is
    not known until it is expanded); expanding it resolves it, a link to a
    folder lists under the link's own path, and a link to a file loses its
    twistie and opens. Go to Path roots last for the window only.
17. **Recursive delete and folder copy** walk with `ifs.list`: links are
    entries, deleted and never followed; a delete goes deepest first, root
    last; a copy makes each directory, copies its files on the system, then
    goes into its directories. Entries of kind `other` are skipped and
    logged. A folder copied into itself is refused before anything is sent.
18. **Drag and drop** in the IFS view copies entries onto a folder (through
    the provider's `copy`), and local files or folders dropped on a folder
    upload.
19. **Host tests** use a fake that implements `qap-client`'s own `Files`
    (`ifs_call`, `ifs_request`, `ifs_supports`), with `ifs_request` going
    over a real `qap_client::Connection` on an in-memory `Transport`
    (`Connection::over`). So `Listing`'s paging, `stamp`'s fallback,
    `read`'s whole-character chunks and `write`'s `Create`/`Update` run as
    shipped, against a canned server.
20. **Test isolation.** A test run from a terminal inside a portable VS
    Code inherited `VSCODE_PORTABLE`, and the test instance then used that
    installation's own settings.json in place of `.vscode-test/user-data`,
    so the suites' `code-for-qs400.connections` writes reached the
    developer's real settings. `.vscode-test.mjs` now deletes the variable.
    One leftover test connection (`LIBL`, `h.example`) was removed from that
    settings file by hand.

## Decisions made in Phase 4

1. **No new pins.** `qap-client` stays at `quartz-systems-access`
   `90d9bba`. The prompt calls the command service "Service 4 `Command`";
   `docs/QAP.md` at `7f82a43f` numbers it **Service 3 `Command`**
   (version 2), and Service 4 is `Spool`. "Service 9 `Develop`" operation
   15 `Compile` and "Service 10 `Jobs`" operation 2 `JobLog` match.
2. **`CommandBackend`.** `RunCommand`, `CheckCommand`, `Compile` and
   `JobLog` are one object-safe trait in `session.rs`, implemented for
   every `qap-client` `Requests` type (`run_command` is
   `request_op(RunCommand)`, which is what `Client::run_command` sends;
   `compile` is `Develop::compile`; `job_log` is `Jobs::job_log`), and
   reached with `Backend::command` and `Sessions::command`. Tests
   implement `Requests` over a canned `Connection`, so the real outcomes
   and `Pending` run.
3. **Lane waits happen outside the session.** A compile or a command waits
   in the connection job's lane, behind any other, with no reply timeout.
   `action.run` holds the session only to send, and a thread waits for the
   reply, so member saves and the views go on meanwhile. `CheckCommand` is
   a lane request too, so `action.check` does the same with `request_op`
   and `CheckOutcome::from_reply`, waiting for `qap-client`'s reply timeout
   (60 s), instead of `Client::check_command`, which waits holding the
   session. What that gives up is `check_command`'s one resend after a
   dropped connection.
4. **`action.run` is `{ name, command, kind, run? }`.** `name` is the
   connection, as in every host method; the action's own name is not sent.
   `run` is an optional ID for `action.cancel { run }`, as transfer IDs are
   (Phase 3 decision 6); without one the host makes `r<n>`, and an ID
   already running is `-32602`. Both `action.run` and `action.check` are
   deferred, and the extension does not time them out (`UNTIMED_METHODS`).
   The host log names the run and its kind, never the command.
5. **The outcome as JSON.** `status` is QAP's status name (`Ok`, `Error`,
   `NotFound`, `NotAuthorized`, `Cancelled`); `escape` and `messages` are
   `{ id, severity, text, secondLevel? }`, as Phase 1's errors name the
   second level; `diagnostics` are `{ at, line, column, endLine, endColumn,
   severity, id, text, help }`, keeping the spec's `help`, with `at` (the
   Rust field is `r#where`) as `{ kind: "member", library, file, member }`,
   `{ kind: "path", path }` or `{ kind: "none" }`. A status outside those
   five is the server's refusal, `-32010`. `kind: "command"` always
   answers `diagnostics: []`.
6. **Every `CompileOutcome` shape fit the mapping**, with three readings
   recorded here. `column` 0 is "unknown" in the spec, placed as the
   whole line as the prompt says. `end_column` is "the last column", so
   it is taken as inclusive: columns 9 to 17 are characters 8 to 17, and
   `end_column` 0 runs to the end of the line. `line` 0 is line 1. The
   escape message comes in the reply's message and may also be the last
   of `messages`; the output channel shows it once, last.
7. **Variables for every environment** (the prompt lists them for
   members and stream files). For a stream file `&NAME` is the name
   without its extension, upper case (an object name), `&TYPE` the
   extension in upper case, and `&LIBRARY` the current library, asked for
   when there is none, as for a member. For an object `&TYPE` is its type
   (`*PGM`) and `&EXT` its attribute in lower case. Names are not case
   sensitive, `&&` is a literal `&`, `&CUSTOM:` names are upper-cased, and
   a word after `&` that is no variable is an error in the file and stops
   a run.
8. **Matching.** `extensions` are compared upper case without a leading
   `*` or `.`, so `*PGM` and `PGM` both match an object type; `*` or
   `*ALL` (or no `extensions`) is any. A member matches its source type or
   its URI's extension.
9. **The files.** `actions.json` is a top-level array, read as JSON with
   comments and trailing commas through `jsonc-parser` 3.3.1, now a direct
   dependency (it was already in the tree under `vsce`), which also gives
   each `command`'s place for the diagnostics. esbuild takes its ES module
   build (`mainFields`): its UMD `main` loads its parts with a `require`
   the bundle cannot follow, and the extension did not activate. Names
   compare without case; a name used twice in one file keeps the first.
   An override keeps the place of the action it overrides. A connection's
   `actions` are kept in the setting as written, so an entry that does not
   parse survives **Edit Connection**; its `variables` are parsed.
10. **Checking `actions.json`.** On the save of any `.vscode/actions.json`
    (`workspaceContains:.vscode/actions.json` activates the extension for
    it). Its diagnostics go to a collection of their own,
    `code-for-qs400-actions`, so **Clear Compile Diagnostics** leaves them.
    Commands are checked on the active connection, one at a time; with none
    signed on, one information diagnostic says they were not checked.
    Sample values: `QTEMP` for `&LIBRARY`, `&SRCLIB` and `&CURLIB`, `SAMPLE`
    for `&NAME`, `QSRC` for `&SRCFILE`, the first extension for `&TYPE` and
    `&EXT`, `/tmp/sample.<ext>` for paths, the connection's own value for
    `&CUSTOM:` (else `SAMPLE`). A connection's `actions` are not checked
    this way; settings have their own schema.
11. **Running.** The target comes from the URI (editor title, palette:
    a member's type from its extension through the member type table), or
    from the tree node (the type the server sent). A disconnected
    connection connects first. The current library is read (`libl.get`)
    only when the command uses `&CURLIB`, or `&LIBRARY` of a member or a
    stream file. The remembered choice is per connection, environment and
    member type, extension or object type, in workspace state under
    `code-for-qs400.lastActions`.
12. **Batch.** `SBMJOB CMD(<command>) JOB(<&NAME>) JOBQ(QBATCH)` runs as a
    command; `JOB` is `*JOBD` when `&NAME` is not a valid name (a long
    stream file name). The submitted job is read from `CPC1221`'s text
    (`Job 654321/CWELLMAN/ASSETS submitted to job queue QBATCH in QGPL.`).
13. **The output channel's link.** Output channels have no command links,
    so the channel has a language of its own, `code-for-qs400-output`, and
    a `DocumentLinkProvider` makes **Show** in `Job log: Show` a link to
    **Job Log** for the connection the block's first line names. The
    channel is made on first use.
14. **`refresh`.** `parent` and `library` read the whole Objects view (or
    the IFS view, for a stream file) again: the trees' nodes have no IDs
    that would let the providers find one node again.
15. **Which diagnostics a compile replaces.** The prompt says each run
    replaces the diagnostics of the documents it reported on. A `/COPY`
    member a compile no longer complains about is not among those, and
    would keep a fixed error forever. So diagnostics are kept per target:
    a compile replaces its target's last compile's, on every document
    either reported on, and a document shows the union of every target's.
    Two members sharing a `/COPY` member keep each other's. The target's
    own document is always reported on, so a clean compile clears it.
    Commands, batch runs and cancelled compiles change nothing.
16. **Where diagnostics land.** The member compiled is its open document,
    else its writable URI; any other member is its open document, else its
    `?readonly` URI, so a click opens it read-only. A path is its open
    document or its `qs400ifs` URI. `none` on an object goes on its
    **Properties** document (`qs400obj`). `source` is the command's name
    (`CRTBNDRPG`).
17. **`job.log` is `{ name, job? }`** and drains the log in pages of 500,
    as Phase 2 decision 7 pages lists. Without `job` it is the session's
    own (`JobInfo`), read after a stale session is brought back. The Job
    log document is `qs400joblog://<connection>/Job log 123456∕QUSER∕QAPCNN?job=123456/QUSER/QAPCNN`:
    the tab shows only the last path segment (Phase 2 decision 9), so the
    name's slashes are U+2215, and the job is read from the query. Each
    line is `YYYY-MM-DD HH:MM:SS  ID  text`, a message's line breaks
    folded, with no header, so line *n* is entry *n*; the hover is on the
    ID column only. The hover's text is the server's, escaped.
18. **Defaults.** The member `RUNSQLSTM` is **Compile (RUNSQLSTM)**, since
    names are the override key and **Run SQL statements (RUNSQLSTM)** is
    the stream file's. `DBGVIEW(*SOURCE)` is on the six whose definitions
    in QS/400's `command/sys-cpps/cmds` at `7f82a43f` have `DBGVIEW`
    (`CRTBNDRPG`, `CRTRPGMOD`, `CRTSQLRPGI`, `CRTBNDCL`, `CRTCLMOD`,
    `RUNSQLSTM`). `OPTION(*EVENTF)`, as in the prompt's example, is on
    every compiler command whose `OPTION` takes it; QS/400 accepts it and
    writes no event file (`lic/slic/src/cpp/compdiags.rs`), since the
    diagnostics come with `Compile`. It is not on `RUNSQLSTM`, whose
    `OPTION` is `*LIST` or `*NOLIST`. `CRTCMD`'s `PGM(&LIBRARY/&NAME)`
    takes the processing program to have the command's name.
19. **The live test** works on its own member, `QS4ACT42`, in
    `QS400_TEST_SRCPF`, copied from `QS400_TEST_SOURCE`, not on the
    `ASSETS42` the exit test names, and breaks line 42 in the member's own
    form (free or fixed). It sets the current library with `libl.set`
    first, so `&LIBRARY` is never asked for, and adds a connection action
    for the wrong `&SRCFILE`. The program it makes stays in that library.

## Decisions made in Phase 5

1. **The front-ends are pinned at `quartz-systems-400` `5e2bbee9`**
   (`5e2bbee93f4055680b96c5e0ebbdbb691f4fc10c`, `main` and tag `v1.1.0`,
   V1R1M0), apart from the `7f82a43f` that `qap-client` carries for
   `qap-proto`. `rpgfront`, `cl`, `dds`, `sql` and `cmd` take
   `default-features = false, features = ["front"]` and build alone for
   `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-musl`, as QS/400's
   `front-ends` CI job builds them. **`compdiag` takes no features**: it
   has none (its `front` module is always built), and cargo refuses
   `features = ["front"]` on it ("does not have that feature"). `rpgspecs`
   is pinned at the same commit for the fixed-form column table
   (decision 10).
2. **`lsp-server` 0.10, `lsp-types` 0.97, `crossbeam-channel` 0.5.**
   `lsp-server` 0.10's `Response` carries `response_result`, and its
   `ProtocolError` cannot be made outside it, so `serve_stdio` answers
   its own error text.
3. **The front-ends' `Options`, none of them guessed:**
   - RPG: `defines` empty and `copynest` 0 (32), the compile commands'
     `DEFINE` and `COPYNEST` defaults; `fetch` the include fetch.
   - CL: `files` `None`. A `DCLF` file's formats are in the file object,
     and no host method reads a file's record formats (`qap-client`'s
     `Develop` at `90d9bba` lists, describes and reads members, but has
     nothing for a file's fields), so every `DCLF` reports `CPD0744 file
     LIB/FILE was not found`, as the front end documents for a compile
     without the file.
   - DDS: `kind` from the URI's extension (`Kind::of_srctype`, `PF` when
     it is none of `pf`, `lf`, `prtf`); `refs` `None`, for the reason CL's
     `files` is. DSPF and ICFF are **not analyzed**: `dds::analysis::Kind`
     has no display or ICF compiler at this commit, and running them as a
     PF would report another compiler's messages. They get the grammar
     only.
   - SQL: `NAMING(*SYS)`, `RUNSQLSTM`'s default.
   - CMD: `name` `None`, so `analyze` takes the member's or stream file's
     name, which is what the default `CRTCMD CMD(&LIBRARY/&NAME)` creates.
4. **What the front-ends report at this commit**, read from their source
   and seen in the tests:
   - `rpgfront` reports its reader's, lexer's and parser's messages
     (`RNF0xxx`, `RNF5xxx`). `RNF7030`, `RNF7031`, `RNF7066`, `RNF5318`
     and the other checks of the compiler proper are `rpg/compiler`'s
     (`rpgc`), which the `front` feature does not include. So a name that
     is not defined gets no diagnostic as you type, and the exit test's
     `RNF7030` step cannot pass with this front end.
   - Subfields come with `scope: None` (their data structure is only in
     `detail`, `subfield CHAR of CUST`), so the outline lists them beside
     their data structure, not under it.
   - `rpgfront`'s tree places things by listing line, and its map back to
     sources (`LineMap`) is crate-private. `lsp-rpgle::blocks::Listing`
     rebuilds it from `Analysis::sources` and `includes` (each include's
     lines after its directive). The folding tests check it against the
     declarations' own spans, through a `/COPY` and a skipped `/IF`
     block.
   Each of these is a `quartz-systems-400` matter; nothing here works
   around them.
5. **Includes are fetched without blocking `analyze`.** An analysis
   answers each include from the cache and notes what the cache lacks; the
   server sends `qs400/fetchInclude` for those, keeps the previous result,
   and analyzes again when every answer is in, so nothing is published
   from a half-read member. An answer not in after 10 s counts as not
   found. A member not found is cached as not found. The cache is per
   origin (scheme and connection), so two systems' `*LIBL/QRPGLESRC,CP`
   are apart. `qs400/includesChanged` drops a member whatever library
   found it, or a path, or everything; the extension sends it on
   `onDidSaveTextDocument` of a `qs400mbr` or `qs400ifs` document (after
   the provider's write succeeded, so Phases 2 and 3 are unchanged) and
   for a connection whenever its session is `connected` again.
6. **`*LIBL` and `*CURLIB` includes** are looked up with `object.list` of
   the source file in that library, in order, and the first library whose
   `member.read` (`lock: false`) succeeds answers, with that library in
   `at`. `member.read` returns no library, and the compiler's messages
   name the library it found, so answering `*LIBL` would never match a
   compile. A path include relative to nothing (`request.file` empty) is
   taken from `/`. A local file's includes come from the active
   connection.
7. **One severity table, in a file.** `host/crates/severity/severity.json`
   is read by the `severity` crate (`include_str!`) and imported by
   `src/actions/severity.ts` (`resolveJsonModule`), so the Problems
   panel's compile diagnostics and the language servers cannot drift.
8. **Diagnostics as LSP's.** The range follows Phase 4 decision 6 (column
   0 the whole line, `end_column` the last column, 0 the end of the line,
   line 0 line 1), converted from characters to UTF-16; the code is the
   message ID, the source the language id, the second-level text the
   related information, as the compile diagnostics carry it. An include's
   diagnostics go to its document when it is open, writable or read-only;
   otherwise one `<n> messages in LIB/FILE(MBR)` at their highest severity
   on the directive in the document, through nested includes to the
   outermost directive.
9. **`qs400/diagnostics`** answers a document's diagnostics exactly as
   `analyze` returned them, every source, in the host's compile diagnostic
   shape, or `null` while a change or a fetch is pending. The parity test
   compares that, not the Problems panel, whose include summaries are not
   `analyze`'s.
10. **Rulers.** VS Code 1.143 has no rulers per document:
    `TextEditorOptions` has `tabSize`, `indentSize`, `insertSpaces`,
    `cursorStyle` and `lineNumbers` only, and `editor.rulers` is set per
    language. A `[qs400-rpgle]` default would put rulers on `**FREE`
    members, which the exit test excludes, and one set of rulers cannot
    sit at both a D and a C specification's boundaries. So fixed-form RPG
    gets **guides**: a decoration bordering the first character of each
    field of each line's own specification, in `editorRuler.foreground`,
    on the visible lines, where the line reaches. The table is
    `rpgspecs::forms()` through the RPG server's `qs400/specForms`. DDS,
    always fixed, gets the `[qs400-dds]` default of `editor.rulers` at its
    specification's columns. The column in the status bar uses the same
    table.
11. **Comment toggling.** VS Code inserts a line comment at a line's first
    character that is not blank. DDS therefore has no `lineComment` (an
    inserted `A*` would land in column 6 and move the line), and
    fixed-form RPG's `*` in column 7 is the grammar's only; RPG's
    `lineComment` is `//`.
12. **Local files** (settling Phase 2 decision 13): `.rpgle`, `.sqlrpgle`,
    `.rpgleinc`, `.rpg`, `.clle`, `.clp`, `.pf`, `.lf`, `.dspf`, `.prtf` and
    `.icff` open in the QS/400 languages. `.sql`, `.cmd` and `.cl` stay
    VS Code's SQL, Windows batch and OpenCL; members of those types still
    get the language from their source type. The language registrations'
    `onLanguage` activation events are in (Phase 0 decision 3).
13. **Completion tables** are each `lsp-<lang>`'s own, marked so in the
    source: no front end exports its keywords, operation codes or
    built-ins. SQL's special registers and built-in globals are the front
    end's (`sql::words::CURRENT`, `GLOBALS`). After `/COPY` or `/INCLUDE`,
    the RPG server asks the client (`qs400/listMembers`, `member.list`)
    and waits up to 3 s for the answer, handling what else arrives
    afterwards.
14. **Synchronizing.** Full text on each change; analysis on open and
    300 ms after the last change; a request on a document whose change is
    still waiting (definition, rename, symbols) analyzes it first.
15. **The client.** `vscode-languageclient` 10.1.2 (`engines.vscode`
    `^1.91.0`), one client per language started on the first document of
    it on `qs400mbr`, `qs400ifs` or `file`, all writing to the **Code for
    QS/400 Languages** output channel. Version 10 syncs a document that was
    already open when its client started only if the document is in an
    editor (the others wait in a list flushed only with
    `delayOpenNotifications`). In use the document that starts a server is
    the one being shown, so this does not show; the tests show each
    document they open.
16. **Grammars** are plain JSON in `syntaxes/`. Fixed-form fields are
    atomic groups (`(?>.{0,n})`), so a whole record keeps exact columns: a
    plain `.{0,n}` let a regex give columns back and pushed the `LR` of
    columns 71 and 72 into the comment columns. They are generated once
    from the column tables of `rpgspecs` and `dds::lex::columns` at
    `5e2bbee9`; the generator is not kept, so edit the JSON.
17. **Parity fixtures.** `host/fixtures/parity/` keeps the records and its
    README only: HLINV's source is not ours to ship (QS/400 gitignores it
    as `tools/conformance/hlinv/src/` for that reason) and this repository
    is public under MIT, so the members' text the live test writes beside
    each record is gitignored, and the offline test also reads it from
    `QS400_PARITY_SRC`. The prompt's `--record` is `QS400_PARITY_RECORD=1`:
    mocha under `vscode-test` passes no flags of its own to the suites.
    The live test opens members read-only (no locks) and analyzes them
    with a `LanguageServers` of its own on the extension's sessions, so it
    can record what was fetched. No record exists yet (see the exit test).
18. **The process test** now drives `lsp rpgle` through `initialize`, a
    published `RNF5014`, `shutdown` and `exit`; `dap` is still not
    implemented, and an unknown language exits 2.

## Decisions made in Phase 6

1. **No new pins.** `qap-client` stays at `quartz-systems-access`
   `90d9bba`. The prompt calls the service "Service 6 `Sql`";
   `docs/QAP.md` at `7f82a43f` numbers it **Service 5 `Sql`** (version 4),
   and Service 6 is `Ifs`. The version 8 additions, operations 12
   `ListRoutines` and 13 `ListIndexes`, match.
2. **A query's statement is released with its cursor**, not after the
   first fetch as the prompt has it. `SqlConnection::release` takes the
   statement's cursors with it ("the statement is gone, its cursors with
   it"), so releasing after the first page would end Load more. A query's
   statement goes at its cursor's end, at `sql.close`, or when an export
   reaches the end; every other statement is released as soon as it ran.
3. **`cursor` in the JSON is the host's result ID**, not QAP's cursor
   number (a new job has new numbers). The result stays after its cursor
   ended, with the rows sent so far, so Export CSV can write them; it goes
   at `sql.close`, which the panel sends when a tab closes, when a 21st
   tab pushes it out, or when the panel closes.
4. **Export** writes the held rows, then fetches the rest in pages of 500
   to the file, not into memory. After an export that read past the held
   rows, a second export of that result is refused (`-32031`, "no longer
   held") and the tab says so. `sql.export` takes an `export` ID;
   `sql.progress { export, rows }` goes at most every 250 ms;
   `sql.cancel { id }` cancels a run or an export. A cancelled or failed
   export removes its file. Error codes: `-32030` cancelled
   (`data: { id, rows }`), `-32031` no such result.
5. **`SqlValue` to JSON beyond the prompt's rules** (`sql::values`):
   - `Boolean` (variant 9, in the spec at `7f82a43f` but not in the
     prompt's list) is a JSON `true` or `false`, and `TRUE` or `FALSE` in
     CSV.
   - "Fits 53 bits" is `Number.MAX_SAFE_INTEGER`: −(2⁵³ − 1) to 2⁵³ − 1
     are numbers; ±2⁵³ and beyond are strings.
   - `Binary` hex is upper case.
   - `Time` has `.mmm` only when its milliseconds are not 0.
   - `Timestamp` is `YYYY-MM-DDTHH:MM:SS` with as many fraction digits as
     the column's `scale` (0 to 12), cut from the milliseconds and the
     picoseconds past them; no zone, since the spec sends them "as if
     UTC".
   - `Date` is the day of `ms`, floored to whole days.
6. **CSV**: CRLF after every record, the header is the column names (not
   labels), and an empty string is `""` so it stays apart from `NULL`'s
   empty field.
7. **`kind`**: `query` when `Prepare` returned columns; `update` when the
   statement's first keyword (past comments and parentheses) is `INSERT`,
   `UPDATE`, `DELETE` or `MERGE`; else `ddl`, without a count. A trailing
   `;` is not sent.
8. **Every `sql.*` method is deferred**, on a thread of its own, and the
   connection is held only to send and to read a reply: `Execute` and
   `Fetch` are waited for outside it. So a long query holds up neither the
   catalog nor `sql.cancel`. The extension does not time out `sql.run`,
   `sql.fetch`, `sql.commit`, `sql.rollback`, `sql.options.set` or
   `sql.export`.
9. **Life of the SQL connection.** It attaches on the first statement;
   options set before then are kept and sent when it attaches, and set
   again on every new one. It is made again when its session ended or
   signed on anew (a sign-on epoch the session keeps), and noted when
   `SqlConnection::lost` says so; both send `sql.lost { name, message }`,
   which the extension shows and which stops Load more on that
   connection's tabs. `Sessions::on_close` closes it on disconnect and
   before a new sign-on, so the options start again at `None`, `Sql` and no
   default schema. `Backend::sql` has a default of `None`, so the other
   services' test fakes are unchanged.
10. **JSON names**: `commit` is `none`, `readUncommitted`,
    `readCommitted`, `repeatableRead` or `serializable`; `naming` is `sql`
    or `system`; table kinds `table`, `view`, `alias`, `physicalFile`,
    `logicalFile`. `sql.options.*`, `sql.commit` and `sql.rollback` all
    answer the options with `uncommitted`. Column JSON names the SQL type
    `type`.
11. **`qs400/sqlStatements`.** The front end at `5e2bbee9` measures a
    string or number token by its value (`Tok::describe`), so a span ending
    in `'it''s'` is one character short, and running it would drop the
    closing quote. `lsp-sql` keeps the parser's statements (their starts,
    and which `;` ends each) and takes each end from the source: the last
    character before that `;`, comments and blanks left out
    (`statement_end`). That is a `quartz-systems-400` matter.
    `lsp-common` gained `Language::document_methods` and
    `document_request` for requests on one document's analysis.
12. **Scope.** The statement under the cursor runs from its first
    character to its `;`, or from anywhere on its last line after it; on a
    line between statements the whole document runs. A selection is split
    by the extension's own rule (`statements.ts`), which is also used for
    a document the server has no answer for. The two agree on the test
    fixtures; they differ on compound statements (`BEGIN ... END`), which
    the parser keeps whole and the fallback splits.
13. **Local `.sql` files stay VS Code's SQL** (Phase 5 decision 12). Run
    Statement and its title button work in both `qs400-sql` and `sql`
    documents, with the local split for `sql`; `Ctrl+Enter` is bound in
    `qs400-sql` only, so other SQL extensions keep theirs. `untitled` is
    now one of the language client's schemes, for New SQL Editor.
14. **Which connection.** A member or stream file runs on its own
    connection; any other document on the one it was bound to (New SQL
    Editor, Generate, the status bar), else the active one. Bindings last
    while the document is open; they are not saved.
15. **The Problems panel** gets one diagnostic for a failed statement:
    collection `code-for-qs400-sql`, source `SQL`, the message ID as the
    code, the server's text, the statement's whole first line, the second
    level as related information. A document's next run clears it.
16. **The status bar item** shows only while an SQL document is active.
    Commit levels are shown as `qap-proto` names them: `*NONE`, `*CHG`,
    `*CS`, `*ALL` (`RepeatableRead`), `*RR` (`Serializable`); QS/400 runs
    both of the last two as `*ALL` (`docs/QAP.md`, "Version 4 Sql, as
    built").
17. **Disconnect with uncommitted changes** asks through a guard on the
    session manager (`addDisconnectGuard`), for Disconnect and Remove:
    **Commit and Disconnect** or **Roll Back and Disconnect**.
18. **The results webview** (`code-for-qs400.sqlResults`) keeps its
    context when hidden, loads nothing (`localResourceRoots: []`, a nonce
    policy), draws the rows of 22 px in view plus 20 either side, and is
    told whole tabs and appended rows by message. Numeric types (right
    aligned) are `SMALLINT`, `INTEGER`, `INT`, `BIGINT`, `DECIMAL`,
    `NUMERIC`, `DECFLOAT`, `REAL`, `DOUBLE` and `FLOAT`. The elapsed time
    is the extension's round trip.
19. **The SQL tree** always shows all seven groups; tables, views,
    aliases, physical and logical files each have Columns and Indexes.
    The schema pattern is kept per connection in workspace state
    (`code-for-qs400.sql.schemaFilter`). Generated SQL uses the naming
    last read for the connection.
20. **Copy CALL.** The spec's `Routine` has no parameters, so they are
    read with `sql.run` from `QSYS2.SYSPARMS`, `ORDER BY 3` (its third
    column is the parameter's position; the naming check matches that
    column's name, so it is not spelled). Each `?` carries the parameter's
    name in a comment; a function gets `VALUES`. When the catalog query
    fails, the `CALL` has no parameters and a warning says so.
21. **History** is workspace state `code-for-qs400.sqlHistory`, keyed by
    the connection name in upper case, newest first; a query's count is
    the rows shown, with `+` when there were more.
22. **The naming check** fired on a word in a comment and on that
    `SYSPARMS` column; both are gone.
23. **Not in this phase:** values for parameter markers. A statement with
    `?` is sent with no parameter rows, and the system refuses it.

## Decisions made in Phase 7

1. **No new pins.** `qap-client` stays at `quartz-systems-access`
   `90d9bba`. The prompt calls the spooled-file service "Service 5
   `Spool`"; `docs/QAP.md` at `7f82a43f` numbers it **Service 4 `Spool`**
   (version 3; `WatchSpool`, `UnwatchSpool` and `SpooledFileChanged`
   version 6), and Service 5 is `Sql`. "Service 7 `Messages`" (version 6)
   and "Service 10 `Jobs`" (version 8) match. Below those versions each
   method answers `-32001` with the version and sends nothing, as before.
2. **`WorkBackend`.** `qap-client`'s `Jobs` is generic over `Requests`, but
   its `Spool` and `Messages` operations and the watches are methods of
   `Client` only. So `session::WorkBackend` is one object-safe trait for
   all three and the watches, implemented for `Client` (each method the
   `qap-client` call of the same name), reached with `Backend::work`
   (default `None`, so the other services' fakes are unchanged) and
   `Sessions::work`. `jobs.log` and Phase 4's `job.log` keep going through
   `CommandBackend::job_log`.
3. **Where the watches' events come from.** The client keeps what its
   watches report until `watch_events` takes it. The host takes it after
   every call on a session (`Sessions::with_backend`, which also covers a
   resume, after which the client watches again by itself) and whenever
   the watcher thread looks: woken by the connection's `Wake` when an
   event arrives, else every 5 s. A session busy with a call is skipped
   and its events go out when the call ends. `Sessions::on_events` hands
   them, with the session let go, to `watches::Watches`, which sends
   `spool.changed` and `messages.arrived`. So an event's delay is the
   server's look (250 ms, `Config::watch_poll`) plus the wake.
4. **Who wants a watch.** The client keeps one watch per `Queue` or
   `SpoolTarget` value, and `unwatch` forgets it whoever else wanted it.
   `Watches` counts the extension's watch (`spool.watch`,
   `messages.watch`, once) and each one-shot wait, and tells the client to
   unwatch only when nobody wants it. A session's end (disconnect, or a new
   sign-on, whose new client watches nothing) forgets that session's
   watches and answers its waits `null`. The extension watches again when
   a connection's session job changes: the Spooled files view while it is
   shown, the Messages view's own queue always.
5. **Notifications.** `spool.changed` is `{ name, target, change, id,
   file? }`, `file` the file as listed after the change (absent for
   `removed`); `SpoolRewatched` is `change: "rewatched"` with no `id`, for
   the view to read its list again. `messages.arrived` is `{ name, queue,
   message, caughtUp }`, `caughtUp` for a message found by a catch-up after
   a resume or a sign-on. `Watching`, `CaughtUp` and `Failed` go to the
   host log; a `Failed` that is `NotAuthorized` has taken the watch away.
6. **JSON shapes** (`codec.rs`, the one place): a key is 8 upper-case
   hexadecimal characters, read in either case; a `JobId` is `{ number,
   user, name }`, the number six digits, names trimmed and never
   case-folded, written `nnnnnn/USER/NAME`; an `ObjectName` is `{ library,
   name }`; a `Queue` is `"own"`, `"sysopr"` or `{ library, queue }`; a
   `Recipient` `{ profile }` or `{ queue }`; a `SpoolTarget` `{ outq }` or
   `{ profile }` (`*ALL` refused, as the spec does); enums are the spec's
   names in lower camel case (`onJobQueue`, `held`, `senderCopy`). A job
   log entry's `kind` is now the same `MessageType` name: Phase 4 sent
   `Debug` in lower case, which made `senderCopy` `sendercopy`.
7. **`jobs.end`.** `how` is `controlled` or `immediate`; `delay`, seconds,
   only with `controlled`, 1 to 999999 as `ENDJOB DELAY` takes; anything
   else is `-32602`. The extension offers **End…** on every job but the
   connection's own, which the spec refuses (`InvalidRequest`).
8. **`spool.files` takes a `job`.** `ListSpooledFiles` has no job among its
   filters, so the host lists `user`'s files (`*CURRENT` when absent) and
   keeps that job's. A job's files are listed as its user's, but the
   connection job's (`123456/QUSER/QAPCNN`), whose spooled files belong to
   the signed-on profile, are listed as `*CURRENT`.
9. **Reading.** `spool.readText` sends one `ReadSpooledFile` as `Text` for
   the range itself: `qap_client::spool::read` reads `Text` and `Pdf`
   whole, whatever range it is given. It answers `{ pages, firstPage,
   lastPage, text }`, `pages` the whole file's. `spool.readText`,
   `spool.download` and `spool.awaitFile` are deferred, each on a thread of
   its own, and the extension does not time them out. `spool.download`
   goes through `qap_client::spool::read` (SCS in batches of 25 pages),
   takes a `download` ID for `spool.progress` (at most every 250 ms) and
   `spool.cancel`, answers `-32040` when cancelled (`data: { download,
   pages }`), and removes its file when cancelled or failed. Spooled-file
   actions are sent in the session and waited for outside it.
10. **`spool.awaitFile { name, job, file?, timeoutMs? }`** is the one-shot
    the prompt describes for batch runs, a method of its own. It watches
    the profile's own files, lists them once (so a file written before the
    watch counts), and answers the first file of the job named `file` that
    is not `Open` or `Writing`, or `null` after 10 minutes or when the
    session ends. A rewatch lists again.
11. **How the compile listing is matched to its run.** Before a compile the
    extension reads the connection job's highest spooled file number
    (`spool.files` with the job); after it, the job's files again, and the
    listing is the newest file named for the listing (the command's
    `PRTFILE`, else `QSYSPRT`) numbered above that. Numbers in a job only
    go up, so it is a file the run made, and a compile that wrote none
    gets no line. That is two lists per compile; when either fails, no line
    and no error. A batch run waits for its submitted job's file named for
    its command's listing with `spool.awaitFile`, for any batch run, not
    only compiles (a `CALL` may print to `QSYSPRT`).
12. **The output channel's links.** `Job: Open` is the qualified job on the
    `Job:` and `Submitted:` lines made a link to the Jobs view, so the
    lines stay as Phase 4 wrote them. `Job log: Show` now opens the log of
    the block's job: the submitted one for a batch run. The listing line,
    `Listing: Open  QSYSPRT(8) 123456/QUSER/QAPCNN · QSHQ400`, names its
    file and connection, since a batch run's comes after other blocks
    perhaps. **Show in Jobs view** makes the job's connection the active
    one; a job the view's filter does not list offers its job log.
13. **The viewer.** A `TextDocumentContentProvider` on `qs400spl`, read-only
    by being one (Phase 2 decision 9). The form feeds are not kept in the
    text: before each page, the first included, is an empty line that an
    `after` decoration shows as `— page n —`, so no printed line moves a
    column and Find searches the text as printed. Monospace is the
    editor's font; `qs400-spool` is a language of its own whose
    `configurationDefaults` turn word wrap off and put rulers at 80 and 132
    (rulers are per language, Phase 5 decision 10). A file under 2000 pages
    is read whole, a larger one at pages 1 to 100 with **Load All Pages**
    (context key `code-for-qs400.spoolPartial`); a viewer restored without
    the page count reads 100 pages, then the whole file when it has fewer
    than 2000. Its connection is matched without case against the saved
    connections and the signed-on sessions (Phase 2 decision 15).
    Deleting the file closes its viewers.
14. **Statuses shown without a spec description.** The spec lists
    `SpoolStatus` by name and describes only `Message` ("waiting for a
    reply"); the tree shows `Ready`, `Held`, `Open`, `Closed`, `Writing`,
    `Printing`, `Message waiting`, `Pending` and `Saved`, `WRKSPLF`'s words
    for the `qap-proto` states. QS/400 never sends `Writing` ("QS/400 has
    no separate state for a file being written"). Every `MessageType` has
    a spec name; the tooltip shows them as `Information`, `Inquiry`,
    `Reply`, `Completion`, `Diagnostic`, `Escape`, `Notify` and `Sender's
    copy`. **Hold** is not offered on a held file.
15. **Messages.** The own queue of every signed-on connection at QAP 6 or
    later is watched once per session job, whether the view is shown or
    not, and listed once then, so inquiries already waiting count. The
    badge is the active connection's inquiries waiting plus arrivals not
    yet seen (cleared when the view is shown); a reply that arrives, a
    reply sent and a remove take an inquiry off it. Notifications come for
    any signed-on connection, prefixed with its name; `all` includes
    caught-up arrivals. `messages.canRead` for **System operator** is asked
    once per session job. The description is `ID · from user · time ·
    key`: the exit test looks for the key in the list. **Remove All
    Answered** removes answered inquiries and sender's copies and every
    reply, after a modal naming the count.
16. **Replies are passed as typed.** The extension refuses an empty reply
    in its input box; the host does not, since the spec makes an empty
    reply the message's default.
17. **Tests.** `tests/work.rs` drives `jobs.*`, `spool.*` and `messages.*`
    through the registry with a fake `WorkBackend` (`tests/common/mod.rs`):
    canned lists and refusals as `qap-client`'s own `Error::Status`, and
    `ReadSpooledFile` and the spooled-file actions over a real
    `qap_client::Connection` on an in-memory transport, so their `Pending`
    replies are `qap-client`'s. Watch events are handed to the fake and
    the watcher's look (`Sessions::check_all`) is called. The extension's
    suites must not register the extension's own command IDs: running a
    contributed command activates the extension, whose registration then
    fails on the ID already taken, and every later suite with it. So the
    viewer's tests register only its provider (`registerProvider`).

## Decisions made in Phase 8

1. **No new pins, no new QAP.** `qap-client` stays at
   `quartz-systems-access` `90d9bba`. The host gains `deploy.rs` only:
   `deploy.member` and `deploy.path` call the host's own `member.*` and
   `ifs.*` functions in sequence, behind a `Steps` trait (`Live` on a
   session; the unit tests script it). `ifs::register` now returns its
   `Transfers`, so `ifs.cancel` stops a `deploy.path` upload, and
   `run_upload`, `not_found` and `Transfers::begin`/`end` are
   `pub(crate)`.
2. **The save diff in Rust too.** `deploy.member` reads the member with
   `lock: true`, plans the write and writes in one host call, so the lock
   is held by one request rather than across a round trip to the
   extension. That needs the plan where the read is: `deploy::plan` is
   `src/members/diff.ts` line for line, tested on Phase 2's six save
   fixtures and the same gap cases. The editor's save still plans in the
   extension. A change to one is a change to both.
3. **Conflict detection, members: `member.list`'s `changed`.** Each file's
   record keeps the timestamp and *where it is from*
   (`HLINVDEV/QRPGLESRC(ASSETS)` or the stream file's path). A conflict is
   a `changed` newer than the record's for the same member; for a stream
   file, `ifs.info`'s `change` different from the record's. A record of
   another place (a pull from `HLINV` deploying to `HLINVDEV`) is no
   baseline, and a file with no record is never a conflict, so a first
   deploy over existing members replaces them. The timestamps are read
   before anything is written (one `member.list` per source file), and
   `deploy.member` checks `expect` again in the host, answering `-32050`
   (`DeployErrorCodes.Conflict`, `data: { changed }` or `{ change }`) when
   the member changed in between. Overwrite sends no `expect`.
4. **Changed is by hash.** A member's hash is of its lines as a member
   holds them: CRLF read as LF, trailing blanks removed, and the newline
   that ends the file not a line. So a CRLF checkout is not a change. A
   stream file's hash is of its bytes.
5. **Pull writes `\n` after every line**, so git sees a final newline, and
   deploy drops the empty line that newline would make. An empty member is
   an empty file. Pull reads with `lock: false`.
6. **Member text round-trips through `texts`.** Pull records each
   member's text in `qs400project.json`'s `texts`, so **Deploy All** into
   a new library creates every member with its text, as the exit test
   needs. A project file that exists gets the texts it lacks; it is never
   rewritten otherwise.
7. **A conflict's Pull** writes the system's copy into the local file and
   records the system's timestamp but keeps the old hash, so the file
   shows as Changed until it is deployed again ("mark it changed"). It
   writes into the deploy's own state, which the deploy saves at its end:
   writing `state.json` separately was overwritten by the deploy, which
   the conflict test caught.
8. **Deletions** are listed once as **Left on the system** and their
   records dropped, since "removed since the last deploy" is no longer
   true after it.
9. **The type follows the extension.** A member that exists with another
   source type than its local file's extension gets the file's type
   (`member.changeText` with `type`) after the write. A member already
   holding the lines is not written and only unlocked; it counts as
   deployed in the summary.
10. **An open editor of a member deploy wrote** is read again and locked
    again (Phase 2's `refresh`), since the write ended the lock its job
    held and its next save must diff the new lines.
11. **Ignore globs** are matched from the folder's root, without case; a
    glob without `/` matches a name in any directory. `.git/**`,
    `.gitignore`, `.gitattributes`, `.qs400/**`, `.vscode/**` and
    `qs400project.json` are always ignored, so the generator's own
    `.gitignore` is never deployed as a stray file. A directory every name
    of which a glob ignores is not walked.
12. **Files outside the layout** (not one directory deep, or not a system
    name) are skipped with their reason in the output, and two local files
    naming one member are an error for both, each deploy.
13. **Source files** are made with `CRTSRCPF FILE(LIB/FILE) RCDLEN(112)`
    through `action.run` (`kind: "command"`) after one question naming
    them all; declining skips their members.
14. **Pull of a stream file**: bytes as stored (`ifs.download`) when the
    file is 1208, 65535 or a binary extension; otherwise `ifs.readText`,
    converted to UTF-8, with a note that a deploy sends UTF-8 bytes, since
    deploy uploads as the prompt says (`ifs.upload`, which sends bytes as
    they are) and an existing file keeps its own CCSID tag.
15. **Git.** **Deploy Git-Changed** takes the working tree, index, merge
    and untracked changes of the folder's repository from the built-in git
    extension's API (`vscode.git`, `getAPI(1)`), after `repository.status()`
    so a `git stash` outside VS Code shows; no repository, or the git
    extension disabled, is **Deploy Changed** with a notice. The live test
    runs VS Code with `--disable-extensions`, so it reads `git status
    --porcelain` itself through the same `GitChanges` interface; the API
    path is tested with a mock API.
16. **Actions on local files.** `ActionRunner` takes a `local` resolver:
    a `file` URI of a project becomes the member or stream file it deploys
    to, deployed first (saved, with the conflict check; not deployed, not
    run). `&LIBRARY` is the target library, so the current library is read
    only for `&CURLIB`. **Run Action…** is on the editor title of a
    project's files (context key `code-for-qs400.hasProject`).
17. **The diagnostic map** is the deployer's, in memory: each member or
    stream file a deploy wrote, to its local file. After a window reload it
    is empty until the next deploy, and a compile on a local file always
    deploys first, so its own diagnostics land locally; a `/COPY` member
    deployed in an earlier window lands on the system's member until it is
    deployed again.
18. **Includes from the workspace.** From a local document the directive's
    library is ignored; from a member or stream file it must be `*LIBL`,
    `*CURLIB`, none, or the project's target library, and only projects on
    the document's connection answer. A local document's own project goes
    first, and its includes come from its project's connection (Phase 5
    decision 6 used the active connection). The answer's `at` names the
    target library, so the servers' `includesChanged` drops it on a save.
19. **Project actions** are a layer of every project on the connection,
    between the workspace's `.vscode/actions.json` and the connection's
    own, not only of the file's project.
20. **Folders outside the workspace.** A pull into a folder that is not a
    workspace folder (the open dialog, when none is open) keeps that folder
    among the projects (`ProjectStore.track`) for the window.
21. **The Project view** reads the system only on **Refresh**; between
    refreshes Conflict comes from the last deploy. Its title-bar **Pull**
    pulls the whole target (every source file of the library, or the
    directory) into the project; a file's **Pull from System** takes the
    system's copy as Deployed.
22. **No mapping beyond Phase 2's table.** Every type in it maps to an
    extension that maps back to the same type (tested over the whole
    table), and an unknown extension is its own type in upper case, as
    `typeForExtension` already did.
23. **The exit test's `STRSEU` step** is a hand step; the live suite stands
    in for it with a `member.write` from the host, which moves the
    member's `changed` the same way.
24. **The activity bar icon** is now a Q on a terminal display
    (`media/qs400.svg`), chosen by the user from eight drawn options.

## Decisions made in Phase 9

1. **No new pins.** `qap-client` stays at `quartz-systems-access`
   `90d9bba`, whose `debug.rs` has the `Debugger` trait, `DebugSession`
   and `DebugEvent` the prompt names. "Service 11 `Debug`" (version 9) in
   `docs/QAP.md` at `7f82a43f` matches the prompt's numbering. Its "as
   built" notes decide two things the prompt left open, recorded below
   (decisions 11 and 12).
2. **Hand-written DAP types.** The `dap` crate on crates.io is published
   only as `0.4.1-alpha1`, a pre-release, and would share the new crate's
   name, so `host/crates/dap/src/protocol.rs` has serde types for what
   the adapter reads and writes and nothing more. The framing is
   `host-rpc`'s `Content-Length` framing, as the language servers'.
3. **`DebugBackend`.** `Debugger` is a trait over `Requests`, whose
   methods are generic, so it cannot be a trait object.
   `dap::backend::DebugBackend` is the same ten operations, object-safe,
   plus `JobInfo` (the `Own` thread's name), `SetLibraryList`, the `CALL`
   (sent with `request_op(RunCommand)` and waited for in 50 ms steps so a
   cancel can come between) and the sign-off. `code-host`'s
   `src/debug.rs` implements it for `qap-client`'s `Client`, and its
   `connector` signs on (with `session::trust_for`, so TLS is the editor's)
   and refuses a server below version 9 before anything of the session is
   sent. The refusal is the DAP error "QAP version 9 not available on this
   server": the adapter is not JSON-RPC and there are no `debug.*` host
   methods, so it carries no `-32001` code.
4. **Where the password goes.** The prompt puts the sign-on in the
   `launch` and `attach` arguments. A resolved debug configuration is
   `vscode.debug.activeDebugSession.configuration`, which every extension
   can read, so the password is not put in it. The extension runs the
   adapter as an inline `DebugAdapter` (`src/debug/adapter.ts`) over the
   host process's stdio, and adds `qs400` to the `launch` or `attach`
   request's arguments as it writes them to the adapter, once. The
   password is read, or asked for, in
   `resolveDebugConfigurationWithSubstitutedVariables` (so a cancel
   starts nothing) and kept by a key in the configuration until the
   adapter is made. It is never on a command line.
5. **The library list.** The adapter's job is a new sign-on with the
   profile's library list, where a `CALL` or `*LIBL` would not find what
   the editor's compiles and calls find. So the extension passes the
   editor session's list as `libl.get` reads it, and the adapter sets it
   with `SetLibraryList` (what `libl.set` sends) before `Start`. A list
   the server refuses is reported in the Debug Console and the session
   goes on.
6. **`qs400/debugSource` is an event and a request.** DAP has no custom
   requests from the adapter to the client. The adapter sends the event
   `qs400/debugSource { id, program, module }`; the extension answers with
   the request of the same name, `{ id, path, name }`, `path` null for "no
   source". The adapter's reader thread takes the answer, so a worker
   waiting for it inside `stackTrace` is not blocked; no answer in 5 s is
   null. Each module with a `Source` view is asked about right after
   `AddProgram`, so `setBreakpoints` knows which module a source path is;
   a frame of a module not yet known is asked about then. Once per module
   per session.
7. **Where a module's source is.** `object.properties` of the `*MODULE`,
   then of the `*PGM` (or `*SRVPGM`) when the module has the program's
   name, since `CRTBNDRPG`'s module is temporary. The labels are the
   server's (`Source file` as `LIB/FILE` or a path, `Source member`,
   `Attribute`), from `work/qsjob/src/work/qap/develop.rs` at `7f82a43f`.
   The local file comes from Phase 8's deploy map, then from a library
   project whose target is the source library (its layout), since the map
   is empty after a window reload (Phase 8 decision 17). A member opens
   with `?readonly`; source paths are compared without case, query and
   escapes, so a breakpoint set in the writable member's editor finds the
   module too.
8. **The synthetic document** is `qs400dbg:/LIB/PROGRAM/MODULE`: the
   prompt's `PROGRAM/MODULE` with the library, since two libraries can
   hold a program of one name. Line *n* reads `LIB/PROGRAM MODULE
   statement n`, so a frame's statement is its line. It has 200 lines and
   grows to the highest statement a stack has shown (a tracker reads the
   `stackTrace` responses). A frame stands on it when its view is not
   `Source` or its `line` is 0; a frame with neither line nor statement
   has no source and is shown subtle. Breakpoints on it are refused with
   the message to compile with `DBGVIEW(*SOURCE)`.
9. **Frame names** are `PROGRAM › MODULE › PROCEDURE · stmt n`, the
   prompt's name with the statement the exit test asks the Call Stack to
   show; empty parts are left out.
10. **Breakpoints.** All of a source's lines go in one `SetBreakpoints`,
    each with its condition as typed. A `BreakpointSet` on another line
    is answered at that line, which moves the breakpoint in the editor. A
    refusal (`CPD9CCB`, `CPF9C59`) changes nothing on the server, so every
    breakpoint of the request is answered unverified with the server's
    text.
11. **`setVariable` is hidden.** The probe is `Eval` of `NAME = NAME` on
    the first variable without parts, at the first `variables` of a
    session, which changes nothing where an assignment is taken. QS/400's
    `eval_in` (`runtime/mi/src/debug.rs` at `7f82a43f`) looks the whole
    text up as a name, so it answers `CPF7E12` and **Set Value** is not
    shown. Had it succeeded, a `capabilities` event would turn it on.
    `initialize` advertises `supportsSetVariable: false` either way, since
    no session exists yet then.
12. **`ProgramEnd` and `Exception`.** The spec's "as built" notes say this
    build sends neither: an unhandled exception goes to the job's own
    handling and a step past the end runs on. Both are mapped as the
    prompt says and tested. A **Call** session ends when the `CALL`'s
    reply comes: its messages, its escape message last, and `CALL
    PGM(HLINV/ASSETS) ended: Ok` in the Debug Console, then `terminated`.
    So the exit test's "ends with `ProgramEnd` in the Debug Console" reads
    "ended: Ok" against this build.
13. **A second session.** One debug session per connection is the
    spec's rule, and every VS Code debug session has its own connection,
    so two sessions run side by side; `TCP1A72` comes only from a second
    `Start` on one connection, which the adapter never sends. Its mapping
    (the server's text, nothing else sent) is tested with the mock. The
    exit test's "start a second session: `TCP1A72`" therefore does not
    happen as written; attaching to a job already serviced is the
    server's `CPF3503`. This needs a decision if one session at a time is
    wanted (see the Phase 9 exit test).
14. **Terminate cancels before `End`.** `End` first would let a stopped
    job run on to its program's end. `terminate`, and `disconnect` with
    `terminateDebuggee` (true when absent), cancel the `CALL` (`CPF1907`)
    and then send `End`, wait up to 2 s for the `CALL`'s reply, and sign
    off. A service entry point is removed before `End`.
15. **Service entry.** `Start(Own)`, the program added, the breakpoints,
    then `SetServiceEntry` at `configurationDone`, so the breakpoints are
    there when the job stops. No thread is listed until the first stop
    binds the job that called. The adapter's event `qs400/thread {
    threadId, job }` names each job as it becomes a thread, for the status
    bar.
16. **`programs`.** Each is tried as `*PGM`, then as `*SRVPGM` on
    `NotFound`, and a refusal of one is reported in the Debug Console
    without stopping the session. The launched program's refusal stops
    it. **Attach** has no launched program: all of its programs are
    `programs`.
17. **`CPF9C15`.** The extension always sends `recompileOffer`, and the
    adapter then answers the refusal with `showUser: false`, so VS Code
    does not show it beside the extension's notification. The message ID
    is in the error's `variables` (not its `format`, so nothing is
    substituted). The recompile finds the source as decision 7 does (a
    member made writable), runs the compile that applies to it (the one
    last run on its kind when that is a compile, else the first compile
    in merge order, never a batch one) with `DBGVIEW(*SOURCE)` forced into
    the resolved command (`ActionRunner.run`'s new `rewrite`), and offers
    **Start again** with the configuration as it was asked for.
18. **Where the commands are.** On `*PGM` objects in the Objects view; in
    a member's editor title when its program (Phase 4's `&LIBRARY`, the
    current library) is found there by `object.list`, the context key
    `code-for-qs400.debuggable`; on a library project's files in the
    editor title and the Project view. A project file is deployed, then
    compiled when its program is missing or its `changed` is before the
    member's (`object.list` and `member.list` after the deploy). The
    Objects view is now a `TreeView` so its selection can be a default
    program.
19. **The Debug Console** takes `EVAL NAME` as typed at `STRDBG` (the
    `EVAL` is dropped), and `NAME:x`, `NAME:c` and `&NAME` are passed
    through for the server. A hover that fails is not shown. **Pause** is
    refused with a sentence saying a stop needs a breakpoint.

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

## Phase 1 exit test

> Connect to `QSHQ400` as `CWELLMAN`; `QMAXSIGN` lockout and expired
> password surface as the real `CPF` messages.

**Not run yet, 2026-11-07: no QAP server was reachable from the
development machine.** `QSHQ400` does not resolve (as a bare name or under
`ad.quartz.systems` or `quartz.systems`), and the one system configured in the
QS/400 Access configuration there (`QS400`, 10.42.70.150) does not answer
on QAP port 2320. No message IDs from a real system have been seen, so none
are recorded here.

**Library list: unblocked in Phase 2, not run yet.** Until Phase 2 the
pinned `qap-client` had no library list service (Phase 1 decision 1).
Phase 2 pins `qap-client` at `quartz-systems-access` `90d9bba`, whose
`Develop` service (QAP version 8) has `GetLibraryList` and
`SetLibraryList`, and `libl.get` and `libl.set` now call them (Phase 2
decision 2). On 2026-11-07 `QSHQ400` still did not resolve and
10.42.70.150 still did not answer on port 2320, so step 4 below has not
been run against a real system. The host's `libl.*` are tested against
canned `qap-client` replies, including `CPF2110` from `CHGLIBL` and a
server below version 8.

What was checked instead, on Windows x64 with VS Code 1.143.0:

- The host's state machine against canned replies carrying the IDs and
  texts QS/400's sign-on sends: `CPF1107` (password or profile not
  correct), `CPF1392` (the next attempt disables the profile), `CPF1393`
  (`QMAXSIGN` reached, profile or device disabled) and `CPF1394` (profile
  disabled), each passed through as `messageId: text` with nothing added.
  The expired-password case uses `CPD9BAE` from QS/400's QAP test engine;
  the real system's ID for it is still to be seen.
- The real `qap-client` against a closed port: a `-32011` transport error,
  and the session back to `disconnected`.
- The extension against the real host: the tree, the status bar, the
  reconnect and the library list against a fake server, and the
  `win32-x64` VSIX packaged.

To run it, on a machine that reaches `QSHQ400`:

1. Add a connection named `QSHQ400` for `CWELLMAN`. Connect and enter the
   password. Check the status bar reads `QSHQ400 · CWELLMAN`, and hover it:
   the session job is `nnnnnn/CWELLMAN/<jobname>`.
2. Disconnect. Connect with a wrong password, choosing **Ask every time**,
   as many times as `QMAXSIGN` allows. Note each notification's message ID
   and text; they must be the server's own.
   This disables `CWELLMAN`, and a security officer must enable it again
   before step 3.
3. With an expired password: note the message. **Change password** appears
   (Phase 1 decision 2), changes the password and signs on.
4. Library list (needs a server at QAP version 8): add a library, move it
   to the top, set a current library, disconnect and connect: the list
   comes back as saved. `test/live.test.ts` runs steps 1 and 4 when
   `QS400_TEST_HOST`, `QS400_TEST_USER` and `QS400_TEST_PASSWORD` are
   set.
5. Record the result and every message ID seen here.

## Phase 2 exit test

> A member saved from VS Code round-trips byte-identical in `QRPGLESRC`;
> `DSPPFM` shows updated dates.

**Not run yet, 2026-11-07: no QAP server was reachable from the
development machine.** As for Phase 1, `QSHQ400` does not resolve (bare,
under `ad.quartz.systems` or `quartz.systems`) and 10.42.70.150 does not
answer on port 2320; checked at the start of the phase and again at its
end. So there are no `DSPPFM` or `CMPPFM` observations, no message IDs
from a real system, and the library list step of the Phase 1 exit test is
still to run too.

What was checked instead, on Windows x64 with VS Code 1.143.0:

- The host's `object.*` and `member.*` against canned `qap-client`
  replies (`tests/develop.rs`): paging in 500s, filters and patterns sent
  as typed, `seq` and `date` converted only in `members::codec` (edges
  `0000.01`, `9999.99`, `000000`, a date of 0), `renumber` through
  `WriteOptions` alone, and `CPF1002`, `TCP1A5A`, `TCP1A61`, `TCP1A62`,
  `CPF9801` and `CPF7306` passed through with their second-level text.
  Below version 8 every method answers `-32001` with the version and sends
  nothing.
- The save diff's six fixtures through the provider (`test/save.test.ts`),
  each asserting the exact `lines` sent: no change (nothing written), one
  change, insert at the top, two inserts in a gap, an insert with no room
  (`renumber: true`), and deleted lines. All six pass.
- The provider against a fake host: the lock on open, `CPF1002` falling
  back to a read-only open, Open Read-Only without a lock, unlock on
  release, locks taken again after a reconnect, directory listings.
- The Objects view against a fake host, and the `win32-x64` VSIX packaged
  with the new contributions.

To run it, on a machine that reaches `QSHQ400`, signed on as `CWELLMAN`:

1. Set `QS400_TEST_HOST`, `QS400_TEST_USER`, `QS400_TEST_PASSWORD` (and
   `QS400_TEST_SRCPF=HLINV/QTMPSRC`, which must exist) and run `npm test`.
   The Phase 2 live suite runs every scenario below except the lock, on
   copies in `HLINV/QTMPSRC`, and logs the messages it sees.
2. By hand, in the Objects view: open `HLINV/QRPGLESRC/ASSETS.rpgle`, save
   with no change. The host log shows no `member.write`.
3. `CPYSRCF FROMFILE(HLINV/QRPGLESRC) TOFILE(HLINV/QTMPSRC)
   FROMMBR(ASSETS)` at a 5250 session. Save `ASSETS` from VS Code with no
   change, then `CMPPFM NEWFILE(HLINV/QRPGLESRC) NEWMBR(ASSETS)
   OLDFILE(HLINV/QTMPSRC) OLDMBR(ASSETS)`: identical; record the result.
4. Change one line, save, `DSPPFM HLINV/QRPGLESRC ASSETS`: that line has
   today's date and its own sequence number; every other line is as it
   was. Record what `DSPPFM` shows.
5. Insert two lines between two existing ones, save: sequence numbers
   between the neighbours, today's date.
6. Insert where no gap remains: the member is renumbered from `0001.00`,
   with a notification.
7. In `HLINV/QTMPSRC`, from the tree: New Member, Copy, Rename, Delete
   (it asks, naming the member). Check each in `WRKMBRPDM`.
8. Hold `ASSETS` with `STRSEU` at a 5250 session and open it in VS Code:
   the `CPF1002` text is shown and the document is read-only.
9. Record the result, the `DSPPFM` and `CMPPFM` observations and every
   message ID seen here.

## Phase 3 exit test

> Edit a UTF-8 file and an EBCDIC-tagged file; both reopen correctly at
> 5250 `EDTF`.

**Not run yet, 2026-11-07: no QAP server was reachable from the
development machine.** `QSHQ400` does not resolve (bare, under
`ad.quartz.systems` or `quartz.systems`), checked at the start of the
phase and again at 23:24 at its end. 10.42.70.150 now actively refuses
port 2320, where in Phases 1 and 2 it did not answer at all: the machine is
up, but no QAP server listens there. So there are no `EDTF` or `WRKLNK`
observations, no checksum from a real transfer, and no message IDs from a
real system.

What was checked instead, on Windows x64 with VS Code 1.143.0:

- The host's `ifs.*` against canned replies through `qap-client`'s own
  `Files`, `read` and `write` (`tests/ifs.rs`, 33 tests): paging 1,203
  entries in 500s, the stamp before the data and the `Stat`/`GetInfo`
  fallback at version 5, text read in 1 MiB chunks joined on whole
  characters, a CCSID 37 file read and written through the server's
  conversion, the 10 MiB cap (exactly 10 MiB reads; one byte more is
  `-32021` and nothing is read), the `expect` refusal (no `WriteFile`
  sent), `TCP1A5A` on read and on write with the file unchanged, `CPFA0A9`,
  `CPFA0A0` and `CPFA0AC` passed through with their second-level text, a
  3 MiB download byte for byte, a five-chunk upload cancelled at the third
  write (offset two chunks, the system holding three) and resumed from the
  system's size to the same bytes, `replace` starting again, and progress
  no more often than every 250 ms.
- `host-rpc`'s deferred methods: an answer from another thread after the
  request behind it, `dispatch` waiting for it, and a dropped responder
  still answering.
- The extension against a fake host (`ifsView`, `ifsProvider`,
  `ifsCommands`, `ifsTransfers`): the binary-extension table, the
  languages, Overwrite and Reload, an unchanged save not written, a new
  file made as 1208, the image read through a temporary file, a
  non-empty delete on a fixture tree children first and root last, folder
  copy, and uploads cancelled and resumed.
- The `win32-x64` VSIX packaged with the new contributions.

To run it, on a machine that reaches `QSHQ400`, signed on as `CWELLMAN`:

1. Set `QS400_TEST_HOST`, `QS400_TEST_USER`, `QS400_TEST_PASSWORD` and run
   `npm test`. The Phase 3 live suite makes `/home/CWELLMAN/code-test`,
   runs the UTF-8 and CCSID 37 round-trips, the `TCP1A5A` refusal, the
   20 MB upload cancelled half way, resumed and downloaded with its
   sha256, the folder round-trip, rename, copy and delete, the `.png` and
   the size refusal, logs every message it sees, and removes the
   directory. Record its `live:` lines.
2. By hand, in the IFS view, under `/home/CWELLMAN/code-test` (make it with
   **New Folder…**): **New File…** `utf8.txt`, CCSID 1208; type a line
   with `é` and `—`; save. At a 5250 session,
   `EDTF '/home/CWELLMAN/code-test/utf8.txt'` shows the line as typed, and
   `WRKLNK '/home/CWELLMAN/code-test/*'` option 8 shows CCSID 1208.
3. **New File…** `ebcdic.txt`, CCSID 37; type a line; save. `EDTF` shows it;
   `WRKLNK` shows CCSID 37. Close the tab and open it again: it reads as
   typed. Add a character CCSID 37 lacks (an emoji) and save: the
   notification shows `TCP1A5A` and `EDTF` still shows the line before it.
4. **Upload Files…** a 20 MB file; Cancel half way. The tree marks it
   `partial upload`; `WRKLNK` shows the partial size. **Resume**: it ends
   at the full size. **Download…** it and compare `sha256` with the
   original.
5. **Upload Folder…** a folder of three files; **Download Folder…** it into
   a new local folder; compare the trees.
6. Rename, Copy to… and Delete from the tree, checking each in `WRKLNK`;
   Delete on a folder that is not empty names its count first.
7. Open a `.png`: VS Code's image preview shows it. Open a 50 MB file: the
   message names its size and the 10 MiB limit, and offers Download.
8. Record the result, the `EDTF` and `WRKLNK` observations, the checksums
   and every message ID seen here.

## Phase 4 exit test

> `CRTBNDRPG` with an error on line 42 shows a Problems entry at line 42
> of the open member.

**Not run yet, 2026-11-08: no QAP server was reachable from the
development machine.** `QSHQ400` does not resolve (bare, under
`ad.quartz.systems` or `quartz.systems`), checked at the start of the
phase and again at 00:15 at its end. 10.42.70.150 answers ping but
refuses port 2320, as at the end of Phase 3. So no compile has run against
a real system: there are no diagnostic IDs or line placements observed
live, and no message IDs from a real system are recorded here. The IDs
below are the canned ones, taken from QS/400's own message files at
`7f82a43f` (`runtime/msgf/msgs/qrpglemsg.toml`, `qcpfmsg.toml`).

What was checked instead, on Windows x64 with VS Code 1.143.0:

- The host's `action.*` and `job.log` against canned replies through
  `qap-client`'s own `Develop::compile`, `Jobs::job_log` and outcomes
  (`tests/actions.rs`, 19 tests): a compile sent as `Compile` and a `CALL`
  as `RunCommand`; an `Error` compile with its body still filled (escape
  `RNS9310`, `RNF7030` at line 42 columns 9 to 17 of the member, a second
  on a `/COPY` member, one on a stream file, one nowhere); `RNS9304` on a
  clean compile; `CPF9812` for a wrong `SRCFILE` as the escape, unchanged;
  a run cancelled in the lane coming back `Cancelled` with no job and no
  messages, and one cancelled once started keeping its body; `Busy` as the
  server's refusal; version 7 refused before anything is sent;
  `CheckCommand` answering `CPD0030` for `CRTBNDRPGX`; the job log of the
  connection job drained in pages of 500 (1,203 entries) and `CPF1321` for
  an ended job.
- The extension against fake hosts (`actions`, `run`, `diagnostics` and
  `jobLog` suites): merge order, every variable for a member, a stream
  file and an object, `&CUSTOM:` and the unresolved-variable error; the
  check results on the right JSON line; the severity table; placement for
  `Member`, `Path` and `None` with `column` 0 and `end_line` 0; a clean
  compile clearing the target and its `/COPY` member; save before run; the
  output block; the job log's lines and hover.
- The defaults: every one parses, the spec's 13 compiles each run as a
  compile, `DBGVIEW(*SOURCE)` on the six commands whose definitions take it.
- The `win32-x64` VSIX packaged, carrying `defaults/actions.json` and
  `schemas/actions.json`; its minified bundle activates, shows About, and
  runs the actions suites in VS Code 1.143.0. That check found the
  `jsonc-parser` bundling fault of Phase 4 decision 9, which stopped the
  extension activating at all.

To run it, on a machine that reaches `QSHQ400`, signed on as `CWELLMAN`:

1. Set `QS400_TEST_HOST`, `QS400_TEST_USER`, `QS400_TEST_PASSWORD` (and
   `QS400_TEST_SRCPF=HLINV/QTMPSRC`, `QS400_TEST_CURLIB` if not
   `CWELLMAN`) and run `npm test`. The Phase 4 live suite copies
   `HLINV/QRPGLESRC(ASSETS)` to `QS4ACT42`, breaks line 42, compiles,
   fixes, compiles again, `CALL`s `HLINV/ASSETS`, checks `CRTBNDRPGX`,
   compiles with a wrong `SRCFILE`, reads the job log, and removes its
   member. Record its `live:` lines.
2. By hand: `CPYSRCF FROMFILE(HLINV/QRPGLESRC) TOFILE(HLINV/QTMPSRC)
   FROMMBR(ASSETS) TOMBR(ASSETS42)`. Open `HLINV/QTMPSRC/ASSETS42` from the
   Objects view, change line 42 to use a name nothing defines, save, and
   run **Compile (CRTBNDRPG)** from the editor title. The Problems panel
   shows one error at line 42 of that document with the ID the compile
   listing shows (`RNF7030` for an undefined name); hovering it shows the
   second-level text; clicking it goes to line 42.
3. Fix the line and run it again: the Problems entry clears, and the
   **Code for QS/400** output channel shows the completion message and
   the job.
4. In the Objects view, **Run Action…** on `HLINV/ASSETS` (`*PGM`), **Call
   (CALL)**: the output channel shows the messages; nothing is added to
   the Problems panel.
5. Add an action with `CRTBNDRPGX` to `.vscode/actions.json` and save: the
   `CheckCommand` message shows on that action's `command` line, and the
   action is listed, marked, in the pick.
6. Run the compile with `&SRCFILE` wrong on purpose (`SRCFILE(&SRCLIB/QNOSRC)`
   in a copy of the action): the escape message is the system's own ID and
   text.
7. **Job Log**: the messages of the runs above, newest at the bottom; each
   ID's hover shows its second-level text.
8. Record the result, the diagnostic IDs and their line placement, and
   every message ID seen here.

## Phase 5 exit test

> Diagnostics in the editor match the compiler listing line for line on
> the `HLINV` fixture sources.

**Not run yet, 2026-11-08: no QAP server was reachable from the
development machine.** `QSHQ400` does not resolve (bare, under
`ad.quartz.systems` or `quartz.systems`), checked at the start of the
phase and again at 02:00 at its end; 10.42.70.150 answers ping and refuses
port 2320, as at the end of Phase 4. So no member was compiled, no
compile was recorded in `host/fixtures/parity/`, and none of the steps
below has been seen against a real system.

Parity per source file:

| Source file | Result |
| --- | --- |
| `HLINV/QRPGLESRC` | not run |
| `HLINV/QCLSRC` | not run |
| `HLINV/QDDSSRC` | not run |
| `HLINV/QSQLSRC` | not run |

Differences to expect when it runs, from the front-ends' source at
`5e2bbee9` (decisions 3 and 4), not from a comparison:

- **compiler only**, RPG: every message of the RPG compiler proper
  (`RNF7030`, `RNF7031`, `RNF7066`, `RNF5318`...), which `rpgfront`'s
  `front` does not report. The exit test's step 3 (`RNF7030` as you
  type) fails for the same reason.
- **compiler only**, DDS: any message on a DSPF or ICFF member, which is
  not analyzed.
- **editor only**, CL: `CPD0744 file LIB/FILE was not found` on each
  `DCLF`, where the compile has the file.
- **editor only**, DDS: the messages of a `PFILE`, `JFILE`, `REF` or
  `REFFLD` the front end cannot find, where the compile has the file.

For an indication, the front-ends were run on the copy of HLINV that
QS/400's conformance tests use (`tools/conformance/hlinv/src` in a local
`quartz-systems-400` checkout at `5e2bbee9`). That copy is an inventory
application without an `ASSETS` member, so it is not the `HLINV` on
`QSHQ400`. On it the editor reports: nothing on the six RPG members, on
`QCLSRC(INVBUILD)` (no `DCLF`), on the two PFs or on `QSQLSRC(INVSEED)`;
`DDS1001`, `DDS1022` twice and `DDS3002` on each LF, whose `PFILE` it
cannot read; `DDS5002` five times on `REORDRPTP` and eight on `STKRPTP`
(the PRTFs whose type `Y` QS/400's `known.txt` records as refused by the
real system too); and nothing on the four DSPFs, which are not analyzed.

What was checked instead, on Windows x64 with VS Code 1.143.0:

- The five servers through the protocol (`lsp-<lang>/tests`), over an
  in-memory connection with a mock client: diagnostics with their IDs,
  ranges and second-level text, the outline, definition, hover,
  completion, rename and folding on one source per language; `/COPY`
  fetched once and cached for every document, not found cached, a save
  fetching again, nothing published before every fetch was answered, an
  include's message summarized on its directive and moved to the include
  when it opens; the 300 ms debounce (four changes, one publish, after the
  delay); a DSPF analyzed as nothing.
- Positions: UTF-16 against characters (`é`, an emoji, fixed-form
  columns), the Problems panel's placement rules, and the severity table
  read from the one JSON file by both sides.
- The real `qs400-code-host lsp rpgle` process: `initialize`, a published
  `RNF5014`, `shutdown`, `exit` with 0.
- The extension against the real host binary: diagnostics as you type
  (`RNF5014` on a new line, gone when it is deleted), each of the five
  servers publishing from local files, `qs400/fetchInclude` round-tripping
  through a real language client into a summary, Go to Definition into
  the copy member's read-only URI at the declaration, the outline, and
  the `fetchInclude` handler for a member, `*LIBL`, a stream file and not
  found.
- Fixed-form RPG: the server's `rpgspecs` table, each specification
  picked per line, guides only where a line reaches, the status bar's
  `D · Ds 24–25 · col 24`, none for `**FREE`.
- The grammar snapshots for RPG (fixed, `**FREE`, both kinds of embedded
  SQL), CL, PF, LF, DSPF, PRTF, SQL and CMD.
- The offline parity harness: its comparison, its table and a record run
  through the front end with an include; with no record it says so and
  passes.
- `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and the
  whole workspace's tests; the five language crates also built for
  `x86_64-unknown-linux-musl`. `npm run lint` and the full extension
  suite (176 passing, the live suites pending), and the language suites
  again on the minified bundle of the packaged `win32-x64` VSIX, which
  carries the five grammars and configurations.

To run it, on a machine that reaches `QSHQ400`, signed on as `CWELLMAN`:

1. Set `QS400_TEST_HOST`, `QS400_TEST_USER`, `QS400_TEST_PASSWORD` (and
   `QS400_TEST_CURLIB` if not `CWELLMAN`; the compiles' objects stay
   there), with `QS400_PARITY_RECORD=1`, and run `npm test`. The Phase 5
   live suite compares every member of the four source files and prints
   a `live:` line per member and a table of every difference; it also
   runs steps 2 to 4 and 6 below. Record the `live: parity` line and the
   table here, per source file, differences included, and commit the
   records it wrote to `host/fixtures/parity/` (the members' text stays
   out, by `.gitignore`).
2. Open `HLINV/QRPGLESRC/ASSETS.rpgle` and go to definition on a field
   declared in a `/COPY` member: the copy member opens read-only at the
   declaration.
3. Type an undefined name on a new line: `RNF7030` appears within half a
   second, with the second-level text on hover, and goes when the line is
   deleted. At `5e2bbee9` it does not appear (see above); record what
   does.
4. In a fixed-form RPG member the guides sit at the specification
   boundaries and the status bar shows the column's field; in a `**FREE`
   member there are none.
5. Outline: the member's subprocedures, files, data structures and
   fields. Rename a local variable: every reference in the document
   changes, nothing outside it.
6. `cargo test -p code-host --test parity` with the records: the same
   differences as step 1, without the system.
7. Report each difference to `quartz-systems-400` with its member, line
   and ID.

## Phase 6 exit test

> Query `HLINV.ASSETS`, export CSV, open a view's columns from the
> explorer.

**Not run yet, 2026-11-08: no QAP server was reachable from the
development machine.** `QSHQ400` does not resolve (bare, under
`ad.quartz.systems` or `quartz.systems`), checked at the start of the
phase (02:11) and again at its end (02:51); 10.42.70.150 answers ping and
refuses port 2320, as at the end of Phase 5. So no statement has run
against a real system: there is no CSV row count against `COUNT(*)`, no
`DSPFFD` or `DSPDBR` comparison, and none of the message IDs below is
one seen from a real system.

| Step | Result |
| --- | --- |
| `SELECT * FROM HLINV.ASSETS`: types, rows, footer | not run |
| Export CSV rows against `SELECT COUNT(*)` | not run |
| A view's columns against `DSPFFD`; `HLINV.ASSETS`'s indexes against `DSPDBR` | not run |
| `UPDATE HLINV.ASSETS SET NOTES = NOTES WHERE 1 = 0`: `0 rows updated` | not run |
| A syntax error: the server's ID in the tab and the Problems panel, `lsp-sql` first | not run |
| `*CHG`: `INSERT`, Rollback, gone; `INSERT`, Commit, kept | not run |
| History: three runs, the first again | not run |

Message IDs to expect, from QS/400's `docs/QAP.md` at `7f82a43f` ("Version
4 Sql, as built") and its message files, not from a run: `SQL0104` for the
syntax error (SQLSTATE `42601`), `SQL0752` for a commit level change while
uncommitted, `SQL7008` (`55019`) if `HLINV` is not journaled when the
`*CHG` step inserts, `SQL0551` for a table the profile may not read,
`SQL0952` for a cancel. The editor's own diagnostic for the syntax error
before the run is the front end's `SQL0104`, as `lsp-sql`'s test sees it
at `5e2bbee9`.

What was checked instead, on Windows x64 with VS Code 1.143.0:

- The host's `sql.*` against canned replies (`tests/sql.rs`, 27 tests):
  `Prepare`, `Execute` and the first `Fetch` of 500 for a query, the
  cursor and statement kept until the end and then closed and released in
  that order; a query that ends on its first fetch closing at once; Load
  more to the end and nothing sent past it; `sql.close` of an open result;
  an `UPDATE`'s count with its statement released at once and no fetch; a
  DDL statement with no count; `SQL0104` with SQLSTATE `42601` and SQLCODE
  `-104` passed through with its second-level text; `SQL0803` at
  `Execute` with its failing row, the statement released; a run cancelled
  while it executed coming back with its count and `SQL0952`; options kept
  before the connection attaches and sent when it does, `uncommitted`
  after an `INSERT` under `*CHG`, `SQL0752` leaving the options as they
  were, Rollback and Commit clearing it; a lost connection sending
  `sql.lost` and its old cursors refused; disconnect closing the SQL
  connection and the next run attaching anew; version 3 refused before
  anything is sent; an export of 1,203 rows (500 held, two pages fetched)
  with progress, a second export refused, an export of a result already
  at its end, a cancelled export removing its file; schemas paged 1,203
  in 500s; tables, columns, routines and indexes, `SQL0551` on columns,
  and version 6 refusing routines and indexes.
- `sql::values` at its edges: ±(2⁵³ − 1) as numbers and ±2⁵³, `i64::MIN`
  and `i64::MAX` as text; negative and `DECFLOAT` decimals as sent; dates
  from 0001-01-01 to 9999-12-31 and before 1970; times with and without
  milliseconds and 24:00:00; timestamps at scale 0, 3, 6 and 12 from the
  picoseconds; hex, Booleans, `NULL`. `sql::csv`: quotes, commas, CR and
  LF quoted, `""` apart from an empty `NULL`, CRLF, no byte order mark.
- `lsp-sql`'s `qs400/sqlStatements` over strings and comments holding
  `;`, a doubled quote, a statement that does not parse and one with no
  `;`.
- The extension against the real host's SQL language server: every
  fixture split the same way by the server and by `statements.ts`; and
  against fake hosts: Run Statement on the statement under the cursor, a
  selection, and the whole document stopping at `SQL0104` with one
  Problems entry on the statement's first line, cleared by the next run;
  the result panel's typed headers, `500 of more`, Load more to `1007
  rows`, 20 tabs kept with the oldest cursor closed, closing a tab and the
  panel closing cursors, `0 rows updated`, the error view, a lost
  connection stopping Load more; Export CSV and a cancelled export; the
  SQL view's schemas by pattern, groups, a view's columns with their
  tooltips, indexes, routines, the QAP 3 line; Copy CALL from `SYSPARMS`,
  View data and Generate SELECT; the history's cap of 50, its entries and
  Run Again.
- The results page in a DOM (jsdom, outside the repository): the tab
  strip, typed headers, 20 rows drawn for an empty viewport, `-` for
  `NULL`, hex with its copy button, Load more and Copy posted, appended
  rows and the error view.
- `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and the
  whole workspace's tests; `npm run lint` and the full extension suite
  (197 passing, the live suites pending); the `win32-x64` VSIX packaged.

To run it, on a machine that reaches `QSHQ400`, signed on as `CWELLMAN`:

1. Set `QS400_TEST_HOST`, `QS400_TEST_USER` and `QS400_TEST_PASSWORD` and
   run `npm test`. The Phase 6 live suite runs the query, the count, the
   export and its row check, lists `HLINV`'s views with a view's columns
   and `HLINV.ASSETS`'s indexes, runs the `UPDATE`, the syntax error, the
   commit and rollback pair on `HLINV.QS4SQL6` (which it makes and
   drops), and the history steps, and logs every message ID it sees.
   Record its `live:` lines here.
2. By hand: **New SQL Editor**, type `SELECT * FROM HLINV.ASSETS` and press
   `Ctrl+Enter`. The result tab shows each column's SQL type, the rows,
   and `n rows` or `500 of more` with **Load more**. **Export CSV**; open
   the file: its record count is `SELECT COUNT(*) FROM HLINV.ASSETS`,
   decimals as the grid shows them, dates `YYYY-MM-DD`, `NULL` empty.
3. In the SQL view, expand `HLINV` → Views → `ASSETS_BY_SITE` (or any
   view there) → Columns. Compare names, types, lengths, nullable and
   text with `DSPFFD`. Expand `HLINV` → Tables → `ASSETS` → Indexes and
   compare with `DSPDBR HLINV/ASSETS`.
4. Run `UPDATE HLINV.ASSETS SET NOTES = NOTES WHERE 1 = 0`: `0 rows
   updated`, no grid.
5. Type `SELECT * FORM HLINV.ASSETS`: the editor flags the line; run it:
   the server's ID and text in the result tab and in the Problems panel on
   that line.
6. From the status bar item, set the commit level to `*CHG`; `INSERT`
   into a scratch table; **Rollback**: the row is gone. `INSERT` again;
   **Commit**: it stays.
7. Run three statements; **SQL History**: all three with their times and
   counts; **Run Again** on the first.
8. Record the result, the CSV row count against `COUNT(*)`, the `DSPFFD`
   and `DSPDBR` observations and every message ID seen here.

## Phase 7 exit test

> Compile output spooled file opens from the Actions result; an inquiry
> reply clears the message.

**Not run yet, 2026-11-08: no QAP server was reachable from the
development machine.** `QSHQ400` does not resolve (bare, under
`ad.quartz.systems` or `quartz.systems`), checked at the start of the
phase (08:36) and again at its end (09:19); 10.42.70.150 answers ping and
refuses port 2320, as at the end of Phase 6. So no compile listing has
been read from a real system, no inquiry has arrived from one, and the
event latency below is not a measurement.

| Step | Result |
| --- | --- |
| Compile `HLINV/QRPGLESRC/ASSETS`: `Listing: Open` opens `QSYSPRT`, 132 columns, page breaks, the `RNF` summary; **Save as PDF** | not run |
| Hold from the viewer (`Held` in the tree), release, delete with confirmation | not run |
| `SNDMSG MSG('reply test') TOUSR(CWELLMAN) MSGTYPE(*INQ)` at 5250: badge 1, notification with **Reply**; reply `OK`; `DSPMSG` shows it | not run |
| `SBMJOB CMD(DLYJOB 300) JOB(CODETEST)`: Active, its log, **End** `*IMMED` | not run |
| Send a message to yourself: listed with its key and time | not run |

**Event latency to expect**, from QS/400's `docs/QAP.md` at `7f82a43f`
("Version 6, as built") and the host's code, not from a run: the server
looks at each watch every 250 ms (`Config::watch_poll`); the event wakes
the host's watcher at once through the connection's `Wake`, which takes it
from the client and sends `messages.arrived`. So an inquiry should show
within about a quarter of a second, well inside the exit test's "few
seconds"; a session busy with a long call sends it when the call ends.
The live suite logs `live: inquiry … arrived N ms after the send`.

Message IDs to expect, from the spec and QS/400's message files at
`7f82a43f`, not from a run: `CPC1221` for the `SBMJOB`, `CPF1321` for the
log of an ended job without a spooled log, `CPF1362` for ending a job that
has ended, `CPF2422` for replying twice, `CPF2420` for a reply the message
does not take, `TCP1A57` for reading a spooled file still open,
`CPF3337` for releasing one not held.

What was checked instead, on Windows x64 with VS Code 1.143.0:

- The host's `jobs.*`, `spool.*` and `messages.*` against canned replies
  (`tests/work.rs`, 43 tests): 1,203 jobs and 1,203 log entries drained in
  500s; `user` and `state` passed as typed; `CPF1343` (another user's
  jobs), `CPF2204`, `CPF1321` and `CPF1362` passed through with their
  second-level text; `end` with `immediate`, `controlled` with and without
  a delay, and a delay with `*IMMED` refused before anything is sent;
  version 7 refusing `Jobs`; spooled files filtered to a job, the filters
  passed as typed, `NotAuthorized` passed through, output queues;
  `readText` of a three-page listing with a 132-column line, whole and as
  a range, its form feeds kept, `TCP1A57` for a file still open; hold at
  the end of the page and immediately, release, move to the top of a
  queue, delete, `CPF3337`, ids checked first; downloads as PDF (starting
  `%PDF`), text and SCS in one batch of 25 pages with `spool.progress`, a
  refused one leaving no file; `spool.changed` for added, removed and
  rewatched, and events taken after an unrelated call; `spool.awaitFile`
  answering on the first closed file of its job (not while `Open`), from a
  list made before its watch, `null` after its timeout and when the
  session ends, and the watch kept while the view or a wait still wants it;
  `messages.list` newest first in 500s with keys as hex, `reply` with the
  key either case and an empty reply as typed, `CPF2422`, `remove` all or
  none, `send` answering an inquiry's key, `CPF2403`, `canRead` false only
  for `NotAuthorized`, `messages.arrived` with `caughtUp`, a refused watch
  (`CPF9802`), version 5 refusing `Messages`. The codecs at their edges:
  keys `00000001` to `FFFFFFFF` both ways, job names, queues, recipients,
  targets and every enum name.
- The extension against fake hosts (`jobs`, `spool`, `viewer`, `messages`
  and `run` suites): the Jobs view grouped by state with the connection job
  marked, the filter saved per connection, `CPF1343` shown in the tree, the
  job log of any job from `jobs.log` with `from → to` in its hover; the
  Spooled files view's roots, descriptions, the library saved per
  connection, a job's node, `spool.changed` refreshing it and counting new
  files; the viewer on a three-page listing with a 132-column line: page
  markers on empty lines, every printed line unchanged, Go to Page and the
  status bar's `Page 3 of 3`, rulers at 80 and 132 and no word wrap, a
  2,500-page file opened at 100 pages and Load All Pages; the Messages
  view's inquiries first, System operator only when readable, the badge
  through arrivals, replies and a look, and `code-for-qs400.messages.notify`
  as `inquiries`, `all` and `none`; a compile's listing found by its job and
  number, none when the run made none, a batch run's by
  `spool.awaitFile`, and every output channel link.
- `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and the
  whole workspace's tests; `npm run lint` and the full extension suite
  (231 passing, the live suites pending); the `win32-x64` VSIX packaged,
  carrying the five job log glyphs.

To run it, on a machine that reaches `QSHQ400`, signed on as `CWELLMAN`:

1. Set `QS400_TEST_HOST`, `QS400_TEST_USER` and `QS400_TEST_PASSWORD` (and
   `QS400_TEST_SRCPF`, `QS400_TEST_CURLIB` as for Phase 4) and run
   `npm test`. The Phase 7 live suite compiles `QS4SPL7`, reads its
   listing, saves it as PDF, holds, releases and deletes it, submits and
   ends `CODETEST`, and sends itself an inquiry and a message. Record its
   `live:` lines here, the inquiry's latency among them.
2. By hand: run **Compile (CRTBNDRPG)** on `HLINV/QRPGLESRC/ASSETS`. In the
   **Code for QS/400** output channel, **Open** on `Listing: Open` shows
   the new `QSYSPRT` in the viewer: 132 columns intact (the ruler at 132
   meets the right margin), `— page n —` at each break, the `RNF` summary
   on the last page. **Save as PDF…** from its title bar; open the file.
3. **Hold** from the viewer's title bar: the Spooled files view shows
   `Held`. **Release**; **Delete**, which names the file and the job.
4. At a 5250 session, `SNDMSG MSG('reply test') TOUSR(CWELLMAN)
   MSGTYPE(*INQ)`. Within a few seconds the Messages view's badge shows 1
   and a notification offers **Reply**; reply `OK`. The message leaves the
   inquiries at the top of the list, and `DSPMSG` at the 5250 session shows
   the reply.
5. Submit `SBMJOB CMD(DLYJOB DLY(300)) JOB(CODETEST)` from **Run
   Action…** (a connection action with that `command` and `"environment":
   "object"`; Phase 4's own batch actions name the job after their
   target). **Refresh Jobs**: `CODETEST` is under Active; **Job Log**
   opens; **End Job…** offers `*CNTRLD` and `*IMMED` and confirms
   `End job nnnnnn/CWELLMAN/CODETEST *IMMED?`; after the next refresh it is
   no longer Active.
6. **Send Message…** to your own profile: it is listed with its key and
   time.
7. Record the result, the latency, and every message ID seen here.

## Phase 8 exit test

> Clone `HLINV` sources locally, change one file, deploy, compile; only
> the changed member is rewritten.

**Not run yet, 2026-11-08: the system could not be signed on to.**
`QSHQ400` does not resolve (bare, under `ad.quartz.systems` or
`quartz.systems`), checked at the start of the phase (09:27) and again at
its end (10:17). 10.42.70.150 has changed since Phase 7: it no longer
answers ping, but its port 2320 now **accepts** a TCP connection, where in
Phases 3 to 7 it refused it. No `QS400_TEST_*` variables were set on the
development machine and no password was at hand, so nothing signed on
there, and whether a QAP server answers on that port is not known. So no
member was pulled from or deployed to a real system, and no timestamp
below is observed.

| Step | Result |
| --- | --- |
| **Pull Library…** `HLINV` into an empty folder, target `HLINVDEV` (`CRTLIB`, `CRTSRCPF` per source file); `git init` and commit | not run |
| **Deploy all**: every member in `HLINVDEV` with `HLINV`'s text and type; `DSPFD` member counts match the folder | not run |
| `DSPFD *MBRLIST` timestamps; one line of `ASSETS.rpgle` changed; **Deploy changed**: one timestamp moved, that line dated today, every other line's seq and date kept | not run |
| **Compile (CRTBNDRPG)** on the local `ASSETS.rpgle`: deployed, compiled into `HLINVDEV`, the error on line 42 in Problems on the local file | not run |
| `STRSEU` at a 5250 session, then **Deploy changed**: Conflict in the Project view, Overwrite / Pull / Skip | not run |
| `git stash`, **Deploy git-changed**: nothing to deploy | not run |

Members **Deploy changed** wrote: not observed. Against the fake system of
`test/deploy.test.ts` and in the host's `deploy.member` sequence it is one
(`QRPGLESRC/ASSETS`), every other member untouched.

What was checked instead, on Windows x64 with VS Code 1.143.0:

- The host's `deploy.*` (`deploy.rs`, 15 unit tests, and the registry):
  `deploy::plan` on Phase 2's six save fixtures and its gaps; an existing
  member listed, read with `lock: true`, written with the diff and listed
  again, with no unlock after the write; nothing to write unlocking and
  keeping the timestamp; a new member created with its type and text and
  written with `renumber: true`, every line `0000.00`/`000000`; a newer
  `changed` refused with `-32050` before anything is locked; a refused write
  ending the lock; a member of another type changed to the file's; a new
  stream file's directory made and the file uploaded with Replace and the
  CCSID, and an existing one checked against its change counter. Through
  the registry on `tests/develop.rs`'s `Develop` fake and `tests/ifs.rs`'s
  `Files` over a real `Connection`: `list_members` with the member as the
  pattern, `read_member lock=true`, `write_member` with every seq and date
  kept on the one changed line, `create_member`; `Stat`, `Stat` of the
  parent, `CreateDirectory parents=true`, `WriteFile Replace ccsid=1208`,
  `Stat`, and `ifs.progress` under the deploy's transfer.
- The extension against fake systems (`projects`, `pull`, `deploy`,
  `localActions`, `workspaceIncludes`, `projectView` suites, 47 tests):
  the project file's every problem at its place; the layout both ways over
  the whole type table, clashes; pull of four source files into the layout
  with the project file, texts, state and `.gitignore`, Overwrite and Keep;
  **Deploy all** into a new library with `CRTSRCPF` asked once, every member
  with its type and text; **Deploy changed** after one change sending one
  `deploy.member` and moving one timestamp; a member changed on the system
  listed first and Skipped, Pulled and Overwritten; a removed file left on
  the system; an IFS project's uploads and its conflict; git-changed through
  a mock git API, nothing after a stash, Deploy changed without a
  repository; a compile on a local file deployed first, run as
  `CRTBNDRPG PGM(HLINVDEV/ASSETS) SRCFILE(HLINVDEV/QRPGLESRC)`, with its
  line 42 error on the local file and a member with no local file left on
  its `qs400mbr` URI; a file in conflict not compiled; includes from the
  workspace first and the system second; the Project view's states, the
  ignored group folded, Conflict after Refresh, the status bar's count.
- `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and the
  whole workspace's tests; `npm run lint` and the full extension suite
  (270 passing, the live suites pending), again on the release host the
  `win32-x64` VSIX was packaged with, which carries
  `schemas/qs400project.json`.

To run it, on a machine that reaches `QSHQ400`, signed on as `CWELLMAN`:

1. Set `QS400_TEST_HOST`, `QS400_TEST_USER` and `QS400_TEST_PASSWORD` (and
   `QS400_TEST_CURLIB` if not `CWELLMAN`), with `git` on `PATH`, and run
   `npm test`. The Phase 8 live suite deletes and makes `HLINVDEV`, pulls
   `HLINV`'s four source files into a temporary folder, commits, deploys
   all and compares every member's type and text and each file's count,
   changes one line of `ASSETS` and deploys, checks that one `changed`
   moved and the line's seq and date, compiles with line 42 broken, writes
   the member from the host and checks the conflict and the Project view,
   stashes and deploys git-changed, and deletes `HLINVDEV`. Record its
   `live:` lines, the timestamps among them.
2. By hand, in an empty folder opened in VS Code: **Pull Library…** →
   `HLINV` → all source files → target `HLINVDEV` (after `CRTLIB
   HLINVDEV` at a 5250 session). The folder has `QRPGLESRC/ASSETS.rpgle`,
   `QCLSRC/…`, `QDDSSRC/…`, `QSQLSRC/…` and `qs400project.json`. `git init`,
   `git add -A`, `git commit`.
3. **Deploy All**: confirm the `CRTSRCPF`s. `DSPFD FILE(HLINVDEV/QRPGLESRC)
   TYPE(*MBRLIST)` (and each other file): the member count is the folder's;
   `WRKMBRPDM` shows each member's type and text as in `HLINV`.
4. Note each member's change date and time from `DSPFD *MBRLIST`. Change one
   line of `ASSETS.rpgle`; **Deploy Changed**. `DSPFD *MBRLIST` again:
   only `ASSETS` moved. `DSPPFM HLINVDEV/QRPGLESRC ASSETS`: the changed line
   has today's date and its own sequence number, every other line as
   before. Record the timestamps.
5. Break line 42 of the local `ASSETS.rpgle`; **Run Action… → Compile
   (CRTBNDRPG)** from its editor title: the output shows the deploy and
   then `CRTBNDRPG PGM(HLINVDEV/ASSETS) SRCFILE(HLINVDEV/QRPGLESRC)…`; the
   Problems panel has the error on the local file at line 42. Fix it.
6. `STRSEU SRCFILE(HLINVDEV/QRPGLESRC) SRCMBR(ASSETS)`, change a line,
   save. Change a line locally; **Deploy Changed**: the output lists the
   conflict first, the question offers Overwrite, Pull and Skip, and the
   Project view marks the file Conflict.
7. `git stash`; **Deploy Git-Changed**: the output says `Nothing to deploy`.
8. Record the result, the timestamps and every message ID seen here.

## Phase 9 exit test

> Breakpoint in an `HLINV` program hit from an interactive 5250 job;
> variables shown; step over and continue.

**Not run yet, 2026-11-08: the system could not be signed on to.**
`QSHQ400` does not resolve (bare, under `ad.quartz.systems` or
`quartz.systems`), checked at the start of the phase and again at 11:11 at
its end. 10.42.70.150 does not answer ping and accepts a TCP connection on
port 2320, as at the end of Phase 8; new this phase, a TLS handshake there
(no sign-on) completes as TLS 1.3 with a self-signed certificate,
`C=US, O=Quartz Systems, CN=qs400`, so a QS/400 server listens there and a
connection to it needs that certificate in `tls.caFile`. No `QS400_TEST_*`
variables were set and no password was at hand, and nothing signed on with
a guessed one (it would count against `QMAXSIGN`). QS/400 Access for
Desktop was not run. So no program has been debugged on a real system,
and no message ID, line or latency below is observed.

| Step | Result |
| --- | --- |
| Compile `HLINV/ASSETS` (`DBGVIEW(*SOURCE)`); breakpoint in the main procedure; **Call**: hit, the editor at the line, Call Stack `ASSETS › ASSETS › main · stmt n`, Variables, a data structure's subfields, hover | not run |
| **Step Over** one statement; **Continue** to the end; the end in the Debug Console | not run |
| **Service entry** on `HLINV/ASSETS`; `CALL HLINV/ASSETS` at a 5250 session as `CWELLMAN`: keyboard locked, stop with `reason: entry`, the 5250 job in the Call Stack and status bar | not run (manual) |
| **Set Value** of a field, **Continue**, the display shows it | not run; **Set Value** is hidden (decision 11) |
| Conditional breakpoint `ASSETCOUNT > 3` through a loop: stops only when it holds | not run |
| **Call** on a program compiled `DBGVIEW(*NONE)`: `CPF9C15`, **Recompile with DBGVIEW(*SOURCE)**, **Start again** | not run |
| A second session while one is active: `TCP1A72` | not run; does not happen as designed (decision 13) |

What the prompt asks to report, from the spec, the server's source at
`7f82a43f` and the host's code, not from a run:

- **`Eval` and an assignment**: not taken. QS/400's `eval_in` looks the
  whole expression up as a variable's name, so `NAME = value` is
  `CPF7E12`; the probe finds that and **Set Value** stays hidden. The
  exit test's Set Value step cannot pass against `7f82a43f`; changing a
  field needs an assignment in QS/400's `Eval` first.
- **Stop-to-editor latency for a service entry hit**: not measured. What
  to expect: the 5250 job's dynamic call checks the entry list (read
  again at most once a second, `devtools/dbg/entry.rs`), the owner's next
  look sees the attachment, and the server's watches' thread sends
  `Stopped` at its next look (`Config::watch_poll`, 250 ms). `qap-client`
  hands the event from the connection's thread straight to the session's
  receiver; the adapter's event thread forwards it at once, and VS Code
  then asks for the threads and the stack (two round trips) before the
  editor moves. So about a quarter of a second to a second and a half
  from the `CALL` at the display, most of it the entry list's refresh.
  The live suite logs `live: stopped … N ms after configurationDone` for
  the **Call** case.
- **Frames with `line` 0**: none met, since nothing ran. A `Source` frame
  with `line` 0 stands on the synthetic `qs400dbg:/LIB/PROGRAM/MODULE`
  document at its statement number, and one with neither has no source;
  both are tested against the mock (`stepping.rs`), and the document's
  lines and growth in the extension suite.
- **`ProgramEnd`**: this build of the server does not send it (decision
  12); a **Call** session ends with `CALL PGM(HLINV/ASSETS) ended: Ok` in
  the Debug Console.

Message IDs to expect, from `docs/QAP.md` at `7f82a43f`, not from a run:
`CPF9C15` for `DBGVIEW(*NONE)`, `TCP1A72` for a second `Start` on a
connection, `CPF3503` to attach to a job already serviced, `CPF3501` to
attach to the connection's own job, `CPF3520` for no such job, `CPF3502`
and `TCP1A74` for another user's jobs without `*SERVICE`, `CPD9CCB` for a
line no statement starts on or after, `CPF9C59` for a condition that does
not read, `CPD9CCC` when no job is stopped, `CPF7E12` for a name that is
not a variable, `TCP1A75` when the debugged job ends, `TCP1A76` at
sign-off.

What was checked instead, on Windows x64 with VS Code 1.143.0:

- The adapter (`host/crates/dap/tests`, 31 tests) against a canned
  `DebugBackend`: `initialize`'s capabilities; **Call** as `Start Own`,
  `AddProgram` (`*PGM`, then `*SRVPGM` on `NotFound`), the editor
  session's library list first, the `CALL` only at `configurationDone`,
  its messages and outcome then `terminated`; `CPF9C15` ending the session
  with the server's text and its ID, quiet with the recompile offer;
  `TCP1A72` with nothing else sent; a server below version 9 refused before
  anything is sent; `Stopped` as `stopped` with each reason, `Exception`'s
  text, `ProgramEnd` as `terminated`, `DebugEnded` and a closed connection
  as `terminated`; the stack on the member the extension named, on the
  synthetic document for `line` 0 and for a module with no known source,
  and paged; breakpoints on the module a source was compiled into, the
  writable member matching the read-only URI, a moved line, a condition,
  an empty list, `CPF9C59` leaving every one unverified, a module with no
  source view and a source of no program refused with nothing sent;
  continue and the three steps as `Resume`, `pause` refused, `CPD9CCC`
  passed through; terminate cancelling the `CALL` before `End`; `Locals`,
  a structure's parts with their full names, the probe both ways (hidden;
  shown with a `capabilities` event and `Set Value` as `Eval` of the
  assignment), watch, hover (a failure not shown), the Debug Console's
  `EVAL`, `:x` and `:c`, references gone after a resume; `Stopped` and
  `DebugEnded` sent in order while a `Stack` waited, before its reply;
  attach as `Start Job` with its thread named, `CPF3520`, `CPF3502`,
  `CPF3503` and `CPF3501` as sent; service entry with `SetServiceEntry`
  after the breakpoints, no thread until the entry's stop binds the 5250
  job, one thread for its later stops, `RemoveServiceEntry` before `End`.
- The real `qs400-code-host dap` process: `initialize`, a launch that
  cannot connect refused, `disconnect`, exit 0 (`tests/process.rs`); and
  from the extension through the inline adapter, with the sign-on put into
  `launch` without the configuration holding it.
- The extension (`test/debug.test.ts`, 24 tests, and `run.test.ts`):
  `CALL` quoting (numbers, quotes doubled, empty strings, a number CL
  cannot write refused); the provider's defaults and its refusals; the
  snippets; `qs400/debugSource` resolution in order (project file, member
  read-only, a several-module program's own `*MODULE`, stream file, local
  stream file, nothing); the synthetic document; the status bar's text;
  Attach to Job…'s programs and menu; `DBGVIEW(*SOURCE)` forced; the
  `CPF9C15` response picked out; the recompile on the writable member
  with Start again, and nothing after a failed compile or a dismissed
  offer; Debug (Call) and (Service entry) from the Objects view, a member
  and a project file deployed and compiled only when its program is
  older or missing.
- `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and the
  whole workspace's tests (310 passing); `npm run lint` and the full
  extension suite (295 passing, the live suites pending), on the release
  host built into `bin/`.

To run it, on a machine that reaches `QSHQ400`, signed on as `CWELLMAN`:

1. Set `QS400_TEST_HOST`, `QS400_TEST_USER`, `QS400_TEST_PASSWORD` (and
   `QS400_TEST_CA_FILE` with the system's certificate, which is
   self-signed) and run `npm test`. The Phase 9 live suite compiles
   `ASSETS` with `DBGVIEW(*SOURCE)` and `NODEBUG` with `DBGVIEW(*NONE)` into
   `HLINVDEV`, runs the **Call** scenario through the real adapter
   (breakpoint, stack, variables, a structure, hover, step over, continue,
   the end), the `CPF9C15` refusal and a second session, and deletes
   `HLINVDEV`. Record its `live:` lines: the stop latency, the frames, the
   variables, the setVariable line and the Debug Console.
2. By hand: compile `HLINV/QRPGLESRC/ASSETS` with **Compile (CRTBNDRPG)**,
   open it, set a breakpoint on an executable line of the main procedure,
   **Debug (Call)** from the editor title. Check the editor shows the
   line, the Call Stack `ASSETS › ASSETS › main · stmt n`, Variables, a
   data structure's subfields, a hover; **Step Over**; **Continue** to the
   end, and the Debug Console's last line.
3. **Debug (Service entry)** on `HLINV/ASSETS`. In QS/400 Access for
   Desktop sign on as `CWELLMAN`, `CALL HLINV/ASSETS`: the display waits
   with its keyboard locked; VS Code stops with `entry`, the Call Stack
   and the status bar name the 5250 job. Note the time from Enter at the
   display to the editor moving. Check that **Set Value** is not offered;
   **Continue**: the display goes on.
4. Edit the breakpoint's condition to `ASSETCOUNT > 3` (a field of the
   loop) and **Continue** through it: it stops only when it holds.
5. **Debug (Call)** on a program compiled `DBGVIEW(*NONE)`: the
   notification has the server's `CPF9C15` text and **Recompile with
   DBGVIEW(*SOURCE)**; the compile in the output channel has
   `DBGVIEW(*SOURCE)`; **Start again** stops at the breakpoint.
6. Start a second **Call** while one is stopped: record what happens (by
   decision 13 it starts on its own connection).
7. Record the result, the latency, any frame with `line` 0, and every
   message ID seen here.
