/**
 * Pure functions over Gmail's message payloads and RFC 822: read a message
 * into text and attachments, and build the raw text of a reply or a new mail.
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

function assemble(headers: [string, string][], body: string): string {
  const lines = headers
    .filter(([, value]) => value !== "")
    // A line break stays only as a fold (CRLF + space), so a value cannot start a new header.
    .map(([name, value]) => `${name}: ${value.replace(/\r\n(?![ \t])|\r(?!\n)|(?<!\r)\n/g, " ")}`);
  const encoded = wrap76(Buffer.from(body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64"));
  return encodeBase64url(
    [
      ...lines,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      encoded,
    ].join("\r\n"),
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

/** The raw (base64url RFC 822) reply to the thread's last sent message, or null with no message. */
export function buildReply(input: ReplyInput): string | null {
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
  const references = `${mail.references} ${mail.messageId}`.trim();
  return assemble(
    [
      ["To", formatList(to)],
      ["Cc", formatList(cc)],
      ["Subject", encodeHeaderText(replySubject(mail.subject))],
      ["In-Reply-To", mail.messageId],
      ["References", mail.messageId === "" ? "" : references],
    ],
    input.body,
  );
}

export type NewMail = { to: string; cc?: string | undefined; subject: string; body: string };

function listOrRaw(value: string): string {
  const boxes = parseAddresses(value);
  return boxes.length > 0 ? formatList(boxes) : value.trim();
}

/** The raw (base64url RFC 822) text of a new mail. */
export function buildNew(mail: NewMail): string {
  return assemble(
    [
      ["To", listOrRaw(mail.to)],
      ["Cc", listOrRaw(mail.cc ?? "")],
      ["Subject", encodeHeaderText(mail.subject)],
    ],
    mail.body,
  );
}
