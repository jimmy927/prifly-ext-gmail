import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_SEND } from "../api-tools";
import { decodeBase64url } from "../mime";
import { CANCELLED, NO_CONFIRM } from "../tool-kit";
import { world } from "./world";

let temp = "";
let stop: (() => void) | undefined;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "gmail-writes-"));
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

/** Every tool that changes the mailbox, with arguments that make it write. */
const WRITES: [string, Record<string, unknown>][] = [
  ["gmail_draft_reply", { thread_id: "t1", body: "10 works." }],
  ["gmail_new_draft", { to: "x@example.com", subject: "Hej", body: "Hello" }],
  ["gmail_send", { to: "x@example.com", subject: "Hej", body: "Hello" }],
  ["gmail_reply", { thread_id: "t1", body: "Yes." }],
  ["gmail_forward", { thread_id: "t1", to: "x@example.com", note: "FYI" }],
  ["gmail_label_create", { name: "Receipts" }],
  ["gmail_label_threads", { thread_ids: ["t1"], add: ["Work"], remove: ["INBOX"] }],
  ["gmail_archive", { thread_ids: ["t1", "t2"] }],
  ["gmail_mark", { thread_ids: ["t1"], read: true }],
  ["gmail_mark", { thread_ids: ["t2"], read: false }],
  ["gmail_trash", { thread_ids: ["t2"] }],
  ["gmail_api", { method: "POST", path: "/labels", body: { name: "Via API" } }],
  ["gmail_api", { method: "DELETE", path: "/labels/Label_1" }],
];

for (const [name, args] of WRITES) {
  const label = `${name} ${JSON.stringify(args)}`;

  test(`${label}: confirms before any write request, then writes`, async () => {
    const w = started();
    const answer = await w.call(name, args);
    expect(w.confirms.length).toBe(1);
    expect(w.confirms[0]?.writesBefore).toBe(0);
    expect(w.writes().length).toBeGreaterThan(0);
    expect(answer).not.toBe(CANCELLED);
  });

  test(`${label}: a cancelled confirm sends nothing`, async () => {
    const w = started({ confirm: false });
    expect(await w.call(name, args)).toBe(CANCELLED);
    expect(w.confirms.length).toBe(1);
    expect(w.writes()).toEqual([]);
    expect(w.gmail.sent).toEqual([]);
    expect(w.gmail.drafts.size).toBe(0);
  });
}

test("without api.confirm (an older prifly) no write is made", async () => {
  const w = started();
  delete w.fake.api.confirm;
  for (const [name, args] of WRITES) expect(await w.call(name, args)).toBe(NO_CONFIRM);
  expect(w.writes()).toEqual([]);
});

test("gmail_api GET runs at once, without a confirm card", async () => {
  const w = started();
  const answer = await w.call("gmail_api", { path: "/profile" });
  expect(JSON.parse(answer)).toEqual({ emailAddress: "jimmy@example.com", historyId: "12" });
  const labels = await w.call("gmail_api", {
    method: "get",
    path: "gmail/v1/users/me/labels/INBOX",
  });
  expect(JSON.parse(labels)["threadsUnread"]).toBe(1);
  expect(w.confirms).toEqual([]);
});

test("gmail_api puts the query in the URL and refuses a path outside users/me", async () => {
  const w = started();
  await w.call("gmail_api", { path: "/threads", query: { q: "is:unread", labelIds: ["A", "B"] } });
  const url = new URL(w.connections.requests.at(-1)?.url ?? "");
  expect(url.searchParams.get("q")).toBe("is:unread");
  expect(url.searchParams.getAll("labelIds")).toEqual(["A", "B"]);
  for (const path of ["https://evil.example.com/x", "/../../drive/v3/files", "/x?y=1", ""]) {
    expect(await w.call("gmail_api", { method: "POST", path })).toContain("path must be");
  }
  expect(await w.call("gmail_api", { method: "TRACE", path: "/x" })).toContain("method must be");
  expect(w.confirms).toEqual([]);
  expect(w.writes()).toEqual([]);
});

