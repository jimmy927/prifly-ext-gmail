/**
 * The tools that write mail: drafts (a new one, or a reply inside a thread)
 * and sending (a new mail, a reply in its thread, a forward). Each reads what
 * it needs first, then shows the reader exactly what will be written or sent
 * on a confirm card, and only then writes.
 */

import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { ExtensionApi, ExtensionTool } from "@prifly/extension-api";
import { failureText, type GmailClient } from "./gmail";
import type { GmailMessage } from "./gmail-types";
import {
  base64urlBytes,
  buildNew,
  type FileAttachment,
  forwardBody,
  forwardSubject,
  lastSent,
  listOrRaw,
  type ReplyEnvelope,
  rawReply,
  readMessage,
  replyEnvelope,
} from "./mime";
import {
  type Args,
  confirmFirst,
  type Session,
  schema,
  strings,
  text,
  untrimmed,
  withGmail,
} from "./tool-kit";

/** Gmail's own limit for what a mail carries. */
const MAX_ATTACHED_BYTES = 25 * 1024 * 1024;

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const ATTACHMENTS_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: "Absolute paths of local files to attach.",
};

function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

/** The local files to attach, read now, or why they cannot be. */
async function localFiles(paths: string[]): Promise<FileAttachment[] | string> {
  const files: FileAttachment[] = [];
  for (const path of paths) {
    if (!isAbsolute(path)) return `Not done: ${path} is not an absolute path.`;
    try {
      const bytes = new Uint8Array(await readFile(path));
      const mimeType = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
      files.push({ filename: basename(path), mimeType, bytes });
    } catch (error) {
      return `Not done: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return files;
}

function tooBig(files: FileAttachment[]): string | null {
  const total = files.reduce((sum, each) => sum + each.bytes.length, 0);
  return total > MAX_ATTACHED_BYTES
    ? `Not done: the attachments come to ${size(total)}, over Gmail's 25 MB.`
    : null;
}

/** `more` and the local files `attachments` names, read now, or why they cannot go. */
async function filesFor(
  args: Args,
  more: FileAttachment[] = [],
): Promise<FileAttachment[] | string> {
  const local = await localFiles(strings(args, "attachments"));
  if (typeof local === "string") return local;
  const files = [...more, ...local];
  return tooBig(files) ?? files;
}

/** What a confirm card shows of a mail: its headers, its files, then its text as written. */
function mailDetails(headers: [string, string][], files: FileAttachment[], body: string): string {
  const lines = headers
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}: ${value}`);
  if (files.length > 0) {
    lines.push(
      "Attachments:",
      ...files.map((each) => `- ${each.filename} (${size(each.bytes.length)})`),
    );
  }
  return [...lines, "", body].join("\n");
}

const envelopeHeaders = (envelope: ReplyEnvelope): [string, string][] => [
  ["To", envelope.to],
  ["Cc", envelope.cc],
  ["Subject", envelope.subject],
];

type ReplyPlan = { envelope: ReplyEnvelope; subject: string };

/** Reads the thread and works out who a reply goes to, or why it cannot be answered. */
async function planReply(
  client: GmailClient,
  account: string,
  threadId: string,
  all: boolean,
): Promise<ReplyPlan | string> {
  const got = await client.thread(threadId);
  if (!got.ok) return failureText(got);
  const envelope = replyEnvelope({ messages: got.value.messages, self: account, all });
  if (envelope === null) return "The thread has no sent message to reply to.";
  const first = got.value.messages[0];
  return { envelope, subject: first === undefined ? "" : readMessage(first.payload).subject };
}

function draftReplyTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_draft_reply",
    description:
      "Writes a draft reply inside a Gmail thread, threaded under its last message; `all` (default true) also keeps everyone else on Cc. Pass replace_draft_id to change an earlier draft instead of adding a second. The reader confirms on a card first; nothing is sent.",
    inputSchema: schema(
      {
        thread_id: { type: "string" },
        body: { type: "string", description: "The reply's plain text." },
        all: { type: "boolean", description: "Reply to everyone (default true)." },
        replace_draft_id: { type: "string", description: "A draft to rewrite in place." },
      },
      ["thread_id", "body"],
    ),
    call: (args) => withGmail(getApi(), args, (session) => draftReply(args, session)),
  };
}

async function draftReply(args: Args, { api, client, account }: Session): Promise<string> {
  const id = text(args, "thread_id");
  const body = untrimmed(args, "body");
  if (id === "" || body.trim() === "") return "thread_id and body are required.";
  const plan = await planReply(client, account, id, args["all"] !== false);
  if (typeof plan === "string") return plan;
  const replace = text(args, "replace_draft_id");
  const refused = await confirmFirst(api, {
    title: replace === "" ? "Write a draft reply" : "Rewrite a draft reply",
    summary: `Draft a reply to “${plan.subject}” for ${plan.envelope.to}, in the thread. Nothing is sent.`,
    details: mailDetails(envelopeHeaders(plan.envelope), [], body),
  });
  if (refused !== null) return refused;
  const raw = rawReply(plan.envelope, body);
  const made =
    replace === "" ? await client.createDraft(raw, id) : await client.updateDraft(replace, raw, id);
  if (!made.ok) return failureText(made);
  return `Draft ${made.value.id} is in the thread “${plan.subject}” in Gmail: open the thread to see it under the last message.`;
}

function newDraftTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_new_draft",
    description:
      "Writes a new draft mail (not a reply) in Gmail's Drafts. The reader confirms on a card first; nothing is sent.",
    inputSchema: schema(
      {
        to: { type: "string", description: "Addresses, separated by commas." },
        cc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text." },
      },
      ["to", "subject", "body"],
    ),
    call: (args) =>
      withGmail(getApi(), args, async ({ api, client }) => {
        const to = text(args, "to");
        const body = untrimmed(args, "body");
        if (to === "" || body.trim() === "") return "to and body are required.";
        const mail = { to, cc: text(args, "cc"), subject: text(args, "subject"), body };
        const refused = await confirmFirst(api, {
          title: "Write a draft",
          summary: `Draft “${mail.subject}” to ${listOrRaw(to)} in Gmail's Drafts. Nothing is sent.`,
          details: mailDetails(newHeaders(mail), [], body),
        });
        if (refused !== null) return refused;
        const made = await client.createDraft(buildNew(mail));
        if (!made.ok) return failureText(made);
        return `Draft ${made.value.id} is in Gmail's Drafts: open Drafts to see it. Nothing was sent.`;
      }),
  };
}

