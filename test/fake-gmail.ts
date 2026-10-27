/**
 * A fake Gmail for the tests: an in-memory mailbox behind a `FakeProvider`,
 * answering the REST calls the extension makes. Threads hold messages with
 * nested multipart bodies, a png and a pdf attachment; drafts, sent mail,
 * labels and the trash are kept to look at.
 */

import type { FakeProvider } from "./fake-api";
import { parseRaw, withoutFiles } from "./parse-raw";

export const b64 = (data: string | Uint8Array): string => Buffer.from(data).toString("base64url");

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
export const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n% fake invoice\n%%EOF\n");

type Json = Record<string, unknown>;

export const SELF = "jimmy@example.com";

const headers = (values: Record<string, string>) =>
  Object.entries(values).map(([name, value]) => ({ name, value }));

const textPart = (mimeType: string, text: string) => ({
  partId: "0",
  mimeType,
  filename: "",
  body: { size: text.length, data: b64(text) },
});

const attachmentPart = (filename: string, mimeType: string, id: string, size: number) => ({
  partId: id,
  mimeType,
  filename,
  body: { size, attachmentId: id },
});

/** Ada's first mail: multipart/mixed holding multipart/alternative, a png and a pdf. */
const FIRST = {
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX", "UNREAD"],
  historyId: "10",
  payload: {
    mimeType: "multipart/mixed",
    headers: headers({
      From: "Ada Lovelace <ada@example.com>",
      To: `Jimmy <${SELF}>, Bob <bob@example.com>`,
      Cc: "carol@example.com",
      Date: "Mon, 5 Oct 2026 09:00:00 +0200",
      Subject: "Plans för Tuesday",
      "Message-ID": "<m1@example.com>",
    }),
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          textPart("text/plain", "Hello Jimmy,\nCan we meet Tuesday? Café at 10."),
          textPart("text/html", "<p>Hello Jimmy,</p><p>Can we meet Tuesday?</p>"),
        ],
      },
      attachmentPart("logo.png", "image/png", "att-png", PNG_BYTES.length),
      attachmentPart("invoice.pdf", "application/pdf", "att-pdf", PDF_BYTES.length),
    ],
  },
};

/** Bob's answer, an HTML-only mail. */
const SECOND = {
  id: "m2",
  threadId: "t1",
  labelIds: ["INBOX"],
  historyId: "11",
  payload: {
    mimeType: "multipart/alternative",
    headers: headers({
      From: "Bob <bob@example.com>",
      To: "Ada Lovelace <ada@example.com>, Jimmy <jimmy@example.com>",
      Cc: "carol@example.com",
      Date: "Mon, 5 Oct 2026 10:30:00 +0200",
      Subject: "Re: Plans för Tuesday",
      "Message-ID": "<m2@example.com>",
      References: "<m1@example.com>",
    }),
    parts: [textPart("text/html", "<div>Works for me.<br>Bob &amp; co</div>")],
  },
};

const OTHER = {
  id: "m3",
  threadId: "t2",
  labelIds: ["INBOX"],
  historyId: "12",
  payload: {
    mimeType: "text/plain",
    headers: headers({
      From: "Dana <dana@example.com>",
      To: SELF,
      Date: "Tue, 6 Oct 2026 08:00:00 +0200",
      Subject: "Invoice question",
      "Message-ID": "<m3@example.com>",
    }),
    body: textPart("text/plain", "Is the invoice paid?").body,
  },
};

export const ATTACHMENTS: Record<string, Uint8Array> = {
  "att-png": PNG_BYTES,
  "att-pdf": PDF_BYTES,
};

export type StoredDraft = { id: string; message: { raw: string; threadId?: string } };

export type FakeGmail = {
  provider: FakeProvider;
  threads: Map<string, Json[]>;
  drafts: Map<string, StoredDraft>;
  /** Answer the next `times` calls with `status` and a `Retry-After` header first. */
  throttle: { status: number; retryAfter: string; times: number };
  /** How many requests the fake got, throttled ones included. */
  hits: () => number;
  /** Every mail sent through /messages/send or /drafts/send, in order. */
  sent: { raw: string; threadId?: string }[];
  /** The ids of the drafts sent through /drafts/send, in order. */
  draftsSent: string[];
  /** Every draft message and sent mail by message id, as raw, to read back with `format=full`. */
  messages: Map<string, { raw: string; threadId: string }>;
  /** While `on`, a stored mail reads back without its pictures and files, as if Gmail dropped them. */
  loseFiles: { on: boolean };
  /** The labels by id, system ones included. */
  labels: Map<string, { id: string; name: string; type: string }>;
  /** Threads moved to the trash, in order. */
  trashed: string[];
};

/**
 * Like Gmail's `format=metadata`: the id, labels and the wanted headers, and never `payload.parts`
 * or any body data (https://developers.google.com/workspace/gmail/api/reference/rest/v1/Format).
 */
