# Changelog

## 1.0.0-pre · Phase 2 · object browser and members

- **Objects** view: the active connection's library list libraries (the
  current library first), their object types, objects with attribute and
  text, and the members of source files. Refresh on every node.
- **Properties** on an object: a read-only `LIBRARY/OBJECT (*TYPE)`
  document of the system's `name: value` lines, in Courier.
- Filters per connection (`code-for-qs400.connections[].filters`) with
  **Add**, **Edit** and **Remove Filter**; a filter opens straight to its
  objects.
- Members open as editor tabs on `qs400mbr://`, with the extension and
  language from the source type. Languages `qs400-rpgle`, `qs400-cl`,
  `qs400-dds`, `qs400-sql` and `qs400-cmd` are registered, without
  grammars yet.
- An open member is held as `STRSEU` holds it and let go when its last tab
  closes. A member another job holds shows the system's `CPF1002` and
  opens read-only; **Open Read-Only** opens without holding it. Locks are
  taken again after a reconnect, and any lost are reported.
- Saving keeps the sequence numbers and dates of unchanged lines, numbers
  inserted lines between their neighbours, and renumbers (with a
  notification) only when no gap is left or on **Renumber Member**. An
  unchanged member is not written. Dates are the system's.
- Member commands: **New Member**, **Copy**, **Rename**, **Delete** (asks
  by name), **Change Text** and **Compare with…** another member or a
  local file.
- Library list editing now works: `libl.get` and `libl.set` use QAP
  version 8's `GetLibraryList` and `SetLibraryList`.
- Host: `object.libraries`, `object.list`, `object.properties`,
  `member.list`, `member.read`, `member.write`, `member.unlock`,
  `member.create`, `member.copy`, `member.rename`, `member.delete` and
  `member.changeText`, over `qap-client`'s `Develop` service. Every
  connection asks for QAP version 9; a server below 8 gets
  `-32001 QAP version 8 not available on this server`. About now shows
  `QAP v9`.

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
