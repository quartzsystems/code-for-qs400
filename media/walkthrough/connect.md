# Add a connection

**Add Connection** asks five things:

1. **Name**: your name for the system, for example `QSHQ400`.
2. **Host**: its host name or address, as its certificate names it.
3. **Port**: the QAP port; empty for the default.
4. **User**: the user profile, for example `CWELLMAN`.
5. **CA file**: a PEM file to trust, when the system's certificate is
   self-signed or from a private CA; empty otherwise.

Then click the connection in the **Connections** view to sign on. You are
asked for the password, and whether to save it in VS Code's secret
storage or ask every time.

When the system refuses the sign-on, the notification shows its own
message, for example `CPF1107: Password or user profile is not correct.`

The status bar then shows `QSHQ400 · CWELLMAN`; hover it for the session
job.
