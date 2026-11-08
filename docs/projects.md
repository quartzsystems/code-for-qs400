# Local projects and deploy

A workspace folder can be a **project**: a local copy of a library's
source (or of an IFS directory) that you keep under git and deploy back to
the system. A `qs400project.json` in the folder's root says where it
goes. You edit the local files with every language feature; **Deploy**
writes the files you changed, keeping each member's sequence numbers and
dates; **Pull** brings the system's copy down.

## Start from a library

1. Open an empty folder in VS Code.
2. Run **Code for QS/400: Pull Library…**, or right-click a library in the
   Objects view. Pick the library, then the source files (all are picked
   to start with).
3. Give the target library: the library this folder deploys to. It offers
   the one you pulled from; give another (say `HLINVDEV`) to deploy to a
   copy.

The folder now holds a directory per source file and a file per member,
`qs400project.json`, and a `.gitignore` with `.qs400/`:

```
QCLSRC/BUILD.clle
QDDSSRC/ASSETSP.pf
QRPGLESRC/ASSETS.rpgle
QSQLSRC/SEED.sql
qs400project.json
.gitignore
```

Members are written as plain text with a newline after each line, with no
sequence numbers and no dates: those belong to the system. Run `git init`
and commit.

## Start from source you already have

Run **Code for QS/400: Initialize Project…** (in the Project view, or
right-click a workspace folder in the Explorer). Pick the connection, then
**Library** or **IFS directory**, then the target: a library (offered the
folder's name) or an IFS path (offered `/home/<user>/<folder>`). It writes
`qs400project.json` and the `.qs400/` line in `.gitignore`, opens the
project file, and pulls nothing. A folder whose top-level directories are
named like source files (`QRPGLESRC`, `qddssrc`) is offered **Library**
first. A folder that already has a `qs400project.json` gets it opened.

**Pull Source File** (on a source file in the Objects view), **Pull
Member** (on members) and **Pull into Project** (on a file or folder in
the IFS view) pull less. A local file you changed since the last deploy or
pull is asked about first: **Overwrite** or **Keep**.

## `qs400project.json`

```json
{
  "connection": "QSHQ400",
  "target": { "library": "HLINVDEV" },
  "layout": "sourceFiles",
  "encoding": { "ifsCcsid": 1208 },
  "ignore": [".git/**", "node_modules/**", "*.md"],
  "texts": { "QRPGLESRC/ASSETS.rpgle": "Asset maintenance" },
  "actions": []
}
```

| Field | Meaning |
| --- | --- |
| `connection` | The saved connection, by name. |
| `target` | `{ "library": "LIB" }`, or `{ "path": "/home/USER/app" }` for an IFS directory. |
| `layout` | `sourceFiles`, the only layout. |
| `encoding.ifsCcsid` | The CCSID of a stream file a deploy creates; default 1208. A file that exists keeps its own. |
| `ignore` | Globs of files never deployed. `*` and `?` match within a name, `**` across directories; a glob without `/` matches a name in any directory, one with `/` is from the folder. `.git/**`, `.gitignore`, `.gitattributes`, `.qs400/**`, `.vscode/**` and `qs400project.json` are always ignored. |
| `texts` | Member text by local path, given when a deploy creates a member. Pull fills it; a member that exists keeps its own text. |
| `actions` | Actions as in `.vscode/actions.json`. They override the workspace's by name, and a connection's override them. |

Saving the file checks it: a problem shows in the Problems panel on its
place, and a connection name that is not saved is a warning.

### The layout

In a library project each directory is a source physical file and each
file in it a member, `MEMBER.ext`. The extension gives the member's source
type, by the same table the Objects view uses: `.rpgle` RPGLE,
`.sqlrpgle` SQLRPGLE, `.rpg` RPG, `.clle` CLLE, `.clp` CLP, `.cl` CL,
`.pf` PF, `.lf` LF, `.dspf` DSPF, `.prtf` PRTF, `.icff` ICFF, `.cmd` CMD,
`.sql` SQL, `.c` C, `.cpp` CPP, `.txt` TXT, `.bnd` BND, `.pnlgrp` PNLGRP,
`.menu` MENU, and `.mbr` (or no extension) none. Any other extension is
its own type in upper case.

Local names may be in any case; files and members are named in upper case
on the system. Two local files that name the same member, such as
`ASSETS.rpgle` and `assets.RPGLE`, or `ASSETS.rpgle` and `ASSETS.sqlrpgle`,
are an error, and neither is deployed. Files that are not one level down
in a directory, or whose names are not system names, are skipped and said
so in the output.

In an IFS project the folder's own tree is the target directory's.

### `.qs400/state.json`

The only local state. For each file it records a hash of its content and
the system's change timestamp at the last deploy or pull, and where that
timestamp is from. It is kept out of git by the `.gitignore` line. A
member's hash is of its lines with line endings and trailing blanks left
out, which a member cannot hold, so a checkout with CRLF is not a change.

## Deploy

| Command | What it deploys |
| --- | --- |
| **Deploy Changed** (editor title, Project view, status bar) | Files whose content differs from the last deploy or pull, and files never deployed. |
| **Deploy All** | Every file of the project. |
| **Deploy Git-Changed** | The files git reports changed, staged or untracked. Outside a git repository it deploys the changed files and says so. |
| **Deploy File** (Explorer, Project view) | The one file. |

Each saves your open documents of the project first. Then, for a library:

- A source file that is not in the library is made with `CRTSRCPF
  FILE(LIB/FILE) RCDLEN(112)` after a question naming it; declining skips
  its members.
- A member that exists is read and locked, and the local lines go through
  the same save rules as an editor's save: an unchanged line keeps its
  sequence number and date, a changed line keeps its sequence number and
  the system dates it today, an inserted line is numbered between its
  neighbours. The write ends the lock. A member that already holds the
  lines is not written.
- A member that is not there is created with the type of its extension and
  the text `texts` gives, and numbered from `0001.00`.

For an IFS target each file is uploaded with Replace, its directory made
when it is not there, with the progress and Cancel of an upload.

Deletions are never deployed: a file you removed is listed in the output
as **Left on the system** once, and the member or stream file stays.

The **Code for QS/400** output channel shows a line per file, then
`n deployed, n skipped, n conflicts`:

```
── 2026-11-08 15:12:40 · Deploy changed · HLINVDEV · QSHQ400
Deployed QRPGLESRC/ASSETS.rpgle → HLINVDEV/QRPGLESRC(ASSETS)
1 deployed, 0 skipped, 0 conflicts
```

### Conflicts

A file is in conflict when the system changed it since your last deploy or
pull: the member's change time (or the stream file's change counter) is
newer than the one recorded. Someone editing the member at a 5250 session
with `STRSEU` does exactly that. The timestamps are read before anything is
written, every conflict is listed in the output first, and then each is
asked about:

