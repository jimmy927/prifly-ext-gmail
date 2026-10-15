import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePart } from "../gmail-types";
import { richBody, textToHtml } from "../mail-html";
import {
  buildNew,
  decodeBase64url,
  type FileAttachment,
  headerValue,
  type InlineImage,
  savedCopyProblems,
} from "../mime";
import { PDF_BYTES, PNG_BYTES } from "./fake-gmail";
import { type Payload, parseRaw } from "./parse-raw";
import { world } from "./world";

let temp = "";
let stop: (() => void) | undefined;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "gmail-inline-"));
});
afterEach(async () => {
  stop?.();
  await rm(temp, { recursive: true, force: true });
});

function started(options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
  stop = w.stop;
  return w;
}

const image = (name: string, id: string, filename = `${name}.png`): InlineImage => ({
  name,
  id,
  filename,
  mimeType: "image/png",
  bytes: PNG_BYTES,
});

const pdf: FileAttachment = {
  filename: "invoice.pdf",
  mimeType: "application/pdf",
  bytes: PDF_BYTES,
};

const mail = { to: "ada@example.com", subject: "Shots", body: "Hello" };

/** A part's media type with its children, to compare a MIME tree at a glance. */
function shape(part: Payload): unknown {
  return part.parts === undefined ? part.mimeType : [part.mimeType, ...part.parts.map(shape)];
}

const parsed = (raw: string) => parseRaw(raw, true);

const child = (part: Payload, ...path: number[]): Payload => {
  let at = part;
  for (const index of path) {
    const next = at.parts?.[index];
    if (next === undefined) throw new Error(`No part ${path.join(".")}`);
    at = next;
  }
  return at;
};

const text = (part: Payload): string =>
  decodeBase64url(part.body.data ?? "").replace(/\r\n/g, "\n");
const header = (part: Payload, name: string): string => headerValue(part.headers, name);

test("a plain mail stays text/plain alone, and with files multipart/mixed", () => {
  expect(shape(parsed(buildNew(mail)))).toBe("text/plain");
  expect(shape(parsed(buildNew(mail, [pdf])))).toEqual([
    "multipart/mixed",
    "text/plain",
    "application/pdf",
  ]);
});

test("html makes multipart/alternative with the plain text first", () => {
  const root = parsed(buildNew(mail, [], { html: "<p>Hello</p>", images: [] }));
  expect(shape(root)).toEqual(["multipart/alternative", "text/plain", "text/html"]);
  expect(text(child(root, 0))).toBe("Hello");
  expect(text(child(root, 1))).toBe("<p>Hello</p>");
});

test("inline images make multipart/related around the alternative, in Gmail's own part shape", () => {
  const shot = image("shot", "ii_aaaaaaaaaaaa");
  const root = parsed(
    buildNew(mail, [], { html: '<img src="cid:ii_aaaaaaaaaaaa">', images: [shot] }),
  );
  expect(shape(root)).toEqual([
    "multipart/related",
    ["multipart/alternative", "text/plain", "text/html"],
    "image/png",
  ]);
  const part = child(root, 1);
  expect(header(part, "Content-Type")).toBe('image/png; name="shot.png"');
  expect(header(part, "Content-Disposition")).toBe('inline; filename="shot.png"');
  expect(header(part, "Content-Transfer-Encoding")).toBe("base64");
  expect(header(part, "Content-ID")).toBe("<ii_aaaaaaaaaaaa>");
  expect(header(part, "X-Attachment-Id")).toBe("ii_aaaaaaaaaaaa");
  expect(new Uint8Array(Buffer.from(part.body.data ?? "", "base64url"))).toEqual(PNG_BYTES);
});