function metadataOnly(message: Json, wanted: string[]): Json {
  const payload = message["payload"] as { headers?: { name: string }[]; body?: Json } & Json;
  const { parts: _parts, body, headers, ...rest } = payload;
  const { data: _data, attachmentId: _attachment, ...size } = (body ?? {}) as Json;
  return {
    ...message,
    payload: {
      ...rest,
      headers: (headers ?? []).filter((each) => wanted.includes(each.name)),
      body: size,
    },
  };
}

/** Whether a message payload has a part with a file name, as Gmail's `has:attachment` sees it. */
const hasFile = (part: Json): boolean =>
  (typeof part["filename"] === "string" && part["filename"] !== "") ||
  ((part["parts"] as Json[] | undefined) ?? []).some(hasFile);

const SYSTEM_LABELS = ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "TRASH"];

/** The system labels, and one of the reader's own: Work. */
function startLabels(): FakeGmail["labels"] {
  const labels: FakeGmail["labels"] = new Map();
  for (const id of SYSTEM_LABELS) labels.set(id, { id, name: id, type: "system" });
  labels.set("Label_1", { id: "Label_1", name: "Work", type: "user" });
  return labels;
}

const labelsOf = (message: Json): string[] => message["labelIds"] as string[];

/** The throttled answer while `throttle.times` lasts, counting it down; null after. */
function throttled(throttle: FakeGmail["throttle"]): Response | null {
  if (throttle.times <= 0) return null;
  throttle.times--;
  return new Response("slow down", {
    status: throttle.status,
    headers: { "Retry-After": throttle.retryAfter },
  });
}

const readAttachment = (id: string): Response => {
  const bytes = ATTACHMENTS[id];
  if (bytes === undefined) return new Response("no attachment", { status: 404 });
  return Response.json({ size: bytes.length, data: b64(bytes) });
};

/** A stored draft message or sent mail, parsed from its raw like Gmail's `format=full`. */
function storedMessage(messages: FakeGmail["messages"], id: string, lose: boolean): Response {
  const stored = messages.get(id);
  if (stored === undefined) return new Response("not found", { status: 404 });
  const payload = parseRaw(stored.raw);
  const shown = lose ? withoutFiles(payload) : payload;
  return Response.json({ id, threadId: stored.threadId, labelIds: [], payload: shown });
}

type Outgoing = { raw: string; threadId?: string };

/** POST /drafts/send: the draft as saved goes out through `send` and leaves Drafts. */
async function sendDraft(
  request: Request,
  drafts: FakeGmail["drafts"],
  draftsSent: string[],
  send: (message: Outgoing) => Response,
): Promise<Response> {
  const { id } = (await request.json()) as { id: string };
  const draft = drafts.get(id);
  if (draft === undefined) return new Response("no draft", { status: 404 });
  drafts.delete(id);
  draftsSent.push(id);
  return send(draft.message);
}

function readThread(threads: Map<string, Json[]>, id: string, url: URL): Response {
  const messages = threads.get(id);
  if (messages === undefined) return new Response("not found", { status: 404 });
  const wanted = url.searchParams.getAll("metadataHeaders");
  const metadata = url.searchParams.get("format") === "metadata";
  return Response.json({
    id,
    messages: metadata ? messages.map((each) => metadataOnly(each, wanted)) : messages,
  });
}

