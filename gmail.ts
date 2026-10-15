/**
 * A small Gmail REST client over `api.connections.fetch`: prifly adds the
 * token, so none is kept here. Every method answers a value or a typed
 * failure (the grant ended, or Gmail answered an error status) and never
 * throws for those. The methods that change the mailbox (drafts, send,
 * labels, modify, trash, `request` with a method other than GET) are only
 * called by the tools after the reader confirmed.
 */

import type { ExtensionConnectionsApi } from "@prifly/extension-api";
import { httpText, signInText } from "./connection";
import {
  type GmailMessage,
  type GmailThread,
  isRecord,
  list,
  parseMessage,
  parseThread,
  str,
} from "./gmail-types";
import { headerValue, type Mailbox, parseAddresses } from "./mime";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type GmailFailure =
  | { ok: false; kind: "sign-in"; account: string }
  | { ok: false; kind: "http"; account: string; status: number; body: string };

export type GmailResult<T> = { ok: true; value: T } | GmailFailure;

/** The tool text for a failure. */
export function failureText(failure: GmailFailure): string {
  return failure.kind === "sign-in"
    ? signInText(failure.account)
    : httpText(failure.status, failure.account, failure.body);
}

export type ThreadSummary = {
  id: string;
  messages: number;
  /** The last message's date and sender, and the first message's subject. */
  date: string;
  from: string;
  subject: string;
  /** Everyone who wrote in it, in order of first appearance. */
  senders: Mailbox[];
  /** Everyone on it (From, To and Cc), the senders first. */
  people: Mailbox[];
};

/** A draft: its id, its thread and the id of the message it holds (which changes on every update). */
export type Draft = { id: string; threadId: string; messageId: string };

export type Sent = { id: string; threadId: string };

export type Label = {
  id: string;
  name: string;
  /** `system` (INBOX, UNREAD, …) or `user`. */
  type: string;
  threadsTotal: number;
  threadsUnread: number;
};

export type GmailClient = {
  searchThreads(q: string, max: number): Promise<GmailResult<ThreadSummary[]>>;
  /** The summaries of the threads with these ids, in order. */
  summaries(ids: string[]): Promise<GmailResult<ThreadSummary[]>>;
  thread(id: string): Promise<GmailResult<GmailThread>>;
  /** One message as Gmail stored it (`format=full`). */
  message(id: string): Promise<GmailResult<GmailMessage>>;
  /** The attachment's bytes, base64url. */
  attachment(messageId: string, attachmentId: string): Promise<GmailResult<string>>;
  labels(): Promise<GmailResult<Label[]>>;
  /** One label with its counts, which the list leaves out. */
  label(id: string): Promise<GmailResult<Label>>;
  createDraft(raw: string, threadId?: string): Promise<GmailResult<Draft>>;
  updateDraft(draftId: string, raw: string, threadId?: string): Promise<GmailResult<Draft>>;
  sendMessage(raw: string, threadId?: string): Promise<GmailResult<Sent>>;
  createLabel(name: string): Promise<GmailResult<Label>>;
  modifyThread(id: string, add: string[], remove: string[]): Promise<GmailResult<null>>;
  trashThread(id: string): Promise<GmailResult<null>>;
  /** Any call below `users/me`: `path` starts with "/" and may carry a query. Answers the body as text. */
  request(method: string, path: string, body?: unknown): Promise<GmailResult<string>>;
};

