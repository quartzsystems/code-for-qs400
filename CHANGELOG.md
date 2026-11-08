# Changelog

## 1.0.0-pre · Phase 9 · debugging

- RPG and CL programs debugged in VS Code's own debugger, the `qs400`
  debug type, over QS/400's source debugger (QAP version 9's `Debug`
  service). Each session signs on with a connection of its own, with the
  editor session's library list, so a stopped program holds up nothing
  else.
- Three ways to start: **Call** a program in the session's own job with
  its parameters quoted as CL needs; **Service entry**, which stops the
  next job of the user that calls the program (a 5250 session waits at
  its locked display); **Attach** to a running job by its qualified name.
  `launch.json` snippets for each; the connection and program are filled
  in from the window when left out.
- Breakpoints, conditional ones included, set in the source the program
  was compiled from and moved to the statement where they landed; Step
  Over, Into and Out, Continue; the Call Stack as `PROGRAM › MODULE ›
  PROCEDURE · stmt n`; Variables with data structures and arrays opening
  to their parts; Watch, hover and the Debug Console with `EVAL`, `:x`
  and `:c`. Pause is not offered: the system stops a job only at a
  breakpoint or a step. Set Value appears only where the system's `Eval`
  takes an assignment, which QS/400's does not at this release.
- Frames open the local project file the member was deployed from, else
  the member read-only, else the stream file; a module without a source
  view stands on a read-only document of its statement numbers.
- **Debug (Call)** and **Debug (Service entry)** on programs in the
  Objects view, in a member's editor title and on project files (deployed,
  and compiled when the program is older than the source); **Attach to
  Job…** in the Jobs view; the debugged job in the status bar.
- A program compiled `DBGVIEW(*NONE)` is refused with the system's
  `CPF9C15` and **Recompile with DBGVIEW(*SOURCE)**, then **Start again**.
- `qs400-code-host dap`, the debug adapter.
  See [docs/debugging.md](docs/debugging.md).

## 1.0.0-pre · Phase 8 · local projects and deploy

- `qs400project.json` maps a workspace folder to a library or an IFS
  directory: its connection, target, layout, the CCSID of stream files it
  creates, ignore globs, member texts and actions of its own. It is
  checked on save, each problem on its place. `.qs400/state.json` keeps
  each file's hash and the system's change timestamp at the last deploy
  or pull.
- **Pull Library…**, **Pull Source File**, **Pull Member** and **Pull into
  Project** write members as text, a directory per source file and a file
  per member with the extension of its type, so existing code can go
  under git; a folder without a project file gets one, and `.qs400/` in
  its `.gitignore`. A local file changed since asks Overwrite or Keep.
- **Deploy Changed**, **Deploy All**, **Deploy Git-Changed** and **Deploy
  File**: changed files by content hash, every file, the files git reports,
  or one. Members keep their sequence numbers and dates by the save rules
  of an editor's save; new members are created with their type and text;
  missing source files are made with `CRTSRCPF` after a question; stream
  files are uploaded with progress and Cancel. Conflicts, a member or file
  changed on the system since, are listed before anything is written and
  resolved per file with Overwrite, Pull or Skip. Deletions are never
  deployed.
- **Run Action…** on a local file deploys it, then runs on the member or
  stream file it went to, with `&LIBRARY` and `&SRCLIB` the project's
  library; the compiler's messages go on the local file.
- `/COPY` and `/INCLUDE` are read from the workspace's projects first, the
  system second; saving a local copy member updates every document that
  includes it.
- The **Project** view: each project's connection and target, its files by
  directory as Deployed, Changed, New, Conflict or Ignored, Deploy, Pull,
  Diff with System and Open on System; the files to deploy in the status
  bar.
- The host's `deploy.member` and `deploy.path`, which sequence the
  existing `member.*` and `ifs.*` calls.
- The activity bar icon is a Q on a terminal display.
  See [docs/projects.md](docs/projects.md).

## 1.0.0-pre · Phase 7 · jobs, spooled files and messages

- The **Jobs** view: My jobs, another profile's or `*ALL` (saved per
  connection), grouped Active, On job queue and On output queue, the
  connection's own job marked; Job Log, Hold, Release, End… (`*CNTRLD`
  with a delay, or `*IMMED`, confirmed by the job's qualified name),
  Spooled Files and Copy Qualified Name; Refresh, and every 30 seconds
  with `code-for-qs400.jobs.autoRefresh`.
- The job log of any job, active or ended (its spooled job log), with each
  message's kind as a glyph in the gutter and `from → to` in the hover.
