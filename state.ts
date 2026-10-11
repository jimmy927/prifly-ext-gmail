/**
 * What the launcher remembers between runs, in `state.json` in the
 * extension's folder: which connection the board shows, and for each thread
 * a session was started from, what its chip says and which sessions it became.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, list, str } from "./gmail-types";

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export type ThreadRecord = {
  subject: string;
  /** Participant names, for the chip's hover. */
  people: string[];
  url: string;
  sessions: string[];
  /** Messages that arrived in the thread since a session was last started from it. */
  newSince: number;
  /** Who wrote the latest of them, as the chip's label says. */
  lastFrom: string;
};

/** What `launch` knows of a thread, before any session or reply. */
export type ThreadInfo = Omit<ThreadRecord, "sessions" | "newSince" | "lastFrom">;

export type State = {
  /** The id of the connection the board shows; "" means the setting's, else the first. */
  account: string;
  /** By thread id. */
  threads: Record<string, ThreadRecord>;
};

const FILE = "state.json";

export const emptyState = (): State => ({ account: "", threads: {} });

function parseRecord(value: unknown): ThreadRecord {
  const each = isRecord(value) ? value : {};
  return {
    subject: str(each["subject"]),
    people: list(each["people"])
      .map(str)
      .filter((name) => name !== ""),
    url: str(each["url"]),
    sessions: list(each["sessions"])
      .map(str)
      .filter((id) => id !== ""),
    newSince: Math.max(0, Math.floor(num(each["newSince"]))),
    lastFrom: str(each["lastFrom"]),
  };
}

export function parseState(value: unknown): State {
  const data = isRecord(value) ? value : {};
  const threads: Record<string, ThreadRecord> = {};
  if (isRecord(data["threads"])) {
    for (const [id, record] of Object.entries(data["threads"])) threads[id] = parseRecord(record);
  }
  return { account: str(data["account"]), threads };
}

/** The saved state; a missing or unreadable file is an empty state, not a failure. */
export async function readState(folder: string): Promise<State> {
  try {
    return parseState(JSON.parse(await readFile(join(folder, FILE), "utf8")));
  } catch {
    return emptyState();
  }
}

export async function writeState(folder: string, state: State): Promise<void> {
  await writeFile(join(folder, FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** Notes that `sessionId` was started from `threadId`; a session is recorded once. A new start clears the new-reply count. */
export function recordSession(
  state: State,
  threadId: string,
  record: ThreadInfo,
  sessionId: string,
): void {
  const sessions = state.threads[threadId]?.sessions ?? [];
  state.threads[threadId] = {
    ...record,
    newSince: 0,
    lastFrom: "",
    sessions: sessions.includes(sessionId) ? sessions : [...sessions, sessionId],
  };
}
