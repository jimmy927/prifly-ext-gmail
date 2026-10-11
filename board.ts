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
  gmailClient,
  type ThreadSummary,
} from "./gmail";
import type { Mailbox } from "./mime";
import { addAccountRow, connectRows, SIGN_IN_FLAG, signInRows } from "./sign-in";
import { readState, type State, writeState } from "./state";

export const LAUNCH_ID = "thread";
export const SWITCH_KEY = "gmail:switch";
export const ERROR_KEY = "gmail:error";

const PER_COLUMN = 25;
const MAX_PEOPLE = 5;
const MAX_SENDERS = 3;
const DEFAULT_COLUMNS = "Unread=is:unread in:inbox; Inbox=in:inbox; Starred=is:starred";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** What "now" is; replaced in tests. */
export const clock = { now: (): Date => new Date() };

export type Column = { name: string; query: string };

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

function badgesOf(summary: ThreadSummary): LaunchBadges | undefined {
  const badges: LaunchBadges = {};
  if (summary.messages > 1) badges.comments = summary.messages;
  if (summary.attachments > 0) badges.attachments = summary.attachments;
  return Object.keys(badges).length === 0 ? undefined : badges;
}

/** One thread as a card. */
export function cardOf(summary: ThreadSummary, account: string, started: boolean): LaunchChoice {
  const when = formatWhen(summary.date, clock.now());
  const detail = [sendersLine(summary, account), when].filter((part) => part !== "").join(" · ");
  const badges = badgesOf(summary);
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

type Found =
  | { ok: true; columns: { column: Column; threads: ThreadSummary[] }[] }
  | { ok: false; failure: GmailFailure };

async function search(client: GmailClient, columns: Column[]): Promise<Found> {
  const answers = await Promise.all(
    columns.map((column) => client.searchThreads(column.query, PER_COLUMN)),
  );
  const out: { column: Column; threads: ThreadSummary[] }[] = [];
  let failure: GmailFailure | undefined;
  for (const [index, answer] of answers.entries()) {
    const column = columns[index];
    if (column === undefined) continue;
    if (answer.ok) out.push({ column, threads: answer.value });
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
  if (failure.kind === "sign-in") {
    api.flag(LAUNCH_ID, SIGN_IN_FLAG);
    return signInRows(connection.id, connection.account);
  }
  api.flag(LAUNCH_ID, null);
  return [{ key: ERROR_KEY, title: failureText(failure), tone: "muted" }];
}

/** The cards of each column, a thread shown in an earlier column not repeated. */
function layout(found: Extract<Found, { ok: true }>, state: State, account: string): LaunchBoard {
  const seen = new Set<string>();
  const columns: LaunchColumn[] = [];
  const items: LaunchChoice[] = [];
  for (const [index, { column, threads }] of found.columns.entries()) {
    const id = `c${index}`;
    columns.push({ id, name: column.name });
    for (const summary of threads) {
      if (seen.has(summary.id)) continue;
      seen.add(summary.id);
      const started = (state.threads[summary.id]?.sessions.length ?? 0) > 0;
      items.push({ ...cardOf(summary, account, started), group: id });
    }
  }
  return { columns, items };
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
    api.flag(LAUNCH_ID, null);
    return connectRows();
  }
  const typed = query.trim();
  const columns: Column[] =
    typed === "" ? columnsOf(api.settings?.["columns"]) : [{ name: "Results", query: typed }];
  const found = await search(client, columns);
  if (!found.ok) return failureRows(api, connection, found.failure);
  api.flag(LAUNCH_ID, null);
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
  return { ...layout(found, state, connection.account), actions };
}
