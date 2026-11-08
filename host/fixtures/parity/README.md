# Parity fixtures

Each `<FILE>/<MEMBER>.<ext>.json` is one real compile of an `HLINV` member,
recorded by the live parity test (`test/parity.test.ts`) with
`QS400_PARITY_RECORD=1`:

```json
{
  "member": { "library": "HLINV", "file": "QRPGLESRC", "member": "ASSETS", "type": "RPGLE" },
  "command": "CRTBNDRPG PGM(CWELLMAN/ASSETS) SRCFILE(HLINV/QRPGLESRC) SRCMBR(ASSETS) ...",
  "includes": [
    { "request": { "library": "*LIBL", "file": "QRPGLESRC", "member": "ASSETSCP" },
      "at": { "kind": "member", "library": "HLINV", "file": "QRPGLESRC", "member": "ASSETSCP" },
      "source": "QRPGLESRC/ASSETSCP.rpgle" }
  ],
  "diagnostics": [ { "at": { "kind": "member", ... }, "line": 42, "id": "RNF7030", ... } ]
}
```

`diagnostics` is the compile's, exactly as `action.run` returned it.
`includes` lists what the language server fetched for the member, so the
offline test can answer the same `/COPY` and `/INCLUDE` requests.

The members' text is **not** committed: HLINV's source is not ours to
ship, so `.gitignore` keeps everything here but the records and this
file. The live test writes the text beside each record (`<FILE>/<MEMBER>.<ext>`);
elsewhere, set `QS400_PARITY_SRC` to a folder with the same layout
(QS/400's `tools/conformance/hlinv/src` has it). A record whose source is
absent is skipped and counted, never failed.

`cargo test -p code-host --test parity` runs each record's member through
its language server's `analyze` and compares (source, line, message ID)
with the recorded compile. A difference fails with a table of what only
the compiler and only the editor reported: each row is a
`quartz-systems-400` issue (see `docs/languages.md`).
