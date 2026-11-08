# SQL

Code for QS/400 runs SQL in a connection job of its own on the system,
shows each result in the **SQL results** panel, exports results to CSV,
lists the database in the **SQL** view, and keeps a history of what you
ran. It needs a server at QAP version 4 or later; the SQL view's
procedures, functions and indexes need version 8.

## Running statements

**Run Statement** (`code-for-qs400.sql.run`, `Ctrl+Enter`, `Cmd+Enter` on
macOS) is on the editor title bar (the ▶ button) of every SQL document: a
member or stream file in the `qs400-sql` language, an untitled SQL editor,
or a local file in either `qs400-sql` or VS Code's own SQL language. The
key works in `qs400-sql` documents.

What it runs:

1. The selection, when there is one, each of its statements in turn.
2. Else the statement under the cursor: from its first character to the
   `;` that ends it, or anywhere on its last line after it.
3. Else, with the cursor between statements, the whole document,
   statement by statement.

Statements are split on `;` outside strings and comments. In a
`qs400-sql` document the split is the SQL language server's, so what runs
is what the editor's own checks see; in VS Code's SQL language the
extension splits by the same rule. A run of several statements stops at
the first that fails.

Each statement runs once, as typed, with no `;`. The server's message for
a statement that fails (its ID, text and second-level text, and SQLSTATE
and SQLCODE when the system gives them) shows in its result tab and in
the Problems panel, on the statement's first line. Running the document
again clears them.

**Cancel Running SQL** (`code-for-qs400.sql.cancel`) asks the system to end
the statements running. A statement cancelled while it ran shows what it
had done: an `UPDATE`'s count so far, a query's rows so far.

**New SQL Editor** (`code-for-qs400.sql.newEditor`, also on the SQL view's
title bar) opens an untitled `qs400-sql` document.

### Which connection

A member or stream file runs on its own connection. Any other SQL
document runs on the active connection, unless you pick another for it:
click the SQL status bar item and choose **Connection**, or run **Change
SQL Connection…**. The choice holds until the document closes.

## The status bar and options

While an SQL document is active, the status bar shows where it runs and
how:

```
$(database) QSHQ400 · *SQL · *CHG ●
```

- **Naming**: `*SQL` (`schema.table`) or `*SYS` (`library/file`).
- **Commit level**: `*NONE`, `*CHG`, `*CS`, `*ALL` or `*RR`.
- `●`: a statement other than a query ran under a commit level, and its
  changes are not committed yet.

Click it for a quick pick to change the connection, the commit level, the
naming and the default schema (the schema unqualified names are found
in), and, under a commit level, **Commit** and **Rollback**
(`code-for-qs400.sql.commit`, `code-for-qs400.sql.rollback`). The system
refuses a new commit level or naming while changes are uncommitted
(`SQL0752`): commit or roll back first.

The options belong to the connection's SQL job, and are set again on a
new one. They last until you disconnect; connecting again starts with
`*NONE`, `*SQL` and no default schema.

Disconnecting with uncommitted changes asks first: **Commit and
Disconnect**, or **Roll Back and Disconnect**.

If the system ends the SQL job (the connection dropped, the session
ended), its uncommitted changes and open cursors are gone. A warning says
so, and the result tabs from it load no more rows. The next statement
starts a new job; nothing is run again by itself.

## Results

**SQL results** is one panel per window, beside the editor, with a tab
per run. The last 20 tabs are kept; closing a tab, or the panel, closes
its cursor on the system.

- A query shows a grid: each column's name, SQL type with its length and
  scale (`DECIMAL(11,2)`), and `?` when it may be null. Numbers are right
  aligned and shown exactly as the system sent them; `NULL` is a muted
  `-`; binary data is hex, with a button to copy it; dates, times and
  timestamps are ISO 8601 (`2026-11-08`, `12:34:56`,
  `2026-11-08T12:34:56.123456`, with the column's precision).
- The footer shows the row count: `12 rows`, or `500 of more` with
  **Load more** while the system has more (500 at a time). Then **Export
  CSV**, the time it took, the connection, and the statement (click to
  open it).
- An `INSERT`, `UPDATE`, `DELETE` or `MERGE` shows `n rows updated`; other
  statements show `Statement ran`. Neither has a grid.
- The system's messages for the run are listed above the footer; hover
  one for its second-level text.

### Export CSV

**Export CSV** asks for a file, then writes the rows the tab shows
followed by the rest of the result, fetched from the system a page at a
time straight to the file. A notification shows the rows written, with
**Cancel**; a cancelled or failed export leaves no file.

The file is RFC 4180: UTF-8 with no byte order mark, a header of the
column names, CRLF line ends, fields quoted when they hold a quote, a
comma or a line break. `NULL` is an empty field and an empty string is
`""`. Decimals are the system's exact text; dates, times and timestamps
are ISO 8601 as in the grid; binary is hex; Booleans are `TRUE` and
`FALSE`.

The rows past those shown are not kept in VS Code, so after an export
that read further, the tab says how many were exported and loads no more.
Run the statement again to see them.

## The SQL view

The **SQL** view, under **IFS**, lists the active connection's schemas.
**Filter Schemas…** (`code-for-qs400.sql.filterSchemas`) sets an SQL
`LIKE` pattern for the connection (`HL%`; empty is all), kept with the
workspace.

Each schema has **Tables**, **Views**, **Aliases**, **Physical files**,
**Logical files**, **Procedures** and **Functions**. A table, view, alias
or file has **Columns** and **Indexes**. Descriptions show each object's
text; a column shows its type, and its tooltip the type, length, scale,
whether it may be null, and its CCSID; an index shows whether it is unique
and its key columns.

On a table, view, alias or file:

- **View Data** runs `SELECT * … FETCH FIRST 500 ROWS ONLY` into the
  results panel.
- **Generate SELECT** opens a new SQL editor with every column selected.
- **Generate INSERT** opens one with every column and a `?` for each
  value.
- **Copy Name** copies the qualified name, in the connection's naming.

On a procedure or function, **Copy CALL** copies `CALL schema.name(?, …)`
(`VALUES` for a function) with one `?` per parameter, its name in a
comment, as `QSYS2.SYSPARMS` lists them. On a column, **Copy Name**.

## History

**SQL History** (`code-for-qs400.sql.history`, on the SQL view's title bar
and the SQL editor's) lists the last 50 statements run on the connection
in this workspace, newest first, with when they ran and their row count,
updated count or message ID. Pick one to **Run Again**, **Open in
Editor** or **Save to File…**. The history keeps statements, never their
results.

## Commands

| Command | Id |
| --- | --- |
| Run Statement | `code-for-qs400.sql.run` |
| Cancel Running SQL | `code-for-qs400.sql.cancel` |
| New SQL Editor | `code-for-qs400.sql.newEditor` |
| SQL Options… | `code-for-qs400.sql.options` |
| Commit, Rollback | `code-for-qs400.sql.commit`, `.rollback` |
| Change SQL Connection… | `code-for-qs400.sql.changeConnection` |
| SQL History | `code-for-qs400.sql.history` |
| Refresh SQL, Filter Schemas… | `code-for-qs400.sql.refresh`, `.filterSchemas` |
| View Data, Generate SELECT, Generate INSERT | `code-for-qs400.sql.viewData`, `.generateSelect`, `.generateInsert` |
| Copy Name, Copy CALL | `code-for-qs400.sql.copyName`, `.copyCall` |