- The **Spooled files** view: My spooled files, the output queues of a
  library (default `*LIBL`) and a job's files from the Jobs view; Save as
  Text, Save as PDF (made by the system), Hold at the end of the page or
  immediately, Release, Move to another queue (at its end or top) and
  Delete; your own files watched while the view is shown, new ones on its
  badge.
- The spooled file viewer: a read-only editor that keeps every column,
  rulers at 80 and 132, `— page n —` before each page, the page in the
  status bar, Go to Page, and Load All Pages for files of 2000 pages or
  more.
- The **Messages** view: My messages, System operator when your profile
  may read it, and named queues; inquiries waiting first; Reply, Remove,
  Copy Text, Send Message (to a profile or a queue, informational or an
  inquiry) and Remove All Answered. Your own queue is watched for as long
  as you are signed on: the badge counts what waits and what arrived, and
  an inquiry shows a notification with Reply and Show
  (`code-for-qs400.messages.notify`).
- The output channel: `Listing: Open` after a compile that wrote its
  listing, and after a batch run once its job has; the job on `Job:` and
  `Submitted:` opens the Jobs view on it; `Job log: Show` opens the log of
  the block's own job.
- The host's `jobs.*`, `spool.*` and `messages.*` methods over QAP's `Jobs`,
  `Spool` and `Messages` services, with the watches' events as
  `spool.changed` and `messages.arrived`.
  See [docs/jobs-spool-messages.md](docs/jobs-spool-messages.md).

## 1.0.0-pre · Phase 6 · SQL

- **Run Statement** (`Ctrl+Enter`) on SQL members, stream files, local
  files and untitled SQL editors: the selection, the statement under the
  cursor, or the whole document statement by statement, stopping at the
  first error. Statements are split as the SQL language server's parser
  splits them. **New SQL Editor** opens one on the active connection, and
  any SQL document can run on another connection.
- A failed statement's message ID, text and second-level text, with
  SQLSTATE and SQLCODE, in its result tab and in the Problems panel on the
  statement's first line.
- **SQL results**, a panel with a tab per run (the last 20): column types
  with length and scale, the system's exact numbers, `NULL` as `-`, binary
  as hex, ISO dates and times, `n rows` or `500 of more` with **Load
  more**, `n rows updated` for a data change.
- **Export CSV**: the rows shown and then the rest of the result, written
  by the host a page at a time (RFC 4180, UTF-8 with no byte order mark,
  `NULL` empty), with progress and Cancel.
- The **SQL** view: schemas (filtered by a pattern per connection), their
  tables, views, aliases, physical and logical files, procedures and
  functions, each table's columns and indexes; View Data, Generate
  `SELECT` and `INSERT`, Copy Name and Copy CALL.
- Commit level, naming and default schema from the SQL status bar item,
  which marks uncommitted changes with `●`; Commit and Rollback; a
  question before disconnecting with uncommitted changes; a warning when
  the system ends the SQL job.
- **SQL History**: the last 50 statements per connection, to run again,
  open or save.
- The host's `sql.*` methods: one SQL connection per session, statements,
  cursors, commitment control and the catalog over QAP's `Sql` service.
  See [docs/sql.md](docs/sql.md).

## 1.0.0-pre · Phase 5 · language support

- Grammars and language configuration for RPG (`qs400-rpgle`: fixed form
  by column, free form, `**FREE`, the directives and the SQL of
  `EXEC SQL`), CL, DDS (PF, LF, DSPF, PRTF, ICFF by column), SQL and
  command definitions, in members, stream files and local files. Local
  `.rpgle`, `.sqlrpgle`, `.rpgleinc`, `.rpg`, `.clle`, `.clp`, `.pf`,
  `.lf`, `.dspf`, `.prtf` and `.icff` files open in them.
- Fixed-form RPG shows a guide at the start of each field of each
  specification line, and the field under the cursor in the status bar
  (`D · Ds 24–25 · col 24`); `**FREE` members show neither. DDS gets
  rulers at its columns.
- A language server for each language, run by the host
  (`qs400-code-host lsp rpgle|cl|dds|sql|cmd`) on the QS/400 compiler
  front-ends: diagnostics as you type with the message ID and the
  second-level text, the outline, Go to Definition (into `/COPY` and
  `/INCLUDE` members, which open read-only), hover, completion (with the
  members of the source file after `/COPY`), rename within the document,
  and folding.
- Includes are read from the system through the extension, `*LIBL`
  resolved with the library list, kept for the window and read again
  when a member is saved or a connection signs on again. An include's
  messages show in it when it is open, else as a count on its directive.
