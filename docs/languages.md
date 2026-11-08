# Language support

Code for QS/400 colours, checks and navigates RPG, CL, DDS, SQL and
command definition source, in members (`qs400mbr`), stream files
(`qs400ifs`) and local files alike. The checking is done by the QS/400
compiler front-ends themselves, running in `qs400-code-host`: the editor
reports what the compiler's own reader and parser report, nothing
filtered and nothing added.

## Languages

| Language | Id | Member types | Local file extensions |
| --- | --- | --- | --- |
| RPG (fixed form, free form, `**FREE`, SQLRPGLE) | `qs400-rpgle` | `RPGLE`, `SQLRPGLE`, `RPG` | `.rpgle`, `.sqlrpgle`, `.rpgleinc`, `.rpg` |
| CL | `qs400-cl` | `CLLE`, `CLP`, `CL` | `.clle`, `.clp` |
| DDS (PF, LF, DSPF, PRTF, ICFF) | `qs400-dds` | `PF`, `LF`, `DSPF`, `PRTF`, `ICFF` | `.pf`, `.lf`, `.dspf`, `.prtf`, `.icff` |
| SQL | `qs400-sql` | `SQL` | none |
| Command definition | `qs400-cmd` | `CMD` | none |

A member gets its language from its source type when it opens. Local
`.sql`, `.cmd` and `.cl` files are left to VS Code's SQL, Windows batch
and OpenCL support; to use the QS/400 languages for them, add a
`files.associations` setting, for example
`"files.associations": { "*.sql": "qs400-sql" }`.

## Colouring

Each language has a TextMate grammar with the usual scopes, so every
theme colours it:

- **RPG**: fixed-form H, F, D, I, C, O and P specifications by column
  (the columns of QS/400's own specification table), `*` comments in
  column 7, columns 81 to 100 as comments, compile-time data after
  `**CTDATA`; free form in `/FREE` blocks, in columns 8 to 80 of a fixed
  member, and in `**FREE` members; the directives (`/COPY`, `/INCLUDE`,
  `/IF DEFINED`, `/ELSEIF`, `/ELSE`, `/ENDIF`, `/DEFINE`, `/UNDEFINE`,
  `/EOF`, `/TITLE`...); and the SQL of `EXEC SQL ... ;` and
  `C/EXEC SQL ... C/END-EXEC`, coloured by the SQL grammar.
- **CL**: labels, commands (control commands, `DCL` and `DCLF` apart from
  the rest), parameters, `&variables`, built-ins, `*` values, strings and
  `/* */` comments, a command continued over `+` and `-` lines.
- **DDS**: every specification by column, `A*` comments, and the keyword
  area (columns 45 to 80) with its parameters.
- **SQL**: keywords, types, functions, strings, delimited names, host
  variables (`:NAME`) and `--` and `/* */` comments.
- **Command definitions**: `CMD`, `PARM`, `ELEM`, `QUAL`, `DEP` and
  `PMTCTL`, their keywords, labels and `/* */` comments.

## Fixed-form guides and the column

In a fixed-form RPG member, each specification line shows a guide at the
start of each of its fields, in the editor's ruler colour: a D
specification's at columns 7, 22, 24, 26, 33, 40, 41 and 44, a C
specification's at its factors, operation code and result. The status bar
shows the field under the cursor, for example `D · Ds 24–25 · col 24`. A
`**FREE` member has neither. The field table is the RPG front end's own.

A guide shows only where the line reaches: VS Code has no rulers per
document, only per language, so the guides are drawn on the text.

DDS members get rulers at the specification's columns (the
`[qs400-dds]` default of `editor.rulers`; change it in your settings).

Comment toggling (Ctrl+/) inserts `//` in RPG, `--` in SQL and `/* */`
in CL and command definitions. It is off for DDS and cannot write a
fixed-form `*` in column 7: VS Code inserts a line comment at the first
character that is not blank, which in those sources would move every
column.

## What the language servers do

One `qs400-code-host lsp <lang>` runs per language per window, started
when the first document of that language opens. Its log is the **Code
for QS/400 Languages** output channel. Each document is analyzed when it
opens and 300 ms after you stop typing.

| Feature | What you get |
| --- | --- |
| Diagnostics | Each message the front end reports, at its line and columns, with its ID (`RNF5014`, `CPD0727`, `SQL0104`) as the code and the second-level text below it on hover. The severity table is the Problems panel's for compiles: below 10 information, 10 to 19 warning, 20 and above error. |
| Outline | The member's procedures, subroutines, files, record formats, data structures, fields, constants, prototypes, labels and command keywords, each under the procedure, format or file it belongs to. |
| Go to Definition | From a name to its declaration, in the member or in a `/COPY` or `/INCLUDE` member, which opens read-only. From a directive, to the member it brings in. |
| Hover | The declaration's type and length, and for a name from a copy member, the directive that brought it in. On a directive, the member it found, or `not found`. |
| Completion | The language's keywords, operation codes and built-ins; the names declared in scope; after `/COPY` or `/INCLUDE` in RPG, the members of the source file named (`QRPGLESRC` when none is). |
| Rename | A name's declaration and every reference to it, in this document only. A name declared in a copy member is refused, with where it is declared. |
| Folding | Procedures, subroutines, `IF`, `DO` and `SELECT` groups, data structures, CL `PGM`, `DO` and `SUBR` groups, DDS record formats, multi-line SQL statements and command definition statements. |

