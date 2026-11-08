# Objects and source members

The **Objects** view, under **Connections** in the QS/400 activity bar,
shows the libraries and objects of the active connection. Source members
open as regular editor tabs, and saving one writes it back to the system
with its sequence numbers and dates kept the way SEU keeps them.

This needs a QS/400 system whose QAP server has version 8 (the `Develop`
service). On an older one the view shows **QAP version 8 not available on
this server** and the QAP version it has.

## The Objects view

The view follows the active connection, the one in the status bar. Connect
first; **Switch Active Connection** changes which one is shown.

- At the top are the libraries of the session's library list: the current
  library first, marked `*CURLIB`, then the user part in order. Change the
  list with the **Library list** node in the Connections view.
- A library opens to its object types: `*FILE`, `*PGM`, `*SRVPGM`,
  `*MODULE`, `*CMD`, `*DTAARA`, `*MSGF`, `*BNDDIR`, and **All**.
- A type opens to its objects, with the attribute and text beside each.
- A source physical file (`*FILE`, attribute `PF-SRC`) opens to its
  members, with the source type beside each and the member text as the
  tooltip. Click a member to open it.
- **Filters** comes last; see below.

Every node has **Refresh**. Lists are read from the system each time a node
opens or is refreshed. Refresh on the view's title bar reads the library
list again too.

**Properties** on an object opens a read-only document named
`LIBRARY/OBJECT (*TYPE)` that lists what the system shows for the object
(`DSPOBJD DETAIL(*FULL)`), one `name: value` line each, in the system's
order and under its labels. The tab shows `OBJECT (*TYPE)`, with the
library beside it as VS Code shows a folder.

## Filters

A filter lists the objects of a library that match a name, a type and an
attribute. Filters belong to a connection and are saved with it.

**Add Filter** (on the Filters node, or the **+** in the view's title bar)
asks for:

1. a name for the filter;
2. the library: a library name, or `*LIBL`, `*CURLIB`, `*USRLIBL` or `*ALL`;
3. the object: a name, a name ending in `*` (`ASSET*`), or `*ALL`;
4. the type: `*ALL` or an object type such as `*FILE`;
5. the attribute, such as `PF-SRC` or `RPGLE`, or nothing for any.

A filter opens straight to its objects. **Edit Filter** and **Remove
Filter** are on each filter's menu. In the settings a filter looks like
this:

```json
"filters": [
  { "name": "RPG sources", "library": "HLINV", "object": "Q*", "type": "*FILE", "attribute": "PF-SRC" }
]
```

## Opening a member

A member opens as `qs400mbr://CONNECTION/LIBRARY/FILE/MEMBER.ext`. The
extension and the editor language come from the member's source type:

| Source type | Extension | Language |
| --- | --- | --- |
| `RPGLE`, `SQLRPGLE`, `RPG` | `.rpgle`, `.sqlrpgle`, `.rpg` | RPG (QS/400) |
| `CLLE`, `CLP`, `CL` | `.clle`, `.clp`, `.cl` | CL (QS/400) |
| `PF`, `LF`, `DSPF`, `PRTF`, `ICFF` | `.pf`, `.lf`, `.dspf`, `.prtf`, `.icff` | DDS (QS/400) |
| `CMD` | `.cmd` | Command definition (QS/400) |
| `SQL` | `.sql` | SQL (QS/400) |
| `C`, `CPP` | `.c`, `.cpp` | C, C++ |
| `TXT`, `BND`, `PNLGRP`, `MENU` | `.txt`, `.bnd`, `.pnlgrp`, `.menu` | Plain text |
| anything else | the type in lower case | Plain text |

Syntax colouring for the QS/400 languages arrives in a later release.

While a member is open, this connection holds it the way `STRSEU` does
(`*SHRNUP`): other jobs can read it but not change it. Closing its last tab
lets it go.

If another job holds the member, for example an SEU session, the system's
message (`CPF1002`) is shown and the member opens **read-only**. **Open
Read-Only** on a member's menu opens it that way on purpose, without
holding it.

If the connection drops while members are open, the extension takes them
again when it reconnects. It tells you about any it could not get back
(they turn read-only) and any that another job changed in the meantime.

## Saving

Saving sends the whole member back, but only the lines you changed change
on the system:

- Lines you did not touch keep their sequence numbers and dates.
- A line you changed keeps its sequence number, and the system gives it
  today's date.
- A line you inserted gets a sequence number between the lines around it
  (two lines inserted between `0003.00` and `0004.00` become `0003.33` and
  `0003.66`), and today's date. A line added at the end gets the next whole
  number.
- When there is no number left between two lines (`0001.00` and `0001.01`),
  or past `9999.99`, the member is renumbered from `0001.00` in steps of
  `0001.00`, and a notification says so. The other lines keep their dates.
- Saving a member you did not change sends nothing.

Trailing blanks are not kept, as on the system. **Renumber Member** (Command
Palette or the editor's context menu) renumbers the open member from
`0001.00` on purpose.

Text goes to and from the system as UTF-8, converted by the system to and
from the file's CCSID. A character the file cannot hold stops the save with
the system's message, and nothing is written.

## Member commands

On a source file:

- **New Member**: name, source type and text, then the new member opens.

On a member:

- **Open** and **Open Read-Only**.
- **Copy Member**: to another name in the same file, or to
  `LIBRARY/FILE(MEMBER)`. Sequence numbers and dates are copied too
  (`CPYSRCF`). If the target exists you are asked before it is replaced.
- **Rename Member**.
- **Change Member Text**.
- **Compare with…**: another member of the same file, a member elsewhere
  (`LIBRARY/FILE(MEMBER)`), or a local file, in VS Code's diff editor.
  Both sides open read-only, so comparing holds nothing.
- **Delete Member**: asks first, naming the member. It cannot be undone.

The system's messages are shown as they come, as `CPF…: text`, with the
second-level text under **Details**.

## Not in this release

- Opening an object in a 5250 session.
- Creating libraries or source files: use a 5250 session or, later, Actions.
