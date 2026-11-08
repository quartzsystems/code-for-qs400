# Actions and diagnostics

An **action** is a named CL command run against a source member, a stream
file or an object: a compile, a `CALL`, a submitted job. **Run Action…**
offers the actions that apply, runs the one you pick in the connection
job, writes what happened to the **Code for QS/400** output channel, and
puts a compiler's messages in the Problems panel on the lines they point
at. It needs a server at QAP version 8 or later for compiles and the job
log; plain commands need version 2.

## Running an action

**Run Action…** (`code-for-qs400.action.run`) is on:

- the editor title bar (the ▶ button) and the editor's context menu, for
  an open member or stream file;
- the context menu of a member, an object or a stream file in the Objects
  and IFS views;
- the Command Palette, for the active editor.

The pick lists the actions whose `environment` and `extensions` match the
target. The one you ran last on that kind of target (that member type,
file extension or object type, on that connection) comes first. An
action that failed the last check of its file (see
[Checking actions.json](#checking-actionsjson)) is marked with a warning
and the reason.

Before anything is sent:

- A document with unsaved changes is saved. If the save fails, nothing
  runs.
- Each variable is replaced (see [Variables](#variables)). A variable
  with no value for the target is an error, and nothing is sent.
- For a member or a stream file, `&LIBRARY` is the connection job's
  current library. When the job has none, you are asked for a library.

The command then runs in the connection job, in its turn behind any other
command of that connection. A progress notification shows it while it
waits and runs; **Cancel** asks the system to end it, and the output
channel says `Cancelled`.

A command whose name is one of the compiles QAP knows (`CRTBNDRPG`,
`CRTRPGMOD`, `CRTSQLRPGI`, `CRTBNDCL`, `CRTCLMOD`, `CRTPF`, `CRTLF`,
`CRTDSPF`, `CRTPRTF`, `CRTCMD`, `RUNSQLSTM`, `CRTPGM`, `CRTSRVPGM`) runs as
a compile, and its diagnostics come back. Any other command runs as a
command: its messages come back, and no diagnostics.

### The output channel

Each run writes one block to **Code for QS/400**:

```
── 2026-11-07 23:59:01 · Compile (CRTBNDRPG) · HLINV/QTMPSRC(ASSETS42) · QSHQ400
Command: CRTBNDRPG PGM(CWELLMAN/ASSETS42) SRCFILE(HLINV/QTMPSRC) SRCMBR(ASSETS42) DBGVIEW(*SOURCE) OPTION(*EVENTF)
Job:     123456/QUSER/QAPCNN
RNS9310  Program ASSETS42 was not created in library CWELLMAN.
Ended:   Error
Job log: Show
Listing: Open  QSYSPRT(8) 123456/QUSER/QAPCNN · QSHQ400
```

The command is shown as sent, with its variables replaced. The messages
are the system's own, oldest first, as `ID  text`; the escape message
that ended the command comes last. The job on the `Job:` line opens the
**Jobs** view on it, and **Show** on `Job log: Show` opens its log. When a
compile wrote its listing during the run (the command's `PRTFILE`, else
`QSYSPRT`), **Open** on `Listing: Open` shows it in the spooled file
viewer; see [Jobs, spooled files and messages](jobs-spool-messages.md).

### Batch

An action with `"runAs": "batch"` is submitted instead:
`SBMJOB CMD(<command>) JOB(<name>) JOBQ(QBATCH)`, where the job is named
after the target (`&NAME`) when that is a valid name. The output channel
names the job submitted (`Submitted: 654321/CWELLMAN/ASSETS`), and its
`Job log: Show` opens that job's log. A batch job runs outside the
connection job, so its diagnostics do not come back; its listing does:
when the submitted job writes it, within 10 minutes, a `Listing: Open`
line naming the file and the connection is added, after whatever the
channel shows by then.

## Diagnostics

A compile's messages go to the Problems panel:

- On the document they point at: the member compiled, a `/COPY` member it
  includes, or a stream file. A `/COPY` member that is not open opens
  read-only when you click its entry. A message that points nowhere goes
  on line 1 of the target (an object's is on its **Properties**
  document).
- At the line and columns the compiler gave. A message with no column
  covers the whole line.
- With the message ID as its code and the first-level text as its
  message. The second-level text (cause and recovery) shows on hover and
  in the entry's detail.
- Severity: below 10 is information, 10 to 19 a warning, 20 and above an
  error.

Each compile replaces the diagnostics its target's last compile left, on
every document either reported on, and leaves those of other compiles
alone. A clean compile clears them. Closing a document keeps its
diagnostics; **Clear Compile Diagnostics**
(`code-for-qs400.diagnostics.clear`) removes them all. Commands, batch
runs and cancelled compiles do not change them.

## The job log

**Job Log** (`code-for-qs400.job.log`) opens the log of the active
connection's job, the job actions run in, as a read-only document named
`Job log nnnnnn/USER/NAME`. Each line is `time  ID  text`, oldest first,
so the newest message is at the bottom, with its kind as a glyph in the
gutter. Hover a message ID for its second-level text and the programs it
went from and to. **Refresh** on the editor title bar reads it again. The
**Jobs** view's **Job Log** opens the same document for any job.

## Where actions come from

Three places, each overriding the one before it by action name (names
compare without case):

1. **Defaults** shipped with the extension (below).
2. **`.vscode/actions.json`** in each workspace folder. With several
   folders, a later folder overrides an earlier one.
3. **The connection's own**, `actions` in its entry of
   `code-for-qs400.connections`: the place for a site's choices, such as a
   `TGTRLS` or a `DBGVIEW`, that should hold whatever workspace is open.

An overriding action keeps the place of the one it overrides in the list.

### The file

`.vscode/actions.json` is a JSON array; comments and trailing commas are
allowed. VS Code checks it against `schemas/actions.json` as you type.

```json
[
  {
    "name": "Compile (CRTBNDRPG)",
    "command": "CRTBNDRPG PGM(&LIBRARY/&NAME) SRCFILE(&SRCLIB/&SRCFILE) SRCMBR(&NAME) DBGVIEW(*SOURCE) OPTION(*EVENTF)",
    "environment": "member",
    "extensions": ["rpgle"],
    "refresh": "parent",
    "runAs": "connection"
  }
]
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Shown in the pick; the key overrides go by. |
| `command` | yes | The CL command, with [variables](#variables). |
| `environment` | yes | `member`, `file` (a stream file) or `object`. |
| `extensions` | no | Member types or extensions (`RPGLE`, `rpgle`), file extensions (`sql`), or object types (`*PGM` or `PGM`), compared without case. Left out, or `"*"`: every target of the environment. |
| `refresh` | no | `none` (the default), `parent` or `library`: after the run, the Objects view (or, for a stream file, the IFS view) is read again. |
| `runAs` | no | `connection` (the default) or `batch`. |

### Variables

| Variable | Member | Stream file | Object |
| --- | --- | --- | --- |
| `&LIBRARY` | the current library, or the library you are asked for | the same | the object's library |
| `&NAME` | the member | the file's name without its extension, upper case | the object |
| `&TYPE` | the source type (`RPGLE`) | the extension, upper case | the object type (`*PGM`) |
| `&EXT` | the extension (`rpgle`) | the extension (`sql`) | the attribute, lower case (`rpgle`) |
| `&SRCFILE` | the source file | — | — |
| `&SRCLIB` | the source file's library | — | — |
| `&FULLPATH` | — | the path | — |
| `&PARENT` | — | the folder it is in | — |
| `&BASENAME` | — | the name without its extension | — |
| `&BASENAMEEXT` | — | the name with its extension | — |
| `&CURLIB` | the connection job's current library | the same | the same |
| `&USERNAME` | the signed-on user | the same | the same |
| `&HOST` | the connection's host | the same | the same |
| `&CUSTOM:NAME` | the connection's variable `NAME` | the same | the same |

`—` means the variable has no value for that target, and an action using
it does not run there. `&&` is a literal `&`. Variable names are not case
sensitive. A word after `&` that is none of these is an error in the file.

`&CUSTOM:NAME` comes from the connection's `variables`:

```json
"code-for-qs400.connections": [
  {
    "name": "QSHQ400",
    "host": "qshq400.example.com",
    "user": "CWELLMAN",
    "variables": { "TGTRLS": "V1R0M0" }
  }
]
```

### Checking actions.json

Saving any `.vscode/actions.json` checks it without running anything:

- the JSON, and each action's fields;
- each variable, by name;
- each command, through the system's own command check (`CheckCommand`)
  on the active connection, with sample values in place of the variables
  (`QTEMP` for libraries, `SAMPLE` for names, the connection's own value
  for `&CUSTOM:` when it has one).

What the check finds is shown on the line of that action's `command`,
with the system's message ID and text, and the action is marked in the
pick. With no connection signed on, the commands are not checked, and the
file says so.

## The defaults

| Name | Environment | Extensions | Command |
| --- | --- | --- | --- |
| Compile (CRTBNDRPG) | member | `rpgle` | `CRTBNDRPG PGM(&LIBRARY/&NAME) SRCFILE(&SRCLIB/&SRCFILE) SRCMBR(&NAME) DBGVIEW(*SOURCE) OPTION(*EVENTF)` |
| Compile module (CRTRPGMOD) | member | `rpgle` | `CRTRPGMOD MODULE(&LIBRARY/&NAME) … DBGVIEW(*SOURCE) OPTION(*EVENTF)` |
| Compile (CRTSQLRPGI) | member | `sqlrpgle` | `CRTSQLRPGI OBJ(&LIBRARY/&NAME) … OBJTYPE(*PGM) DBGVIEW(*SOURCE) OPTION(*EVENTF)` |
| Compile (CRTBNDCL) | member | `clle` | `CRTBNDCL PGM(&LIBRARY/&NAME) … DBGVIEW(*SOURCE) OPTION(*EVENTF)` |
| Compile module (CRTCLMOD) | member | `clle` | `CRTCLMOD MODULE(&LIBRARY/&NAME) … DBGVIEW(*SOURCE) OPTION(*EVENTF)` |
| Compile (CRTPF), (CRTLF), (CRTDSPF), (CRTPRTF) | member | `pf`, `lf`, `dspf`, `prtf` | `CRTPF FILE(&LIBRARY/&NAME) SRCFILE(&SRCLIB/&SRCFILE) SRCMBR(&NAME) OPTION(*EVENTF)`, and the same for each |
| Compile (CRTCMD) | member | `cmd` | `CRTCMD CMD(&LIBRARY/&NAME) PGM(&LIBRARY/&NAME) SRCFILE(&SRCLIB/&SRCFILE) SRCMBR(&NAME)` |
| Compile (RUNSQLSTM) | member | `sql` | `RUNSQLSTM SRCFILE(&SRCLIB/&SRCFILE) SRCMBR(&NAME) COMMIT(*NONE) DBGVIEW(*SOURCE)` |
| Create program (CRTPGM) | object | `*MODULE` | `CRTPGM PGM(&LIBRARY/&NAME) MODULE(&LIBRARY/&NAME)` |
| Create service program (CRTSRVPGM) | object | `*MODULE` | `CRTSRVPGM SRVPGM(&LIBRARY/&NAME) MODULE(&LIBRARY/&NAME) EXPORT(*ALL)` |
| Call (CALL) | object | `*PGM` | `CALL PGM(&LIBRARY/&NAME)` |
| Submit (SBMJOB CALL) | object | `*PGM` | `CALL PGM(&LIBRARY/&NAME)`, submitted (`runAs: batch`) |
| Run SQL statements (RUNSQLSTM) | file | `sql` | `RUNSQLSTM SRCSTMF('&FULLPATH') COMMIT(*NONE) DBGVIEW(*SOURCE)` |

Every default whose command takes `DBGVIEW` asks for `DBGVIEW(*SOURCE)`,
so the program can be debugged at its source without editing the action.
`OPTION(*EVENTF)` is accepted but writes no event file on QS/400: the
diagnostics come back with the compile itself.

## Adding a site default

To change a default for everyone using a system, override it by name in
that connection's `actions`, in your user settings:

```json
"code-for-qs400.connections": [
  {
    "name": "QSHQ400",
    "host": "qshq400.example.com",
    "user": "CWELLMAN",
    "variables": { "TGTRLS": "V1R0M0" },
    "actions": [
      {
        "name": "Compile (CRTBNDRPG)",
        "command": "CRTBNDRPG PGM(&LIBRARY/&NAME) SRCFILE(&SRCLIB/&SRCFILE) SRCMBR(&NAME) DBGVIEW(*ALL) TGTRLS(&CUSTOM:TGTRLS)",
        "environment": "member",
        "extensions": ["rpgle"],
        "refresh": "parent"
      }
    ]
  }
]
```

To share actions with a team, commit `.vscode/actions.json` to the
project instead: the same shape, the same names to override, and new
names to add. A connection's actions still win over the project's, so a
site setting holds whatever project is open.