export type GmailClientOptions = {
  connections: ExtensionConnectionsApi;
  connection: string;
  account: string;
  /** Waits `ms`; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
};

const RETRY_STATUSES = [429, 503];
const MAX_WAIT_SECONDS = 30;
const SUMMARY_CHUNK = 10;

function retryWait(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_WAIT_SECONDS) : 1;
}

/** The mailboxes in the headers called `names` of every message, each address once, in order. */
function mailboxes(thread: GmailThread, names: string[]): Mailbox[] {
  const seen = new Set<string>();
  const out: Mailbox[] = [];
  for (const name of names) {
    for (const message of thread.messages) {
      for (const box of parseAddresses(headerValue(message.payload.headers, name))) {
        if (!seen.has(box.address.toLowerCase())) {
          seen.add(box.address.toLowerCase());
          out.push(box);
        }
      }
    }
  }
  return out;
}

function summarise(id: string, thread: GmailThread): ThreadSummary {
  const first = thread.messages[0];
  const last = thread.messages[thread.messages.length - 1];
  const headers = (message: GmailMessage | undefined, name: string) =>
    message === undefined ? "" : headerValue(message.payload.headers, name);
  return {
    id,
    messages: thread.messages.length,
    date: headers(last, "Date"),
    from: headers(last, "From"),
    subject: headers(first, "Subject"),
    senders: mailboxes(thread, ["From"]),
    people: mailboxes(thread, ["From", "To", "Cc"]),
  };
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0);

export function parseLabel(value: unknown): Label {
  const each = isRecord(value) ? value : {};
  return {
    id: str(each["id"]),
    name: str(each["name"]),
    type: str(each["type"]),
    threadsTotal: num(each["threadsTotal"]),
    threadsUnread: num(each["threadsUnread"]),
  };
}

const idPair = (value: unknown): { id: string; threadId: string } => {
  const data = isRecord(value) ? value : {};
  return { id: str(data["id"]), threadId: str(data["threadId"]) };
};

export function gmailClient(options: GmailClientOptions): GmailClient {
  const { connections, connection, account } = options;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  async function send(url: string, init?: RequestInit): Promise<GmailResult<Response>> {
    for (let attempt = 0; ; attempt++) {
      // A Request carries its method and body, whatever `fetch` does with its options.
      const answer = await connections.fetch(connection, new Request(url, init));
      if ("needsSignIn" in answer) return { ok: false, kind: "sign-in", account };
      if (RETRY_STATUSES.includes(answer.status) && attempt === 0) {
        await answer.text();
        await sleep(retryWait(answer) * 1000);
        continue;
      }
      if (answer.ok) return { ok: true, value: answer };
      const body = await answer.text();
      return { ok: false, kind: "http", account, status: answer.status, body };
    }
  }

  async function json(path: string, init?: RequestInit): Promise<GmailResult<unknown>> {
    const sent = await send(`${GMAIL_API}${path}`, init);
    if (!sent.ok) return sent;
    const text = await sent.value.text();
    return { ok: true, value: text === "" ? {} : (JSON.parse(text) as unknown) };
  }

  const body = (method: string, payload: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const asThread = async (id: string, query: string): Promise<GmailResult<GmailThread>> => {
    const got = await json(`/threads/${encodeURIComponent(id)}?${query}`);
    return got.ok ? { ok: true, value: parseThread(got.value) } : got;
  };

  const asDraft = (got: GmailResult<unknown>): GmailResult<Draft> => {
    if (!got.ok) return got;
    const draft = isRecord(got.value) ? got.value : {};
    const message = isRecord(draft["message"]) ? draft["message"] : {};
    return {
      ok: true,
      value: {
        id: str(draft["id"]),
        threadId: str(message["threadId"]),
        messageId: str(message["id"]),
      },
    };
  };

  const asNull = (got: GmailResult<unknown>): GmailResult<null> =>
    got.ok ? { ok: true, value: null } : got;

  /** Each thread's summary, fetched in small parallel chunks. */
  const summaries = async (ids: string[]): Promise<GmailResult<ThreadSummary[]>> => {
    const meta = new URLSearchParams({ format: "metadata" });
    for (const name of ["From", "To", "Cc", "Subject", "Date"])
      meta.append("metadataHeaders", name);
    const out: ThreadSummary[] = [];
    for (let at = 0; at < ids.length; at += SUMMARY_CHUNK) {
      const chunk = ids.slice(at, at + SUMMARY_CHUNK);
      const got = await Promise.all(chunk.map((id) => asThread(id, meta.toString())));
      for (const [index, each] of got.entries()) {
        if (!each.ok) return each;
        out.push(summarise(chunk[index] ?? "", each.value));
      }
    }
    return { ok: true, value: out };
  };

  const threadIds = async (q: string, max: number): Promise<GmailResult<string[]>> => {
    const query = new URLSearchParams({ q, maxResults: String(max) });
    const found = await json(`/threads?${query}`);
    if (!found.ok) return found;
    const data = isRecord(found.value) ? found.value : {};
    const ids = list(data["threads"]).map((each) => (isRecord(each) ? str(each["id"]) : ""));
    return { ok: true, value: ids.filter((id) => id !== "") };
  };

  const draftBody = (raw: string, threadId?: string) => ({
    message: threadId === undefined || threadId === "" ? { raw } : { raw, threadId },
  });

  const thread = (id: string) => `/threads/${encodeURIComponent(id)}`;

  return {
    async searchThreads(q, max) {
      const ids = await threadIds(q, max);
      return ids.ok ? await summaries(ids.value) : ids;
    },

    summaries,

    thread: (id) => asThread(id, "format=full"),

    async message(id) {
      const got = await json(`/messages/${encodeURIComponent(id)}?format=full`);
      return got.ok ? { ok: true, value: parseMessage(got.value) } : got;
    },

    async attachment(messageId, attachmentId) {
      const path = `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
      const got = await json(path);
      if (!got.ok) return got;
      return { ok: true, value: isRecord(got.value) ? str(got.value["data"]) : "" };
    },

    async labels() {
      const got = await json("/labels");
      if (!got.ok) return got;
      const data = isRecord(got.value) ? got.value : {};
      return { ok: true, value: list(data["labels"]).map(parseLabel) };
    },

    async label(id) {
      const got = await json(`/labels/${encodeURIComponent(id)}`);
      return got.ok ? { ok: true, value: parseLabel(got.value) } : got;
    },

    async createDraft(raw, threadId) {
      return asDraft(await json("/drafts", body("POST", draftBody(raw, threadId))));
    },

    async updateDraft(draftId, raw, threadId) {
      const path = `/drafts/${encodeURIComponent(draftId)}`;
      return asDraft(await json(path, body("PUT", draftBody(raw, threadId))));
    },

    async sendMessage(raw, threadId) {
      const payload = threadId === undefined || threadId === "" ? { raw } : { raw, threadId };
      const got = await json("/messages/send", body("POST", payload));
      return got.ok ? { ok: true, value: idPair(got.value) } : got;
    },

    async createLabel(name) {
      const payload = { name, labelListVisibility: "labelShow", messageListVisibility: "show" };
      const got = await json("/labels", body("POST", payload));
      return got.ok ? { ok: true, value: parseLabel(got.value) } : got;
    },

    async modifyThread(id, add, remove) {
      const payload = { addLabelIds: add, removeLabelIds: remove };
      return asNull(await json(`${thread(id)}/modify`, body("POST", payload)));
    },

    async trashThread(id) {
      return asNull(await json(`${thread(id)}/trash`, { method: "POST" }));
    },

    async request(method, path, payload) {
      const init: RequestInit = payload === undefined ? { method } : body(method, payload);
      const sent = await send(`${GMAIL_API}${path}`, init);
      return sent.ok ? { ok: true, value: await sent.value.text() } : sent;
    },
  };
}
