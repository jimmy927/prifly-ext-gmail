/**
 * The poller: every `pollSeconds`, for the account the board shows, it asks
 * Gmail's history what arrived and does three things with the answer. It marks
 * the board cache stale, turns the chip of a session started from a thread that
 * got a reply into "new reply from …", and counts the first column's threads
 * for the launcher's flag. It never notifies and never prompts a session, and
 * it makes a few requests a tick: no per-thread metadata calls.
 */

import type { ExtensionApi, ExtensionConnection } from "@prifly/extension-api";
import { activeConnection, clientFor, columnsOf } from "./board";
import type { GmailClient, GmailFailure, HistoryAnswer } from "./gmail";
import { showChips } from "./launcher";
import { applyFlag, markStale, pollSeconds, type Runtime, runtimeOf } from "./runtime";
import { readState, type State, writeState } from "./state";

/** The first tick comes soon after `activate`, so the flag does not wait a whole interval. */
const FIRST_TICK_MS = 3000;
/** The most threads one unread count looks at; Gmail lists up to 100 ids a page. */
const UNREAD_MAX = 100;

/** Replaced in tests, so none of them waits on a real timer. */
export const timers = {
  set: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Added = HistoryAnswer["added"];

/** A sign-in failure pauses the poller and lights the flag; any other is logged for the next tick to retry. */
function failed(api: ExtensionApi, connection: ExtensionConnection, failure: GmailFailure): void {
  runtimeOf(api).signedOut = failure.kind === "sign-in";
  applyFlag(api);
  if (failure.kind === "http") {
    api.log("poll-failed", { account: connection.account, status: failure.status });
  }
}

/** Messages the reader did not write: their own drafts and sent mail are no reply. */
const incoming = (added: Added): Added =>
  added.filter((each) => !each.labelIds.includes("DRAFT") && !each.labelIds.includes("SENT"));

/** Turns the chips of the sessions whose thread got mail; the state file keeps the count. */
/** Per thread a session came from: how many messages arrived and the id of the last. */
function repliesIn(state: State, added: Added): Map<string, { id: string; count: number }> {
  const latest = new Map<string, { id: string; count: number }>();
  for (const each of incoming(added)) {
    if ((state.threads[each.threadId]?.sessions.length ?? 0) === 0) continue;
    latest.set(each.threadId, { id: each.id, count: (latest.get(each.threadId)?.count ?? 0) + 1 });
  }
  return latest;
}

async function markReplies(api: ExtensionApi, client: GmailClient, added: Added): Promise<void> {
  const latest = repliesIn(await readState(api.folder), added);
  if (latest.size === 0) return;
  const senders = new Map<string, string>();
  for (const [threadId, { id }] of latest) {
    const from = await client.sender(id);
    senders.set(threadId, from.ok ? from.value.name || from.value.address : "");
  }
  // Read again after the requests, and write with nothing awaited between: a session
  // launched or an account switched meanwhile is kept.
  const state = await readState(api.folder);
  for (const [threadId, { count }] of latest) {
    const record = state.threads[threadId];
    if (record === undefined) continue;
    const who = senders.get(threadId) ?? "";
    state.threads[threadId] = {
      ...record,
      newSince: record.newSince + count,
      lastFrom: who !== "" ? who : record.lastFrom,
    };
  }
  await writeState(api.folder, state);
  showChips(api, state);
}

/** Where the history stands now: from the stored id, else a fresh start from the profile. */
async function advance(
  api: ExtensionApi,
  runtime: Runtime,
  connection: ExtensionConnection,
  client: GmailClient,
): Promise<boolean> {
  const start = runtime.history.get(connection.id);
  if (start !== undefined) {
    const got = await client.history(start);
    if (got.ok) {
      runtime.signedOut = false;
      if (got.value.historyId !== "") runtime.history.set(connection.id, got.value.historyId);
      if (got.value.added.length > 0) {
        markStale(runtime, connection.id);
        await markReplies(api, client, got.value.added);
      }
      return true;
    }
    // Too old an id: Gmail kept no history that far back, so start again and read the board anew.
    if (got.kind === "http" && got.status === 404) {
      runtime.history.delete(connection.id);
      markStale(runtime, connection.id);
    } else {
      failed(api, connection, got);
      return false;
    }
  }
  const profile = await client.profile();
  if (!profile.ok) {
    failed(api, connection, profile);
    return false;
  }
  runtime.signedOut = false;
  runtime.history.set(connection.id, profile.value.historyId);
  return true;
}

/** The launcher flag's count: the threads the first column's search finds, ids only. */
async function countUnread(
  api: ExtensionApi,
  runtime: Runtime,
  connection: ExtensionConnection,
  client: GmailClient,
): Promise<void> {
  const first = columnsOf(api.settings?.["columns"])[0];
  if (first === undefined) return;
  const found = await client.threadIds(first.query, UNREAD_MAX);
  if (found.ok) runtime.unread = found.value.length;
  else failed(api, connection, found);
}

/** One poll. Exported for the tests, which call it instead of waiting on the timer. */
export async function tick(api: ExtensionApi): Promise<void> {
  const runtime = runtimeOf(api);
  if (runtime.stopped) return;
  const connection = activeConnection(api, await readState(api.folder));
  const client = connection === null ? null : clientFor(api, connection);
  if (connection === null || client === null) return;
  // While the grant is ended this is the probe: the first call that works resumes polling.
  if (!(await advance(api, runtime, connection, client)) || runtime.stopped) return;
  await countUnread(api, runtime, connection, client);
  if (!runtime.stopped) applyFlag(api);
}

/** Starts the poller; the function it returns stops it. */
export function startPoller(api: ExtensionApi): () => void {
  const runtime = runtimeOf(api);
  runtime.stopped = false;
  let handle: unknown;
  const schedule = (ms: number): void => {
    handle = timers.set(() => {
      handle = undefined;
      tick(api)
        .catch((error: unknown) => {
          api.log("poll-failed", { error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          if (!runtime.stopped) schedule(pollSeconds(api) * 1000);
        });
    }, ms);
  };
  schedule(FIRST_TICK_MS);
  return () => {
    runtime.stopped = true;
    if (handle !== undefined) timers.clear(handle);
    handle = undefined;
  };
}
