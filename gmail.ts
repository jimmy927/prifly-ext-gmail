/**
 * A small Gmail REST client over `api.connections.fetch`: prifly adds the
 * token, so none is kept here. Every method answers a value or a typed
 * failure (the grant ended, or Gmail answered an error status) and never
 * throws for those. There is deliberately no send method.
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
import { headerValue } from "./mime";

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
};

export type Draft = { id: string; threadId: string };

export type HistoryAnswer = {
  historyId: string;
  added: { id: string; threadId: string; labelIds: string[] }[];
};

export type GmailClient = {
  profile(): Promise<GmailResult<{ emailAddress: string; historyId: string }>>;
  searchThreads(q: string, max: number): Promise<GmailResult<ThreadSummary[]>>;
  thread(id: string): Promise<GmailResult<GmailThread>>;
  /** The attachment's bytes, base64url. */
  attachment(messageId: string, attachmentId: string): Promise<GmailResult<string>>;
  history(startHistoryId: string): Promise<GmailResult<HistoryAnswer>>;
  createDraft(raw: string, threadId?: string): Promise<GmailResult<Draft>>;
  updateDraft(draftId: string, raw: string, threadId?: string): Promise<GmailResult<Draft>>;
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
  };
}

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
    return { ok: true, value: (await sent.value.json()) as unknown };
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
    return { ok: true, value: { id: str(draft["id"]), threadId: str(message["threadId"]) } };
  };

  /** Each thread's summary, fetched in small parallel chunks. */
  const summaries = async (ids: string[]): Promise<GmailResult<ThreadSummary[]>> => {
    const meta = new URLSearchParams({ format: "metadata" });
    for (const name of ["From", "Subject", "Date"]) meta.append("metadataHeaders", name);
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

  const draftBody = (raw: string, threadId?: string) => ({
    message: threadId === undefined || threadId === "" ? { raw } : { raw, threadId },
  });

  return {
    async profile() {
      const got = await json("/profile");
      if (!got.ok) return got;
      const data = isRecord(got.value) ? got.value : {};
      return {
        ok: true,
        value: { emailAddress: str(data["emailAddress"]), historyId: str(data["historyId"]) },
      };
    },

    async searchThreads(q, max) {
      const query = new URLSearchParams({ q, maxResults: String(max) });
      const found = await json(`/threads?${query}`);
      if (!found.ok) return found;
      const data = isRecord(found.value) ? found.value : {};
      const ids = list(data["threads"]).map((each) => (isRecord(each) ? str(each["id"]) : ""));
      return await summaries(ids.filter((id) => id !== ""));
    },

    thread: (id) => asThread(id, "format=full"),

    async attachment(messageId, attachmentId) {
      const path = `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
      const got = await json(path);
      if (!got.ok) return got;
      return { ok: true, value: isRecord(got.value) ? str(got.value["data"]) : "" };
    },

    async history(startHistoryId) {
      const query = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded" });
      const got = await json(`/history?${query}`);
      if (!got.ok) return got;
      const data = isRecord(got.value) ? got.value : {};
      const added = list(data["history"])
        .flatMap((entry) => (isRecord(entry) ? list(entry["messagesAdded"]) : []))
        .map((each) => parseMessage(isRecord(each) ? each["message"] : undefined));
      return {
        ok: true,
        value: {
          historyId: str(data["historyId"]),
          added: added.map(({ id, threadId, labelIds }) => ({ id, threadId, labelIds })),
        },
      };
    },

    async createDraft(raw, threadId) {
      return asDraft(await json("/drafts", body("POST", draftBody(raw, threadId))));
    },

    async updateDraft(draftId, raw, threadId) {
      const path = `/drafts/${encodeURIComponent(draftId)}`;
      return asDraft(await json(path, body("PUT", draftBody(raw, threadId))));
    },
  };
}
