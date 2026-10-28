import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBase64url, headerValue } from "../mime";
import { CANCELLED } from "../tool-kit";
import { PNG_BYTES } from "./fake-gmail";
import { type Payload, parseRaw } from "./parse-raw";
import { world } from "./world";

let temp = "";
let stop: (() => void) | undefined;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "gmail-edit-"));
});
afterEach(async () => {
  stop?.();
  stop = undefined;
  await rm(temp, { recursive: true, force: true });
});

function started(options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
  stop = w.stop;
  return w;
}

type Card = { subject: string; text: string };
type Edited = { choice: "draft" | "send"; subject: string; text: string };

/** A reader who sends (or saves) what the card shows after `change`. */
const reader =
  (choice: "draft" | "send", change: (card: Card) => Card = (card) => card) =>
  async (spec: { mail: Card }): Promise<Edited> => ({ choice, ...change(spec.mail) });

/** The five compose tools: arguments that make a mail, and the choice that puts it somewhere. */
const COMPOSE: [string, Record<string, unknown>, "draft" | "send"][] = [
  ["gmail_new_draft", { to: "x@example.com", subject: "Hej", body: "Hello" }, "draft"],
  ["gmail_draft_reply", { thread_id: "t1", body: "10 works." }, "draft"],
  ["gmail_send", { to: "x@example.com", subject: "Hej", body: "Hello" }, "send"],
  ["gmail_reply", { thread_id: "t1", body: "Yes." }, "send"],
  ["gmail_forward", { thread_id: "t1", to: "x@example.com", note: "FYI" }, "send"],
];

/** The raw mail the fake Gmail was given, sent or saved as a draft, parsed. */
function written(w: ReturnType<typeof started>): Payload {
  const raw = w.gmail.sent[0]?.raw ?? w.gmail.drafts.get("r1")?.message.raw;
  if (raw === undefined) throw new Error("Nothing was written");
  return parseRaw(raw, true);
}

const textOf = (part: Payload): string =>
  decodeBase64url(part.body.data ?? "").replace(/\r\n/g, "\n");

const shape = (part: Payload): unknown =>
  part.parts === undefined ? part.mimeType : [part.mimeType, ...part.parts.map(shape)];

for (const [name, args, choice] of COMPOSE) {
  test(`${name}: the reader's edited subject and text are what goes out`, async () => {
    const w = started({
      edit: reader(choice, () => ({ subject: "Edited subject", text: "Edited by the reader." })),
    });
    const answer = await w.call(name, args);
    expect(w.chooses.length).toBe(1);
    expect(w.confirms).toEqual([]);
    expect(answer).toContain("The reader edited the mail before it went out.");
    expect(answer).toContain("Final subject: “Edited subject”.");
    expect(answer).toContain("Final text:\nEdited by the reader.");
    const mail = written(w);
    expect(headerValue(mail.headers, "Subject")).toBe("Edited subject");
    const plain = mail.parts === undefined ? mail : (mail.parts[0] ?? mail);
    expect(textOf(plain)).toStartWith("Edited by the reader.");
    if (name === "gmail_forward") expect(textOf(plain)).toContain("Forwarded message");
    else expect(textOf(plain)).toBe("Edited by the reader.");
    expect(w.gmail.sent.length).toBe(choice === "send" ? 1 : 0);
    expect(w.gmail.drafts.size).toBe(choice === "draft" ? 1 : 0);
  });

  test(`${name}: an unchanged card goes out as the session wrote it, answered as before`, async () => {
    const w = started({ edit: reader(choice) });
    const answer = await w.call(name, args);
    expect(answer).not.toContain("edited");
    expect(answer).toStartWith(
      choice === "draft" ? "The reader saved it as a draft: " : "The reader sent it: ",
    );
    const mail = written(w);
    expect(headerValue(mail.headers, "Subject")).not.toBe("");
  });

  test(`${name}: Cancel on the editable card writes nothing`, async () => {
    const w = started({ edit: async () => null });
    expect(await w.call(name, args)).toBe(CANCELLED);
    expect(w.writes()).toEqual([]);
  });
}

test("a reply edited to a new subject keeps its threading headers and thread", async () => {
  const w = started({
    edit: reader("send", (card) => ({ ...card, subject: "A new subject" })),
  });
  const answer = await w.call("gmail_reply", { thread_id: "t1", body: "Yes." });
  expect(answer).toContain("Final subject: “A new subject”.");
  const mail = written(w);
  expect(headerValue(mail.headers, "Subject")).toBe("A new subject");
  expect(headerValue(mail.headers, "In-Reply-To")).toBe("<m2@example.com>");
  expect(headerValue(mail.headers, "References")).toContain("<m1@example.com>");
  expect(w.gmail.sent[0]?.threadId).toBe("t1");
});

test("a forward's editable text is the note, and the forwarded message stays", async () => {
  const w = started({ edit: reader("send", (card) => ({ ...card, text: "New note" })) });
  await w.call("gmail_forward", { thread_id: "t1", to: "x@example.com", note: "FYI" });
  expect(w.chooses[0]?.spec.mail?.text).toBe("FYI");
  const body = textOf(written(w));
  expect(body).toStartWith("New note\n\n---------- Forwarded message ---------");
  expect(body).toContain("Works for me.");
  expect(body).not.toContain("FYI");
});

