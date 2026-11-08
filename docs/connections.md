# Connections and sign-on

A connection is a saved QS/400 system and user profile. Code for QS/400
signs on to it over QAP, the same way QS/400 Access does, and keeps one
session per connection while VS Code is open.

## Adding a connection

Run **Code for QS/400: Add Connection** from the Command Palette, or click
**+** at the top of the **Connections** view. Five boxes follow:

1. **Name**: any name you like, for example `QSHQ400`. It must be unique;
   it is the key for the saved password and the library list.
2. **Host**: the host name or address of the system. The server's
   certificate must carry this name.
3. **Port**: the QAP port. Leave it empty for the default port.
4. **User**: the user profile to sign on as, for example `CWELLMAN`.
5. **CA file**: a PEM file with certificates to trust beyond your
   computer's certificate store. Leave it empty unless the server uses a
   self-signed certificate or a private CA. You can also leave it empty
   and trust the certificate when you first connect (below).

If the server's certificate does not verify (for example
`UnknownIssuer`: a self-signed certificate or a private CA), connecting
shows the certificate, with its subject, issuer, validity and SHA-256
fingerprint, as QS/400 Access does. Compare the fingerprint with the one
shown on the system. **Trust for this connection** adds the certificate to
the connection's `tls.certificates` and signs on again. Verification is
never turned off: only that certificate is trusted, and only for that
connection.

**Edit Connection** goes through the same boxes. **Remove Connection** asks
first, then deletes the connection and its saved password.

Connections are kept in your user settings as `code-for-qs400.connections`,
and you can edit them there as well:

```json
"code-for-qs400.connections": [
  {
    "name": "QSHQ400",
    "host": "qshq400.example.com",
    "user": "CWELLMAN",
    "tls": { "caFile": "C:\\certs\\qshq400.pem" },
    "libraryList": { "current": "CWELLMAN", "user": ["DEVLIB", "QGPL"] }
  }
]
```

| Field | Meaning |
| --- | --- |
| `name` | Unique name, the key everywhere. |
| `host` | Host name or address. |
| `port` | QAP port. Leave it out for the default. |
| `user` | User profile. |
| `tls.caFile` | PEM file of certificates to trust: a CA, or the server's own certificate. |
| `tls.certificates` | PEM certificates trusted for this connection alone; **Trust for this connection** adds to it. Remove an entry to stop trusting it. |
| `tls.verify` | Must be `true` or left out. The server's certificate is always checked, as in QS/400 Access; to trust a self-signed one, name it in `caFile`. |
| `libraryList` | The library list to apply when a session starts. The Library list node edits it. |

This setting is read from your user settings only, never from a
workspace's `.vscode/settings.json`, so a project you open cannot add a
connection that asks for your password.

**Set as Default Connection** marks the connection offered first whenever
a command asks which connection to use.

## Signing on

Click a connection in the Connections view, or run **Connect**. Unless a
password is saved, you are asked for it, then whether to save it:

- **Save password** keeps it in VS Code's secret storage (below).
- **Ask every time** keeps it only while the session lasts.

When the system refuses the sign-on, the notification shows the system's
own message, exactly as it was sent, for example:

```
CPF1107: Password or user profile is not correct.
```

**Details** shows the message's second-level text, when there is one.

- After too many wrong passwords the system disables the profile, as its
  `QMAXSIGN` setting says, and the notification shows that message too.
- If a **saved** password is refused, it is deleted from secret storage at
  once, so it is not tried again and does not count against `QMAXSIGN`.
  The next Connect asks for the password.
- If the password has expired, the notification has a **Change password**
  button. It asks for the new password twice, changes it and signs on.

## Where the password is kept

- A saved password goes to VS Code's secret storage under the key
  `code-for-qs400.password.<name>`. VS Code keeps it in your operating
  system's credential store (Windows Credential Manager, or the Secret
  Service keyring on Linux). It is never written to settings or to any
  file.
