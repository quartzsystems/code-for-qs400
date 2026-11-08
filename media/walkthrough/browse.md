# Browse a library and open a member

The **Objects** view shows the libraries of the session's library list,
the current library first:

```
HLINV                     *CURLIB
  *FILE
    QRPGLESRC             PF-SRC  RPG source
      ASSETS              RPGLE   Asset maintenance
```

Click a member to open it. It opens as `qs400mbr://QSHQ400/HLINV/QRPGLESRC/ASSETS.rpgle`,
coloured and checked as you type, and this connection holds it as `STRSEU`
does until its last tab closes.

Saving writes only the lines you changed: every other line keeps its
sequence number and date.

Change the library list from the **Library list** node in the
**Connections** view.