- **Overwrite**: the local file replaces the system's.
- **Pull**: the system's copy replaces the local file, which then shows as
  Changed: look at it with `git diff`, keep what you want, and deploy
  again.
- **Skip**: neither changes.

A timestamp recorded from another library (you pulled `HLINV` and deploy
to `HLINVDEV`) is no baseline, so the first deploy to a library is never a
conflict.

## Actions on local files

**Run Action…** on a local file of a project (the editor title, or the
palette) deploys that one file with the conflict check, then runs the
action against the member or stream file it deployed to. For a library
project `&LIBRARY` and `&SRCLIB` are the target library, `&SRCFILE` the
file's directory, `&NAME` and `&TYPE` its name and extension; `&CURLIB` is
still the connection's. For an IFS project `&FULLPATH` is the deployed
path. **Compile (CRTBNDRPG)** on `QRPGLESRC/ASSETS.rpgle` of a project
targeting `HLINVDEV` runs:

```
CRTBNDRPG PGM(HLINVDEV/ASSETS) SRCFILE(HLINVDEV/QRPGLESRC) SRCMBR(ASSETS) DBGVIEW(*SOURCE) OPTION(*EVENTF)
```

The compiler's messages on a deployed member or stream file go on its
local file in the Problems panel, at the same line; a message on a member
that has no local file stays on the system's member, as before.

## Includes

`/COPY` and `/INCLUDE` are read from the workspace first. A `/COPY
QRPGLESRC,ASSETCP` is answered from `QRPGLESRC/ASSETCP.*` of a library
project on the document's connection, its own project first. From a
local file the library in the directive does not matter; from a member on
the system, it must be `*LIBL`, `*CURLIB`, none, or the project's target
library. A stream file include is answered from an IFS project whose
target holds the path. Anything not found locally comes from the system.
Saving a local copy member tells every open document that includes it.

## The Project view

The **Project** view, at the top of the QS/400 container, shows each
project: its connection and target, then its files by directory with
their state.

| State | Meaning |
| --- | --- |
| Deployed | The same as at the last deploy or pull. |
| Changed | Edited since. |
| New | Never deployed or pulled. |
| Conflict | Changed on the system since; see above. |
| Ignored | Matched by `ignore` (folded away). |

Its title bar has **Deploy Changed**, **Deploy All**, **Pull into
Project** (the whole target again) and **Refresh**, which also reads the
system's timestamps so a change there shows as Conflict before you
deploy. A file's menu has **Deploy File**, **Pull from System**, **Diff
with System** (the system's copy read-only on the left) and **Open on
System**.

The status bar shows `n changed` for the active editor's project; click it
to deploy them.

## A git workflow

```sh
# Once
git init && git add -A && git commit -m "HLINV as pulled"

# Each change
#   edit QRPGLESRC/ASSETS.rpgle, then Run Action… → Compile (CRTBNDRPG):
#   it deploys the file to HLINVDEV and compiles it there.
git commit -am "ASSETS: validate the asset type"

# Someone changed ASSETS at a 5250 session: Deploy Changed says Conflict.
#   Commit yours first: Pull replaces the local file.
git commit -am "ASSETS: my change"
#   Deploy Changed again → Pull: the system's copy is in the local file
git diff                     # their version against your commit
#   merge by hand, then Deploy Changed again

# Set work aside: nothing left to deploy
git stash                    # Deploy Git-Changed: "Nothing to deploy"
```
