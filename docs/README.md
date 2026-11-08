# Code for QS/400 user guide

This guide grows with each phase and ships with the marketplace listing.

## Getting started

1. Install the VSIX for your platform (Windows x64 or Linux x64).
2. Open the **QS/400** view in the activity bar and add a connection: see
   [Connections and sign-on](connections.md).
3. Run **Code for QS/400: About** from the Command Palette to check that the
   bundled host is working. It shows the QS/400 release, the host version
   and the QAP version, all reported by the host.

## Guides

- [Connections and sign-on](connections.md): adding a connection, where the
  password is kept, the Connections view, the status bar, reconnecting and
  the library list.
- [Objects and source members](objects-and-members.md): the Objects view,
  filters, opening and saving members, sequence numbers and dates, and the
  member commands.
- [The IFS](ifs.md): the IFS view and its roots, opening stream files and
  their CCSIDs, uploads and downloads with resume, and the file commands.
- [Actions and diagnostics](actions.md): running compiles and other
  commands on members, stream files and objects, `.vscode/actions.json`
  and its variables, the Problems panel, the output channel and the job
  log.
- [Language support](languages.md): colouring, the fixed-form guides, the
  language servers' diagnostics, outline, Go to Definition, hover,
  completion, rename and folding, how includes are read, and how the
  editor's diagnostics are held to the compiler's.
- [SQL](sql.md): running statements, the results panel, CSV export, the
  SQL view, commit levels and the history.

## Troubleshooting

- **QS/400 host stopped** in the status bar means the host process ended.
  The next Code for QS/400 command starts it again; click the item, or run
  **Code for QS/400: Restart Host**, to restart it now.
- The **Code for QS/400 Host** output channel shows the host's log; the
  **Code for QS/400** channel shows each action's command and messages;
  the **Code for QS/400 Languages** channel shows the language servers'
  log.
- To try a different host build, set `code-for-qs400.host.path` in your user
  settings to the full path of a `qs400-code-host` binary.
