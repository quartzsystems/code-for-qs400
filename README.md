# Code for QS/400

A VS Code extension for developing on QS/400 (Quartz Systems/400). Every
remote operation goes through `qs400-code-host`, a Rust sidecar bundled
with the extension that speaks QAP, the Quartz Access Protocol shared with
QS/400 Access.

**Status: 1.0.0 pre-release, Phase 0.** The extension activates, shows an
empty Connections view and an About command, and starts and supervises the
host. Connections and sign-on arrive in Phase 1.

## Requirements

- VS Code **1.143.0** or later (`engines.vscode` is `^1.143.0`: the
  current stable release, 1.145, minus two minor versions).
- Windows x64 or Linux x64. Each platform has its own VSIX carrying only
  its own host binary.

## Install

Download the VSIX for your platform from the CI artifacts and install it:

```sh
code --install-extension code-for-qs400-win32-x64.vsix   # Windows
code --install-extension code-for-qs400-linux-x64.vsix   # Linux
```

## Commands

| Command | Id |
| --- | --- |
| Code for QS/400: About | `code-for-qs400.about` |
| Code for QS/400: Restart Host | `code-for-qs400.host.restart` |

**About** asks the host for its version and shows, for example,
`Code for QS/400 V1R0M0 · host 1.0.0 · QAP v1`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `code-for-qs400.host.path` | empty | Path to a `qs400-code-host` binary. Empty uses the bundled one. Machine scope only. |

## Host

The extension starts one `qs400-code-host` per window, on the first command
that needs it, and talks JSON-RPC 2.0 over stdio with `Content-Length`
framing. Host logs appear in the **Code for QS/400 Host** output channel. If
the host stops, the status bar shows **QS/400 host stopped**; the next
command starts it again, or click the item to restart it now.

```sh
qs400-code-host --version
# qs400-code-host 1.0.0 (QS/400 V1R0M0, QAP v1)
```

## Repository layout

```
package.json, src/      the extension (TypeScript, bundled by esbuild to dist/)
  src/extension.ts        activate/deactivate, status bar, command wiring
  src/host/client.ts      spawns the host; JSON-RPC client and framing
  src/host/protocol.ts    types for every host method
  src/views/connections.ts  the Connections tree (empty for now)
  src/commands/about.ts   the About command
syntaxes/, languages/   grammars and language configuration (Phase 5)
schemas/actions.json    schema for .vscode/actions.json (Phase 4)
media/                  activity bar icon (placeholder)
bin/                    host binary, copied in at package time (gitignored)
host/                   Cargo workspace for the sidecar
  crates/host-rpc         JSON-RPC 2.0 framing and method registry (no QS/400 knowledge)
  crates/code-host        the qs400-code-host binary
test/                   extension integration tests (@vscode/test-electron)
scripts/                check-naming.sh, package.sh, package.ps1
docs/                   user documentation
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to build, test and package.

## License

MIT. See [LICENSE](LICENSE).
