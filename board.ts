/**
 * The launcher's board: the reader's mail in the columns they chose, one card
 * per thread. Everything that goes wrong on the way is a row on the board
 * (connect, sign in again, the error text), never a throw.
 */

import type {
  ExtensionApi,
  ExtensionConnection,
  Launch,
  LaunchBadges,
  LaunchBoard,
  LaunchChoice,
  LaunchColumn,
} from "@prifly/extension-api";
import { pickConnection } from "./connection";
import {
  failureText,
  type GmailClient,
  type GmailFailure,
  type GmailResult,
  gmailClient,
  type ThreadSummary,
} from "./gmail";
import type { Mailbox } from "./mime";
import {
  applyFlag,
  type Column,
  type ColumnRead,
  cachedColumns,
  LAUNCH_ID,
  pollSeconds,
  runtimeOf,
  storeColumn,
  versionOf,
} from "./runtime";
import { addAccountRow, connectRows, signInRows } from "./sign-in";
import { readState, type State, writeState } from "./state";

export { type Column, LAUNCH_ID };
export const SWITCH_KEY = "gmail:switch";
export const ERROR_KEY = "gmail:error";

const PER_COLUMN = 25;
/** How many threads with an attachment one search lists; ids only, so a page is cheap. */
const ATTACHED_MAX = 100;
/** A typed search asked again within this long gets the answer it just had. */
const DEBOUNCE_MS = 2000;
const MAX_PEOPLE = 5;
const MAX_SENDERS = 3;
const DEFAULT_COLUMNS = "Unread=is:unread in:inbox; Inbox=in:inbox; Starred=is:starred";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** What "now" is; replaced in tests. */
export const clock = { now: (): Date => new Date() };

function parseColumns(setting: string): Column[] {
  return setting.split(";").flatMap((part) => {
    const at = part.indexOf("=");
    if (at < 0) return [];
    const name = part.slice(0, at).trim();
    const query = part.slice(at + 1).trim();
    return name === "" || query === "" ? [] : [{ name, query }];
  });
}

/** The `columns` setting as columns; what parses to nothing is the default three. */
export function columnsOf(setting: unknown): Column[] {
  const parsed = typeof setting === "string" ? parseColumns(setting) : [];
  return parsed.length > 0 ? parsed : parseColumns(DEFAULT_COLUMNS);
}

