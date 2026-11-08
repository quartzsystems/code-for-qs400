# Known limitations

What Code for QS/400 V1R0M0 does not do, or does differently from what
you might expect, and why. Most follow from what QAP or the QS/400
compiler front-ends offer at this release.

## The extension as a whole

- **Remote workspaces are not supported.** The extension runs where VS
  Code's window runs (`extensionKind` `ui`), because its host is a native
  program bundled for Windows x64 and Linux x64. In a Remote - SSH, WSL,
  container or Codespaces window it runs on your own computer, and local
  projects in the remote folder are not seen as files it can deploy.
- **Windows x64 and Linux x64 only.** There is no macOS or Arm build.
- **Restricted Mode.** The extension does not run in an untrusted
  workspace: a workspace's actions run commands on the system as your
  profile.
- **No automatic updates.** An extension installed from a VSIX is not
  updated by VS Code; install the next release's VSIX over it.

## Connections

- **Verification cannot be turned off.** A certificate that does not
  verify can be trusted for one connection (**Trust for this
  connection**), as in QS/400 Access; `tls.verify: false` is refused.

## Objects and members

- **No "Open in 5250".** Objects and members cannot be opened in a 5250
  session from the Objects view.
- **No commands for creating libraries.** Run `CRTLIB` as an action or at
  a 5250 session. Source files are made by `CRTSRCPF` when a deploy needs
  them, or as an action.

## The IFS

- **Change CCSID works only on an empty file.** QAP has no operation that
  sets a stream file's CCSID, so an empty file is deleted and created
  again with the new one (its owner and authorities become those of a new
  file). A file with data would keep its bytes under the new tag, which is
  not the same text, so the command explains instead: make a new file with
  the CCSID and copy the text into it.
- **Files over 10 MiB do not open in the editor.** Download them instead.
- **A large text file saved with a character its CCSID lacks.** Text is
  sent about 1 MiB at a time, each part converted by the system. When a
  later part is refused (`TCP1A5A`), the parts before it are already
  written. For a file that fits in one part, nothing is written.
- **A change in the instant after a save.** After writing a file the host
  reads its change counter again; a change someone else makes between the
  write and that read is taken as yours, and the next save will not warn
  about it.

## Actions and compiles

- **A batch run's diagnostics do not come back.** A submitted job runs
  outside the connection job, so its compiler messages do not reach the
  Problems panel; its listing does.

## Languages

These are what the QS/400 compiler front-ends report at this release; the
editor shows them as they are and hides nothing.

- **RPG: the compiler's own checks come only with a compile.** As you type
  you get the reader's, lexer's and parser's messages (`RNF0xxx`,
  `RNF5xxx`). A name that is not defined (`RNF7030`) and the other checks
  of the compiler proper appear after **Compile (CRTBNDRPG)**.
- **CL: every `DCLF` is reported as not found** (`CPD0744`) as you type,
  since the editor does not read a file's record formats.
- **DDS: files named by `REF`, `REFFLD`, `PFILE` and `JFILE` are not
  found** as you type, for the same reason.
- **DDS: display and ICF files are coloured but not checked.** The front
  end has no compiler for DSPF or ICFF at this release.
- **RPG outline:** a data structure's subfields are listed beside it, not
  under it.
- **Rename** changes the current document only, and a name declared in a
  copy member cannot be renamed.
- **Column guides, not rulers, for fixed-form RPG and DDS.** VS Code has rulers per
  language, not per document, so the guides are drawn on the text and
  show only as far as each line reaches.
- **Comment toggling** is off for DDS, and in RPG inserts `//`, never a
  fixed-form `*` in column 7: VS Code inserts a line comment at the first
  character that is not blank, which would move every column.
- **Local `.sql`, `.cmd` and `.cl` files** stay VS Code's SQL, Windows
  batch and OpenCL; use `files.associations` to change that.

## SQL

- **No values for parameter markers.** A statement with `?` is sent
  without values, and the system refuses it.
- **Compound statements in VS Code's own SQL language.** In a local `.sql`
  file that is not in the `qs400-sql` language, statements are split on
  `;` by the extension, so a `BEGIN … END` block is split where the SQL
  language server would keep it whole. Use the `qs400-sql` language for
  such files.

## Local projects and deploy

- **One layout**, `sourceFiles`: a directory per source file, a file per
  member.
- **Deletions are never deployed.** A file you removed is listed as **Left
  on the system** and the member or stream file stays.
- **A stream file pulled in another CCSID is deployed as UTF-8 bytes.**
  Pull converts a text file that is not 1208 to UTF-8, and deploy uploads
  bytes as they are; a file that exists keeps its own CCSID tag. Keep
  stream files of an IFS project in 1208.
- **After a window reload, a `/COPY` member's compile messages** land on
  the system's member, not on its local file, until it is deployed again
  in that window.

## Debugging

- **No Pause.** QS/400's debugger stops a job only at a breakpoint or a
  step, so set a breakpoint where it should stop.
- **No Set Value.** The system's `Eval` shows values but does not take an
  assignment at this release, so **Set Value** is not offered in
  Variables.
- **No stop on an unhandled exception or at the program's end.** The
  system reports neither at this release: an exception goes to the job's
  own handling (an inquiry message, a function check), and a step past the
  end runs on. A **Call** session ends when the call returns, with
  `CALL PGM(LIB/PROGRAM) ended: Ok` in the Debug Console.
- **A job already being serviced** (by `STRSRVJOB` at a display, say)
  cannot be attached: the system answers `CPF3503`.
- **Programs compiled without a source view** (`DBGVIEW(*LIST)`,
  `*STMT`) have no breakpoints in the source; the Call Stack stands on a
  document of statement numbers. `DBGVIEW(*NONE)` cannot be debugged; the
  notification offers to recompile.
