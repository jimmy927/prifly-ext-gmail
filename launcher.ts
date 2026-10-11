/**
 * The launcher "From a Gmail thread…": what the chooser lists, what opening a
 * card shows, the session a card starts and the chip that session then wears.
 * Each function is given the api; `index.ts` holds the one `activate` gave it.
 */

import { join } from "node:path";
import type {
  Decoration,
  DecorationIcon,
  ExtensionApi,
  ExtensionConnection,
  Launch,
  LaunchBoard,
  LaunchChoice,
  LaunchItem,
  LaunchItemFile,
} from "@prifly/extension-api";
import {
  activeConnection,
  board,
  clientFor,
  LAUNCH_ID,
  SWITCH_KEY,
  switchAccount,
  threadUrl,
} from "./board";
import { NO_CONNECTION } from "./connection";
import { failureText, type GmailClient } from "./gmail";
import type { GmailThread } from "./gmail-types";
import { base64urlBytes, readMessage } from "./mime";
import { safeFilename, saveThread } from "./save";
import { signInLaunch } from "./sign-in";
import {
  readState,
  recordSession,
  type State,
  type ThreadInfo,
  type ThreadRecord,
  writeState,
} from "./state";
import { carriedImages, isImageType, slugOf, threadPrompt } from "./thread-prompt";

/** The most a picture may weigh to be fetched into the thread's view. */
const MAX_VIEW_IMAGE_BYTES = 2 * 1024 * 1024;
const CHIP_SUBJECT_CHARS = 50;

/** The Gmail mark, in the api's icon list since v0.5.0. */
const GMAIL_ICON: DecorationIcon = "gmail";

/** The connection and client the launcher uses now, or why there is none. */
async function session(
  api: ExtensionApi,
): Promise<{ connection: ExtensionConnection; client: GmailClient } | null> {
  const connection = activeConnection(api, await readState(api.folder));
  const client = connection === null ? null : clientFor(api, connection);
  return connection === null || client === null ? null : { connection, client };
}

export function choices(api: ExtensionApi, query: string): Promise<LaunchChoice[] | LaunchBoard> {
  return board(api, query);
}

const subjectOf = (thread: GmailThread): string => {
  const first = thread.messages[0];
  const subject = first === undefined ? "" : readMessage(first.payload).subject.trim();
  return subject === "" ? "(no subject)" : subject;
};

const people = (thread: GmailThread): string[] => {
  const names = thread.messages.map((each) => readMessage(each.payload).from);
  return [...new Set(names.map((name) => name.replace(/\s*<[^>]*>\s*$/, "").trim()))].filter(
    (name) => name !== "",
  );
};

async function viewFiles(client: GmailClient, thread: GmailThread): Promise<LaunchItemFile[]> {
  const wanted = thread.messages.flatMap((message) =>
    readMessage(message.payload).attachments.map((each) => ({ message, each })),
  );
  return await Promise.all(
    wanted.map(async ({ message, each }): Promise<LaunchItemFile> => {
      const at = readMessage(message.payload).date;
      const file: LaunchItemFile = {
        id: `${message.id}:${each.attachmentId}`,
        name: each.filename,
        ...(at === "" ? {} : { at }),
      };
      if (!isImageType(each.mimeType) || each.size > MAX_VIEW_IMAGE_BYTES) return file;
      if (each.attachmentId === "") return file;
      const got = await client.attachment(message.id, each.attachmentId);
      if (!got.ok) return file;
      const data = Buffer.from(base64urlBytes(got.value)).toString("base64");
      return { ...file, data: `data:${each.mimeType.toLowerCase()};base64,${data}` };
    }),
  );
}

