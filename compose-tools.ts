/**
 * The tools that write mail: a new mail, a reply inside a thread, a forward.
 * Each reads what it needs first, then shows the reader exactly the mail on a
 * card, and only then writes. Where prifly has the two-way mail card, the
 * reader chooses there whether it is saved as a draft or sent, whatever the
 * tool is called; an older prifly's confirm card does what the tool's name
 * says.
 */

import type { ExtensionApi, ExtensionTool } from "@prifly/extension-api";
import { finalMail, replyRaw, withEdit } from "./edit";
import { failureText, type GmailClient, type GmailResult, type Sent } from "./gmail";
import type { GmailMessage } from "./gmail-types";
import {
  base64urlBytes,
  buildNew,
  type FileAttachment,
  forwardBody,
  forwardSubject,
  lastSent,
  listForPeople,
  listOrRaw,
  type ReplyEnvelope,
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
  askMail,
  type MailChoice,
  type Session,
  schema,
  text,
  untrimmed,
  withGmail,
} from "./tool-kit";

/** What every compose tool's description ends with: who decides, and that there is no other way. */
const READER_DECIDES =
  "The reader sees the mail on a card and chooses there to save it as a draft or send it now, whatever this tool is called; the answer says which they chose (an older prifly's card only confirms what the tool's name says). Never try another way to send mail.";

/** How the answer opens when the reader chose on the two-way card. */
const SAVED_BY_READER = "The reader saved it as a draft: ";
const SENT_BY_READER = "The reader sent it: ";

/** The answer as is when the tool's name said what to do; else led by what the reader chose. */
const told = (choice: MailChoice, answer: string): string =>
  choice.chosen ? `${choice.kind === "draft" ? SAVED_BY_READER : SENT_BY_READER}${answer}` : answer;

/** A two-way card's summary: the mail and who it is for, its pictures and files, and the two ways. */
const choiceSummary = (mail: string, content: Pick<MailContent, "images" | "files">): string => {
  const extras = extrasText(content);
  return `${mail}${extras === "" ? "" : `,${extras}`}. Save it in Drafts, or send it now.`;
};

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

