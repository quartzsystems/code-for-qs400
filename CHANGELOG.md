# Changelog

## 1.0.0-pre · Phase 1 · connections and sign-on

- Saved connections in `code-for-qs400.connections` (user settings only),
  a default connection (`code-for-qs400.defaultConnection`), and passwords
  in VS Code secret storage under `code-for-qs400.password.<name>`, saved
  or asked every time.
- Commands: Add, Edit and Remove Connection, Connect, Disconnect, Set as
  Default Connection, Forget Saved Password, Switch Active Connection.
- Sign-on through `qap-client` exactly as QS/400 Access does it. The
  system's refusals are shown as `messageId: text`, unchanged, with the
  second-level text under Details. An expired password offers Change
  password. A saved password the system refuses is deleted, so it never
  counts against `QMAXSIGN` twice.
- The Connections view shows each connection's state, and under a
  connected one a **Library list** node and a **System** node (product,
  version, serial, session job, QAP version).
- Status bar item for the active connection: `QSHQ400 · CWELLMAN` when
  connected, a disconnect icon after the system's idle close; the tooltip
  has the host, the session job and the version. Click to switch.
- Silent reconnect after the system's idle timeout: the session is resumed,
  or signed on again with the password kept in memory; one password prompt
  when the system refuses it.
- Library list editing (add, remove, move up, move down, set current),
  applied to the session job and saved per connection. Waiting on QAP's
  `library_list` service: until a server has it, the node shows
  `library_list not available on this server`.
- Host: `session.connect`, `session.changePassword`, `session.disconnect`,
  `session.status`, `session.list`, `libl.get`, `libl.set` and the
  `session.changed` notification. The host now reports QAP v6, the newest
  version `qap-client` offers.

## 1.0.0-pre · Phase 0 · scaffold and host

- Extension skeleton: QS/400 activity bar container with an empty
  Connections view, **About** and **Restart Host** commands, and the
  `code-for-qs400.host.path` setting.
- `qs400-code-host` Rust sidecar speaking JSON-RPC 2.0 over stdio with
  `Content-Length` framing: `host.version`, `host.ping`, `host.shutdown`
  and the `host.log` notification. The `lsp` and `dap` subcommands are
  registered but not implemented yet.
- Host supervision: a status bar warning when the host stops, and a restart
  on the next command.
- Platform-specific pre-release VSIX files for `win32-x64` and `linux-x64`.
- CI on Windows and Linux: naming check, Rust and extension tests, and VSIX
  artifacts.
