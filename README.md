# Code for QS/400

Code for QS/400 is a VS Code extension for developing on QS/400 (Quartz
Systems/400): sign on to a system, browse its libraries and the IFS, edit
source members with their sequence numbers and dates kept, compile with
the compiler's messages in the Problems panel, run SQL, work with jobs,
spooled files and messages, keep source in git as local projects, and
debug RPG and CL programs in VS Code's own debugger. Every remote
operation goes through `qs400-code-host`, a native program bundled with
the extension that speaks QAP, the Quartz Access Protocol QS/400 Access
uses.

The user guide is at [docs/](docs/README.md), and the same pages at
<https://quartzsystems.github.io/code-for-qs400/>.

## Features

**Connections and sign-on.** Saved connections in your user settings,
passwords in VS Code's secret storage, the system's own sign-on messages
(`CPF1107`, `QMAXSIGN`, an expired password with **Change password**),
the session job and library list, and a silent reconnect after the
system's idle timeout. [Guide](docs/connections.md)

**Objects and source members.** The **Objects** view of the library
list's libraries, their objects and source members, with filters and
object properties. Members open as editor tabs, held as `STRSEU` holds
them; a save keeps the sequence numbers and dates of every line you did
not change and numbers inserted lines between their neighbours. New,
Copy, Rename, Delete, Change Text, Compare and Renumber.
[Guide](docs/objects-and-members.md)

**The IFS.** The **IFS** view with roots per connection. Stream files open
in their own CCSID, converted by the system, and a save over someone
else's change asks first. Uploads and downloads with progress, Cancel and
Resume; New, Rename, Copy, Delete and Properties. [Guide](docs/ifs.md)

**Actions and compiles.** **Run Action…** on a member, a stream file or
an object: the default compiles (`CRTBNDRPG` to `CRTSRVPGM`, all with
`DBGVIEW(*SOURCE)`), calls and submitted jobs, overridden or added in
`.vscode/actions.json` or per connection, each command checked by the
system when the file is saved. The compiler's messages go in the
Problems panel at their line with the second-level text on hover, and
each run's command, job and messages in an output channel.
[Guide](docs/actions.md)

**Languages.** RPG (fixed form, free form, `**FREE`, embedded SQL), CL,
DDS, SQL and command definitions coloured, and checked as you type by
QS/400's own compiler front-ends: diagnostics, outline, Go to Definition
into `/COPY` members, hover, completion, rename and folding, with
fixed-form column guides. [Guide](docs/languages.md)

**SQL.** **Run Statement** (`Ctrl+Enter`) into a results panel with the
system's exact values, paging and CSV export; commit levels with Commit
and Rollback; the **SQL** view of schemas, tables, views, routines,
columns and indexes; a statement history. [Guide](docs/sql.md)

**Jobs, spooled files and messages.** The **Jobs** view with job logs,
hold, release and end; the **Spooled files** view and a viewer that keeps
the printed columns, with PDF download; the **Messages** view with
inquiry replies, sends and notifications; the compile listing a click
from the output channel. [Guide](docs/jobs-spool-messages.md)

**Local projects.** A folder of source under git mapped to a library or
an IFS directory by `qs400project.json`: pull a library, deploy only what
changed with sequence numbers and dates kept, conflicts caught before
anything is written, compiles on local files, and the **Project** view.
[Guide](docs/projects.md)

**Debugging.** RPG and CL programs called, attached to, or stopped by a
service entry point when a 5250 user calls them, with breakpoints and
conditions, stepping, the call stack, variables, watch, hover and the
Debug Console in the source the program was compiled from.
[Guide](docs/debugging.md)

**Get started** walks through the first five steps: Help → Welcome →
**Get started with Code for QS/400**.

What is not in this release is listed in
[Known limitations](docs/known-limitations.md).

## Requirements

- A QS/400 system whose QAP server is at **version 8 or 9**. Version 8
  covers everything except debugging, which needs **version 9**. An older
  server signs on, and each view that needs more says so in one line.
- VS Code **1.143.0** or later.
- Windows x64 or Linux x64. Each has its own VSIX, which carries only its
  own host binary.
- A trusted workspace: actions in a workspace run commands on the system
  as your profile, so the extension does not run in Restricted Mode.
- The extension runs where VS Code's window runs. Remote workspaces
  (Remote - SSH, WSL, containers, Codespaces) are not supported.

## Install

Code for QS/400 is installed from a VSIX file, not from an extension
gallery.

1. From the [latest release](https://github.com/quartzsystems/code-for-qs400/releases/latest),
   download the VSIX for your platform and `SHA256SUMS`.
2. Check the download:

   ```sh
   sha256sum --check --ignore-missing SHA256SUMS            # Linux
   Get-FileHash code-for-qs400-win32-x64.vsix -Algorithm SHA256   # Windows PowerShell; compare with SHA256SUMS
   ```

3. Install it, from the Extensions view's `…` menu → **Install from
   VSIX…**, or:

   ```sh
   code --install-extension code-for-qs400-win32-x64.vsix   # Windows
   code --install-extension code-for-qs400-linux-x64.vsix   # Linux
   ```

4. Open the **QS/400** view in the activity bar and add a connection.

VS Code does not update an extension installed from a VSIX. To update,
install the newer release's VSIX the same way; your connections, saved
passwords and settings are kept.

**Code for QS/400: About** shows the release, the host and the QAP
version, for example `Code for QS/400 V1R0M0 · host 1.0.0 · QAP v9`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `code-for-qs400.connections` | `[]` | Saved connections: `name`, `host`, `port`, `user`, `tls`, `libraryList`, `filters`, `ifsRoots`, `actions`, `variables`. User settings only. |
| `code-for-qs400.defaultConnection` | empty | The connection offered first. User settings only. |
| `code-for-qs400.jobs.autoRefresh` | `false` | Read the Jobs view again every 30 s while it is shown. |
| `code-for-qs400.messages.notify` | `inquiries` | Which messages arriving on your own queue notify: `inquiries`, `all` or `none`. |
| `code-for-qs400.host.path` | empty | Path to a `qs400-code-host` binary. Empty uses the bundled one. Machine scope only. |

Passwords are never in settings: they go to VS Code's secret storage.
Every command is listed in the [user guide](docs/README.md#commands).

## Privacy

Code for QS/400 has no telemetry. It collects nothing and sends nothing
anywhere but the QS/400 systems you connect to, and it has no setting for
telemetry because there is none to turn off. The extension itself never
opens a network connection: the bundled host does, to the host and port
of each connection you sign on to, and nowhere else.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to build, test and package.

## License

MIT. See [LICENSE](LICENSE).
