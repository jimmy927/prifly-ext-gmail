/**
 * Pure functions over Gmail's message payloads and RFC 822: read a message
 * into text and attachments, and build the raw text of a reply, a new mail or
 * a forward, with files attached when there are any.
 */

import type { GmailMessage, Header, Part } from "./gmail-types";

export type AttachmentInfo = {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  partId: string;
};

export type ReadMessage = {
  from: string;
  to: string;
  cc: string;
  date: string;
  subject: string;
  messageId: string;
  references: string;
  replyTo: string;
  text: string;
  attachments: AttachmentInfo[];
};

/** Decodes Gmail's base64url (padding optional) to bytes. */
export function base64urlBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64url"));
}

export function decodeBase64url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

export function encodeBase64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** The first header called `name` (case-insensitive), or "". */
export function headerValue(headers: Header[], name: string): string {
  const wanted = name.toLowerCase();
  return headers.find((each) => each.name.toLowerCase() === wanted)?.value ?? "";
}

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** HTML as readable text: block tags become line breaks, the rest of the tags go. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return unescapeHtml(stripped)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Collected = { plain: string[]; html: string[]; attachments: AttachmentInfo[] };

function collect(part: Part, into: Collected): void {
  if (part.filename !== "") {
    into.attachments.push({
      filename: part.filename,
      mimeType: part.mimeType,
      size: part.body.size,
      attachmentId: part.body.attachmentId,
      partId: part.partId,
    });
  } else if (part.body.data !== "") {
    const text = decodeBase64url(part.body.data);
    if (part.mimeType === "text/plain") into.plain.push(text);
    else if (part.mimeType === "text/html") into.html.push(text);
  }
  for (const sub of part.parts) collect(sub, into);
}

/** A message payload as headers, text (plain if present, else HTML as text) and attachments. */
export function readMessage(payload: Part): ReadMessage {
  const found: Collected = { plain: [], html: [], attachments: [] };
  collect(payload, found);
  const h = (name: string) => headerValue(payload.headers, name);
  const text = found.plain.length > 0 ? found.plain.join("\n") : htmlToText(found.html.join("\n"));
  return {
    from: h("From"),
    to: h("To"),
    cc: h("Cc"),
    date: h("Date"),
    subject: h("Subject"),
    messageId: h("Message-ID"),
    references: h("References"),
    replyTo: h("Reply-To"),
    text: text.trim(),
    attachments: found.attachments,
  };
}

export type Mailbox = { name: string; address: string };

/** Splits an address list on the commas outside quotes and angle brackets. */
function splitList(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "<") angle = true;
    else if (!quoted && char === ">") angle = false;
    if (char === "," && !quoted && !angle) {
      out.push(current);
      current = "";
    } else current += char;
  }
  out.push(current);
  return out.map((each) => each.trim()).filter((each) => each !== "");
}

export function parseAddresses(value: string): Mailbox[] {
  return splitList(value).flatMap((entry) => {
    const angled = /^(.*)<([^<>]*)>\s*$/.exec(entry);
    if (angled) {
      const name = (angled[1] ?? "")
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .replace(/\\(.)/g, "$1");
      return [{ name, address: (angled[2] ?? "").trim() }];
    }
    return entry.includes("@") ? [{ name: "", address: entry }] : [];
  });
}

const isAscii = (text: string): boolean => /^[\x20-\x7e]*$/.test(text);

/** RFC 2047 encoded words (UTF-8, base64), each within the 75-character limit. */
export function encodeHeaderText(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  if (isAscii(clean)) return clean;
  const words: string[] = [];
  let chunk = "";
  for (const char of clean) {
    if (Buffer.byteLength(chunk + char) > 42) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk !== "") words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

export function formatMailbox(box: Mailbox): string {
  if (box.name === "") return box.address;
  if (!isAscii(box.name)) return `${encodeHeaderText(box.name)} <${box.address}>`;
  const plain = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(box.name);
  return `${plain ? box.name : `"${box.name.replace(/(["\\])/g, "\\$1")}"`} <${box.address}>`;
}

