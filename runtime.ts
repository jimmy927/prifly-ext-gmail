/**
 * What the board and the poller share while the extension runs, one set per
 * `activate` (keyed by the api it was given): the last board read per account
 * and column, where the poller is in the mailbox's history, and whether the
 * grant works. Nothing here is saved; `state.json` holds what must survive.
 */

import type { ExtensionApi, LauncherFlag } from "@prifly/extension-api";
import type { ThreadSummary } from "./gmail";
import { SIGN_IN_FLAG } from "./sign-in";

export const LAUNCH_ID = "thread";

export type Column = { name: string; query: string };

/** A column as read from Gmail: its threads, and which of them carry an attachment. */
export type ColumnRead = { column: Column; threads: ThreadSummary[]; attached: Set<string> };

type CachedColumn = { read: ColumnRead; at: number; version: number };

export type Runtime = {
  /** By account and column query. */
  columns: Map<string, CachedColumn>;
  /** Bumped when the poller sees mail arrive: a column read before that is stale. */
  versions: Map<string, number>;
  /** The last typed search, so the same one asked again at once is not sent twice. */
  typed: { key: string; at: number; read: ColumnRead } | null;
  /** The poller's place in each account's history. */
  history: Map<string, string>;
  /** Google ended the grant: the flag says so until a call works again. */
  signedOut: boolean;
  /** Threads in the first column, or null until counted. */
  unread: number | null;
  stopped: boolean;
};

const runtimes = new WeakMap<ExtensionApi, Runtime>();

export function runtimeOf(api: ExtensionApi): Runtime {
  const known = runtimes.get(api);
  if (known !== undefined) return known;
  const made: Runtime = {
    columns: new Map(),
    versions: new Map(),
    typed: null,
    history: new Map(),
    signedOut: false,
    unread: null,
    stopped: false,
  };
  runtimes.set(api, made);
  return made;
}

const MAX_UNREAD = 100;

/** The launcher's flag now: the sign-in warning wins over the unread count. */
export function currentFlag(runtime: Runtime): LauncherFlag | null {
  if (runtime.signedOut) return SIGN_IN_FLAG;
  const count = runtime.unread ?? 0;
  if (count <= 0) return null;
  return { tone: "info", hint: `${count >= MAX_UNREAD ? `${MAX_UNREAD}+` : count} unread` };
}

export function applyFlag(api: ExtensionApi): void {
  api.flag(LAUNCH_ID, currentFlag(runtimeOf(api)));
}

export const columnKey = (connection: string, query: string): string => `${connection}\n${query}`;

/** Some mail arrived on this account: what the board last read is out of date. */
export function markStale(runtime: Runtime, connection: string): void {
  runtime.versions.set(connection, (runtime.versions.get(connection) ?? 0) + 1);
}

export const versionOf = (runtime: Runtime, connection: string): number =>
  runtime.versions.get(connection) ?? 0;

/** The columns as last read, if every one is younger than `maxAgeMs` and not stale. */
export function cachedColumns(
  runtime: Runtime,
  connection: string,
  columns: Column[],
  now: number,
  maxAgeMs: number,
): ColumnRead[] | null {
  const out: ColumnRead[] = [];
  for (const column of columns) {
    const each = runtime.columns.get(columnKey(connection, column.query));
    if (each === undefined || each.version !== versionOf(runtime, connection)) return null;
    if (now - each.at >= maxAgeMs) return null;
    out.push({ ...each.read, column });
  }
  return out;
}

export function storeColumn(
  runtime: Runtime,
  connection: string,
  read: ColumnRead,
  now: number,
  version: number,
): void {
  runtime.columns.set(columnKey(connection, read.column.query), { read, at: now, version });
}

const DEFAULT_POLL_SECONDS = 90;
const MIN_POLL_SECONDS = 30;
const MAX_POLL_SECONDS = 900;

/** The `pollSeconds` setting, kept inside its limits. */
export function pollSeconds(api: ExtensionApi): number {
  const given = api.settings?.["pollSeconds"];
  const seconds =
    typeof given === "number" && Number.isFinite(given) ? given : DEFAULT_POLL_SECONDS;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, seconds));
}