test("images and files nest as mixed[related[alternative, images], files]", () => {
  const images = [image("a", "ii_000000000001"), image("b", "ii_000000000002")];
  const root = parsed(buildNew(mail, [pdf], { html: "<p>x</p>", images }));
  expect(shape(root)).toEqual([
    "multipart/mixed",
    [
      "multipart/related",
      ["multipart/alternative", "text/plain", "text/html"],
      "image/png",
      "image/png",
    ],
    "application/pdf",
  ]);
  const ids = [child(root, 0, 1), child(root, 0, 2)].map((part) => header(part, "X-Attachment-Id"));
  expect(ids).toEqual(["ii_000000000001", "ii_000000000002"]);
  expect(child(root, 1).filename).toBe("invoice.pdf");
});

test("an image with a non-ASCII file name uses the RFC 2231 form", () => {
  const root = parsed(
    buildNew(mail, [], { html: "<p>x</p>", images: [image("s", "ii_1", "skärm.png")] }),
  );
  const part = child(root, 1);
  expect(header(part, "Content-Disposition")).toBe("inline; filename*=UTF-8''sk%C3%A4rm.png");
  expect(part.filename).toBe("skärm.png");
});

test("textToHtml makes paragraphs, line breaks and escapes everything", () => {
  expect(textToHtml('Hi <b> & co\nsecond line\n\nNext "one"', [])).toBe(
    "<p>Hi &lt;b&gt; &amp; co<br>second line</p>\n<p>Next &quot;one&quot;</p>",
  );
});

test("textToHtml turns list lines into lists, with no stray paragraph", () => {
  expect(textToHtml("- one\n* two", [])).toBe("<ul><li>one</li><li>two</li></ul>");
  expect(textToHtml("Steps:\n- one\n- two\n\nThen:\n1. first\n2) second", [])).toBe(
    "<p>Steps:</p>\n<ul><li>one</li><li>two</li></ul>\n<p>Then:</p>\n<ol><li>first</li><li>second</li></ol>",
  );
  expect(textToHtml("1. a\n- b", [])).toBe("<ol><li>a</li></ol>\n<ul><li>b</li></ul>");
  expect(textToHtml("**bold** stays text", [])).toBe("<p>**bold** stays text</p>");
});

test("textToHtml puts a picture at its marker line, in a paragraph of its own", () => {
  const html = textToHtml("Before\n\n[image:shot]\n\nAfter", [image("shot", "ii_abc")]);
  expect(html).toBe(
    '<p>Before</p>\n<p><img src="cid:ii_abc" alt="shot" style="max-width:100%"></p>\n<p>After</p>',
  );
});

const files = (...names: string[]) =>
  names.map((name) => ({ name, filename: `${name}.png`, mimeType: "image/png", bytes: PNG_BYTES }));

test("richBody resolves markers in the plain and the HTML version, with unique ids", () => {
  const rich = richBody("See:\n[image:a]\nand\n[image: b ]", "", files("a", "b"));
  if (rich === null || typeof rich === "string") throw new Error(`Not rich: ${rich}`);
  expect(rich.text).toBe("See:\n[image: a]\nand\n[image: b]");
  const ids = rich.images.map((each) => each.id);
  expect(ids[0]).toMatch(/^ii_[0-9a-f]{12}$/);
  expect(new Set(ids).size).toBe(2);
  expect(rich.html).toContain(`<img src="cid:${ids[0]}" alt="a"`);
  expect(rich.html).toContain(`<img src="cid:${ids[1]}" alt="b"`);
});

test("richBody with an html argument keeps it and replaces its markers", () => {
  const rich = richBody("plain", "<div>Look [image:a] here</div>", files("a"));
  if (rich === null || typeof rich === "string") throw new Error(`Not rich: ${rich}`);
  expect(rich.html).toMatch(/^<div>Look <img src="cid:ii_[0-9a-f]{12}" alt="a"[^>]*> here<\/div>$/);
  expect(rich.text).toBe("plain");
});