const formatList = (boxes: Mailbox[]): string => boxes.map(formatMailbox).join(", ");

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function wrap76(text: string): string {
  return text.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** A file that travels in an outgoing mail. */
export type FileAttachment = { filename: string; mimeType: string; bytes: Uint8Array };

const base64Lines = (bytes: Uint8Array): string => wrap76(Buffer.from(bytes).toString("base64"));

const textBytes = (body: string): Uint8Array =>
  new Uint8Array(Buffer.from(body.replace(/\r?\n/g, "\r\n"), "utf8"));

/** `filename="x.pdf"` for a plain name, else the RFC 2231 form that carries any character. */
function fileParameter(name: string, filename: string): string {
  const clean = filename.replace(/[\r\n]+/g, " ");
  return isAscii(clean) && !/["\\]/.test(clean)
    ? `${name}="${clean}"`
    : `${name}*=UTF-8''${encodeURIComponent(clean)}`;
}

function attachmentPart(file: FileAttachment): string[] {
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType)
    ? file.mimeType
    : "application/octet-stream";
  return [
    `Content-Type: ${type}; ${fileParameter("name", file.filename)}`,
    `Content-Disposition: attachment; ${fileParameter("filename", file.filename)}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(file.bytes),
  ];
}

/** The lines after the headers: plain text alone, or multipart/mixed with the files. */
function bodyLines(body: string, attachments: FileAttachment[]): string[] {
  const text = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(textBytes(body)),
  ];
  if (attachments.length === 0) return text;
  const boundary = `prifly-${crypto.randomUUID()}`;
  return [
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...[text, ...attachments.map(attachmentPart)].flatMap((part) => [`--${boundary}`, ...part]),
    `--${boundary}--`,
  ];
}

function assemble(
  headers: [string, string][],
  body: string,
  attachments: FileAttachment[] = [],
): string {
  const lines = headers
    .filter(([, value]) => value !== "")
    // A line break stays only as a fold (CRLF + space), so a value cannot start a new header.
    .map(([name, value]) => `${name}: ${value.replace(/\r\n(?![ \t])|\r(?!\n)|(?<!\r)\n/g, " ")}`);
  return encodeBase64url(
    [...lines, "MIME-Version: 1.0", ...bodyLines(body, attachments)].join("\r\n"),
  );
}

export type ReplyInput = {
  /** The thread's messages, oldest first. */
  messages: GmailMessage[];
  /** The connected account's own address. */
  self: string;
  body: string;
  all: boolean;
};

/** The last message anyone sent: a draft in the thread is not one to reply to. */
export function lastSent(messages: GmailMessage[]): GmailMessage | null {
  const sent = messages.filter((each) => !each.labelIds.includes("DRAFT"));
  return sent[sent.length - 1] ?? null;
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`.trim();
}

/** Who a reply goes to, its subject and its threading headers: what a confirm card shows. */
export type ReplyEnvelope = {
  to: string;
  cc: string;
  subject: string;
  inReplyTo: string;
  references: string;
};

/** The envelope of a reply to the thread's last sent message, or null with no message. */
export function replyEnvelope(input: Omit<ReplyInput, "body">): ReplyEnvelope | null {
  const last = lastSent(input.messages);
  if (last === null) return null;
  const mail = readMessage(last.payload);
  const others = (boxes: Mailbox[]) => boxes.filter((box) => !sameAddress(box.address, input.self));
  let to = others(parseAddresses(mail.replyTo !== "" ? mail.replyTo : mail.from));
  // Replying to our own last message answers whoever it went to.
  if (to.length === 0) to = others(parseAddresses(mail.to));
  const cc = input.all
    ? others([...parseAddresses(mail.to), ...parseAddresses(mail.cc)]).filter(
        (box) => !to.some((each) => sameAddress(each.address, box.address)),
      )
    : [];
  return {
    to: formatList(to),
    cc: formatList(cc),
    subject: replySubject(mail.subject),
    inReplyTo: mail.messageId,
    references: mail.messageId === "" ? "" : `${mail.references} ${mail.messageId}`.trim(),
  };
}

/** The raw (base64url RFC 822) text of a reply with this envelope. */
export function rawReply(
  envelope: ReplyEnvelope,
  body: string,
  attachments: FileAttachment[] = [],
): string {
  return assemble(
    [
      ["To", envelope.to],
      ["Cc", envelope.cc],
      ["Subject", encodeHeaderText(envelope.subject)],
      ["In-Reply-To", envelope.inReplyTo],
      ["References", envelope.references],
    ],
    body,
    attachments,
  );
}

/** The raw (base64url RFC 822) reply to the thread's last sent message, or null with no message. */
export function buildReply(input: ReplyInput): string | null {
  const envelope = replyEnvelope(input);
  return envelope === null ? null : rawReply(envelope, input.body);
}

export type NewMail = {
  to: string;
  cc?: string | undefined;
  bcc?: string | undefined;
  subject: string;
  body: string;
};

/** An address list as it goes in a header: parsed and formatted, else as given. */
export function listOrRaw(value: string): string {
  const boxes = parseAddresses(value);
  return boxes.length > 0 ? formatList(boxes) : value.trim();
}

/** The raw (base64url RFC 822) text of a new mail. */
export function buildNew(mail: NewMail, attachments: FileAttachment[] = []): string {
  return assemble(
    [
      ["To", listOrRaw(mail.to)],
      ["Cc", listOrRaw(mail.cc ?? "")],
      ["Bcc", listOrRaw(mail.bcc ?? "")],
      ["Subject", encodeHeaderText(mail.subject)],
    ],
    mail.body,
    attachments,
  );
}

export function forwardSubject(subject: string): string {
  return /^fwd?:/i.test(subject.trim()) ? subject.trim() : `Fwd: ${subject.trim()}`.trim();
}

/** The note, then the forwarded message's headers and text, the way Gmail's Forward writes it. */
export function forwardBody(note: string, message: GmailMessage): string {
  const mail = readMessage(message.payload);
  const lines = [
    "---------- Forwarded message ---------",
    `From: ${mail.from}`,
    `Date: ${mail.date}`,
    `Subject: ${mail.subject}`,
    `To: ${mail.to}`,
  ];
  if (mail.cc !== "") lines.push(`Cc: ${mail.cc}`);
  const quoted = [...lines, "", mail.text].join("\n");
  return note.trim() === "" ? quoted : `${note.trimEnd()}\n\n${quoted}`;
}
