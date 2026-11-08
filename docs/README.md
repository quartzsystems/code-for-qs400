# Code for QS/400 user guide

Code for QS/400 is a VS Code extension for developing on QS/400. This
guide covers release V1R0M0. The same pages are published at
<https://quartzsystems.github.io/code-for-qs400/>.

## Getting started

1. Install the VSIX for your platform (Windows x64 or Linux x64) from the
   [releases page](https://github.com/quartzsystems/code-for-qs400/releases/latest):
   the Extensions view's `…` menu → **Install from VSIX…**, or
   `code --install-extension code-for-qs400-<platform>.vsix`. Check it
   against the release's `SHA256SUMS` first. VS Code does not update a
   VSIX install; install the next release over it.
2. Open the **QS/400** view in the activity bar and add a connection: see
   [Connections and sign-on](connections.md).
3. Run **Code for QS/400: About** from the Command Palette to check that the
   bundled host is working. It shows the QS/400 release, the host version
   and the QAP version, all reported by the host:
   `Code for QS/400 V1R0M0 · host 1.0.0 · QAP v9`.
4. **Help → Welcome → Get started with Code for QS/400** walks through
   adding a connection, opening a member, compiling it, running SQL and
   debugging.

The system's QAP server must be at version 8 for everything but debugging,
which needs version 9. A view that needs a newer version than the server
has says so in one line. The extension runs only in a trusted workspace
and has no telemetry.

## Guides

- [Connections and sign-on](connections.md): adding a connection, where the
  password is kept, the Connections view, the status bar, reconnecting and
  the library list.
- [Objects and source members](objects-and-members.md): the Objects view,
  filters, opening and saving members, sequence numbers and dates, and the
  member commands.
- [The IFS](ifs.md): the IFS view and its roots, opening stream files and
  their CCSIDs, uploads and downloads with resume, and the file commands.
- [Actions and diagnostics](actions.md): running compiles and other
  commands on members, stream files and objects, `.vscode/actions.json`
  and its variables, the Problems panel, the output channel and the job
  log.
- [Language support](languages.md): colouring, the fixed-form guides, the
  language servers' diagnostics, outline, Go to Definition, hover,
  completion, rename and folding, how includes are read, and how the
  editor's diagnostics are held to the compiler's.
- [SQL](sql.md): running statements, the results panel, CSV export, the
  SQL view, commit levels and the history.
- [Jobs, spooled files and messages](jobs-spool-messages.md): the Jobs
  view and job logs, the Spooled files view and its viewer, the Messages
  view, inquiry replies and notifications, and the listing link after a
  compile.
- [Local projects and deploy](projects.md): a folder mapped to a library
  or an IFS directory, Pull, Deploy and its conflicts, actions on local
  files, includes from the workspace, the Project view and a git
  workflow.
- [Debugging](debugging.md): Call, Service entry and Attach, what
  `DBGVIEW` each program needs, breakpoints and conditions, stepping, the
  Call Stack, Variables and the Debug Console, and what a display user
  sees during a stop.
- [Known limitations](known-limitations.md): what this release does not
  do, and why.

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
| Jobs: Refresh, Change Jobs Filter…, Job Log, Hold, Release, End…, Spooled Files, Copy Qualified Name, Show Job in Jobs View | `code-for-qs400.jobs.refresh`, `.filter`, `.log`, `.hold`, `.release`, `.end`, `.spooledFiles`, `.copyName`, `.reveal` |
| Spooled files: Refresh, Output Queue Library…, Open, Save as Text…, Save as PDF…, Hold…, Release, Move…, Delete, Show Spooled Files of Job, Close Job Node | `code-for-qs400.spool.refresh`, `.queueLibrary`, `.open`, `.saveText`, `.savePdf`, `.hold`, `.release`, `.move`, `.delete`, `.showJob`, `.clearJob` |
| Spooled file viewer: Go to Page…, Load All Pages, Refresh | `code-for-qs400.spool.goToPage`, `.loadAll`, `.viewerRefresh` |
| Pull Library…, Pull Source File, Pull Member, Pull into Project | `code-for-qs400.pull.library`, `.sourceFile`, `.member`, `.path` |
| Deploy Changed, Deploy All, Deploy Git-Changed, Deploy File | `code-for-qs400.deploy.changed`, `.all`, `.git`, `.file` |
| Project: Refresh Project, Pull into Project, Pull from System, Diff with System, Open on System | `code-for-qs400.project.refresh`, `.pull`, `.pullFile`, `.diff`, `.openRemote` |
| Messages: Refresh, Reply…, Remove, Copy Text, Send Message…, Remove All Answered, Add and Remove Message Queue | `code-for-qs400.messages.refresh`, `.reply`, `.remove`, `.copyText`, `.send`, `.removeAnswered`, `.addQueue`, `.removeQueue` |
| Debug (Call), Debug (Service entry), Attach to Job… | `code-for-qs400.debug.call`, `.serviceEntry`, `.attach` |

All are in the **Code for QS/400** category of the Command Palette, apart
from those that act on a node of a view, which are on its context menu.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `code-for-qs400.connections` | `[]` | Saved connections: `name`, `host`, `port`, `user`, `tls`, `libraryList`, `filters`, `ifsRoots`, `actions`, `variables`. User settings only. |
| `code-for-qs400.defaultConnection` | empty | The connection offered first. User settings only. |
| `code-for-qs400.jobs.autoRefresh` | `false` | Read the Jobs view again every 30 s while it is shown. |
| `code-for-qs400.messages.notify` | `inquiries` | Which messages arriving on your own queue notify: `inquiries`, `all` or `none`. |
| `code-for-qs400.host.path` | empty | Path to a `qs400-code-host` binary. Empty uses the bundled one. Machine scope only. |

## The host

The extension starts one `qs400-code-host` per window, on the first
command that needs it, and talks JSON-RPC 2.0 to it over stdio. The host
makes every connection to the system; the extension itself never touches
the network. The same binary runs the language servers
(`qs400-code-host lsp rpgle|cl|dds|sql|cmd`, one per language per window)
and the debug adapter (`qs400-code-host dap`, one per debug session, on a
QAP connection of its own).

```sh
qs400-code-host --version
# qs400-code-host 1.0.0 (QS/400 V1R0M0, QAP v9)
```

## Troubleshooting

- **QS/400 host stopped** in the status bar means the host process ended.
  The next Code for QS/400 command starts it again; click the item, or run
  **Code for QS/400: Restart Host**, to restart it now.
- The **Code for QS/400 Host** output channel shows the host's log; the
  **Code for QS/400** channel shows each action's command and messages;
  the **Code for QS/400 Languages** channel shows the language servers'
  log.
- **The extension does nothing in a folder.** VS Code has opened it in
  Restricted Mode; trust the workspace (**Manage Workspace Trust**).
- To try a different host build, set `code-for-qs400.host.path` in your user
  settings to the full path of a `qs400-code-host` binary.