- While a session is open, the bundled host process keeps the password in
  memory, so it can sign on again by itself after the system ends an idle
  session. It never writes it anywhere, and forgets it on Disconnect.
- **Forget Saved Password** deletes a saved password. **Remove Connection**
  deletes it as well.

## The Connections view

Each connection shows its name, `user@host`, and an icon for its state:

| Icon | State |
| --- | --- |
| Outline | Not connected. Click to connect. |
| Spinner | Connecting. |
| Green | Connected. |
| Disconnect icon, yellow | The system closed the connection (its idle timeout). It reconnects by itself on the next request. |

A connected connection has two nodes under it:

- **Library list**: the current library first, marked `*CURLIB`, then the
  user part in order. See [Library list](#library-list).
- **System**: the system's name, product and version, its serial number
  when the system reports one, the **session job**
  (`number/USER/NAME`), and the QAP version agreed with the server.

Right-click a connection for Connect, Disconnect, Edit, Set as Default,
Forget Saved Password and Remove.

## The status bar

The left side of the status bar shows the **active connection**:

| Shows | Means |
| --- | --- |
| `$(plug) QSHQ400 · CWELLMAN` | Connected to `QSHQ400` as `CWELLMAN`. |
| `$(debug-disconnect) QSHQ400` | The system closed the connection; the next request reconnects. |
| nothing | No connection is signed on. |

Hover over it to see the host, the session job (for example
`123456/CWELLMAN/<job name>`) and the system's version. Click it to switch the
active connection: pick a connected one to make it active, or one that is
not connected to connect it.

The active connection is the one Connect last signed on, or the one you
picked in the status bar. It is kept per workspace. The Objects, IFS, SQL,
Jobs, Spooled files and Messages views show it, and a command that needs
a connection and has none of its own (a new SQL editor, a local file
outside any project) uses it.

## Idle timeout and reconnect

The system ends a quiet connection after its own idle timeout. The
connection then shows as closed, and the next request reconnects without
asking:

- If the system still has the session, it is resumed: same session job.
- If the session has ended, Code for QS/400 signs on again with the
  password it kept in memory: a new session job, with your library list
  applied again.
- If the system refuses that password (it was changed elsewhere, say), you
  are asked for the password once.

Running **Connect** on a closed connection reconnects in the same way.

## Library list

The Library list node shows the session job's library list as the system
reports it. Right-click it, or a library in it, to:

- **Add Library to Library List**: adds a library at the end of the user
  part.
- **Move Up** and **Move Down**.
- **Set as Current Library**.
- **Remove from Library List**.

Each change is applied to the session job at once, then saved in the
connection's `libraryList`, so the next session starts with the same list.

The library list uses QAP version 8's `Develop` service (`GetLibraryList`
and `SetLibraryList`, which stand for `DSPLIBL` and `CHGLIBL`). A system
whose QAP server is older shows **QAP version 8 not available on this
server** on the node, and nothing can be changed there.

## Commands

| Command | Id |
| --- | --- |
| Add Connection | `code-for-qs400.connection.add` |
| Edit Connection | `code-for-qs400.connection.edit` |
| Remove Connection | `code-for-qs400.connection.remove` |
| Connect | `code-for-qs400.connection.connect` |
| Disconnect | `code-for-qs400.connection.disconnect` |
| Set as Default Connection | `code-for-qs400.connection.setDefault` |
| Forget Saved Password | `code-for-qs400.connection.forgetPassword` |
| Switch Active Connection | `code-for-qs400.connection.switchActive` |
| Add Library to Library List | `code-for-qs400.libl.add` |
| Remove from Library List | `code-for-qs400.libl.remove` |
| Move Up | `code-for-qs400.libl.moveUp` |
| Move Down | `code-for-qs400.libl.moveDown` |
| Set as Current Library | `code-for-qs400.libl.setCurrent` |

All are in the **Code for QS/400** category of the Command Palette, except
the library commands that act on a library in the tree.