test("gmail_api shows the exact request on the card, with a raw mail decoded", async () => {
  const w = started();
  const raw = Buffer.from("To: ada@example.com\r\nSubject: Hi\r\n\r\nHello").toString("base64url");
  await w.call("gmail_api", { method: "POST", path: "/drafts", body: { message: { raw } } });
  const spec = w.confirms[0]?.spec;
  expect(spec?.summary).toBe("POST /drafts");
  expect(spec?.details).toContain("POST https://gmail.googleapis.com/gmail/v1/users/me/drafts");
  expect(spec?.details).toContain(raw);
  expect(spec?.details).toContain("To: ada@example.com\r\nSubject: Hi");
  expect(w.gmail.drafts.get("r1")?.message.raw).toBe(raw);
  expect(w.gmail.sent).toEqual([]);
});

test("gmail_api refuses every send path, whatever the method, without a card", async () => {
  const w = started({ choose: "send" });
  const raw = Buffer.from("To: ada@example.com\r\nSubject: Hi\r\n\r\nHello").toString("base64url");
  const paths = [
    "/messages/send",
    "/drafts/send",
    "messages/send",
    "users/me/messages/send",
    "/gmail/v1/users/me/drafts/send",
    "/messages/send/",
    "/drafts/send?alt=json",
    "/messages/SEND",
    "/messages/%73end",
  ];
  for (const path of paths) {
    for (const method of ["POST", "PUT", "GET"]) {
      const answer = await w.call("gmail_api", { method, path, body: { raw, id: "r1" } });
      expect(answer).toBe(NO_SEND);
    }
  }
  expect(w.confirms).toEqual([]);
  expect(w.chooses).toEqual([]);
  // Only the status line's own label reads went out: no send, and no write.
  expect(w.connections.requests.filter((each) => each.url.includes("/send"))).toEqual([]);
  expect(w.writes()).toEqual([]);
  expect(w.gmail.sent).toEqual([]);
});

test("gmail_api still makes other writes after the card, and its description says it never sends", async () => {
  const w = started();
  const answer = await w.call("gmail_api", {
    method: "POST",
    path: "/labels",
    body: { name: "Sender" },
  });
  expect(JSON.parse(answer)["name"]).toBe("Sender");
  expect(w.confirms.length).toBe(1);
  const tool = w.fake.tools().find((each) => each.name === "gmail_api");
  expect(tool?.description).toContain("never sends mail");
});

test("gmail_send shows the recipients, subject, text and files, then sends them", async () => {
  const w = started();
  const file = join(temp, "notes.txt");
  await writeFile(file, "the notes");
  const answer = await w.call("gmail_send", {
    to: "Ada <ada@example.com>",
    cc: "bob@example.com",
    bcc: "carol@example.com",
    subject: "Notes",
    body: "Here they are.",
    attachments: [file],
  });
  expect(answer).toBe("Sent: message s1 in thread ts1.");
  const spec = w.confirms[0]?.spec;
  expect(spec?.title).toBe("Send an email");
  expect(spec?.summary).toBe("Send “Notes” to Ada <ada@example.com> with 1 attachment");
  expect(spec?.details).toBe(
    [
      "To: Ada <ada@example.com>",
      "Cc: bob@example.com",
      "Bcc: carol@example.com",
      "Subject: Notes",
      "Attachments:",
      "- notes.txt (1 KB)",
      "",
      "Here they are.",
    ].join("\n"),
  );
  const mail = decodeBase64url(w.gmail.sent[0]?.raw ?? "");
  expect(mail).toContain("Bcc: carol@example.com");
  expect(mail).toContain("Content-Type: multipart/mixed");
  expect(mail).toContain('Content-Disposition: attachment; filename="notes.txt"');
  expect(mail).toContain(Buffer.from("the notes").toString("base64"));
});