- The severity table is one file shared by the Problems panel's compile
  diagnostics and the language servers.
- Parity: a live test compares the editor's diagnostics with each `HLINV`
  member's compile, and an offline test compares recorded compiles.
  See [docs/languages.md](docs/languages.md).

## 1.0.0-pre · Phase 4 · actions and diagnostics

- **Run Action…** on an open member or stream file (editor title and
  context menu), on a member, an object or a stream file in the Objects
  and IFS views, and from the Command Palette. The pick lists the actions
  that apply, the one last run on that member type, extension or object
  type first. A document with unsaved changes is saved first, and a save
  that fails stops the run.
- Actions come from the defaults shipped with the extension, each
  workspace folder's `.vscode/actions.json` and the connection's own
  `actions`, each overriding the one before it by name. Variables:
  `&LIBRARY`, `&NAME`, `&TYPE`, `&EXT`, `&SRCFILE`, `&SRCLIB`, `&CURLIB`,
  `&USERNAME`, `&HOST`, `&FULLPATH`, `&PARENT`, `&BASENAME`,
  `&BASENAMEEXT` and `&CUSTOM:NAME` from the connection's `variables`. A
  member's `&LIBRARY` is the current library, asked for when the job has
  none; a variable with no value stops the run before anything is sent.
- Saving an `actions.json` checks every command with the system's
  `CheckCommand`, with sample values, and shows the system's message on
  that command's line; the action is marked in the pick. The file has a
  JSON schema.
- Compiles (the spec's list, `CRTBNDRPG` to `CRTSRVPGM`) run through QAP's
  `Compile` and put the compiler's messages in the Problems panel, on the
  member, `/COPY` member or stream file they name, with the message ID,
  the severity and the second-level text on hover. A clean compile clears
  them; **Clear Compile Diagnostics** clears all.
- `runAs: batch` submits the command with `SBMJOB` to `QBATCH` and names
  the job submitted.
- The **Code for QS/400** output channel: one block per run with the
  time, the command as sent, the job, the system's messages oldest first,
  the escape message last, how it ended, and **Job log: Show**. Cancel in
  the progress notification ends the command on the system.
- **Job Log**: the connection job's log as a read-only document, one line
  per message, with the second-level text on hover, and **Refresh**.
- Defaults: a compile for each member type of the spec's list, `CRTPGM`
  and `CRTSRVPGM` for modules, **Call (CALL)** and **Submit (SBMJOB
  CALL)** for programs, and **Run SQL statements (RUNSQLSTM)** for `.sql`
  stream files, each with `DBGVIEW(*SOURCE)` where the command takes it.
- Host: `action.run` (`Develop::compile` for compiles, `RunCommand` for
  anything else, deferred, with `action.cancel`), `action.check`
  (`CheckCommand`) and `job.log` (`Jobs::job_log`, drained whole).

## 1.0.0-pre · Phase 3 · IFS browser

- **IFS** view under Objects: the active connection's roots (by default
  `/home/<user>` and `/`, saved per connection as `ifsRoots`), with **Add
  IFS Root**, **Remove IFS Root**, **Set as IFS Home** and **Go to IFS
  Path…**. Folders list as they open, folders first; files show size and
  CCSID; symbolic links show and follow their target; hidden entries
  toggle from the title bar.
- Stream files open as editor tabs on `qs400ifs://`. Text is converted by
  the system to UTF-8 and back to the file's CCSID on save; a character
  the CCSID lacks is refused with the system's `TCP1A5A` and nothing is
  written. Images and known binary types open as bytes in VS Code's own
  viewers. Documents are capped at 10 MiB, and the refusal names the size
  and the limit and offers Download.
- A save over a change made on the system gets caught (QAP version 6's
  change counter) and asks **Overwrite** or **Reload**. An unchanged
  document is not written.
- **Upload Files…**, **Upload Folder…**, **Download…** and **Download
  Folder…** in a progress notification with Cancel; bytes go exactly as
  stored. A cancelled upload keeps the part sent, is marked partial in the
  tree, and offers **Resume**. Local files dropped on a folder upload;
  entries dragged onto a folder copy.
- File commands: **New File…** with a CCSID (1208, 37, 500, 819 or any),
  **New Folder…**, **Rename…**, **Copy to…** (folders file by file),
  **Delete** (a folder that is not empty lists its count first and is
  deleted deepest first), **Properties** and **Change CCSID…** (empty
  files only).
