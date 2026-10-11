/**
 * A fake Gmail for the tests: an in-memory mailbox behind a `FakeProvider`,
 * answering the REST calls the extension makes. Threads hold messages with
 * nested multipart bodies, a png and a pdf attachment; drafts are stored.
 */

import type { FakeProvider } from "./fake-api";

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
};

/** Like Gmail's `format=metadata`: the wanted headers, and the MIME parts without their data. */
function metadataPart(part: Json, wanted: string[]): Json {
  const { body, parts, headers, ...rest } = part as {
    body?: Json;
    parts?: Json[];
    headers?: { name: string }[];
  };
  const kept = (headers ?? []).filter((each) => wanted.includes(each.name));
  const { data: _data, ...bodyRest } = body ?? {};
  return {
    ...rest,
    headers: kept,
    body: bodyRest,
    ...(parts === undefined ? {} : { parts: parts.map((each) => metadataPart(each, wanted)) }),
  };
}

function metadataOnly(message: Json, wanted: string[]): Json {
  return { ...message, payload: metadataPart(message["payload"] as Json, wanted) };
}

export function fakeGmail(): FakeGmail {
  const threads = new Map<string, Json[]>([
    ["t1", structuredClone([FIRST, SECOND])],
    ["t2", structuredClone([OTHER])],
  ]);
  const drafts = new Map<string, StoredDraft>();
  const throttle = { status: 429, retryAfter: "0", times: 0 };
  let hits = 0;
  let draftCount = 0;

  const throttled = (): Response | null => {
    if (throttle.times <= 0) return null;
    throttle.times--;
    return new Response("slow down", {
      status: throttle.status,
      headers: { "Retry-After": throttle.retryAfter },
    });
  };

  const provider: FakeProvider = async (request) => {
    hits++;
    const slow = throttled();
    if (slow !== null) return slow;
    const url = new URL(request.url);
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    const routes: [string, RegExp, (found: RegExpExecArray) => Response | Promise<Response>][] = [
      ["GET", /^\/profile$/, () => Response.json({ emailAddress: SELF, historyId: "12" })],
      ["GET", /^\/threads$/, () => listThreads(url)],
      ["GET", /^\/history$/, () => Response.json({ historyId: "12", history: [] })],
      ["GET", /^\/threads\/([^/]+)$/, (found) => readThread(found[1] ?? "", url)],
      [
        "GET",
        /^\/messages\/[^/]+\/attachments\/([^/]+)$/,
        (found) => readAttachment(found[1] ?? ""),
      ],
      ["POST", /^\/drafts$/, () => writeDraft(request, undefined)],
      ["PUT", /^\/drafts\/([^/]+)$/, (found) => writeDraft(request, found[1])],
    ];
    for (const [method, pattern, handle] of routes) {
      const found = method === request.method ? pattern.exec(path) : null;
      if (found) return await handle(found);
    }
    return new Response(`unknown ${request.method} ${path}`, { status: 404 });
  };

  const listThreads = (url: URL): Response => {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const max = Number(url.searchParams.get("maxResults") ?? 100);
    const hit = [...threads.entries()].filter(
      ([, messages]) =>
        q === "" || q.includes(":") || JSON.stringify(messages).toLowerCase().includes(q),
    );
    return Response.json({ threads: hit.slice(0, max).map(([id]) => ({ id })) });
  };

  const readThread = (id: string, url: URL): Response => {
    const messages = threads.get(id);
    if (messages === undefined) return new Response("not found", { status: 404 });
    const wanted = url.searchParams.getAll("metadataHeaders");
    const metadata = url.searchParams.get("format") === "metadata";
    return Response.json({
      id,
      messages: metadata ? messages.map((each) => metadataOnly(each, wanted)) : messages,
    });
  };

  const readAttachment = (id: string): Response => {
    const bytes = ATTACHMENTS[id];
    if (bytes === undefined) return new Response("no attachment", { status: 404 });
    return Response.json({ size: bytes.length, data: b64(bytes) });
  };

  /** POST /drafts creates, PUT /drafts/{id} replaces. */
  const writeDraft = async (request: Request, existing: string | undefined): Promise<Response> => {
    if (existing !== undefined && !drafts.has(existing)) {
      return new Response("no draft", { status: 404 });
    }
    const sent = (await request.json()) as StoredDraft;
    const id = existing ?? `r${++draftCount}`;
    drafts.set(id, { id, message: sent.message });
    return Response.json({ id, message: { id: `dm-${id}`, threadId: sent.message.threadId } });
  };

  return { provider, threads, drafts, throttle, hits: () => hits };
}