test("gmail_send refuses a relative or missing file before any card", async () => {
  const w = started();
  const base = { to: "a@example.com", subject: "s", body: "b" };
  expect(await w.call("gmail_send", { ...base, attachments: ["notes.txt"] })).toContain(
    "is not an absolute path",
  );
  expect(await w.call("gmail_send", { ...base, attachments: [join(temp, "gone.pdf")] })).toContain(
    "cannot read",
  );
  expect(w.confirms).toEqual([]);
  expect(w.writes()).toEqual([]);
});

test("gmail_reply sends in the thread to the last sender, the others on Cc", async () => {
  const w = started();
  await w.call("gmail_reply", { thread_id: "t1", body: "Yes." });
  expect(w.confirms[0]?.spec.details).toBe(
    [
      "To: Bob <bob@example.com>",
      "Cc: Ada Lovelace <ada@example.com>, carol@example.com",
      "Subject: Re: Plans för Tuesday",
      "",
      "Yes.",
    ].join("\n"),
  );
  expect(w.gmail.sent[0]?.threadId).toBe("t1");
  expect(decodeBase64url(w.gmail.sent[0]?.raw ?? "")).toContain("In-Reply-To: <m2@example.com>");
});

test("gmail_forward carries the note, the forwarded mail and its attachments", async () => {
  const w = started();
  await w.call("gmail_forward", {
    thread_id: "t1",
    message_id: "m1",
    to: "x@example.com",
    note: "FYI",
  });
  const details = w.confirms[0]?.spec.details ?? "";
  expect(details).toContain("Subject: Fwd: Plans för Tuesday");
  expect(details).toContain("- logo.png");
  expect(details).toContain("- invoice.pdf");
  expect(details).toContain("FYI\n\n---------- Forwarded message ---------");
  expect(details).toContain("Can we meet Tuesday? Café at 10.");
  const mail = decodeBase64url(w.gmail.sent[0]?.raw ?? "");
  expect(mail).toContain('filename="invoice.pdf"');
  expect(w.gmail.sent[0]?.threadId).toBeUndefined();
});

test("gmail_label_threads finds labels by name and refuses an unknown one without a card", async () => {
  const w = started();
  expect(await w.call("gmail_label_threads", { thread_ids: ["t2"], add: ["work"] })).toBe(
    "Done: 1 thread relabelled.",
  );
  expect(w.gmail.threads.get("t2")?.[0]?.["labelIds"]).toEqual(["INBOX", "Label_1"]);
  expect(w.confirms[0]?.spec.details).toContain("Add: work");
  expect(w.confirms[0]?.spec.details).toContain("t2 | Dana <dana@example.com> | Invoice question");
  const before = w.writes().length;
  expect(await w.call("gmail_label_threads", { thread_ids: ["t2"], add: ["Nope"] })).toContain(
    "no label called Nope",
  );
  expect(w.confirms.length).toBe(1);
  expect(w.writes().length).toBe(before);
});

test("archive, mark and trash change the threads as the card says", async () => {
  const w = started();
  expect(await w.call("gmail_archive", { thread_ids: ["t1", "t2"] })).toBe(
    "Done: 2 threads archived.",
  );
  expect(w.confirms[0]?.spec.summary).toBe("2 threads will be archived");
  const labels = (id: string) =>
    w.gmail.threads.get(id)?.flatMap((each) => each["labelIds"] as string[]);
  expect(labels("t1")).not.toContain("INBOX");
  await w.call("gmail_mark", { thread_ids: ["t1"] });
  expect(labels("t1")).not.toContain("UNREAD");
  await w.call("gmail_mark", { thread_ids: ["t2"], read: false });
  expect(labels("t2")).toContain("UNREAD");
  expect(await w.call("gmail_trash", { thread_ids: ["t2"] })).toBe(
    "Done: 1 thread moved to the trash.",
  );
  expect(w.gmail.trashed).toEqual(["t2"]);
});

test("a thread Gmail does not know stops the change before the card", async () => {
  const w = started();
  expect(await w.call("gmail_trash", { thread_ids: ["nope"] })).toContain("Gmail answered 404");
  expect(w.confirms).toEqual([]);
  expect(w.writes()).toEqual([]);
});