Compile diagnostics are kept apart from these: after a compile,
the Problems panel shows the compiler's messages (source `CRTBNDRPG`) and
the editor's (source `qs400-rpgle`) side by side.

### Per language

- **RPG** (`rpgfront`): fixed form, free form and `**FREE`, the
  directives with `/IF DEFINED` evaluated (no condition names are
  defined, as with the compile commands' default `DEFINE`), and the
  `EXEC SQL` of SQLRPGLE. At this release the front end reports what its
  reader and parser find (the `RNF0xxx` and `RNF5xxx` messages). The
  checks of the compiler proper, such as `RNF7030` for a name that is not
  defined, come only with a compile.
- **CL** (`cl`): a `DCLF` file's record formats live in the file object,
  which the editor does not read, so each `DCLF` is reported as not found,
  as a compile without the file would report it.
- **DDS** (`dds`): the compiler is chosen by the source type (PF, LF or
  PRTF). Files named by `REF`, `REFFLD`, `PFILE` and `JFILE` are objects
  the editor does not read, so they are not found. DSPF and ICFF sources
  are coloured but not checked: the front end has no compiler for them at
  this release.
- **SQL** (`sql`): with `NAMING(*SYS)`, as `RUNSQLSTM` defaults it. The SQL
  inside SQLRPGLE is checked by the RPG front end.
- **Command definitions** (`cmd`): the command takes the member's (or the
  stream file's) name, as the default `CRTCMD` action does.

## Includes

The language servers never read the network. When the RPG front end
meets `/COPY`, `/INCLUDE` or `EXEC SQL INCLUDE`, the server asks the
extension (`qs400/fetchInclude`), which answers from a local project
when one holds it (below), else reads it through the host:

- A member: `member.read` without a lock. A library not written, or
  written as `*LIBL` or `*CURLIB`, is looked up with the job's library
  list (`object.list` of the source file), and the first library holding
  the member answers, so messages name the library the compiler would
  find. The member opens read-only from Go to Definition.
- A stream file: `ifs.readText`. A relative path is taken from the
  including stream file's folder, else from `/`.
- Not found, or no connection signed on: the directive is reported as the
  compiler would report a member it cannot open.

The connection is the document's own (`qs400mbr`, `qs400ifs`). For a
local file it is its project's connection, or the active connection when
the file is in no project.

In a workspace with [local projects](projects.md), includes are read from
the projects' files first and from the system only when no project has
them; see [Includes](projects.md#includes) there.

What is fetched is kept for every document in the window, and a member
not found is remembered as not found. Saving a member or stream file
through the extension, or a connection signing on again, tells the
servers to read it again.

An include's own messages appear in that member when it is open (its
writable or its read-only document). When it is not, the directive line
of the member that includes it says how many there are:
`2 messages in HLINV/QRPGLESRC(ASSETSCP)`, at the highest of their
severities; open the member to see them.

## Parity with the compiler

The test of all this is that the editor's diagnostics match a compile's,
line for line. `test/parity.test.ts`, run against a real system, opens
every member of `HLINV`'s `QRPGLESRC`, `QCLSRC`, `QDDSSRC` and `QSQLSRC`,
waits for the language server, runs the member's default compile, and
compares the two as sets of (source, line, message ID). With
`QS400_PARITY_RECORD=1` it writes each compile to `host/fixtures/parity/`,
and `cargo test -p code-host --test parity` compares them again without
the system (see that folder's README).

A difference is printed as a table, for example:

```
member                    source                    line  id       where
HLINV/QRPGLESRC(ASSETS)   HLINV/QRPGLESRC(ASSETS)     42  RNF7030  compiler only
HLINV/QCLSRC(INVBUILD)    HLINV/QCLSRC(INVBUILD)      12  CPD0744  editor only
```

- **compiler only**: the compile reported it and the front end did not.
  Either the check belongs to a later stage of the compiler (binding,
  generation, the RPG compiler's name checks), or the front end misses
  it.
- **editor only**: the front end reported it and the compile did not.
  Often the front end lacked something the compile had: a `DCLF` file
  (`CPD0744 file HLINV/ITEMMST was not found`), a `REF` file, an include
  the editor could not fetch.

Either way the editor is not changed to hide it: each row is reported as
an issue against the `quartz-systems-400` front end, with the member, the
line and the ID.
