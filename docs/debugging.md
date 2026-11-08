# Debugging

RPG and CL programs are debugged in VS Code's own debugger: breakpoints in
the gutter, the Run and Debug view's Call Stack, Variables and Watch, the
Debug Console, hover on a field. Underneath is QS/400's own source
debugger, the one `STRDBG` runs, with its stops reported to VS Code
instead of a display.

Each debug session signs on with a connection of its own, separate from
the editor's: the program you debug can stop for as long as you like and
the Objects view, saves and compiles go on meanwhile. It signs on as the
connection's user with the saved password (or asks for one), and its job
gets the library list the editor's session has at that moment.

## What a program needs

A program can be debugged in its source when it was compiled with a
source view. The default compile actions (see [Actions](actions.md))
already compile with `DBGVIEW(*SOURCE)`.

| `DBGVIEW` | What you get |
| --- | --- |
| `*SOURCE`, `*COPY`, `*ALL` | Breakpoints in the source; the Call Stack opens the source at the line. |
| `*LIST`, `*STMT` | No breakpoints in the source. The Call Stack stands on a read-only document of statement numbers (line *n* is statement *n*), so stepping still shows where you are. |
| `*NONE` | The program cannot be debugged. Starting is refused with the system's `CPF9C15`, and the notification offers **Recompile with DBGVIEW(*SOURCE)**: it runs the source's default compile with that option, then offers **Start again**. |

The source a frame opens is, in order: the local file of a
[project](projects.md) the member was deployed from, the member itself
(read-only), or the stream file. The system knows which source a program
was compiled from; nothing needs to be configured.

## Three ways to start

### Call

The program is called in the debug session's own job, with the
parameters you give. Breakpoints are set before the call. When the
program ends, its messages and the call's outcome appear in the Debug
Console and the session ends.

Start it with **Debug (Call)** on a program in the Objects view, in the
title bar of a member's editor (when its program is in the current
library), or on a file of a project (it is deployed first, and compiled
when the program is older than the source). Or in `.vscode/launch.json`:

```json
{
  "type": "qs400",
  "request": "launch",
  "name": "Call HLINV/ASSETS",
  "connection": "QSHQ400",
  "program": "HLINV/ASSETS",
  "parameters": ["DESK", 3],
  "programs": ["HLINV/ASSETSRV"]
}
```

- `parameters` become `CALL PGM(HLINV/ASSETS) PARM('DESK' 3)`: a string
  is passed quoted (its quotes doubled), a number as typed. Give a number
  as a string to pass it as characters.
- `programs` are further programs or service programs to debug, for
  breakpoints in programs this one calls.
- `connection` and `program` can be left out: the active connection, and
  the program of the member or project file in the editor (or the program
  selected in the Objects view), are used. **F5** with no `launch.json`
  does this.

### Service entry

Nothing is called. The session waits until a job of the user calls the
program, from a 5250 command line, a menu or another program, and stops
that job at the program's first statement. Its breakpoints then apply to
that job. This is how you debug a program as a display user runs it.

```json
{
  "type": "qs400",
  "request": "launch",
  "name": "Service entry",
  "connection": "QSHQ400",
  "mode": "serviceEntry",
  "program": "HLINV/ASSETS",
  "user": "*CURRENT"
}
```

Or **Debug (Service entry)** where **Debug (Call)** is. The status bar shows
`waiting for HLINV/ASSETS`, then the job that called it. `user` is
`*CURRENT` (your own jobs) or another profile, which needs `*SERVICE`
authority.

### Attach

The session attaches to a job that is already running, as `STRSRVJOB`
does: **Attach to Job…** on a job in the Jobs view asks which programs to
debug in it. Or:

```json
{
  "type": "qs400",
  "request": "attach",
  "name": "Attach to job",
  "connection": "QSHQ400",
  "job": "123456/CWELLMAN/QPADEV0001",
  "programs": ["HLINV/ASSETS"]
}
```

The job takes the breakpoints at its next program call. A job of another
user needs `*SERVICE`. **Disconnect** lets the job go on.

## What the display user sees

While a job is stopped (a service entry or an attached 5250 session), its
display waits with the keyboard locked, exactly as under `STRDBG` at a
console. **Continue**, **Step** or ending the debug session lets it go on;
the user sees the program carry on from where it stopped.

## While stopped

- **Call Stack**: one thread, the job (`nnnnnn/USER/NAME`, also in the
  status bar), and each entry as `PROGRAM › MODULE › PROCEDURE · stmt n`.
- **Variables**: one scope, **Locals**, with the procedure's fields as
  `EVAL` shows them. A data structure or an array opens to its parts.
- **Hover** on a field shows its value. **Watch** takes the same names.
- **Debug Console**: `NAME`, `NAME:x` (hexadecimal) or `NAME:c`
  (characters), with or without `EVAL` in front, as at `STRDBG`; for a CL
  program `&NAME` works too.
- **Step Over**, **Step Into**, **Step Out** and **Continue**. **Pause**
  is not there: QS/400's debugger stops a job only at a breakpoint or a
  step, so set a breakpoint where it should stop.
- **Conditional breakpoints**: right-click a breakpoint, **Edit
  Condition**, and write `variable op value` with `op` one of `=`, `<>`,
  `<`, `<=`, `>`, `>=`, for example `ASSETCOUNT > 3`. The system decides
  when it holds; a condition it cannot read is shown on the breakpoint.
- A breakpoint on a line where no statement starts moves to the next
  statement.
- **Set Value** in Variables appears only when the system's debugger can
  change a value. QS/400's `Eval` at this release only shows values, so
  it does not appear.

## Limits

- A debug session's connection debugs one session at a time; each VS Code
  debug session has its own connection, so two can run at once.
- A job already being serviced (by `STRSRVJOB` at a display, say) cannot
  be attached: the system answers `CPF3503`.
- An exception the program does not handle goes to the job as it would
  without the debugger (an inquiry message, a function check), and a step
  past the program's end runs on: the system does not report either as a
  stop at this release.
