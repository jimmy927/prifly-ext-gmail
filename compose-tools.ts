/**
 * The tools that write mail: drafts (a new one, or a reply inside a thread)
 * and sending (a new mail, a reply in its thread, a forward). Each reads what
 * it needs first, then shows the reader exactly what will be written or sent
 * on a confirm card, and only then writes.
 */

import type { ExtensionApi, ExtensionTool } from "@prifly/extension-api";
import { failureText, type GmailClient, type GmailResult, type Sent } from "./gmail";
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
  ATTACHMENTS_PROPERTY,
  brokenCopy,
  cardMail,
  extrasText,
  filesFor,
  HTML_PROPERTY,
  INLINE_IMAGES_PROPERTY,
  type MailContent,
  type MailEnvelope,
  mailContent,
  mailDetails,
} from "./outgoing";
import {
  type Args,
  confirmFirst,
  type Session,
  schema,
  text,
  untrimmed,
  withGmail,
} from "./tool-kit";

const envelopeHeaders = (envelope: ReplyEnvelope): [string, string][] => [
  ["To", envelope.to],
  ["Cc", envelope.cc],
  ["Subject", envelope.subject],
];

type ReplyPlan = { envelope: ReplyEnvelope; subject: string };

/** The card's envelope for a reply: the plan's recipients and the subject it goes out with. */
const replyCard = (plan: ReplyPlan, account: string, draft: boolean): MailEnvelope => ({
  account,
  to: plan.envelope.to,
  cc: plan.envelope.cc,
  bcc: "",
  subject: plan.envelope.subject,
  draft,
});

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
      "Writes a draft reply inside a Gmail thread, threaded under its last message; `all` (default true) also keeps everyone else on Cc. Local files can be attached and pictures shown inline (inline_images, each at an [image:name] line of the body); such a draft survives being opened and sent from Gmail's web editor. Pass replace_draft_id to change an earlier draft instead of adding a second. The reader confirms on a card first; nothing is sent.",
    inputSchema: schema(
      {
        thread_id: { type: "string" },
        body: { type: "string", description: "The reply's plain text." },
        html: HTML_PROPERTY,
        inline_images: INLINE_IMAGES_PROPERTY,
        attachments: ATTACHMENTS_PROPERTY,
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
  const content = await mailContent(args, body);
  if (typeof content === "string") return content;
  const plan = await planReply(client, account, id, args["all"] !== false);
  if (typeof plan === "string") return plan;
  const replace = text(args, "replace_draft_id");
  const refused = await confirmFirst(api, {
    title: replace === "" ? "Write a draft reply" : "Rewrite a draft reply",
    summary: `Draft a reply to “${plan.subject}” for ${plan.envelope.to}, in the thread${extrasText(content)}. Nothing is sent.`,
    details: mailDetails(envelopeHeaders(plan.envelope), content, body),
    mail: cardMail(replyCard(plan, account, true), content, content.text),
  });
  if (refused !== null) return refused;
  const raw = rawReply(plan.envelope, content.text, content.files, content.rich);
  const made =
    replace === "" ? await client.createDraft(raw, id) : await client.updateDraft(replace, raw, id);
  if (!made.ok) return failureText(made);
  const broken = await brokenCopy(
    client,
    "Saved",
    `draft ${made.value.id}`,
    made.value.messageId,
    content,
  );
  if (broken !== null) return broken;
  return `Draft ${made.value.id} is in the thread “${plan.subject}” in Gmail: open the thread to see it under the last message.`;
}

function newDraftTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_new_draft",
    description:
      "Writes a new draft mail (not a reply) in Gmail's Drafts. Local files can be attached and pictures shown inline (inline_images, each at an [image:name] line of the body); such a draft survives being opened and sent from Gmail's web editor. The reader confirms on a card first; nothing is sent.",
    inputSchema: schema(
      {
        to: { type: "string", description: "Addresses, separated by commas." },
        cc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text." },
        html: HTML_PROPERTY,
        inline_images: INLINE_IMAGES_PROPERTY,
        attachments: ATTACHMENTS_PROPERTY,
      },
      ["to", "subject", "body"],
    ),
    call: (args) => withGmail(getApi(), args, (session) => newDraft(args, session)),
  };
}

