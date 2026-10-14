# prifly-ext-gmail

A prifly extension that gives every Claude session tools to search, read,
draft, send, label, archive and trash Gmail, through your Google account.
Reading runs at once. Every change to the mailbox first shows you a confirm
card with exactly what will happen (the recipients, subject, text and files of
a mail, or the threads and the change), and only happens when you confirm.
Cancel, and the tool answers "Not done: you cancelled" and nothing is written.

There is no UI besides that: no launcher, no chips. Settings → Extensions
shows one status line, read at start and every 15 minutes: "Connected as
ada@example.com · 3 unread · 12 labels" (unread inbox threads, your own
labels), or what is wrong with the sign-in.

## What it needs

A prifly with `api.confirm` and `api.status` (extension API v0.6.0; on an
older prifly every write answers that it cannot ask, and nothing is written), and a Google connection in
prifly's Vault → Connections with these scopes:

- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/gmail.send`

A connection made for an older version holds only `gmail.readonly` and
`gmail.compose`: reading and drafting still work, the status line says
"read-only", and `gmail_sign_in` (ask any session to sign in to Gmail) asks
you to approve the new scopes once.

Your own Google client works. Its Google project must be In production,
otherwise Google ends the grant every 7 days and you sign in again.

prifly holds the token and adds it to each request, so the extension never
keeps one.

## The tools

Each takes an optional `account` (the Google account's email, when several are
connected). Without it the extension uses the `account` setting, else the first
connected Google account.

Reads, at once:

| Tool | What it does |
|---|---|
| `gmail_search` `{ query, max }` | Gmail search; one line per thread: `thread_id \| N msg \| date \| from \| subject` |
| `gmail_thread` `{ thread_id }` | The whole thread as Markdown, oldest first; saves `thread.md` and every attachment (up to 25 MB each) in the session's scratchpad (else in the extension's own `threads/<id>/` folder, which is git-ignored; with neither, nothing is saved) and lists the paths |
| `gmail_labels` | Every label: `id \| name \| system or user` |
| `gmail_api_docs` `{ method }` | Gmail's own API reference, from its discovery document: every method, or one method's parameters and request and response fields |

Changes, each after a confirm card:

| Tool | What it does |
|---|---|
| `gmail_draft_reply` `{ thread_id, body, all, replace_draft_id }` | A threaded reply draft (`Re:`, In-Reply-To, References); `all` (default true) keeps everyone else on Cc; `replace_draft_id` rewrites a draft instead of adding one |
| `gmail_new_draft` `{ to, cc, subject, body }` | A new draft |
| `gmail_send` `{ to, cc, bcc, subject, body, attachments }` | Sends a new mail; `attachments` are absolute paths of local files (25 MB in all) |
| `gmail_reply` `{ thread_id, body, all, attachments }` | Sends a reply in the thread, to its last message, as `gmail_draft_reply` addresses it |
| `gmail_forward` `{ thread_id, message_id, to, cc, bcc, note, include_attachments, attachments }` | Forwards a message (the thread's last, or `message_id`) with a note, its own attachments and any local files |
| `gmail_label_create` `{ name }` | Creates a label |
| `gmail_label_threads` `{ thread_ids, add, remove }` | Adds and removes labels, by name or id, on whole threads |
| `gmail_archive` `{ thread_ids }` | Takes threads out of the inbox |
| `gmail_mark` `{ thread_ids, read }` | Marks threads read (default) or unread |
| `gmail_trash` `{ thread_ids }` | Moves threads to the trash |
| `gmail_api` `{ method, path, query, body }` | Any Gmail REST call below `gmail/v1/users/me`; a GET runs at once, any other method shows the exact request first (a `raw` mail decoded) |

`gmail_sign_in` `{ account }` opens your browser to sign in: again for the
account in use, or a new one with `account: "new"`.

When the grant has ended, a tool answers "The Gmail grant for … ended: sign in
again in prifly's Vault → Connections." With no Google account connected it
says to connect one. The rules every session gets about these tools are in
`prompt.md`.

## Settings

- `account`: the email of the account to use; empty means the first one.

## Checks

`bun test`, `bun run typecheck` and `bun run check` (biome: 500 lines per
file, 120 per function, cognitive complexity 15, no `any`, no `!`).

| File | What it is |
|---|---|
| `prifly-extension.json` | The manifest: the Google connection, its setting and `prompt.md` |
| `index.ts` | `activate(api)` registers the tools and starts the status line |
| `tools.ts` | Every tool, and the reads: search, thread, labels |
| `compose-tools.ts` | Drafts, send, reply, forward |
| `change-tools.ts` | Labels, archive, mark read or unread, trash |
| `api-tools.ts`, `discovery.ts` | `gmail_api`, and `gmail_api_docs` over Gmail's discovery document |
| `tool-kit.ts` | Arguments, the connection, and the confirm card every write waits for |
| `status.ts` | The status line |
| `sign-in.ts` | The scopes, and `gmail_sign_in` |
| `connection.ts` | Picks the connection; the texts for no connection, an ended grant and an HTTP error |
| `gmail.ts`, `gmail-types.ts` | The REST client over `api.connections.fetch`, and tolerant parsers of its answers |
| `mime.ts` | Reads a message into text and attachments; builds the RFC 822 reply, new mail and forward, with files |
| `save.ts` | A thread as Markdown, and on disk with its attachments |
| `prompt.md` | The rules added to every session |
| `test/` | `fake-api.ts` (the template's fake `api`, with `confirm` and `status`), `fake-gmail.ts` (an in-memory mailbox) and the tests |

## License and contributing

Source-available under the Functional Source License 1.1 with an Apache 2.0 future license (`LICENSE.md`): use it, change it and fix it freely, but not to offer a competing product. Each version becomes Apache 2.0 two years after its release.

Pull requests are welcome. Before one can be merged, its author signs the contributor agreement (`CLA.md`), which assigns the copyright in the contribution to The Startup Factory AB; the CLA bot asks for it on the pull request.