type Outgoing = { to: string; cc: string; bcc: string; subject: string; body: string };

const newHeaders = (mail: Omit<Outgoing, "bcc"> & { bcc?: string }): [string, string][] => [
  ["To", listOrRaw(mail.to)],
  ["Cc", listOrRaw(mail.cc)],
  ["Bcc", listOrRaw(mail.bcc ?? "")],
  ["Subject", mail.subject],
];

const sentText = (id: string, threadId: string): string =>
  `Sent: message ${id} in thread ${threadId}.`;

function sendTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_send",
    description:
      "Sends a new mail (not a reply), with local files attached if given. The reader confirms on a card showing the recipients, subject, text and files first.",
    inputSchema: schema(
      {
        to: { type: "string", description: "Addresses, separated by commas." },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text." },
        attachments: ATTACHMENTS_PROPERTY,
      },
      ["to", "subject", "body"],
    ),
    call: (args) => withGmail(getApi(), args, (session) => sendNew(args, session)),
  };
}

async function sendNew(args: Args, { api, client }: Session): Promise<string> {
  const mail: Outgoing = {
    to: text(args, "to"),
    cc: text(args, "cc"),
    bcc: text(args, "bcc"),
    subject: text(args, "subject"),
    body: untrimmed(args, "body"),
  };
  if (mail.to === "" || mail.body.trim() === "") return "to and body are required.";
  const files = await filesFor(args);
  if (typeof files === "string") return files;
  const refused = await confirmFirst(api, {
    title: "Send an email",
    summary: `Send “${mail.subject}” to ${listOrRaw(mail.to)}`,
    details: mailDetails(newHeaders(mail), files, mail.body),
  });
  if (refused !== null) return refused;
  const sent = await client.sendMessage(buildNew(mail, files));
  return sent.ok ? sentText(sent.value.id, sent.value.threadId) : failureText(sent);
}

function replyTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_reply",
    description:
      "Sends a reply in a Gmail thread, to its last message; `all` (default true) keeps everyone else on Cc. Local files are attached if given. The reader confirms on a card showing the recipients, subject, text and files first.",
    inputSchema: schema(
      {
        thread_id: { type: "string" },
        body: { type: "string", description: "The reply's plain text." },
        all: { type: "boolean", description: "Reply to everyone (default true)." },
        attachments: ATTACHMENTS_PROPERTY,
      },
      ["thread_id", "body"],
    ),
    call: (args) => withGmail(getApi(), args, (session) => sendReply(args, session)),
  };
}

