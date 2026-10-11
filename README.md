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

## The launcher: From a Gmail thread…

In prifly's New session area it lists your mail as a board, one column per
Gmail search, one card per thread (subject, who wrote and when, the message and
attachment counts, a link to the thread in Gmail). Typing in the filter field
searches Gmail with what you typed, in one column called Results. Opening a
card shows the whole thread; starting from it starts a session that already
knows it.

- Columns: the `columns` setting, `Name=Gmail search` pairs separated by `;`,
  for example `Unread=is:unread in:inbox; Jobs=from:jobylon`. Spaces and empty
  parts are fine; what parses to nothing gives the default three (Unread,
  Inbox, Starred). Each column shows up to 25 threads, and a thread appears
  only in the first column that has it.
- Accounts: the board shows the account last picked here, else the `account`
  setting, else the first connected one. With two or more connected,
  "Switch account…" at the end of the board moves to the next and lists again.
  "Add another Google account…" opens the sign-in in your browser and then
  shows the new account.
- Signed out: with no Google account the board is one row, "Connect a Google
  account". When Google ended a grant it is one row, "Sign in again as …", and
  the launcher button glows amber until it works again. Both rows sign in and
  list again. A Gmail error (an HTTP status) is one muted row with its text.
- What a session starts with: the first message holds the subject, the Gmail
  link and account, the participants, every message in order (from, to, cc,
  date, text), the paths of the saved files and up to 20 pictures (png, jpeg,
  gif, webp, each up to 5 MB) from the attachments. `thread.md` and every
  attachment are saved in `threads/<thread id>/` in the extension's folder
  (git-ignored). The prompt ends with "Answer by drafting with
  `gmail_draft_reply`; nothing is ever sent."
- The session wears a Gmail chip (the subject, the participants, a link to the
  thread). The chips and the cards' "started" tint come from `state.json` in
  the extension's folder (also git-ignored), so they survive a restart; the
  same file remembers the account picked with "Switch account…".

## Settings

- `columns`: `Name=Gmail search` pairs separated by `;`, the launcher's
  columns (default `Unread=is:unread in:inbox; Inbox=in:inbox; Starred=is:starred`).
- `pollSeconds`: how often to check for new mail, 30 to 900 (default 90; for a poller to
  come).
- `account`: the email of the account to use; empty means the first one.

## Checks

`bun test`, `bun run typecheck` and `bun run check` (biome: 500 lines per
file, 120 per function, cognitive complexity 15, no `any`, no `!`).

| File | What it is |
|---|---|
| `prifly-extension.json` | The manifest: the Google connection, its settings and `prompt.md` |
| `index.ts` | `activate(api)` registers the four tools and puts the chips back; exports the launcher's `choices`, `open`, `launch` and `launched` |
| `board.ts` | The board: the `columns` setting, the cards, "Switch account…" |
| `sign-in.ts` | The one-row boards for no account or an ended grant, and the sign-in launches |
| `launcher.ts` | Open a thread, launch a session from it, the chip it wears |
| `thread-prompt.ts` | The first prompt, the pictures carried in it, the session's name |
| `state.ts` | `state.json`: the account picked, and thread → sessions |
| `tools.ts` | The tools |
| `connection.ts` | Picks the connection; the texts for no connection, a ended grant and an HTTP error |
| `gmail.ts`, `gmail-types.ts` | The REST client over `api.connections.fetch`, and tolerant parsers of its answers |
| `mime.ts` | Reads a message into text and attachments; builds the RFC 822 reply and new mail |
| `save.ts` | A thread as Markdown, and on disk with its attachments |
| `prompt.md` | The rules added to every session |
| `test/` | `fake-api.ts` (the template's fake `api`), `fake-gmail.ts` (an in-memory mailbox) and the tests |
