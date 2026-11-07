# Changelog

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
