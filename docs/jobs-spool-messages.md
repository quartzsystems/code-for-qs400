# Jobs, spooled files and messages

Three views under SQL in the **QS/400 Work** container (its own icon in
the activity bar, below **QS/400**) show the active
connection's work on the system: **Jobs**, **Spooled files** and
**Messages**. Spooled files open in a read-only viewer that keeps the
printed columns. Jobs need a server at QAP version 8, spooled files
version 3 (their watch version 6), messages version 6; a view on an older
server says so in one line.

What you may see and do is what the system lets your profile do: another
user's jobs, spooled files and queues need the authority the commands
`WRKUSRJOB`, `WRKSPLF` and `DSPMSG` need, and a refusal shows as the
system's own message.

## Jobs

The view lists one filter's jobs: **My jobs** (`*CURRENT`, the default),
another profile's, or **All jobs** (`*ALL`). **Change Jobs Filter…** on the
view's title bar picks it; it is saved per connection. Jobs are grouped
**Active**, **On job queue** and **On output queue**, in the system's
order. Each shows its name with `nnnnnn/USER · status · type · subsystem ·
function`; the connection's own job, where actions and compiles run, is
marked `this connection`.

On a job:

| Command | What it does |
| --- | --- |
| **Job Log** | Opens the job's log: an active job's now, an ended job's from its spooled job log. |
| **Hold Job**, **Release Job** | `HLDJOB`, `RLSJOB`. |
| **End Job…** | Asks `*CNTRLD` (with a delay in seconds, empty for the job's default) or `*IMMED`, then confirms by the job's qualified name. Not offered on the connection's own job: disconnect instead. |
| **Spooled Files** | Shows the job's spooled files in the Spooled files view. |
| **Copy Qualified Name** | `nnnnnn/USER/NAME` to the clipboard. |

The list is read when the view opens and on **Refresh Jobs**. With
`code-for-qs400.jobs.autoRefresh` on, it is read again every 30 seconds
while the view is shown.

### The job log

A read-only document, `Job log nnnnnn/USER/NAME`, one line per message,
oldest first: `time  ID  text`. Each message's kind is a glyph in the
gutter (escape, diagnostic, completion, inquiry or reply, and the rest).
Hovering an ID shows the severity, the kind, the sending and receiving
programs (`from → to`) and the second-level text. **Refresh Job Log** on
the title bar reads it again. **Code for QS/400: Job Log** opens the
connection job's.

## Spooled files

- **My spooled files**: the files your profile owns (`*CURRENT`).
- **Output queues**: the queues in a library, `*LIBL` unless
  **Output Queue Library…** names another (or `*ALL`), saved per
  connection. Each queue shows `files · writer · held`, and opens to its
  files.
- **Job nnnnnn/USER/NAME**: a job's files, when you came from the Jobs
  view. Close it with its ✕.

Each file shows `FILE (number)` with `status · pages · user data · form
type · outq`. Clicking one opens it in the viewer. On a file:

| Command | What it does |
| --- | --- |
| **Save as Text…**, **Save as PDF…** | Writes the file where you pick, with progress and Cancel. PDF is made by the system. |
| **Hold Spooled File…** | At the end of the page or immediately. |
| **Release Spooled File** | Releases a held file. |
| **Move to Output Queue…** | Another queue, at its end or at its top. |
| **Delete Spooled File** | Confirms by the file's name, number and job. |

While the view is shown, your own files are watched: a new, changed or
removed file refreshes the list, and new files count on the view's badge
until **Refresh Spooled Files**.

### The viewer

A spooled file opens as a read-only text editor, its tab
`FILE(number) nnnnnn/USER/NAME`, in a monospace font with no word wrap and
rulers at columns 80 and 132. Each page starts with a line that reads
`— page n —`: the line itself is empty, so every printed line keeps its
columns, and Find searches the text as printed. The status bar shows the
page under the cursor; click it, or run **Go to Page…**, to jump.

A file of fewer than 2000 pages is read whole. A larger one opens at its
first 100 pages, and **Load All Pages** on the title bar reads the rest.
The title bar also has **Save as Text…**, **Save as PDF…** and **Refresh**,
and under `…` **Hold**, **Release**, **Move** and **Delete**; deleting
closes the viewer.

## Messages

- **My messages**: your profile's own message queue.
- **System operator**: `QSYSOPR`, shown only when your profile may read
  it.
- Any queue you add with **Add Message Queue…** (`LIBRARY/QUEUE`), saved
  per connection; **Remove Message Queue from View** takes it away.

Inquiries waiting for a reply come first, with a question mark, then every
other message newest first. Each shows its text with `ID · from user ·
time · key`; its tooltip has the type, the sending job, the reply and the
second-level text.

| Command | Where | What it does |
| --- | --- | --- |
| **Reply…** | an inquiry waiting | Asks the reply (not empty) and sends it. The system checks it against the replies the message takes. |
| **Remove Message** | a message | Removes it. |
| **Copy Text** | a message | The text and second-level text. |
| **Send Message…** | the view, a queue | To a user profile, a queue (`LIBRARY/QUEUE`) or the system operator; informational or an inquiry, whose reply comes to your own queue. |
| **Remove All Answered** | a queue | Removes the answered inquiries and their replies, after asking. |

Your own queue is watched for as long as each connection is signed on,
whether the view is shown or not. A message that arrives refreshes the
list and counts on the view's badge; the badge is the inquiries still
waiting plus what arrived since you last looked. An inquiry also shows a
notification with **Reply** and **Show**. `code-for-qs400.messages.notify`
sets which arrivals notify: `inquiries` (the default), `all` or `none`.

## From an action

After a compile the **Code for QS/400** output channel adds
`Listing: Open  QSYSPRT(8) 123456/QUSER/QAPCNN · QSHQ400` when the compile
wrote its listing (the command's `PRTFILE`, else `QSYSPRT`) during the
run; **Open** shows it in the viewer. A batch run adds the same line once
the submitted job has written that file, within 10 minutes. The job on
the `Job:` and `Submitted:` lines opens the Jobs view on it, and
`Job log: Show` opens the log of the block's job: the submitted one for a
batch run.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `code-for-qs400.jobs.autoRefresh` | `false` | Read the Jobs view again every 30 seconds while it is shown. |
| `code-for-qs400.messages.notify` | `inquiries` | Which arrivals on your own queue notify: `inquiries`, `all` or `none`. |
