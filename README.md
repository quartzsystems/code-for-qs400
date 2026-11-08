# Code for QS/400

A VS Code extension for developing on QS/400 (Quartz Systems/400). Every
remote operation goes through `qs400-code-host`, a Rust sidecar bundled
with the extension that speaks QAP, the Quartz Access Protocol shared with
QS/400 Access.

**Status: 1.0.0 pre-release, Phase 6.** Saved connections, sign-on over
QAP, a session per connection with its status, session job and library
list; the Objects view with filters; source members opened, locked and
saved with their sequence numbers and dates; the IFS view, with stream
files opened and saved in their own CCSID, uploads and downloads with
resume, and the file commands; actions (compiles, calls, submitted jobs)
from `.vscode/actions.json`, the defaults and each connection, with the
compiler's messages in the Problems panel and the connection job's log;
RPG, CL, DDS, SQL and command definition source coloured and checked as
you type by the QS/400 compiler front-ends, with the outline, Go to
Definition into `/COPY` members, hover, completion, rename and folding;
SQL run from the editor into a results panel with paging and CSV export,
the SQL view of schemas, tables, views, routines, columns and indexes,
commit levels with Commit and Rollback, and a statement history.
See [docs/connections.md](docs/connections.md),
[docs/objects-and-members.md](docs/objects-and-members.md),
[docs/ifs.md](docs/ifs.md), [docs/actions.md](docs/actions.md),
[docs/languages.md](docs/languages.md) and [docs/sql.md](docs/sql.md).

## Requirements

- VS Code **1.143.0** or later (`engines.vscode` is `^1.143.0`: the
  current stable release, 1.145, minus two minor versions).
- Windows x64 or Linux x64. Each platform has its own VSIX carrying only
  its own host binary.

## Install

Download the VSIX for your platform from the CI artifacts and install it:

```sh
code --install-extension code-for-qs400-win32-x64.vsix   # Windows
code --install-extension code-for-qs400-linux-x64.vsix   # Linux
```

## Commands

| Command | Id |
| --- | --- |
| Code for QS/400: About | `code-for-qs400.about` |
| Code for QS/400: Restart Host | `code-for-qs400.host.restart` |
| Code for QS/400: Add, Edit, Remove Connection | `code-for-qs400.connection.add`, `.edit`, `.remove` |
| Code for QS/400: Connect, Disconnect | `code-for-qs400.connection.connect`, `.disconnect` |
| Code for QS/400: Set as Default Connection | `code-for-qs400.connection.setDefault` |
| Code for QS/400: Forget Saved Password | `code-for-qs400.connection.forgetPassword` |
| Code for QS/400: Switch Active Connection | `code-for-qs400.connection.switchActive` |
| Library list: Add, Remove, Move Up, Move Down, Set as Current | `code-for-qs400.libl.*` |
| Objects: Refresh, Properties | `code-for-qs400.objects.refresh`, `code-for-qs400.object.properties` |
| Add, Edit, Remove Filter | `code-for-qs400.filter.add`, `.edit`, `.remove` |
| Member: Open, Open Read-Only, New, Copy, Rename, Delete, Change Text, Compare with… | `code-for-qs400.member.open`, `.openReadOnly`, `.create`, `.copy`, `.rename`, `.delete`, `.changeText`, `.compare` |
| Renumber Member | `code-for-qs400.member.renumber` |
| IFS: Refresh, Go to IFS Path…, Show and Hide Hidden Entries | `code-for-qs400.ifs.refresh`, `.goTo`, `.showHidden`, `.hideHidden` |
| IFS: Add, Remove IFS Root, Set as IFS Home | `code-for-qs400.ifs.addRoot`, `.removeRoot`, `.setHome` |
| IFS: Open, New File…, New Folder…, Rename…, Copy to…, Delete, Properties, Change CCSID… | `code-for-qs400.ifs.open`, `.newFile`, `.newFolder`, `.rename`, `.copy`, `.delete`, `.properties`, `.changeCcsid` |
| IFS: Upload Files…, Upload Folder…, Download…, Download Folder… | `code-for-qs400.ifs.upload`, `.uploadFolder`, `.download`, `.downloadFolder` |
| Run Action… | `code-for-qs400.action.run` |
| Clear Compile Diagnostics | `code-for-qs400.diagnostics.clear` |
| Job Log, Refresh Job Log | `code-for-qs400.job.log`, `code-for-qs400.job.logRefresh` |
| Run Statement, Cancel Running SQL, New SQL Editor | `code-for-qs400.sql.run`, `.cancel`, `.newEditor` |
| SQL Options…, Commit, Rollback, Change SQL Connection… | `code-for-qs400.sql.options`, `.commit`, `.rollback`, `.changeConnection` |
| SQL History | `code-for-qs400.sql.history` |
| SQL view: Refresh, Filter Schemas…, View Data, Generate SELECT, Generate INSERT, Copy Name, Copy CALL | `code-for-qs400.sql.refresh`, `.filterSchemas`, `.viewData`, `.generateSelect`, `.generateInsert`, `.copyName`, `.copyCall` |