async function newDraft(args: Args, { api, client, account }: Session): Promise<string> {
  const to = text(args, "to");
  const body = untrimmed(args, "body");
  if (to === "" || body.trim() === "") return "to and body are required.";
  const content = await mailContent(args, body);
  if (typeof content === "string") return content;
  const mail = { to, cc: text(args, "cc"), subject: text(args, "subject"), body: content.text };
  const refused = await confirmFirst(api, {
    title: "Write a draft",
    summary: `Draft “${mail.subject}” to ${listOrRaw(to)} in Gmail's Drafts${extrasText(content)}. Nothing is sent.`,
    details: mailDetails(newHeaders(mail), content, body),
    mail: cardMail({ account, ...mail, bcc: "", draft: true }, content, content.text),
  });
  if (refused !== null) return refused;
  const made = await client.createDraft(buildNew(mail, content.files, content.rich));
  if (!made.ok) return failureText(made);
  const what = `draft ${made.value.id}`;
  const broken = await brokenCopy(client, "Saved", what, made.value.messageId, content);
  if (broken !== null) return broken;
  return `Draft ${made.value.id} is in Gmail's Drafts: open Drafts to see it. Nothing was sent.`;
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
      "Sends a new mail (not a reply), with local files attached and pictures shown inline (inline_images, each at an [image:name] line of the body) if given. The reader confirms on a card showing the recipients, subject, text, pictures and files first.",
    inputSchema: schema(
      {
        to: { type: "string", description: "Addresses, separated by commas." },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text." },
        html: HTML_PROPERTY,
        inline_images: INLINE_IMAGES_PROPERTY,
        attachments: ATTACHMENTS_PROPERTY,
      },
      ["to", "subject", "body"],
    ),
    call: (args) => withGmail(getApi(), args, (session) => sendNew(args, session)),
  };
}

async function sendNew(args: Args, { api, client, account }: Session): Promise<string> {
  const mail: Outgoing = {
    to: text(args, "to"),
    cc: text(args, "cc"),
    bcc: text(args, "bcc"),
    subject: text(args, "subject"),
    body: untrimmed(args, "body"),
  };
  if (mail.to === "" || mail.body.trim() === "") return "to and body are required.";
  const content = await mailContent(args, mail.body);
  if (typeof content === "string") return content;
  const refused = await confirmFirst(api, {
    title: "Send an email",
    summary: `Send “${mail.subject}” to ${listOrRaw(mail.to)}${extrasText(content)}`,
    details: mailDetails(newHeaders(mail), content, mail.body),
    mail: cardMail({ account, ...mail, draft: false }, content, content.text),
  });
  if (refused !== null) return refused;
  const sent = await client.sendMessage(
    buildNew({ ...mail, body: content.text }, content.files, content.rich),
  );
  return await sentAnswer(client, sent, content);
}

/** The answer for a send: the ids, or the error when Gmail's sent copy lost a picture or file. */
async function sentAnswer(
  client: GmailClient,
  sent: GmailResult<Sent>,
  content: MailContent,
): Promise<string> {
  if (!sent.ok) return failureText(sent);
  const what = `message ${sent.value.id} in thread ${sent.value.threadId}`;
  const broken = await brokenCopy(client, "Sent", what, sent.value.id, content);
  return broken ?? sentText(sent.value.id, sent.value.threadId);
}

function replyTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_reply",
    description:
      "Sends a reply in a Gmail thread, to its last message; `all` (default true) keeps everyone else on Cc. Local files are attached and pictures shown inline (inline_images, each at an [image:name] line of the body) if given. The reader confirms on a card showing the recipients, subject, text, pictures and files first.",
    inputSchema: schema(
      {
        thread_id: { type: "string" },
        body: { type: "string", description: "The reply's plain text." },
        html: HTML_PROPERTY,
        inline_images: INLINE_IMAGES_PROPERTY,
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
  const content = await mailContent(args, body);
  if (typeof content === "string") return content;
  const plan = await planReply(client, account, id, args["all"] !== false);
  if (typeof plan === "string") return plan;
  const refused = await confirmFirst(api, {
    title: "Send a reply",
    summary: `Reply to “${plan.subject}”, sent to ${plan.envelope.to}${extrasText(content)}`,
    details: mailDetails(envelopeHeaders(plan.envelope), content, body),
    mail: cardMail(replyCard(plan, account, false), content, content.text),
  });
  if (refused !== null) return refused;
  const raw = rawReply(plan.envelope, content.text, content.files, content.rich);
  return await sentAnswer(client, await client.sendMessage(raw, id), content);
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

async function forward(args: Args, { api, client, account }: Session): Promise<string> {
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
  const content: MailContent = { text: "", rich: undefined, images: [], files, html: "" };
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
    details: mailDetails(newHeaders(mail), content, mail.body),
    mail: cardMail({ account, ...mail, draft: false }, content, mail.body),
  });
  if (refused !== null) return refused;
  return await sentAnswer(client, await client.sendMessage(buildNew(mail, files)), content);
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
    call: (args) => withGmail(getApi(), args, (session) => forward(args, session)),
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