test("richBody is null for a plain mail, and refuses markers and images that do not match", () => {
  expect(richBody("Hello", "", [])).toBeNull();
  expect(richBody("[image:ghost]", "", files("a"))).toContain(
    "[image:ghost] names no inline image",
  );
  expect(richBody("Hello", "", files("a"))).toContain("“a” is never referenced");
  expect(richBody("see [image:a] inline", "", files("a"))).toContain("never referenced");
  expect(richBody("x", "<p>[image:ghost]</p>", [])).toContain("names no inline image");
  expect(richBody("x\n[image:a]", "<p>no picture</p>", files("a"))).toContain("never referenced");
  expect(richBody("[image:a]", "", files("a", "a"))).toContain("same name");
});

const withParts = (html: string, filenames: string[], contentIds: string[]) =>
  parsePart({
    mimeType: "multipart/related",
    parts: [
      {
        mimeType: "text/html",
        body: { size: html.length, data: Buffer.from(html).toString("base64url") },
      },
      ...filenames.map((filename, at) => ({
        mimeType: "image/png",
        filename,
        headers: [{ name: "Content-ID", value: `<${contentIds[at] ?? ""}>` }],
        body: { size: 3, attachmentId: `a${at}` },
      })),
    ],
  });

test("savedCopyProblems finds nothing wrong with a whole copy", () => {
  const whole = withParts(
    "<img src=\"cid:ii_1\"><img src='cid:ii_2'>",
    ["a.png", "b.png"],
    ["ii_1", "ii_2"],
  );
  expect(savedCopyProblems(whole, ["a.png", "b.png"])).toEqual([]);
});

test("savedCopyProblems names a cid without a part and a missing file", () => {
  const broken = withParts('<img src="cid:ii_1"><img src="cid:ii_2">', ["a.png"], ["ii_1"]);
  expect(savedCopyProblems(broken, ["a.png", "report.pdf", "a.png"])).toEqual([
    "the HTML shows cid:ii_2 but no part has that Content-ID",
    "the file report.pdf is missing",
    "the file a.png is missing",
  ]);
});

async function pictures(...names: string[]): Promise<{ name: string; path: string }[]> {
  const out: { name: string; path: string }[] = [];
  for (const name of names) {
    const path = join(temp, `${name}.png`);
    await writeFile(path, PNG_BYTES);
    out.push({ name, path });
  }
  return out;
}

/** The newest raw mail the fake holds, parsed. */
const lastDraft = (w: ReturnType<typeof started>) => {
  const drafts = [...w.gmail.drafts.values()];
  return parsed(drafts[drafts.length - 1]?.message.raw ?? "");
};

test("gmail_new_draft with pictures and files writes Gmail's shape and lists them on the card", async () => {
  const w = started();
  const report = join(temp, "report.pdf");
  await writeFile(report, PDF_BYTES);
  const answer = await w.call("gmail_new_draft", {
    to: "ada@example.com",
    subject: "Shots",
    body: "Look:\n\n[image:one]\n\nand\n\n[image:two]\n\nBye",
    inline_images: await pictures("one", "two"),
    attachments: [report],
  });
  expect(answer).toBe("Draft r1 is in Gmail's Drafts: open Drafts to see it. Nothing was sent.");
  const root = lastDraft(w);
  expect(shape(root)).toEqual([
    "multipart/mixed",
    [
      "multipart/related",
      ["multipart/alternative", "text/plain", "text/html"],
      "image/png",
      "image/png",
    ],
    "application/pdf",
  ]);
  const html = text(child(root, 0, 0, 1));
  const ids = [child(root, 0, 1), child(root, 0, 2)].map((part) => header(part, "X-Attachment-Id"));
  expect(html).toContain(`cid:${ids[0]}`);
  expect(html.indexOf(`cid:${ids[0]}`)).toBeLessThan(html.indexOf(`cid:${ids[1]}`));
  expect(text(child(root, 0, 0, 0))).toBe("Look:\n\n[image: one]\n\nand\n\n[image: two]\n\nBye");
  const spec = w.confirms[0]?.spec;
  expect(spec?.summary).toBe(
    "Draft “Shots” to ada@example.com in Gmail's Drafts with 2 inline images and 1 attachment. Nothing is sent.",
  );
  expect(spec?.details).toBe(
    [
      "To: ada@example.com",
      "Subject: Shots",
      "Inline images:",
      "- one (one.png, 1 KB)",
      "- two (two.png, 1 KB)",
      "Attachments:",
      "- report.pdf (1 KB)",
      "",
      "Look:\n\n[image:one]\n\nand\n\n[image:two]\n\nBye",
    ].join("\n"),
  );
});

