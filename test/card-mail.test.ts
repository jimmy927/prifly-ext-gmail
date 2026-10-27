import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfirmMail } from "@prifly/extension-api";
import { PDF_BYTES, PNG_BYTES, SELF } from "./fake-gmail";
import { world } from "./world";

let temp = "";
let stop: (() => void) | undefined;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "card-mail-"));
});

afterEach(async () => {
  stop?.();
  stop = undefined;
  await rm(temp, { recursive: true, force: true });
});

async function files(): Promise<{ images: { name: string; path: string }[]; report: string }> {
  const images: { name: string; path: string }[] = [];
  for (const name of ["one", "two"]) {
    const path = join(temp, `${name}.png`);
    await writeFile(path, PNG_BYTES);
    images.push({ name, path });
  }
  const report = join(temp, "report.pdf");
  await writeFile(report, PDF_BYTES);
  return { images, report };
}

function started() {
  const w = world();
  stop = w.stop;
  return w;
}

/** The `mail` of the first confirm card the world showed. */
const shownMail = (w: ReturnType<typeof started>): ConfirmMail | undefined =>
  w.confirms[0]?.spec.mail;

test("a reply's card mail carries its two images, its file and the HTML with cid refs", async () => {
  const w = started();
  const { images, report } = await files();
  await w.call("gmail_reply", {
    thread_id: "t1",
    body: "See:\n\n[image:one]\n\nand\n\n[image:two]",
    inline_images: images,
    attachments: [report],
  });
  const mail = shownMail(w);
  expect(mail?.from).toBe(SELF);
  expect(mail?.draft).toBeUndefined();
  const shown = mail?.images ?? [];
  expect(shown.length).toBe(2);
  const html = mail?.html ?? "";
  for (const image of shown) {
    expect(image.id.startsWith("<")).toBe(false);
    expect(image.mimeType).toBe("image/png");
    expect(image.bytes).toEqual(PNG_BYTES);
    expect(html).toContain(`cid:${image.id}`);
  }
  expect(html.indexOf(`cid:${shown[0]?.id}`)).toBeLessThan(html.indexOf(`cid:${shown[1]?.id}`));
  // `bytes` is not in @prifly/extension-api v0.8.0's ConfirmMailFile yet, so compare it untyped.
  const attached: unknown[] = mail?.attachments ?? [];
  expect(attached).toEqual([
    {
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: PDF_BYTES.length,
      bytes: PDF_BYTES,
    },
  ]);
  expect(mail?.text).not.toContain("cid:");
});

const TOOLS: [string, Record<string, unknown>, boolean][] = [
  ["gmail_send", { to: "x@example.com", cc: "c@example.com", subject: "Hej", body: "Hi" }, false],
  ["gmail_reply", { thread_id: "t1", body: "Yes." }, false],
  ["gmail_forward", { thread_id: "t1", to: "x@example.com", note: "FYI" }, false],
  ["gmail_new_draft", { to: "x@example.com", subject: "Hej", body: "Hi" }, true],
  ["gmail_draft_reply", { thread_id: "t1", body: "Yes." }, true],
];

for (const [name, args, draft] of TOOLS) {
  test(`${name}: the confirm spec has a mail, ${draft ? "" : "not "}marked as a draft`, async () => {
    const w = started();
    await w.call(name, args);
    const mail = shownMail(w);
    expect(mail).toBeDefined();
    expect(mail?.from).toBe(SELF);
    expect(mail?.draft).toBe(draft ? true : undefined);
    expect(mail?.to).not.toBe("");
    expect(mail?.text).not.toBe("");
    expect(w.confirms[0]?.spec.details).toBeString();
  });
}

test("a forward's card mail lists the original's attachments", async () => {
  const w = started();
  await w.call("gmail_forward", { thread_id: "t1", message_id: "m1", to: "x@example.com" });
  expect(shownMail(w)?.attachments?.map((each) => each.filename)).toEqual([
    "logo.png",
    "invoice.pdf",
  ]);
});

test("a new draft's summary shows the recipient's name in plain Unicode", async () => {
  const w = started();
  await w.call("gmail_new_draft", {
    to: "Pär Dahlund <par.dahlund@clwork.se>",
    subject: "Hej",
    body: "Hi",
  });
  const summary = w.confirms[0]?.spec.summary ?? "";
  expect(summary).toContain("Pär Dahlund <par.dahlund@clwork.se>");
  expect(summary).not.toContain("=?");
});