export function fakeGmail(): FakeGmail {
  const threads = new Map<string, Json[]>([
    ["t1", structuredClone([FIRST, SECOND])],
    ["t2", structuredClone([OTHER])],
  ]);
  const drafts = new Map<string, StoredDraft>();
  const sent: FakeGmail["sent"] = [];
  const draftsSent: string[] = [];
  const messages: FakeGmail["messages"] = new Map();
  const loseFiles = { on: false };
  const trashed: string[] = [];
  const labels = startLabels();
  const throttle = { status: 429, retryAfter: "0", times: 0 };
  let hits = 0;
  let draftCount = 0;
  let sentCount = 0;

  const provider: FakeProvider = async (request) => {
    hits++;
    const slow = throttled(throttle);
    if (slow !== null) return slow;
    const url = new URL(request.url);
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    const routes: [string, RegExp, (found: RegExpExecArray) => Response | Promise<Response>][] = [
      ["GET", /^\/profile$/, () => Response.json({ emailAddress: SELF, historyId: "12" })],
      ["GET", /^\/threads$/, () => listThreads(url)],
      ["GET", /^\/threads\/([^/]+)$/, (found) => readThread(threads, found[1] ?? "", url)],
      [
        "GET",
        /^\/messages\/[^/]+\/attachments\/([^/]+)$/,
        (found) => readAttachment(found[1] ?? ""),
      ],
      [
        "GET",
        /^\/messages\/([^/]+)$/,
        (found) => storedMessage(messages, found[1] ?? "", loseFiles.on),
      ],
      ["GET", /^\/labels$/, () => Response.json({ labels: [...labels.values()] })],
      ["GET", /^\/labels\/([^/]+)$/, (found) => readLabel(found[1] ?? "")],
      ["POST", /^\/labels$/, () => createLabel(request)],
      ["POST", /^\/drafts$/, () => writeDraft(request, undefined)],
      ["PUT", /^\/drafts\/([^/]+)$/, (found) => writeDraft(request, found[1])],
      ["POST", /^\/messages\/send$/, () => sendMessage(request)],
      ["POST", /^\/drafts\/send$/, () => sendDraft(request, drafts, draftsSent, sendStored)],
      ["POST", /^\/threads\/([^/]+)\/modify$/, (found) => modifyThread(found[1] ?? "", request)],
      ["POST", /^\/threads\/([^/]+)\/trash$/, (found) => trashThread(found[1] ?? "")],
    ];
    for (const [method, pattern, handle] of routes) {
      const found = method === request.method ? pattern.exec(path) : null;
      if (found) return await handle(found);
    }
    return new Response(`unknown ${request.method} ${path}`, { status: 404 });
  };

  /** `has:attachment` keeps the threads with a file in them; the rest is matched as before. */
  const listThreads = (url: URL): Response => {
    const asked = (url.searchParams.get("q") ?? "").toLowerCase();
    const attachment = asked.includes("has:attachment");
    const q = asked.replace("has:attachment", "").trim();
    const max = Number(url.searchParams.get("maxResults") ?? 100);
    const hit = [...threads.entries()].filter(
      ([, messages]) =>
        (!attachment || messages.some((each) => hasFile(each["payload"] as Json))) &&
        (q === "" || q.includes(":") || JSON.stringify(messages).toLowerCase().includes(q)),
    );
    return Response.json({ threads: hit.slice(0, max).map(([id]) => ({ id })) });
  };

  /** A label with its counts: a thread counts as unread when one of its messages is. */
  const readLabel = (id: string): Response => {
    const label = labels.get(id);
    if (label === undefined) return new Response("no label", { status: 404 });
    const holding = [...threads.values()].filter((messages) =>
      messages.some((each) => labelsOf(each).includes(id)),
    );
    const unread = holding.filter((messages) =>
      messages.some((each) => labelsOf(each).includes("UNREAD")),
    );
    return Response.json({ ...label, threadsTotal: holding.length, threadsUnread: unread.length });
  };

  const createLabel = async (request: Request): Promise<Response> => {
    const { name } = (await request.json()) as { name: string };
    const id = `Label_${labels.size}`;
    labels.set(id, { id, name, type: "user" });
    return Response.json(labels.get(id));
  };

  const sendMessage = async (request: Request): Promise<Response> =>
    sendStored((await request.json()) as Outgoing);

  const sendStored = (message: Outgoing): Response => {
    sent.push(message);
    const id = `s${++sentCount}`;
    const threadId = message.threadId ?? `ts${sentCount}`;
    messages.set(id, { raw: message.raw, threadId });
    return Response.json({ id, threadId, labelIds: ["SENT"] });
  };

  const modifyThread = async (id: string, request: Request): Promise<Response> => {
    const messages = threads.get(id);
    if (messages === undefined) return new Response("not found", { status: 404 });
    const change = (await request.json()) as { addLabelIds: string[]; removeLabelIds: string[] };
    for (const message of messages) {
      const kept = labelsOf(message).filter((each) => !change.removeLabelIds.includes(each));
      message["labelIds"] = [...new Set([...kept, ...change.addLabelIds])];
    }
    return Response.json({ id });
  };

  const trashThread = (id: string): Response => {
    const messages = threads.get(id);
    if (messages === undefined) return new Response("not found", { status: 404 });
    trashed.push(id);
    for (const message of messages) message["labelIds"] = [...labelsOf(message), "TRASH"];
    return Response.json({ id });
  };

  /** POST /drafts creates, PUT /drafts/{id} replaces. */
  const writeDraft = async (request: Request, existing: string | undefined): Promise<Response> => {
    if (existing !== undefined && !drafts.has(existing)) {
      return new Response("no draft", { status: 404 });
    }
    const sent = (await request.json()) as StoredDraft;
    const id = existing ?? `r${++draftCount}`;
    drafts.set(id, { id, message: sent.message });
    messages.set(`dm-${id}`, { raw: sent.message.raw, threadId: sent.message.threadId ?? "" });
    return Response.json({ id, message: { id: `dm-${id}`, threadId: sent.message.threadId } });
  };

  return {
    provider,
    threads,
    drafts,
    throttle,
    hits: () => hits,
    sent,
    draftsSent,
    messages,
    loseFiles,
    labels,
    trashed,
  };
}
