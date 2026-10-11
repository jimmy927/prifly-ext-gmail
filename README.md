# prifly-ext-gmail

A prifly extension that gives every Claude session four tools to search, read
and draft replies in Gmail, through your Google account. The tools never
send: a draft only leaves Gmail when you press Send.

## What it needs

A Google connection in prifly's Vault → Connections with these scopes:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`

Your own Google client works. Its Google project must be In production,
otherwise Google ends the grant every 7 days and you sign in again.

A connection that also holds `gmail.send` is fine: the extension never uses it
and never asks for it on a fresh connect. There is no send code in it, and a
test asserts that no request goes to a `/send` URL.

prifly holds the token and adds it to each request, so the extension never
keeps one.

## The tools

Each takes an optional `account` (the Google account's email, when several are
connected). Without it the extension uses the `account` setting, else the first
connected Google account.

| Tool | What it does |
|---|---|
| `gmail_search` `{ query, max }` | Gmail search; one line per thread: `thread_id \| N msg \| date \| from \| subject` |
| `gmail_thread` `{ thread_id }` | The whole thread as Markdown, oldest first; saves `thread.md` and every attachment (up to 25 MB each) in the session's scratchpad (else in the extension's own `threads/<id>/` folder, which is git-ignored; with neither, nothing is saved) and lists the paths |
| `gmail_draft_reply` `{ thread_id, body, all, replace_draft_id }` | A threaded reply draft (`Re:`, In-Reply-To, References); `all` (default true) keeps everyone else on Cc; `replace_draft_id` rewrites a draft instead of adding one |
| `gmail_new_draft` `{ to, cc, subject, body }` | A new draft |

When the grant has ended, a tool answers "The Gmail grant for … ended: sign in
again in prifly's Vault → Connections." With no Google account connected it
says to connect one.

## Settings

- `columns`: `Name=Gmail search` pairs separated by `;` (for a launcher board
  to come).
- `pollSeconds`: how often to check for new mail, 30 to 900 (default 90; for a poller to
  come).
- `account`: the email of the account to use; empty means the first one.

## Checks

`bun test`, `bun run typecheck` and `bun run check` (biome: 500 lines per
file, 120 per function, cognitive complexity 15, no `any`, no `!`).

| File | What it is |
|---|---|
| `prifly-extension.json` | The manifest: the Google connection, its settings and `prompt.md` |
| `index.ts` | `activate(api)` registers the four tools |
| `tools.ts` | The tools |
| `connection.ts` | Picks the connection; the texts for no connection, a ended grant and an HTTP error |
| `gmail.ts`, `gmail-types.ts` | The REST client over `api.connections.fetch`, and tolerant parsers of its answers |
| `mime.ts` | Reads a message into text and attachments; builds the RFC 822 reply and new mail |
| `save.ts` | A thread as Markdown, and on disk with its attachments |
| `prompt.md` | The rules added to every session |
| `test/` | `fake-api.ts` (the template's fake `api`), `fake-gmail.ts` (an in-memory mailbox) and the tests |