async function sendReply(args: Args, { api, client, account }: Session): Promise<string> {
  const id = text(args, "thread_id");
  const body = untrimmed(args, "body");
  if (id === "" || body.trim() === "") return "thread_id and body are required.";
  const files = await filesFor(args);
  if (typeof files === "string") return files;
  const plan = await planReply(client, account, id, args["all"] !== false);
  if (typeof plan === "string") return plan;
  const refused = await confirmFirst(api, {
    title: "Send a reply",
    summary: `Reply to “${plan.subject}”, sent to ${plan.envelope.to}`,
    details: mailDetails(envelopeHeaders(plan.envelope), files, body),
  });
  if (refused !== null) return refused;
  const sent = await client.sendMessage(rawReply(plan.envelope, body, files), id);
  return sent.ok ? sentText(sent.value.id, sent.value.threadId) : failureText(sent);
}

/** The message to forward: the one asked for, else the thread's last sent one. */
function pickMessage(messages: GmailMessage[], messageId: string): GmailMessage | null {
  if (messageId === "") return lastSent(messages);
  return messages.find((each) => each.id === messageId) ?? null;
}

/** The forwarded message's own attachments, fetched, or why one could not be. */
async function originalFiles(
  client: GmailClient,
  message: GmailMessage,
): Promise<FileAttachment[] | string> {
  const files: FileAttachment[] = [];
  for (const each of readMessage(message.payload).attachments) {
    if (each.attachmentId === "") continue;
    const got = await client.attachment(message.id, each.attachmentId);
    if (!got.ok) return failureText(got);
    files.push({
      filename: each.filename,
      mimeType: each.mimeType,
      bytes: base64urlBytes(got.value),
    });
  }
  return files;
}

async function forward(args: Args, api: ExtensionApi, client: GmailClient): Promise<string> {
  const id = text(args, "thread_id");
  const to = text(args, "to");
  if (id === "" || to === "") return "thread_id and to are required.";
  const got = await client.thread(id);
  if (!got.ok) return failureText(got);
  const message = pickMessage(got.value.messages, text(args, "message_id"));
  if (message === null) return "There is no such message in the thread to forward.";
  const own = args["include_attachments"] === false ? [] : await originalFiles(client, message);
  if (typeof own === "string") return own;
  const files = await filesFor(args, own);
  if (typeof files === "string") return files;
  const mail: Outgoing = {
    to,
    cc: text(args, "cc"),
    bcc: text(args, "bcc"),
    subject: forwardSubject(readMessage(message.payload).subject),
    body: forwardBody(untrimmed(args, "note"), message),
  };
  const refused = await confirmFirst(api, {
    title: "Forward an email",
    summary: `Forward “${mail.subject}” to ${listOrRaw(to)}`,
    details: mailDetails(newHeaders(mail), files, mail.body),
  });
  if (refused !== null) return refused;
  const sent = await client.sendMessage(buildNew(mail, files));
  return sent.ok ? sentText(sent.value.id, sent.value.threadId) : failureText(sent);
}

function forwardTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_forward",
    description:
      "Forwards a message of a Gmail thread (its last one, or message_id) with a note on top, its own attachments (unless include_attachments is false) and any local files. The reader confirms on a card showing the recipients, subject, text and files first.",
    inputSchema: schema(
      {
        thread_id: { type: "string" },
        message_id: { type: "string", description: "Left out: the thread's last message." },
        to: { type: "string", description: "Addresses, separated by commas." },
        cc: { type: "string" },
        bcc: { type: "string" },
        note: { type: "string", description: "Plain text above the forwarded message." },
        include_attachments: {
          type: "boolean",
          description: "Forward the message's own attachments (default true).",
        },
        attachments: ATTACHMENTS_PROPERTY,
      },
      ["thread_id", "to"],
    ),
    call: (args) => withGmail(getApi(), args, ({ api, client }) => forward(args, api, client)),
  };
}

export function composeTools(getApi: () => ExtensionApi | null): ExtensionTool[] {
  return [
    draftReplyTool(getApi),
    newDraftTool(getApi),
    sendTool(getApi),
    replyTool(getApi),
    forwardTool(getApi),
  ];
}