test("the card is given the session's text with its markers, and the edit rebuilds the HTML", async () => {
  const shot = join(temp, "shot.png");
  await writeFile(shot, PNG_BYTES);
  let seen = "";
  const w = started({
    edit: reader("send", (card) => {
      seen = card.text;
      return { ...card, text: `${card.text}\nAnd a PS.` };
    }),
  });
  await w.call("gmail_send", {
    to: "x@example.com",
    subject: "Pics",
    body: "Look:\n[image:shot]",
    inline_images: [{ name: "shot", path: shot }],
  });
  expect(seen).toBe("Look:\n[image: shot]");
  const mail = written(w);
  expect(shape(mail)).toEqual([
    "multipart/related",
    ["multipart/alternative", "text/plain", "text/html"],
    "image/png",
  ]);
  const alternative = mail.parts?.[0];
  expect(textOf(alternative?.parts?.[0] as Payload)).toBe("Look:\n[image: shot]\nAnd a PS.");
  const html = textOf(alternative?.parts?.[1] as Payload);
  expect(html).toContain('<img src="cid:ii_');
  expect(html).toContain("And a PS.");
});

test("a marker the reader removed drops its image", async () => {
  const [a, b] = [join(temp, "a.png"), join(temp, "b.png")] as [string, string];
  await writeFile(a, PNG_BYTES);
  await writeFile(b, PNG_BYTES);
  const w = started({
    edit: reader("send", (card) => ({ ...card, text: card.text.replace("[image: b]", "") })),
  });
  await w.call("gmail_send", {
    to: "x@example.com",
    subject: "Pics",
    body: "One\n[image:a]\nTwo\n[image:b]",
    inline_images: [
      { name: "a", path: a },
      { name: "b", path: b },
    ],
  });
  const mail = written(w);
  expect(shape(mail)).toEqual([
    "multipart/related",
    ["multipart/alternative", "text/plain", "text/html"],
    "image/png",
  ]);
  expect(JSON.stringify(mail)).not.toContain('"b.png"');
});

test("removing every marker leaves a plain mail", async () => {
  const a = join(temp, "a.png");
  await writeFile(a, PNG_BYTES);
  const w = started({ edit: reader("send", (card) => ({ ...card, text: "No picture now" })) });
  await w.call("gmail_send", {
    to: "x@example.com",
    subject: "Pics",
    body: "One\n[image:a]",
    inline_images: [{ name: "a", path: a }],
  });
  expect(written(w).mimeType).toBe("text/plain");
});

test("a marker naming no image is answered as an error, with nothing written", async () => {
  const w = started({ edit: reader("send", (card) => ({ ...card, text: "Hi\n[image:ghost]" })) });
  for (const [name, args] of COMPOSE) {
    const answer = await w.call(name, args);
    expect(answer).toBe("Not done: [image:ghost] names no inline image (the images are none).");
  }
  expect(w.writes()).toEqual([]);
});

test("a body the reader emptied is answered as an error, with nothing written", async () => {
  const w = started({ edit: reader("send", (card) => ({ ...card, text: "  " })) });
  expect(await w.call("gmail_send", COMPOSE[2]?.[1] ?? {})).toStartWith(
    "Not done: the reader emptied",
  );
  expect(w.writes()).toEqual([]);
});

test("the editable card is preferred over the two-way card", async () => {
  let edited = 0;
  const w = started({
    choose: "draft",
    edit: async (spec) => {
      edited += 1;
      return { choice: "send", subject: spec.mail.subject, text: spec.mail.text };
    },
  });
  const answer = await w.call("gmail_send", COMPOSE[2]?.[1] ?? {});
  expect(edited).toBe(1);
  expect(answer).toStartWith("The reader sent it: ");
});

test("a subject-only edit keeps the session's HTML and its picture", async () => {
  const shot = join(temp, "shot.png");
  await writeFile(shot, PNG_BYTES);
  const w = started({ edit: reader("send", (card) => ({ ...card, subject: "Only the subject" })) });
  await w.call("gmail_send", {
    to: "x@example.com",
    subject: "Pics",
    body: "Plain alternative",
    html: "<h1>Session HTML</h1>[image:shot]",
    inline_images: [{ name: "shot", path: shot }],
  });
  const mail = written(w);
  expect(headerValue(mail.headers, "Subject")).toBe("Only the subject");
  expect(shape(mail)).toEqual([
    "multipart/related",
    ["multipart/alternative", "text/plain", "text/html"],
    "image/png",
  ]);
  const alternative = mail.parts?.[0];
  expect(textOf(alternative?.parts?.[0] as Payload)).toBe("Plain alternative");
  expect(textOf(alternative?.parts?.[1] as Payload)).toStartWith("<h1>Session HTML</h1><img");
});

test("without the editable card, the two-way card then the confirm card are used as before", async () => {
  const two = started({ choose: "send" });
  expect(await two.call("gmail_send", COMPOSE[2]?.[1] ?? {})).toStartWith("The reader sent it: ");
  expect(two.chooses.length).toBe(1);
  two.stop();
  const old = started();
  expect(await old.call("gmail_send", COMPOSE[2]?.[1] ?? {})).toStartWith("Sent: ");
  expect(old.confirms.length).toBe(1);
});