- Host: `ifs.list`, `ifs.info`, `ifs.readText`, `ifs.writeText`,
  `ifs.download`, `ifs.upload`, `ifs.mkdir`, `ifs.delete`, `ifs.rename`,
  `ifs.copy`, `ifs.resolve` and `ifs.cancel` over `qap-client`'s `Files`,
  with `ifs.progress` and `ifs.transferEnded`. Transfers run on threads of
  their own, so the host keeps answering while one runs.

## 1.0.0-pre · Phase 2 · object browser and members

- **Objects** view: the active connection's library list libraries (the
  current library first), their object types, objects with attribute and
  text, and the members of source files. Refresh on every node.
- **Properties** on an object: a read-only `LIBRARY/OBJECT (*TYPE)`
  document of the system's `name: value` lines, in Courier.
- Filters per connection (`code-for-qs400.connections[].filters`) with
  **Add**, **Edit** and **Remove Filter**; a filter opens straight to its
  objects.
- Members open as editor tabs on `qs400mbr://`, with the extension and
  language from the source type. Languages `qs400-rpgle`, `qs400-cl`,
  `qs400-dds`, `qs400-sql` and `qs400-cmd` are registered, without
  grammars yet.
- An open member is held as `STRSEU` holds it and let go when its last tab
  closes. A member another job holds shows the system's `CPF1002` and
  opens read-only; **Open Read-Only** opens without holding it. Locks are
  taken again after a reconnect, and any lost are reported.
- Saving keeps the sequence numbers and dates of unchanged lines, numbers
  inserted lines between their neighbours, and renumbers (with a
  notification) only when no gap is left or on **Renumber Member**. An
  unchanged member is not written. Dates are the system's.
- Member commands: **New Member**, **Copy**, **Rename**, **Delete** (asks
  by name), **Change Text** and **Compare with…** another member or a
  local file.
- Library list editing now works: `libl.get` and `libl.set` use QAP
  version 8's `GetLibraryList` and `SetLibraryList`.
- Host: `object.libraries`, `object.list`, `object.properties`,
  `member.list`, `member.read`, `member.write`, `member.unlock`,
  `member.create`, `member.copy`, `member.rename`, `member.delete` and
  `member.changeText`, over `qap-client`'s `Develop` service. Every
  connection asks for QAP version 9; a server below 8 gets
  `-32001 QAP version 8 not available on this server`. About now shows
  `QAP v9`.

## 1.0.0-pre · Phase 1 · connections and sign-on

- Saved connections in `code-for-qs400.connections` (user settings only),
  a default connection (`code-for-qs400.defaultConnection`), and passwords
  in VS Code secret storage under `code-for-qs400.password.<name>`, saved
  or asked every time.
- Commands: Add, Edit and Remove Connection, Connect, Disconnect, Set as
  Default Connection, Forget Saved Password, Switch Active Connection.
- Sign-on through `qap-client` exactly as QS/400 Access does it. The
  system's refusals are shown as `messageId: text`, unchanged, with the
  second-level text under Details. An expired password offers Change
  password. A saved password the system refuses is deleted, so it never
  counts against `QMAXSIGN` twice.
- The Connections view shows each connection's state, and under a
  connected one a **Library list** node and a **System** node (product,
  version, serial, session job, QAP version).
- Status bar item for the active connection: `QSHQ400 · CWELLMAN` when
  connected, a disconnect icon after the system's idle close; the tooltip
  has the host, the session job and the version. Click to switch.
- Silent reconnect after the system's idle timeout: the session is resumed,
  or signed on again with the password kept in memory; one password prompt
  when the system refuses it.
- Library list editing (add, remove, move up, move down, set current),
  applied to the session job and saved per connection. Waiting on QAP's
  `library_list` service: until a server has it, the node shows
  `library_list not available on this server`.
- Host: `session.connect`, `session.changePassword`, `session.disconnect`,
  `session.status`, `session.list`, `libl.get`, `libl.set` and the
  `session.changed` notification. The host now reports QAP v6, the newest
  version `qap-client` offers.

## 1.0.0-pre · Phase 0 · scaffold and host

- Extension skeleton: QS/400 activity bar container with an empty
  Connections view, **About** and **Restart Host** commands, and the
  `code-for-qs400.host.path` setting.
- `qs400-code-host` Rust sidecar speaking JSON-RPC 2.0 over stdio with
  `Content-Length` framing: `host.version`, `host.ping`, `host.shutdown`
  and the `host.log` notification. The `lsp` and `dap` subcommands are
  registered but not implemented yet.
- Host supervision: a status bar warning when the host stops, and a restart
  on the next command.
- Platform-specific pre-release VSIX files for `win32-x64` and `linux-x64`.
- CI on Windows and Linux: naming check, Rust and extension tests, and VSIX
  artifacts.
