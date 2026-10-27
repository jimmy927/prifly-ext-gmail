import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBase64url } from "../mime";
import { CANCELLED } from "../tool-kit";
import { b64 } from "./fake-gmail";
import { world } from "./world";

let temp = "";
let stop: (() => void) | undefined;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "gmail-choose-"));
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

/** The five compose tools: arguments that make a mail, its card's title, and what the tool's name does. */
const COMPOSE: [string, Record<string, unknown>, string, "draft" | "send"][] = [
  [
    "gmail_new_draft",
    { to: "x@example.com", subject: "Hej", body: "Hello" },
    "Write an email",
    "draft",
  ],
  ["gmail_draft_reply", { thread_id: "t1", body: "10 works." }, "Reply in the thread", "draft"],
  ["gmail_send", { to: "x@example.com", subject: "Hej", body: "Hello" }, "Write an email", "send"],
  ["gmail_reply", { thread_id: "t1", body: "Yes." }, "Reply in the thread", "send"],
  [
    "gmail_forward",
    { thread_id: "t1", to: "x@example.com", note: "FYI" },
    "Forward an email",
    "send",
  ],
];

for (const [name, args, title, own] of COMPOSE) {
  test(`${name}: "draft" on the two-way card saves a draft and sends nothing`, async () => {
    const w = started({ choose: "draft" });
    const answer = await w.call(name, args);
    expect(answer).toStartWith("The reader saved it as a draft: Draft r1 is in ");
    expect(w.chooses.length).toBe(1);
    expect(w.chooses[0]?.writesBefore).toBe(0);
    expect(w.confirms).toEqual([]);
    expect(w.chooses[0]?.spec.title).toBe(title);
    expect(w.chooses[0]?.spec.summary).toEndWith(". Save it in Drafts, or send it now.");
    expect(w.chooses[0]?.spec.mail?.draft).toBe(false);
    expect([...w.gmail.drafts.keys()]).toEqual(["r1"]);
    expect(w.gmail.sent).toEqual([]);
  });

  test(`${name}: "send" on the two-way card sends it, leaving no draft`, async () => {
    const w = started({ choose: "send" });
    const answer = await w.call(name, args);
    expect(answer).toMatch(/^The reader sent it: message s1 in thread \w+\.$/);
    expect(w.chooses.length).toBe(1);
    expect(w.chooses[0]?.writesBefore).toBe(0);
    expect(w.confirms).toEqual([]);
    expect(w.gmail.sent.length).toBe(1);
    expect(w.gmail.drafts.size).toBe(0);
  });

  test(`${name}: Cancel on the two-way card writes nothing`, async () => {
    const w = started({ choose: null });
    expect(await w.call(name, args)).toBe(CANCELLED);
    expect(w.chooses.length).toBe(1);
    expect(w.confirms).toEqual([]);
    expect(w.writes()).toEqual([]);
  });

  test(`${name}: without "choose-mail" the confirm card does what the name says (${own})`, async () => {
    const w = started();
    const answer = await w.call(name, args);
    expect(w.chooses).toEqual([]);
    expect(w.confirms.length).toBe(1);
    expect(answer).not.toContain("The reader");
    expect(w.gmail.sent.length).toBe(own === "send" ? 1 : 0);
    expect(w.gmail.drafts.size).toBe(own === "draft" ? 1 : 0);
  });
}

test("the two-way card says neutrally what the mail is, with its files", async () => {
  const w = started({ choose: "draft" });
  const file = join(temp, "notes.txt");
  await writeFile(file, "the notes");
  await w.call("gmail_send", {
    to: "Ada <ada@example.com>",
    subject: "Notes",
    body: "Here they are.",
    attachments: [file],
  });
  const spec = w.chooses[0]?.spec;
  expect(spec?.summary).toBe(
    "“Notes” to Ada <ada@example.com>, with 1 attachment. Save it in Drafts, or send it now.",
  );
  expect(spec?.details).toContain("To: Ada <ada@example.com>");
  expect(spec?.mail?.attachments?.map((each) => each.filename)).toEqual(["notes.txt"]);
  // Asked to send, the reader saved it: a draft, no thread, nothing sent.
  expect(w.gmail.drafts.get("r1")?.message.threadId).toBeUndefined();
  expect(w.gmail.sent).toEqual([]);
});

test("a reply saved as a draft sits in its thread; a forward sent keeps its own thread", async () => {
  const w = started({ choose: "draft" });
  const answer = await w.call("gmail_reply", { thread_id: "t1", body: "Yes." });
  expect(answer).toBe(
    "The reader saved it as a draft: Draft r1 is in the thread “Plans för Tuesday” in Gmail: open the thread to see it under the last message.",
  );
  expect(w.gmail.drafts.get("r1")?.message.threadId).toBe("t1");
  expect(w.chooses[0]?.spec.summary).toBe(
    "“Re: Plans för Tuesday” to Bob <bob@example.com>, in the thread. Save it in Drafts, or send it now.",
  );
  const sent = started({ choose: "send" });
  await sent.call("gmail_forward", { thread_id: "t1", message_id: "m1", to: "x@example.com" });
  expect(sent.gmail.sent[0]?.threadId).toBeUndefined();
  expect(decodeBase64url(sent.gmail.sent[0]?.raw ?? "")).toContain('filename="invoice.pdf"');
});

test("replace_draft_id with Send updates the draft, then sends it through drafts/send, once", async () => {
  const w = started({ choose: "send" });
  w.gmail.drafts.set("r1", { id: "r1", message: { raw: b64("old text"), threadId: "t1" } });
  const answer = await w.call("gmail_draft_reply", {
    thread_id: "t1",
    body: "The new text.",
    replace_draft_id: "r1",
  });
  expect(answer).toBe("The reader sent it: message s1 in thread t1.");
  expect(w.chooses[0]?.spec.summary).toContain("in the thread in place of draft r1.");
  const writes = w.writes().map((each) => `${each.method} ${new URL(each.url).pathname}`);
  expect(writes).toEqual([
    "PUT /gmail/v1/users/me/drafts/r1",
    "POST /gmail/v1/users/me/drafts/send",
  ]);
  expect(w.gmail.draftsSent).toEqual(["r1"]);
  expect(w.gmail.drafts.size).toBe(0);
  expect(w.gmail.sent.length).toBe(1);
  expect(w.gmail.sent[0]?.threadId).toBe("t1");
  // What went out is the updated draft, its body base64 as rawReply writes it.
  expect(decodeBase64url(w.gmail.sent[0]?.raw ?? "")).toContain(
    Buffer.from("The new text.").toString("base64"),
  );
});

test("the two-way card is asked bound to prifly's api", async () => {
  const w = started();
  let bound = false;
  const api = w.fake.api;
  Object.assign(api, {
    features: [...(api.features ?? []), "choose-mail"],
    chooseMail(this: unknown) {
      bound = this === api;
      return Promise.resolve(null);
    },
  });
  expect(await w.call("gmail_send", { to: "x@example.com", subject: "s", body: "b" })).toBe(
    CANCELLED,
  );
  expect(bound).toBe(true);
});
