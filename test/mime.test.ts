import { expect, test } from "bun:test";
import { type GmailMessage, parseThread } from "../gmail-types";
import {
  buildNew,
  buildReply,
  decodeBase64url,
  encodeBase64url,
  encodeHeaderText,
  htmlToText,
  parseAddresses,
  readMessage,
} from "../mime";
import { fakeGmail, SELF } from "./fake-gmail";

const thread = (): GmailMessage[] =>
  parseThread({ id: "t1", messages: fakeGmail().threads.get("t1") }).messages;

function message(index: number): GmailMessage {
  const found = thread()[index];
  if (found === undefined) throw new Error(`No fixture message ${index}`);
  return found;
}

/** The headers and the decoded body of a raw RFC 822 text, as a mail client would read them. */
function parseRaw(raw: string) {
  const text = decodeBase64url(raw);
  const [head = "", body = ""] = text.split("\r\n\r\n");
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n /g, " ").split("\r\n")) {
    const at = line.indexOf(": ");
    headers.set(line.slice(0, at), line.slice(at + 2));
  }
  const decoded = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  return { headers, body: decoded, text };
}

/** Reads RFC 2047 encoded words back to text. */
function decodeWords(value: string): string {
  return value
    .replace(/(\?=) (=\?UTF-8)/g, "$1$2")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, data: string) =>
      Buffer.from(data, "base64").toString("utf8"),
    );
}

test("readMessage walks nested multipart into text and attachments", () => {
  const mail = readMessage(message(0).payload);
  expect(mail.from).toBe("Ada Lovelace <ada@example.com>");
  expect(mail.subject).toBe("Plans för Tuesday");
  expect(mail.messageId).toBe("<m1@example.com>");
  expect(mail.text).toBe("Hello Jimmy,\nCan we meet Tuesday? Café at 10.");
  expect(mail.attachments).toEqual([
    {
      filename: "logo.png",
      mimeType: "image/png",
      size: 11,
      attachmentId: "att-png",
      partId: "att-png",
    },
    {
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      size: 30,
      attachmentId: "att-pdf",
      partId: "att-pdf",
    },
  ]);
  // An HTML-only mail becomes text.
  expect(readMessage(message(1).payload).text).toBe("Works for me.\nBob & co");
});

test("a message with missing fields parses to empty values", () => {
  const [sparse] = parseThread({
    messages: [{ payload: { headers: [{ name: "From" }] } }],
  }).messages;
  if (sparse === undefined) throw new Error("no message");
  const mail = readMessage(sparse.payload);
  expect(mail).toMatchObject({ from: "", subject: "", text: "", attachments: [] });
});

test("htmlToText drops styles and decodes entities", () => {
  expect(htmlToText("<style>p{}</style><p>a &lt; b</p><p>&#65;&nbsp;&#x42;</p>")).toBe(
    "a < b\nA B",
  );
});

test("a reply is threaded: Re: once, In-Reply-To, References", () => {
  const raw = buildReply({ messages: thread(), self: SELF, body: "Yes, 10 works.", all: false });
  const { headers, body } = parseRaw(raw ?? "");
  expect(decodeWords(headers.get("Subject") ?? "")).toBe("Re: Plans för Tuesday");
  expect(headers.get("In-Reply-To")).toBe("<m2@example.com>");
  expect(headers.get("References")).toBe("<m1@example.com> <m2@example.com>");
  expect(headers.get("To")).toBe("Bob <bob@example.com>");
  expect(headers.has("Cc")).toBe(false);
  expect(body).toBe("Yes, 10 works.");
});

test("reply-all keeps everyone else on Cc, minus self and the To", () => {
  const raw = buildReply({ messages: thread(), self: SELF.toUpperCase(), body: "Hi", all: true });
  const { headers } = parseRaw(raw ?? "");
  expect(headers.get("To")).toBe("Bob <bob@example.com>");
  expect(headers.get("Cc")).toBe("Ada Lovelace <ada@example.com>, carol@example.com");
});

test("replying to our own last message answers whoever it went to; a draft is not replied to", () => {
  const first = message(0);
  const second = message(1);
  const own: GmailMessage = {
    ...second,
    labelIds: ["SENT"],
    payload: {
      ...second.payload,
      headers: second.payload.headers.map((each) =>
        each.name === "From" ? { ...each, value: `Jimmy <${SELF}>` } : each,
      ),
    },
  };
  const draft: GmailMessage = { ...own, id: "d1", labelIds: ["DRAFT"] };
  const raw = buildReply({ messages: [first, own, draft], self: SELF, body: "x", all: false });
  const { headers } = parseRaw(raw ?? "");
  expect(headers.get("To")).toBe("Ada Lovelace <ada@example.com>");
  expect(headers.get("In-Reply-To")).toBe("<m2@example.com>");
});

test("a thread with no sent message has nothing to reply to", () => {
  expect(buildReply({ messages: [], self: SELF, body: "x", all: true })).toBeNull();
});

test("base64url round trip, with no padding or + / characters", () => {
  const text = "Åke ≠ Zoë?>>> ~~~";
  const encoded = encodeBase64url(text);
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeBase64url(encoded)).toBe(text);
  const { body } = parseRaw(buildNew({ to: "a@example.com", subject: "s", body: text }));
  expect(body).toBe(text);
});

test("a non-ASCII subject and name are RFC 2047 encoded within the line limit", () => {
  const subject = "Ärendet gäller förslaget om årsmötet i Göteborg och Malmö nästa vecka";
  const encoded = encodeHeaderText(subject);
  expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
  for (const word of encoded.split("\r\n ")) expect(word.length).toBeLessThanOrEqual(75);
  expect(decodeWords(encoded.replace(/\r\n /g, " "))).toBe(subject);

  const raw = buildNew({
    to: "Zoë Åkesson <zoe@example.com>",
    cc: "b@example.com",
    subject,
    body: "hi",
  });
  const { headers, text } = parseRaw(raw);
  expect(decodeWords(headers.get("Subject") ?? "")).toBe(subject);
  expect(decodeWords(headers.get("To") ?? "")).toBe("Zoë Åkesson <zoe@example.com>");
  expect(headers.get("Cc")).toBe("b@example.com");
  expect(text).toMatch(/^[\t\r\n\x20-\x7e]*$/);
});

test("address lists split on commas outside quotes", () => {
  expect(parseAddresses('"Lovelace, Ada" <ada@example.com>, bob@example.com')).toEqual([
    { name: "Lovelace, Ada", address: "ada@example.com" },
    { name: "", address: "bob@example.com" },
  ]);
});

test("a header value cannot start a new header", () => {
  const { headers } = parseRaw(
    buildNew({ to: "a@example.com", subject: "x\r\nBcc: evil@example.com", body: "b" }),
  );
  expect(headers.has("Bcc")).toBe(false);
});
