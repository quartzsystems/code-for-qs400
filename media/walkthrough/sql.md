# Run SQL

**New SQL Editor** opens an SQL document on the active connection. Type
a statement and press `Ctrl+Enter`:

```sql
SELECT * FROM HLINV.ASSETS;
```

The **SQL results** panel shows each column's SQL type, the rows as the
system sent them, and `500 of more` with **Load more** while there are
more. **Export CSV** writes the whole result.

The SQL status bar item sets the commit level, the naming and the default
schema, with **Commit** and **Rollback**. The **SQL** view lists schemas,
tables, views, routines, columns and indexes. SQL members and stream
files run the same way, on their own connection.
