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

## Troubleshooting

- **QS/400 host stopped** in the status bar means the host process ended.
  The next Code for QS/400 command starts it again; click the item, or run
  **Code for QS/400: Restart Host**, to restart it now.
- The **Code for QS/400 Host** output channel shows the host's log.
- To try a different host build, set `code-for-qs400.host.path` in your user
  settings to the full path of a `qs400-code-host` binary.