test("gmail_new_draft with only files is multipart/mixed, and the card lists them", async () => {
  const w = started();
  const report = join(temp, "report.pdf");
  await writeFile(report, PDF_BYTES);
  await w.call("gmail_new_draft", {
    to: "a@example.com",
    subject: "s",
    body: "b",
    attachments: [report],
  });
  expect(shape(lastDraft(w))).toEqual(["multipart/mixed", "text/plain", "application/pdf"]);
  expect(w.confirms[0]?.spec.details).toContain("Attachments:\n- report.pdf (1 KB)");
});

test("an html argument is the HTML version, shown on the card, with the body as plain text", async () => {
  const w = started();
  await w.call("gmail_new_draft", {
    to: "a@example.com",
    subject: "s",
    body: "plain\n[image:one]",
    html: "<h1>Hi</h1>[image:one]",
    inline_images: await pictures("one"),
  });
  const root = lastDraft(w);
  expect(text(child(root, 0, 0))).toBe("plain\n[image: one]");
  expect(text(child(root, 0, 1))).toMatch(/^<h1>Hi<\/h1><img src="cid:ii_[0-9a-f]{12}"/);
  expect(w.confirms[0]?.spec.details).toContain("HTML version:\n<h1>Hi</h1>[image:one]");
});

test("a draft reply takes pictures and files, and replace_draft_id rewrites the whole message", async () => {
  const w = started();
  await w.call("gmail_draft_reply", { thread_id: "t1", body: "First." });
  expect(shape(lastDraft(w))).toBe("text/plain");
  const report = join(temp, "report.pdf");
  await writeFile(report, PDF_BYTES);
  const answer = await w.call("gmail_draft_reply", {
    thread_id: "t1",
    body: "Here:\n[image:one]",
    inline_images: await pictures("one"),
    attachments: [report],
    replace_draft_id: "r1",
  });
  expect(answer).toContain("Draft r1 is in the thread");
  expect(w.gmail.drafts.size).toBe(1);
  const root = lastDraft(w);
  expect(shape(root)).toEqual([
    "multipart/mixed",
    ["multipart/related", ["multipart/alternative", "text/plain", "text/html"], "image/png"],
    "application/pdf",
  ]);
  expect(header(root, "In-Reply-To")).toBe("<m2@example.com>");
  expect(w.confirms[1]?.spec.title).toBe("Rewrite a draft reply");
  expect(w.confirms[1]?.spec.summary).toContain("with 1 inline image and 1 attachment");
  expect(w.gmail.drafts.get("r1")?.message.threadId).toBe("t1");
});

test("gmail_send and gmail_reply carry pictures inline and read the sent copy back", async () => {
  const w = started();
  expect(
    await w.call("gmail_send", {
      to: "a@example.com",
      subject: "s",
      body: "[image:one]",
      inline_images: await pictures("one"),
    }),
  ).toBe("Sent: message s1 in thread ts1.");
  expect(
    await w.call("gmail_reply", {
      thread_id: "t1",
      body: "See\n[image:two]",
      inline_images: await pictures("two"),
    }),
  ).toBe("Sent: message s2 in thread t1.");
  for (const sent of w.gmail.sent) {
    expect(shape(parsed(sent.raw))).toEqual([
      "multipart/related",
      ["multipart/alternative", "text/plain", "text/html"],
      "image/png",
    ]);
  }
  expect(w.connections.requests.some((each) => each.url.endsWith("/messages/s2?format=full"))).toBe(
    true,
  );
});

