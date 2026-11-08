# Changelog

## 1.0.0 — V1R0M0 · 2026-11-08

The first release. Windows x64 and Linux x64, VS Code 1.143.0 or later, a
QS/400 whose QAP server is at version 8 (version 9 for debugging).

### Connections and sign-on

- Saved connections in `code-for-qs400.connections` (user settings only),
  a default connection, and passwords in VS Code secret storage, saved or
  asked every time.
- Sign-on exactly as QS/400 Access does it, TLS with an optional CA file.
  The system's refusals are shown as `messageId: text`, unchanged, with
  the second-level text under Details; an expired password offers
  **Change password**; a saved password the system refuses is deleted, so
  it never counts against `QMAXSIGN` twice.
- The **Connections** view with each connection's state, its **Library
  list** and its **System** (product, version, serial, session job, QAP
  version); the active connection in the status bar.
- A silent reconnect after the system's idle timeout: the session
  resumed, or signed on again with the password kept in memory.
- Library list editing (add, remove, move, set current), applied to the
  session job and saved per connection.

### Objects and source members

- The **Objects** view: the library list's libraries, their object types,
  objects with attribute and text, and the members of source files;
  filters per connection; **Properties** of an object.
- Members open as editor tabs, held as `STRSEU` holds them and let go when
  the last tab closes; a member another job holds opens read-only with the
  system's `CPF1002`. Locks are taken again after a reconnect.
- Saving keeps the sequence numbers and dates of unchanged lines, numbers
  inserted lines between their neighbours, and renumbers only when no gap
  is left or on **Renumber Member**. An unchanged member is not written.
- **New Member**, **Copy**, **Rename**, **Delete**, **Change Text** and
  **Compare with…** another member or a local file.

### The IFS

- The **IFS** view with roots per connection, **Go to IFS Path…**, hidden
  entries on request, and symbolic links followed.
- Stream files open in their own CCSID, converted by the system; a
  character the CCSID lacks is refused with `TCP1A5A`. Images and binary
  files open as bytes. A save over a change made on the system asks
  **Overwrite** or **Reload**.
- Uploads and downloads of files and folders with progress and Cancel; a
  cancelled upload is kept as partial and resumes. Drag and drop.
- **New File…** with a CCSID, **New Folder…**, **Rename…**, **Copy to…**,
  **Delete**, **Properties** and **Change CCSID…** of an empty file.

### Actions and compiles

- **Run Action…** on a member, a stream file or an object, from the editor
  title, the views and the Command Palette, the last action used offered
  first.
- Default compiles for every source type (`CRTBNDRPG` to `CRTSRVPGM`,
  with `DBGVIEW(*SOURCE)` wherever the command takes it), **Call**,
  **Submit** and `RUNSQLSTM`; overridden or added by name in
  `.vscode/actions.json` and in the connection's own `actions`, with
  variables from `&LIBRARY` to `&CUSTOM:NAME`. Saving `actions.json`
  checks each command with the system's `CheckCommand`.
- The compiler's messages in the Problems panel on the member, `/COPY`
  member or stream file they name, at their line and columns, with the
  second-level text on hover. A clean compile clears them.
- The **Code for QS/400** output channel: a block per run with the command
  as sent, the job, the system's messages and how it ended, with links to
  the job log, the Jobs view and the compile listing. Cancel ends the
  command on the system. Batch runs are submitted with `SBMJOB`.
- **Job Log**: a job's log as a read-only document, each message's kind in
  the gutter and its second-level text on hover.

### Languages

- RPG (fixed form, free form, `**FREE`, embedded SQL), CL, DDS (PF, LF,
  DSPF, PRTF, ICFF), SQL and command definitions coloured in members,
  stream files and local files.
- Fixed-form RPG column guides and the field under the cursor in the
  status bar; DDS rulers.
- A language server per language on QS/400's compiler front-ends:
  diagnostics as you type with the message ID and second-level text, the
  outline, Go to Definition into `/COPY` and `/INCLUDE` members, hover,
  completion, rename and folding. Includes are read from local projects
  first, then from the system with the library list.

### SQL

- **Run Statement** (`Ctrl+Enter`): the selection, the statement under the
  cursor or the whole document; **New SQL Editor**; any SQL document on
  any connection.
- **SQL results**: a tab per run with column types, the system's exact
  values, paging with **Load more**, and **Export CSV** of the whole
  result. A failed statement's message in its tab and the Problems panel.
- Commit level, naming and default schema from the status bar, with
  **Commit** and **Rollback** and a question before disconnecting with
  uncommitted changes.
- The **SQL** view of schemas, tables, views, aliases, files, procedures,
  functions, columns and indexes, with View Data, Generate `SELECT` and
  `INSERT`, Copy Name and Copy CALL.
- **SQL History**: the last 50 statements per connection.

### Jobs, spooled files and messages

- The **Jobs** view: your jobs, another profile's or all, grouped by
  state; Job Log, Hold, Release, End…, Spooled Files, and an optional
  refresh every 30 seconds.
- The **Spooled files** view: your files, output queues and a job's
  files; Save as Text, Save as PDF, Hold, Release, Move and Delete; new
  files on the badge. A viewer that keeps every printed column, marks each
  page and goes to a page.
- The **Messages** view: your queue, the system operator's and named
  queues, inquiries first; Reply, Remove, Copy Text, Send Message and
  Remove All Answered. Inquiries on your queue notify, with **Reply**.

### Local projects

- `qs400project.json` maps a folder to a library or an IFS directory, with
  its connection, ignore globs, member texts and actions.
- **Pull** a library, source file, member or IFS directory into the
  folder, a directory per source file and a file per member, ready for
  git.
- **Deploy Changed**, **Deploy All**, **Deploy Git-Changed** and **Deploy
  File**, keeping each member's sequence numbers and dates; conflicts with
  changes made on the system listed first and resolved by Overwrite, Pull
  or Skip.
- **Run Action…** on a local file deploys it and compiles it there, with
  the compiler's messages on the local file.
- The **Project** view of each project's files as Deployed, Changed, New,
  Conflict or Ignored, with Diff with System and Open on System.

### Debugging

- RPG and CL programs in VS Code's debugger, each session on a connection
  of its own with the editor's library list: **Debug (Call)**, **Debug
  (Service entry)** for the next job that calls the program (a 5250
  session, say), and **Attach to Job…**; `launch.json` snippets.
- Breakpoints and conditional breakpoints in the source the program was
  compiled from, Step Over, Into and Out, Continue, the Call Stack,
  Variables with data structures and arrays opened to their parts, Watch,
  hover and the Debug Console with `EVAL`, `:x` and `:c`.
- A program compiled `DBGVIEW(*NONE)` is refused with `CPF9C15` and
  offered **Recompile with DBGVIEW(*SOURCE)**.

### The extension

- **Get started**, a five-step walkthrough.
- **About** shows `Code for QS/400 V1R0M0 · host 1.0.0 · QAP v9`, all from
  the host.
- `qs400-code-host`, bundled for each platform, makes every connection to
  the system; the language servers (`lsp`) and the debug adapter (`dap`)
  are the same binary. A stopped host is shown in the status bar and
  restarts on the next command.
- No telemetry.
- Not in this release: see [docs/known-limitations.md](docs/known-limitations.md).
