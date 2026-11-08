# Compile and read the Problems panel

With a member open, click **Run Action…** (▶ in the editor title) and
pick **Compile (CRTBNDRPG)**. The compile runs in the connection job and
writes a block to the **Code for QS/400** output channel:

```
── 2026-11-08 09:12:01 · Compile (CRTBNDRPG) · HLINV/QRPGLESRC(ASSETS) · QSHQ400
Command: CRTBNDRPG PGM(HLINV/ASSETS) SRCFILE(HLINV/QRPGLESRC) SRCMBR(ASSETS) DBGVIEW(*SOURCE) OPTION(*EVENTF)
Job:     123456/QUSER/QAPCNN
RNS9310  Program ASSETS was not created in library HLINV.
Ended:   Error
Job log: Show
```

The compiler's messages go in the **Problems** panel at the line and
columns they name, with the message ID as the code and the second-level
text on hover. Fix the line and compile again: a clean compile clears
them.

Actions come from the defaults, `.vscode/actions.json` and the
connection's own; see the Actions guide.