/** The two-way card's title and summary for a reply, the same from either reply tool. */
const replyChoice = (plan: ReplyPlan, content: MailContent, replace: string) => ({
  title: "Reply in the thread",
  summary: choiceSummary(
    `“${plan.envelope.subject}” to ${listForPeople(plan.envelope.to)}, in the thread${replace === "" ? "" : ` in place of draft ${replace}`}`,
    content,
  ),
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

/** A reply ready to write: its plan, thread, raw mail, content, and the draft it replaces ("" for none). */
type Reply = {
  plan: ReplyPlan;
  threadId: string;
  raw: string;
  content: MailContent;
  replace: string;
};

/**
 * Writes a reply as the reader chose: a draft under the thread's last
 * message (rewriting `replace` when given), or sent in the thread. A draft
 * that is sent is updated first and then sent itself, so it leaves Drafts and
 * goes out once.
 */
async function writeReply(client: GmailClient, reply: Reply, choice: MailChoice): Promise<string> {
  const { plan, threadId, raw, content, replace } = reply;
  if (choice.kind === "send" && replace === "") {
    return await sentAnswer(client, await client.sendMessage(raw, threadId), content, choice);
  }
  const made =
    replace === ""
      ? await client.createDraft(raw, threadId)
      : await client.updateDraft(replace, raw, threadId);
  if (!made.ok) return failureText(made);
  if (choice.kind === "send") {
    return await sentAnswer(client, await client.sendDraft(made.value.id), content, choice);
  }
  const broken = await brokenCopy(
    client,
    "Saved",
    `draft ${made.value.id}`,
    made.value.messageId,
    content,
  );
  return told(
    choice,
    broken ??
      `Draft ${made.value.id} is in the thread “${plan.subject}” in Gmail: open the thread to see it under the last message.`,
  );
}

function draftReplyTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_draft_reply",
    description: `Proposes a reply inside a Gmail thread, threaded under its last message; \`all\` (default true) also keeps everyone else on Cc. Local files can be attached and pictures shown inline (inline_images, each at an [image:name] line of the body); such a draft survives being opened and sent from Gmail's web editor. Pass replace_draft_id to change an earlier draft instead of adding a second (sent, that draft goes out once and leaves Drafts). ${READER_DECIDES}`,
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
  const choice = await askMail(
    api,
    {
      title: replace === "" ? "Write a draft reply" : "Rewrite a draft reply",
      summary: `Draft a reply to “${plan.subject}” for ${listForPeople(plan.envelope.to)}, in the thread${extrasText(content)}. Nothing is sent.`,
      details: mailDetails(envelopeHeaders(plan.envelope), content, body),
      mail: cardMail(replyCard(plan, account, true), content, content.text),
    },
    "draft",
    replyChoice(plan, content, replace),
  );
  if (typeof choice === "string") return choice;
  const final = finalMail(content, plan.envelope.subject, choice);
  if (typeof final === "string") return final;
  const raw = replyRaw(plan.envelope, final);
  return withEdit(
    choice,
    await writeReply(client, { plan, threadId: id, raw, content: final.content, replace }, choice),
  );
}

/** Writes a new mail (not a reply) as the reader chose: a draft in Gmail's Drafts, or sent. */
async function writeNew(
  client: GmailClient,
  raw: string,
  content: MailContent,
  choice: MailChoice,
): Promise<string> {
  if (choice.kind === "send") {
    return await sentAnswer(client, await client.sendMessage(raw), content, choice);
  }
  const made = await client.createDraft(raw);
  if (!made.ok) return failureText(made);
  const what = `draft ${made.value.id}`;
  const broken = await brokenCopy(client, "Saved", what, made.value.messageId, content);
  return told(
    choice,
    broken ??
      `Draft ${made.value.id} is in Gmail's Drafts: open Drafts to see it. Nothing was sent.`,
  );
}

/** The two-way card's title and summary for a new mail, the same from either tool. */
const newChoice = (mail: { to: string; subject: string }, content: MailContent) => ({
  title: "Write an email",
  summary: choiceSummary(`“${mail.subject}” to ${listForPeople(mail.to)}`, content),
});

function newDraftTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_new_draft",
    description: `Proposes a new mail (not a reply). Local files can be attached and pictures shown inline (inline_images, each at an [image:name] line of the body); such a draft survives being opened and sent from Gmail's web editor. ${READER_DECIDES}`,
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
  const choice = await askMail(
    api,
    {
      title: "Write a draft",
      summary: `Draft “${mail.subject}” to ${listForPeople(to)} in Gmail's Drafts${extrasText(content)}. Nothing is sent.`,
      details: mailDetails(newHeaders(mail), content, body),
      mail: cardMail({ account, ...mail, bcc: "", draft: true }, content, content.text),
    },
    "draft",
    newChoice(mail, content),
  );
  if (typeof choice === "string") return choice;
  const final = finalMail(content, mail.subject, choice);
  if (typeof final === "string") return final;
  const { content: out } = final;
  const raw = buildNew({ ...mail, subject: final.subject, body: out.text }, out.files, out.rich);
  return withEdit(choice, await writeNew(client, raw, out, choice));
}

type Outgoing = { to: string; cc: string; bcc: string; subject: string; body: string };

const newHeaders = (mail: Omit<Outgoing, "bcc"> & { bcc?: string }): [string, string][] => [
  ["To", listOrRaw(mail.to)],
  ["Cc", listOrRaw(mail.cc)],
  ["Bcc", listOrRaw(mail.bcc ?? "")],
  ["Subject", mail.subject],
];

function sendTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_send",
    description: `Proposes a new mail (not a reply) to send, with local files attached and pictures shown inline (inline_images, each at an [image:name] line of the body) if given. The card shows the recipients, subject, text, pictures and files. ${READER_DECIDES}`,
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
  const choice = await askMail(
    api,
    {
      title: "Send an email",
      summary: `Send “${mail.subject}” to ${listForPeople(mail.to)}${extrasText(content)}`,
      details: mailDetails(newHeaders(mail), content, mail.body),
      mail: cardMail({ account, ...mail, draft: false }, content, content.text),
    },
    "send",
    newChoice(mail, content),
  );
  if (typeof choice === "string") return choice;
  const final = finalMail(content, mail.subject, choice);
  if (typeof final === "string") return final;
  const { content: out } = final;
  const raw = buildNew({ ...mail, subject: final.subject, body: out.text }, out.files, out.rich);
  return withEdit(choice, await writeNew(client, raw, out, choice));
}

/** The answer for a send: the ids, or the error when Gmail's sent copy lost a picture or file. */
async function sentAnswer(
  client: GmailClient,
  sent: GmailResult<Sent>,
  content: MailContent,
  choice: MailChoice,
): Promise<string> {
  if (!sent.ok) return failureText(sent);
  const what = `message ${sent.value.id} in thread ${sent.value.threadId}`;
  const broken = await brokenCopy(client, "Sent", what, sent.value.id, content);
  if (broken !== null) return told(choice, broken);
  return choice.chosen ? told(choice, `${what}.`) : `Sent: ${what}.`;
}

function replyTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_reply",
    description: `Proposes a reply in a Gmail thread to send, to its last message; \`all\` (default true) keeps everyone else on Cc. Local files are attached and pictures shown inline (inline_images, each at an [image:name] line of the body) if given. The card shows the recipients, subject, text, pictures and files. ${READER_DECIDES}`,
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
  const choice = await askMail(
    api,
    {
      title: "Send a reply",
      summary: `Reply to “${plan.subject}”, sent to ${listForPeople(plan.envelope.to)}${extrasText(content)}`,
      details: mailDetails(envelopeHeaders(plan.envelope), content, body),
      mail: cardMail(replyCard(plan, account, false), content, content.text),
    },
    "send",
    replyChoice(plan, content, ""),
  );
  if (typeof choice === "string") return choice;
  const final = finalMail(content, plan.envelope.subject, choice);
  if (typeof final === "string") return final;
  const raw = replyRaw(plan.envelope, final);
  return withEdit(
    choice,
    await writeReply(
      client,
      { plan, threadId: id, raw, content: final.content, replace: "" },
      choice,
    ),
  );
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
  const note = untrimmed(args, "note");
  const content: MailContent = { text: note, rich: undefined, images: [], files, html: "" };
  const mail: Outgoing = {
    to,
    cc: text(args, "cc"),
    bcc: text(args, "bcc"),
    subject: forwardSubject(readMessage(message.payload).subject),
    body: forwardBody(note, message),
  };
  const choice = await askMail(
    api,
    {
      title: "Forward an email",
      summary: `Forward “${mail.subject}” to ${listForPeople(to)}`,
      details: mailDetails(newHeaders(mail), content, mail.body),
      // The editable text is the note; the forwarded message follows it as it is.
      mail: cardMail({ account, ...mail, draft: false }, content, note),
    },
    "send",
    {
      title: "Forward an email",
      summary: choiceSummary(`“${mail.subject}” to ${listForPeople(to)}`, content),
    },
  );
  if (typeof choice === "string") return choice;
  const final = finalMail(content, mail.subject, choice, true);
  if (typeof final === "string") return final;
  const body = forwardBody(final.content.text, message);
  const raw = buildNew({ ...mail, subject: final.subject, body }, files);
  return withEdit(choice, await writeNew(client, raw, final.content, choice));
}

function forwardTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_forward",
    description: `Proposes forwarding a message of a Gmail thread (its last one, or message_id) with a note on top, its own attachments (unless include_attachments is false) and any local files. The card shows the recipients, subject, text and files. ${READER_DECIDES}`,
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
