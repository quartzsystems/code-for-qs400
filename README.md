# Code for QS/400

A VS Code extension for developing on QS/400 (Quartz Systems/400). Every
remote operation goes through `qs400-code-host`, a Rust sidecar bundled
with the extension that speaks QAP, the Quartz Access Protocol shared with
QS/400 Access.

**Status: 1.0.0 pre-release, Phase 9.** Saved connections, sign-on over
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
commit levels with Commit and Rollback, and a statement history; the
Jobs view with job logs, hold, release and end, the Spooled files view
with a viewer that keeps the printed columns and PDF download, and the
Messages view with inquiry replies, sends and notifications; and local
projects: a folder of source under git mapped to a library or an IFS
directory by `qs400project.json`, pulled from the system, deployed back
with the changed files only and their sequence numbers kept, conflicts
caught, actions run on local files, and the Project view; and debugging
in VS Code's own debugger: a program called, attached to, or stopped by a
service entry point when a 5250 user calls it, with breakpoints and
conditions, stepping, the call stack, variables, watch and hover in the
source it was compiled from.
See [docs/connections.md](docs/connections.md),
[docs/objects-and-members.md](docs/objects-and-members.md),
[docs/ifs.md](docs/ifs.md), [docs/actions.md](docs/actions.md),
[docs/languages.md](docs/languages.md), [docs/sql.md](docs/sql.md) and
[docs/jobs-spool-messages.md](docs/jobs-spool-messages.md),
[docs/projects.md](docs/projects.md) and
[docs/debugging.md](docs/debugging.md).

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
| Jobs: Refresh, Change Jobs Filter…, Job Log, Hold, Release, End…, Spooled Files, Copy Qualified Name | `code-for-qs400.jobs.refresh`, `.filter`, `.log`, `.hold`, `.release`, `.end`, `.spooledFiles`, `.copyName` |
| Spooled files: Refresh, Output Queue Library…, Open, Save as Text…, Save as PDF…, Hold…, Release, Move…, Delete | `code-for-qs400.spool.refresh`, `.queueLibrary`, `.open`, `.saveText`, `.savePdf`, `.hold`, `.release`, `.move`, `.delete` |
| Spooled file viewer: Go to Page…, Load All Pages, Refresh | `code-for-qs400.spool.goToPage`, `.loadAll`, `.viewerRefresh` |
| Pull Library…, Pull Source File, Pull Member, Pull into Project | `code-for-qs400.pull.library`, `.sourceFile`, `.member`, `.path` |
| Deploy Changed, Deploy All, Deploy Git-Changed, Deploy File | `code-for-qs400.deploy.changed`, `.all`, `.git`, `.file` |
| Project: Refresh Project, Pull into Project, Pull from System, Diff with System, Open on System | `code-for-qs400.project.refresh`, `.pull`, `.pullFile`, `.diff`, `.openRemote` |
| Messages: Refresh, Reply…, Remove, Copy Text, Send Message…, Remove All Answered, Add and Remove Message Queue | `code-for-qs400.messages.refresh`, `.reply`, `.remove`, `.copyText`, `.send`, `.removeAnswered`, `.addQueue`, `.removeQueue` |
| Debug (Call), Debug (Service entry), Attach to Job… | `code-for-qs400.debug.call`, `.serviceEntry`, `.attach` |

**About** asks the host for its version and shows, for example,
`Code for QS/400 V1R0M0 · host 1.0.0 · QAP v9`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `code-for-qs400.host.path` | empty | Path to a `qs400-code-host` binary. Empty uses the bundled one. Machine scope only. |
| `code-for-qs400.connections` | `[]` | Saved connections: `name`, `host`, `port`, `user`, `tls`, `libraryList`, `filters`, `ifsRoots`, `actions`, `variables`. User settings only. |
| `code-for-qs400.defaultConnection` | empty | The connection offered first. User settings only. |
| `code-for-qs400.jobs.autoRefresh` | `false` | Read the Jobs view again every 30 s while it is shown. |
| `code-for-qs400.messages.notify` | `inquiries` | Which messages arriving on your own queue notify: `inquiries`, `all` or `none`. |

Passwords are never in settings: they go to VS Code secret storage.

A workspace folder's actions are in `.vscode/actions.json`, checked against
[schemas/actions.json](schemas/actions.json); see
[docs/actions.md](docs/actions.md). A folder that is a project has a
`qs400project.json`, checked against
[schemas/qs400project.json](schemas/qs400project.json); see
[docs/projects.md](docs/projects.md).

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
the **Code for QS/400 Languages** output channel. The debug adapter is
`qs400-code-host dap`, one process per debug session, the Debug Adapter
Protocol over stdio on a QAP connection of its own.

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
  src/jobs/               the Job log document and its hover, the Jobs view's model
  src/spool/              the Spooled files model, the viewer's layout and the viewer
  src/messages/model.ts   the Messages view's order, descriptions and notify rule
  src/languages/          the language clients, includes for the servers, fixed-form RPG guides
  src/projects/           local projects: the project file and state, the layout, pull, deploy,
                          git changes, actions on local files, includes from the workspace
  src/sql/                SQL: statement scope, the runner, options and status bar, the results
                          webview, CSV export, the generators, history
  src/views/connections.ts  the Connections tree
  src/views/objects.ts    the Objects tree
  src/views/ifs.ts        the IFS tree
  src/views/sql.ts        the SQL tree
  src/views/jobs.ts, spool.ts, messages.ts  the Jobs, Spooled files and Messages trees
  src/views/project.ts    the Project tree and its status bar item
  src/debug/              the qs400 debugger: the configuration and its CALL, the provider, the
                          adapter process, qs400/debugSource, the statements document, the
                          commands, the recompile and the status bar
  src/views/sessionStatusBar.ts  the active connection in the status bar
  src/commands/           About, connection, object, member and IFS commands
syntaxes/, languages/   grammars and language configuration
schemas/actions.json    schema for .vscode/actions.json
schemas/qs400project.json  schema for a project folder's qs400project.json
defaults/actions.json   the default actions shipped with the extension
media/                  activity bar icon (placeholder)
bin/                    host binary, copied in at package time (gitignored)
host/                   Cargo workspace for the sidecar
  crates/host-rpc         JSON-RPC 2.0 framing, method registry and deferred replies (no QS/400 knowledge)
  crates/code-host        the qs400-code-host binary; src/session.rs holds the sessions,
                          src/objects.rs and src/members.rs the object and member methods,
                          src/ifs.rs the IFS methods and transfers, src/actions.rs
                          the commands and compiles, src/jobs.rs the jobs and job logs,
                          src/spool.rs and src/messages.rs spooled files and message
                          queues, src/watches.rs the watches and their events,
                          src/codec.rs keys and job names, src/sql/ the SQL methods,
                          values and CSV, src/deploy.rs the deploy sequences
  crates/dap              qs400-code-host dap: the debug adapter over QAP's Debug service
                          (code-host's src/debug.rs is its connection)
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
