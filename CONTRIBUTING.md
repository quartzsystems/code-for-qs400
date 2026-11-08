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
| `src/views/`, `src/commands/` | Tree views, the status bar item and commands |
| `syntaxes/`, `languages/` | Grammars and language configuration (Phase 5) |
| `schemas/actions.json` | Schema for `.vscode/actions.json` (Phase 4) |
| `media/` | Activity bar icon (placeholder until Phase 10) |
| `bin/` | Host binary for the current platform, copied in by `scripts/package.sh`; gitignored |
| `host/` | Cargo workspace: `crates/host-rpc` (framing, registry, error codes; no QS/400 knowledge) and `crates/code-host` (the `qs400-code-host` binary) |
| `host/crates/code-host/src/session.rs` | Sessions: one per connection name, the state machine, `session.*` and `libl.*` |
| `test/` | Extension tests, run inside VS Code; `live.test.ts` against a real system |
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

### Live tests

`test/live.test.ts` runs the Phase 1 exit test's connect and library list
steps against a real system. It is skipped unless these are set:

| Variable | Meaning |
| --- | --- |
| `QS400_TEST_HOST`, `QS400_TEST_USER`, `QS400_TEST_PASSWORD` | Required. |
| `QS400_TEST_PORT` | QAP port, when not the default. |
| `QS400_TEST_CA_FILE` | PEM file to trust (CI writes `QS400_TEST_CA_PEM` to one). |
| `QS400_TEST_LIBRARY` | Library to add and move to the top. Default `QGPL`. |
| `QS400_TEST_CURLIB` | Library to set as current. Default the user profile. |

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
