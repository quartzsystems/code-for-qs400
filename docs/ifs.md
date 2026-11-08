# The IFS

The **IFS** view, under Objects in the QS/400 activity bar, browses the
integrated file system of the active connection. Stream files open as
plain editor tabs, files and folders upload and download with a
progress notification, and the usual file commands work from the tree.
It needs a server at QAP version 5 or later; an older one shows
`QAP version 5 not available on this server`.

## The view

- The top-level folders are the connection's **roots**: by default your
  home directory (`/home/<user>`) and `/`. The first root is **Home**.
- **Add IFS Root** (on a folder, or from the view's `…` menu with a typed
  path), **Remove IFS Root** and **Set as IFS Home** edit the list, which
  is saved as `ifsRoots` in the connection's entry of
  `code-for-qs400.connections`.
- **Go to IFS Path…** (the view's title bar) opens any path you type. A
  folder appears as an extra root, marked **Go to**, for this window only;
  **Add IFS Root** on it keeps it. A file opens in the editor.
- A folder lists when it opens: folders first, then everything else, by
  name. A file shows its size and CCSID. **Refresh** on a node, or on the
  title bar, reads it again.
- Names starting with `.` are hidden; the eye button on the title bar
  shows or hides them.
- A symbolic link shows its target (`→ ../src`). Expanding it follows the
  link: a link to a folder lists that folder, and a link to a file opens.
- Entries can be dragged onto a folder to copy them there, and files or
  folders dragged in from your desktop are uploaded.

## Opening files

A stream file opens as `qs400ifs://<connection>/<path>`.

- **Text** is converted by the system from the file's CCSID to UTF-8 when it
  opens, and back to the file's CCSID when you save. A file tagged 1208 is
  UTF-8 already; one tagged 37 or 500 is EBCDIC. A file whose CCSID has no
  conversion (65535, binary) shows the system's `TCP1A5A`.
- **Saving a character the file's CCSID cannot hold** (an emoji in a CCSID
  37 file, say) fails with the system's `TCP1A5A` message and the file is
  left as it was.
- **Images and binary files** (`.png .jpg .jpeg .gif .bmp .ico .webp .pdf
  .zip .savf .jar .class .so .a`) are read as bytes, so VS Code's own
  image preview opens them.
- Files over **10 MiB** do not open; the message names the size and the
  limit, and offers **Download…**.
- Source files get the same languages as members: `.rpgle`, `.sqlrpgle`,
  `.clle`, `.pf`, `.dspf`, `.sql`, `.cmd` and the rest of the member table.
- **Someone else changed the file** since you opened it: saving asks
  whether to **Overwrite** it with your version, or **Reload** it from the
  system and lose your changes. Nothing is overwritten without asking.
- A document you saved without changes is not written.

## Uploads and downloads

- **Upload Files…** and **Upload Folder…** on a folder; **Download…** on a
  file; **Download Folder…** on a folder, which makes a folder of the same
  name in the place you pick.
- Each runs in a progress notification that counts the bytes and has a
  **Cancel** button. Bytes go exactly as they are, with no conversion. An
  uploaded file is tagged CCSID 1208, or 65535 for the binary types above.
- **A cancelled upload** leaves the part already sent on the system, and the
  tree marks the file `partial upload: 10.0 MB of 20.0 MB`. The
  notification offers **Resume**, which goes on from what the system has,
  and **Delete Partial File**. Uploading the file again over it starts
  from the beginning.
- A cancelled download deletes the half-written local file.
- An upload onto a file that exists asks **Replace** or **Replace All**.

## File commands

| Command | On | What it does |
| --- | --- | --- |
| New File… | a folder | asks the name, then the CCSID (1208, 37, 500, 819, or any other), creates the empty file and opens it |
| New Folder… | a folder | makes one folder |
| Rename… | an entry | renames in place; asks before replacing |
| Copy to… | an entry | copies on the system to the path you type; a folder is copied file by file |
| Delete | an entry | asks first; a folder that is not empty lists how many files and folders it holds, then deletes the deepest first. A link is deleted, not what it points to |
| Properties | any node | a read-only document: path, type, size, CCSID, owner, last change, change counter, and a link's target |
| Change CCSID… | an empty file | makes the empty file again with the new CCSID |

**Change CCSID** works only on an empty file. A file with data would keep
its bytes under the new tag, which is not the same text, so the command
explains that instead: make a new file with the CCSID you want and copy
the text into it. Because QAP has no operation that sets a CCSID, an empty
file is deleted and created again, so its owner and authorities become
those of a new file in that folder.

Paths under `/QSYS.LIB` list as the system lists them. To edit source
members, with their sequence numbers and dates, use the Objects view.