**About** asks the host for its version and shows, for example,
`Code for QS/400 V1R0M0 · host 1.0.0 · QAP v9`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `code-for-qs400.host.path` | empty | Path to a `qs400-code-host` binary. Empty uses the bundled one. Machine scope only. |
| `code-for-qs400.connections` | `[]` | Saved connections: `name`, `host`, `port`, `user`, `tls`, `libraryList`, `filters`, `ifsRoots`, `actions`, `variables`. User settings only. |
| `code-for-qs400.defaultConnection` | empty | The connection offered first. User settings only. |

Passwords are never in settings: they go to VS Code secret storage.

A workspace folder's actions are in `.vscode/actions.json`, checked against
[schemas/actions.json](schemas/actions.json); see
[docs/actions.md](docs/actions.md).

## Host

The extension starts one `qs400-code-host` per window, on the first command
that needs it, and talks JSON-RPC 2.0 over stdio with `Content-Length`
framing. Host logs appear in the **Code for QS/400 Host** output channel. If
the host stops, the status bar shows **QS/400 host stopped**; the next
command starts it again, or click the item to restart it now.

```sh
qs400-code-host --version
# qs400-code-host 1.0.0 (QS/400 V1R0M0, QAP v9)
```

The language servers are the same binary, one per language per window:
`qs400-code-host lsp rpgle|cl|dds|sql|cmd`, LSP over stdio. Their log is
the **Code for QS/400 Languages** output channel.

## Repository layout

```
package.json, src/      the extension (TypeScript, bundled by esbuild to dist/)
  src/extension.ts        activate/deactivate, status bar, command wiring
  src/host/client.ts      spawns the host; JSON-RPC client and framing
  src/host/protocol.ts    types for every host method
  src/connections/        settings, secret storage, sessions, library list
  src/objects/filters.ts  object filters and generic names
  src/members/            the qs400mbr file system provider, the type table, the save diff
  src/ifs/                the qs400ifs file system provider, paths, tree walks, transfers
  src/actions/            actions: the model and merge, variables, the run and its output, diagnostics
  src/jobs/jobLog.ts      the Job log document and its hover
  src/languages/          the language clients, includes for the servers, fixed-form RPG guides
  src/sql/                SQL: statement scope, the runner, options and status bar, the results
                          webview, CSV export, the generators, history
  src/views/connections.ts  the Connections tree
  src/views/objects.ts    the Objects tree
  src/views/ifs.ts        the IFS tree
  src/views/sql.ts        the SQL tree
  src/views/sessionStatusBar.ts  the active connection in the status bar
  src/commands/           About, connection, object, member and IFS commands
syntaxes/, languages/   grammars and language configuration
schemas/actions.json    schema for .vscode/actions.json
defaults/actions.json   the default actions shipped with the extension
media/                  activity bar icon (placeholder)
bin/                    host binary, copied in at package time (gitignored)
host/                   Cargo workspace for the sidecar
  crates/host-rpc         JSON-RPC 2.0 framing, method registry and deferred replies (no QS/400 knowledge)
  crates/code-host        the qs400-code-host binary; src/session.rs holds the sessions,
                          src/objects.rs and src/members.rs the object and member methods,
                          src/ifs.rs the IFS methods and transfers, src/actions.rs
                          the commands and compiles, src/jobs.rs the job log,
                          src/sql/ the SQL methods, values and CSV
  crates/lsp-common       what the language servers share: the loop, positions, includes, features
  crates/lsp-<lang>       one language server each (rpgle, cl, dds, sql, cmd) on its front end
  crates/severity         the one severity table, shared with the extension
  fixtures/parity         recorded compiles for the offline parity test
test/                   extension integration tests (@vscode/test-electron), grammar snapshots in test/grammar/
scripts/                check-naming.sh, package.sh, package.ps1
docs/                   user documentation
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to build, test and package.

## License

MIT. See [LICENSE](LICENSE).