export function threadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`;
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** A mail's Date header as the board writes it: "14:05" today, "yesterday", else "9 Oct". */
export function formatWhen(header: string, now: Date): string {
  const when = new Date(header);
  if (Number.isNaN(when.getTime())) return "";
  if (sameDay(when, now)) {
    return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  }
  const before = new Date(now);
  before.setDate(before.getDate() - 1);
  if (sameDay(when, before)) return "yesterday";
  return `${when.getDate()} ${MONTHS[when.getMonth()] ?? ""}`;
}

const isSelf = (box: Mailbox, account: string): boolean =>
  box.address.toLowerCase() === account.toLowerCase();

/** "Ada Lovelace <ada@…>" as "Ada"; the reader as "me". */
function shortName(box: Mailbox, account: string): string {
  if (isSelf(box, account)) return "me";
  const name = box.name !== "" ? box.name : (box.address.split("@")[0] ?? box.address);
  return name.split(/\s+/)[0] ?? name;
}

function sendersLine(summary: ThreadSummary, account: string): string {
  const names = [...new Set(summary.senders.map((box) => shortName(box, account)))];
  const shown = names.slice(0, MAX_SENDERS).join(", ");
  return names.length > MAX_SENDERS ? `${shown} +${names.length - MAX_SENDERS}` : shown;
}

/**
 * Gmail's metadata answers carry no MIME parts, so the paperclip comes from a
 * `has:attachment` search and shows no count; the card's exact count is in `open`.
 */
function badgesOf(summary: ThreadSummary, attached: boolean): LaunchBadges | undefined {
  const badges: LaunchBadges = {};
  if (summary.messages > 1) badges.comments = summary.messages;
  if (attached) badges.attachments = 1;
  return Object.keys(badges).length === 0 ? undefined : badges;
}

/** One thread as a card. */
export function cardOf(
  summary: ThreadSummary,
  account: string,
  started: boolean,
  attached: boolean,
): LaunchChoice {
  const when = formatWhen(summary.date, clock.now());
  const detail = [sendersLine(summary, account), when].filter((part) => part !== "").join(" · ");
  const badges = badgesOf(summary, attached);
  const people = summary.people
    .filter((box) => !isSelf(box, account))
    .map((box) => (box.name !== "" ? box.name : box.address))
    .slice(0, MAX_PEOPLE);
  return {
    key: summary.id,
    title: summary.subject.trim() === "" ? "(no subject)" : summary.subject.trim(),
    detail,
    people,
    url: threadUrl(summary.id),
    ...(badges === undefined ? {} : { badges }),
    ...(started ? { started: true } : {}),
  };
}

/** The connection the board shows: the state's choice, else the setting's, else the first. */
export function activeConnection(api: ExtensionApi, state: State): ExtensionConnection | null {
  const chosen = api.connections?.list("google").find((each) => each.id === state.account);
  return chosen ?? pickConnection(api);
}

export function clientFor(api: ExtensionApi, connection: ExtensionConnection): GmailClient | null {
  if (api.connections === undefined) return null;
  return gmailClient({
    connections: api.connections,
    connection: connection.id,
    account: connection.account,
  });
}

/** "Switch account…": shows the next connected account and lists again. */
export async function switchAccount(api: ExtensionApi): Promise<Launch> {
  const all = api.connections?.list("google") ?? [];
  const state = await readState(api.folder);
  const current = activeConnection(api, state);
  const at = all.findIndex((each) => each.id === current?.id);
  const next = all[(at + 1) % Math.max(all.length, 1)];
  if (next === undefined) return { prompt: "", message: "No Google account is connected." };
  await writeState(api.folder, { ...state, account: next.id });
  return { prompt: "", message: `Showing ${next.account}.` };
}

type Found = { ok: true; columns: ColumnRead[] } | { ok: false; failure: GmailFailure };

/** `query` and `has:attachment`, the query in brackets when an OR would otherwise bind wrongly. */
export function withAttachment(query: string): string {
  return /\bOR\b|[{|]/.test(query) ? `(${query}) has:attachment` : `${query} has:attachment`;
}

async function readColumn(client: GmailClient, column: Column): Promise<GmailResult<ColumnRead>> {
  const [threads, attached] = await Promise.all([
    client.searchThreads(column.query, PER_COLUMN),
    client.threadIds(withAttachment(column.query), ATTACHED_MAX),
  ]);
  if (!threads.ok) return threads;
  if (!attached.ok) return attached;
  return { ok: true, value: { column, threads: threads.value, attached: new Set(attached.value) } };
}

async function search(client: GmailClient, columns: Column[]): Promise<Found> {
  const answers = await Promise.all(columns.map((column) => readColumn(client, column)));
  const out: ColumnRead[] = [];
  let failure: GmailFailure | undefined;
  for (const answer of answers) {
    if (answer.ok) out.push(answer.value);
    // An ended grant is the one failure with a fix on the board: it wins over the others.
    else if (failure === undefined || answer.kind === "sign-in") failure = answer;
  }
  return failure === undefined ? { ok: true, columns: out } : { ok: false, failure };
}

function failureRows(
  api: ExtensionApi,
  connection: ExtensionConnection,
  failure: GmailFailure,
): LaunchChoice[] {
  const runtime = runtimeOf(api);
  runtime.signedOut = failure.kind === "sign-in";
  applyFlag(api);
  if (failure.kind === "sign-in") return signInRows(connection.id, connection.account);
  return [{ key: ERROR_KEY, title: failureText(failure), tone: "muted" }];
}

/** The cards of each column, a thread shown in an earlier column not repeated. */
function layout(columnReads: ColumnRead[], state: State, account: string): LaunchBoard {
  const seen = new Set<string>();
  const columns: LaunchColumn[] = [];
  const items: LaunchChoice[] = [];
  for (const [index, { column, threads, attached }] of columnReads.entries()) {
    const id = `c${index}`;
    columns.push({ id, name: column.name });
    for (const summary of threads) {
      if (seen.has(summary.id)) continue;
      seen.add(summary.id);
      const started = (state.threads[summary.id]?.sessions.length ?? 0) > 0;
      items.push({ ...cardOf(summary, account, started, attached.has(summary.id)), group: id });
    }
  }
  return { columns, items };
}

/**
 * The columns for `typed`. With no filter they come from the last read while it is younger than
 * `pollSeconds` and the poller has seen no new mail; a typed filter reads Gmail, except that the
 * same one asked again within 2 s gets the answer it just had.
 */
async function read(
  api: ExtensionApi,
  connection: ExtensionConnection,
  client: GmailClient,
  typed: string,
): Promise<Found> {
  const runtime = runtimeOf(api);
  const now = clock.now().getTime();
  if (typed !== "") {
    const key = `${connection.id}\n${typed}`;
    const last = runtime.typed;
    if (last !== null && last.key === key && now - last.at < DEBOUNCE_MS) {
      return { ok: true, columns: [last.read] };
    }
    const found = await search(client, [{ name: "Results", query: typed }]);
    if (found.ok) runtime.signedOut = false;
    const only = found.ok ? found.columns[0] : undefined;
    if (only !== undefined) runtime.typed = { key, at: now, read: only };
    return found;
  }
  const columns = columnsOf(api.settings?.["columns"]);
  const cached = cachedColumns(runtime, connection.id, columns, now, pollSeconds(api) * 1000);
  if (cached !== null) return { ok: true, columns: cached };
  const version = versionOf(runtime, connection.id);
  const found = await search(client, columns);
  if (found.ok) {
    runtime.signedOut = false;
    for (const each of found.columns) storeColumn(runtime, connection.id, each, now, version);
  }
  return found;
}

/** What the chooser shows: the board for `query` (a Gmail search of its own when typed), or the one row that fixes it. */
export async function board(
  api: ExtensionApi,
  query: string,
): Promise<LaunchBoard | LaunchChoice[]> {
  const state = await readState(api.folder);
  const connection = activeConnection(api, state);
  const client = connection === null ? null : clientFor(api, connection);
  if (connection === null || client === null) {
    const runtime = runtimeOf(api);
    runtime.signedOut = false;
    runtime.unread = null;
    applyFlag(api);
    return connectRows();
  }
  const found = await read(api, connection, client, query.trim());
  if (!found.ok) return failureRows(api, connection, found.failure);
  applyFlag(api);
  const actions: LaunchChoice[] = [];
  if ((api.connections?.list("google").length ?? 0) >= 2) {
    actions.push({
      key: SWITCH_KEY,
      title: "Switch account…",
      detail: `Showing ${connection.account}`,
      group: "prifly",
      tone: "muted",
    });
  }
  actions.push(addAccountRow());
  return { ...layout(found.columns, state, connection.account), actions };
}