/** The thread read whole: the first message as the text, the rest as notes, the attachments as files. */
export async function open(api: ExtensionApi, key: string): Promise<LaunchItem> {
  const at = await session(api);
  if (at === null) return { title: "Gmail", markdown: NO_CONNECTION };
  const got = await at.client.thread(key);
  if (!got.ok) return { title: "Gmail", markdown: failureText(got) };
  const mails = got.value.messages.map((each) => readMessage(each.payload));
  const [first, ...later] = mails;
  return {
    title: subjectOf(got.value),
    url: threadUrl(key),
    markdown: first === undefined || first.text === "" ? "(no text)" : first.text,
    people: people(got.value),
    files: await viewFiles(at.client, got.value),
    notes: later.map((mail) => ({
      by: mail.from,
      ...(mail.date === "" ? {} : { at: mail.date }),
      text: mail.text === "" ? "(no text)" : mail.text,
    })),
  };
}

/** What `launch` knew of a thread, for the chip `launched` puts on its session. */
const pending = new Map<string, ThreadInfo>();

/** The session a card starts, or an empty prompt and a message for the rows that are not cards. */
export async function launch(api: ExtensionApi, key: string): Promise<Launch> {
  const signIn = await signInLaunch(api, key);
  if (signIn !== null) return signIn;
  if (key === SWITCH_KEY) return await switchAccount(api);
  if (key.startsWith("gmail:")) {
    return { prompt: "", message: "Nothing to start from that row." };
  }
  const at = await session(api);
  if (at === null) return { prompt: "", message: NO_CONNECTION };
  const got = await at.client.thread(key);
  if (!got.ok) return { prompt: "", message: failureText(got) };
  const folder = join(api.folder, "threads", safeFilename(key));
  const saved = await saveThread(at.client, got.value, folder);
  const carried = await carriedImages(saved);
  const url = threadUrl(key);
  pending.set(key, { subject: subjectOf(got.value), people: people(got.value), url });
  return {
    prompt: threadPrompt({
      thread: got.value,
      url,
      account: at.connection.account,
      saved,
      carried: carried.files,
    }),
    name: slugOf(subjectOf(got.value)),
    ...(carried.images.length === 0 ? {} : { images: carried.images }),
  };
}

function cut(subject: string): string {
  return subject.length > CHIP_SUBJECT_CHARS
    ? `${subject.slice(0, CHIP_SUBJECT_CHARS - 1).trimEnd()}…`
    : subject;
}

/** The chip of a session started from a thread; "new reply" once mail has come in since. */
function chip(threadId: string, record: ThreadRecord): Decoration {
  const replied = record.newSince > 0;
  const details = [record.subject, record.people.join(", ")].filter((line) => line !== "");
  return {
    key: threadId,
    icon: GMAIL_ICON,
    label: replied
      ? `Gmail: new reply from ${record.lastFrom === "" ? "someone" : record.lastFrom}`
      : `Gmail: ${cut(record.subject)}`,
    tone: replied ? "warning" : "info",
    details: replied ? [...details, `${record.newSince} new since the session started`] : details,
    url: record.url,
    launcher: LAUNCH_ID,
  };
}

/** Puts a chip on every session recorded in `state`, replacing what was shown. */
export function showChips(api: ExtensionApi, state: State): void {
  const bySession: Record<string, Decoration[]> = {};
  for (const [threadId, record] of Object.entries(state.threads)) {
    for (const sessionId of record.sessions) {
      bySession[sessionId] = [...(bySession[sessionId] ?? []), chip(threadId, record)];
    }
  }
  if (Object.keys(bySession).length > 0) api.show(bySession, []);
}

/** The card's session is running: remember it, so the card is tinted and the session wears the chip. */
export async function launched(api: ExtensionApi, key: string, sessionId: string): Promise<void> {
  const state = await readState(api.folder);
  const known = pending.get(key);
  pending.delete(key);
  const record = known ?? {
    subject: state.threads[key]?.subject ?? "Gmail thread",
    people: state.threads[key]?.people ?? [],
    url: threadUrl(key),
  };
  recordSession(state, key, record, sessionId);
  await writeState(api.folder, state);
  showChips(api, state);
}
