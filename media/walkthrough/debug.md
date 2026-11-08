# Start debugging

Compile the program with `DBGVIEW(*SOURCE)` (the default compiles do),
set a breakpoint in the member's gutter, and run **Debug (Call)** from
the member's editor title or on the program in the Objects view.

The debug session signs on with a connection of its own, calls the
program and stops at the breakpoint:

- **Call Stack**: `ASSETS › ASSETS › main · stmt 42`
- **Variables**: the procedure's fields; data structures and arrays open
  to their parts
- **Debug Console**: `EVAL NAME`, `NAME:x`, `NAME:c`

**Debug (Service entry)** stops the next job of yours that calls the
program, such as a 5250 session, instead of calling it. **Attach to
Job…** in the Jobs view attaches to a running job.

Pause is not offered: QS/400's debugger stops a job only at a breakpoint
or a step.