test("markers and images that do not match are refused with no card and nothing written", async () => {
  const w = started();
  const base = { to: "a@example.com", subject: "s" };
  const one = await pictures("one");
  const answers = [
    await w.call("gmail_new_draft", { ...base, body: "[image:ghost]", inline_images: one }),
    await w.call("gmail_send", { ...base, body: "no marker", inline_images: one }),
    await w.call("gmail_draft_reply", { thread_id: "t1", body: "x\n[image:ghost]" }),
    await w.call("gmail_reply", { thread_id: "t1", body: "no marker", inline_images: one }),
  ];
  expect(answers[0]).toContain("[image:ghost] names no inline image");
  expect(answers[1]).toContain("never referenced");
  expect(answers[2]).toContain("names no inline image");
  expect(answers[3]).toContain("never referenced");
  expect(w.confirms).toEqual([]);
  expect(w.writes()).toEqual([]);
});

test("an image path that is relative, unreadable or not an image is refused before any card", async () => {
  const w = started();
  const base = { to: "a@example.com", subject: "s", body: "[image:one]" };
  const refuse = (path: string) =>
    w.call("gmail_new_draft", { ...base, inline_images: [{ name: "one", path }] });
  expect(await refuse("one.png")).toContain("is not an absolute path");
  expect(await refuse(join(temp, "gone.png"))).toContain("cannot read");
  expect(await refuse(join(temp, "notes.pdf"))).toContain("not a png, jpeg, gif or webp image");
  expect(await w.call("gmail_new_draft", { ...base, inline_images: "one.png" })).toContain(
    "must be a list",
  );
  expect(await w.call("gmail_new_draft", { ...base, inline_images: [{ name: "one" }] })).toContain(
    "needs a name and a path",
  );
  expect(w.confirms).toEqual([]);
  expect(w.writes()).toEqual([]);
});

test("pictures count against the 25 MB limit together with the files", async () => {
  const w = started();
  const big = join(temp, "big.png");
  await writeFile(big, new Uint8Array(14 * 1024 * 1024));
  const report = join(temp, "report.pdf");
  await writeFile(report, new Uint8Array(12 * 1024 * 1024));
  const answer = await w.call("gmail_new_draft", {
    to: "a@example.com",
    subject: "s",
    body: "[image:big]",
    inline_images: [{ name: "big", path: big }],
    attachments: [report],
  });
  expect(answer).toContain("over Gmail's 25 MB");
  expect(w.confirms).toEqual([]);
});

test("when Gmail's saved copy lost the pictures and files the answer is an error, not success", async () => {
  const w = started();
  w.gmail.loseFiles.on = true;
  const report = join(temp, "report.pdf");
  await writeFile(report, PDF_BYTES);
  const base = { to: "a@example.com", subject: "s", body: "[image:one]" };
  const args = { ...base, inline_images: await pictures("one"), attachments: [report] };
  const draft = await w.call("gmail_new_draft", args);
  expect(draft).toStartWith("Saved, but Gmail's copy is broken: draft r1: ");
  expect(draft).toMatch(/cid:ii_[0-9a-f]{12} but no part has that Content-ID/);
  expect(draft).toContain("the file one.png is missing; the file report.pdf is missing");
  const sent = await w.call("gmail_send", args);
  expect(sent).toStartWith("Sent, but Gmail's copy is broken: message s1 in thread ts1: ");
  const reply = await w.call("gmail_draft_reply", { thread_id: "t1", ...args });
  expect(reply).toStartWith("Saved, but Gmail's copy is broken: draft r2: ");
});
