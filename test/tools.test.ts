import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBase64url } from "../mime";
import { PDF_BYTES, PNG_BYTES } from "./fake-gmail";
import { SECOND_ACCOUNT, world } from "./world";

let temp = "";
let stop: (() => void) | undefined;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "gmail-ext-"));
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

test("gmail_search answers one line per thread, as the CLI does", async () => {
  const w = started();
  expect(await w.call("gmail_search", { query: "", max: 5 })).toBe(
    [
      "t1 | 2 msg | Mon, 5 Oct 2026 10:30:00 +0200 | Bob <bob@example.com> | Plans för Tuesday",
      "t2 | 1 msg | Tue, 6 Oct 2026 08:00:00 +0200 | Dana <dana@example.com> | Invoice question",
    ].join("\n"),
  );
  expect(await w.call("gmail_search", { query: "nothing-matches" })).toBe("No threads found.");
});

test("gmail_search asks for at most 100 threads, 20 by default", async () => {
  const w = started();
  await w.call("gmail_search", { query: "" });
  await w.call("gmail_search", { query: "", max: 500 });
  const limits = w.connections.requests
    .map((request) => new URL(request.url))
    .filter((url) => url.pathname.endsWith("/threads"))
    .map((url) => url.searchParams.get("maxResults"));
  expect(limits).toEqual(["20", "100"]);
});

test("gmail_thread returns the thread and saves thread.md, the png and the pdf in the scratchpad", async () => {
  const w = started();
  const answer = await w.call("gmail_thread", { thread_id: "t1" }, temp);
  const folder = join(temp, "gmail", "t1");
  expect(answer).toContain("# Plans för Tuesday");
  expect(answer).toContain("Can we meet Tuesday? Café at 10.");
  expect(answer).toContain("Works for me.");
  expect(answer.indexOf("Hello Jimmy")).toBeLessThan(answer.indexOf("Works for me"));
  for (const name of ["thread.md", "logo.png", "invoice.pdf"]) {
    expect(answer).toContain(join(folder, name));
  }
  expect(await readFile(join(folder, "thread.md"), "utf8")).toContain("## Attachments");
  expect(new Uint8Array(await readFile(join(folder, "logo.png")))).toEqual(PNG_BYTES);
  expect(new Uint8Array(await readFile(join(folder, "invoice.pdf")))).toEqual(PDF_BYTES);
});

test("without a scratchpad gmail_thread saves under the extension's folder", async () => {
  const w = started({ folder: temp });
  await w.call("gmail_thread", { thread_id: "t1" });
  expect(existsSync(join(temp, "threads", "t1", "thread.md"))).toBe(true);
  expect(existsSync(join(temp, "threads", "t1", "logo.png"))).toBe(true);
});

test("with no scratchpad and no folder gmail_thread returns the text and writes nothing", async () => {
  const w = started({ folder: "" });
  const before = process.cwd();
  process.chdir(temp);
  try {
    const answer = await w.call("gmail_thread", { thread_id: "t1" });
    expect(answer).toContain("# Plans för Tuesday");
    expect(answer).toContain("Nothing was saved");
    expect(readdirSync(temp)).toEqual([]);
  } finally {
    process.chdir(before);
  }
});

test("two attachments with one name are numbered, and a path cannot leave the folder", async () => {
  const w = started();
  const message = w.gmail.threads.get("t1")?.[0] as {
    payload: { parts: { filename?: string; body?: unknown; mimeType: string }[] };
  };
  for (const part of message.payload.parts) {
    if (part.filename === "logo.png") part.filename = "../../logo.png";
    if (part.filename === "invoice.pdf") part.filename = "logo.png";
  }
  await w.call("gmail_thread", { thread_id: "t1" }, temp);
  const folder = join(temp, "gmail", "t1");
  expect(existsSync(join(folder, ".._.._logo.png"))).toBe(false);
  expect(existsSync(join(folder, "logo.png"))).toBe(true);
  expect(existsSync(join(folder, "logo (2).png"))).toBe(true);
  expect(existsSync(join(temp, "logo.png"))).toBe(false);
});

test("an attachment over 25 MB is listed as not saved", async () => {
  const w = started();
  const message = w.gmail.threads.get("t1")?.[0] as {
    payload: { parts: { filename?: string; body?: { size: number } }[] };
  };
  for (const part of message.payload.parts) {
    if (part.filename === "invoice.pdf" && part.body) part.body.size = 26 * 1024 * 1024;
  }
  const answer = await w.call("gmail_thread", { thread_id: "t1" }, temp);
  expect(answer).toContain("Not saved:");
  expect(answer).toContain("invoice.pdf: 26.0 MB is over 25 MB");
  expect(existsSync(join(temp, "gmail", "t1", "invoice.pdf"))).toBe(false);
  expect(existsSync(join(temp, "gmail", "t1", "logo.png"))).toBe(true);
});

test("gmail_draft_reply puts a threaded draft in the drafts store", async () => {
  const w = started();
  const answer = await w.call("gmail_draft_reply", { thread_id: "t1", body: "10 works." });
  expect(answer).toBe(
    "Draft r1 is in the thread “Plans för Tuesday” in Gmail: open the thread to see it under the last message.",
  );
  const draft = w.gmail.drafts.get("r1");
  expect(draft?.message.threadId).toBe("t1");
  const raw = decodeBase64url(draft?.message.raw ?? "");
  expect(raw).toContain("In-Reply-To: <m2@example.com>");
  expect(raw).toContain("To: Bob <bob@example.com>");
  expect(raw).toContain("Cc: Ada Lovelace <ada@example.com>, carol@example.com");
});

test("all: false leaves Cc out", async () => {
  const w = started();
  await w.call("gmail_draft_reply", { thread_id: "t1", body: "x", all: false });
  expect(decodeBase64url(w.gmail.drafts.get("r1")?.message.raw ?? "")).not.toContain("Cc:");
});

test("replace_draft_id updates the same draft instead of adding one", async () => {
  const w = started();
  await w.call("gmail_draft_reply", { thread_id: "t1", body: "first" });
  const answer = await w.call("gmail_draft_reply", {
    thread_id: "t1",
    body: "second",
    replace_draft_id: "r1",
  });
  expect(answer).toContain("Draft r1 is in the thread");
  expect([...w.gmail.drafts.keys()]).toEqual(["r1"]);
  const raw = decodeBase64url(w.gmail.drafts.get("r1")?.message.raw ?? "");
  expect(
    Buffer.from(raw.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "", "base64").toString(),
  ).toBe("second");
  expect(w.gmail.drafts.get("r1")?.message.threadId).toBe("t1");
});

test("gmail_new_draft creates a draft with no thread", async () => {
  const w = started();
  const answer = await w.call("gmail_new_draft", {
    to: "x@example.com",
    cc: "y@example.com",
    subject: "Hej",
    body: "Hello",
  });
  expect(answer).toContain("Draft r1");
  expect(answer).toContain("Nothing was sent");
  expect(w.gmail.drafts.get("r1")?.message.threadId).toBeUndefined();
  expect(decodeBase64url(w.gmail.drafts.get("r1")?.message.raw ?? "")).toContain(
    "Cc: y@example.com",
  );
});

test("with no account connected every tool says to connect one", async () => {
  const w = started({ accounts: [] });
  const text =
    "No Google account is connected for Gmail: connect one in prifly's Vault → Connections.";
  expect(await w.call("gmail_search", { query: "x" })).toBe(text);
  expect(await w.call("gmail_thread", { thread_id: "t1" })).toBe(text);
  expect(await w.call("gmail_draft_reply", { thread_id: "t1", body: "x" })).toBe(text);
  expect(await w.call("gmail_new_draft", { to: "a@b.c", subject: "s", body: "x" })).toBe(text);
});

test("a revoked grant gives the sign-in text, not an error", async () => {
  const w = started();
  w.connections.endpoint.revoke("g-1");
  expect(await w.call("gmail_search", { query: "x" })).toBe(
    "The Gmail grant for jimmy@example.com ended: sign in again in prifly's Vault → Connections.",
  );
  expect(await w.call("gmail_draft_reply", { thread_id: "t1", body: "x" })).toContain(
    "sign in again",
  );
});

test("an error status from Gmail is reported with its first 300 characters", async () => {
  const w = started();
  expect(await w.call("gmail_thread", { thread_id: "nope" }, temp)).toBe(
    "Gmail answered 404 for jimmy@example.com: not found",
  );
});

test("the account setting picks the second of two accounts; an account argument wins", async () => {
  const w = started({
    accounts: [{ ...SECOND_ACCOUNT, id: "g-0", account: "first@example.com" }, SECOND_ACCOUNT],
    settings: { account: "Second@Example.com" },
  });
  await w.call("gmail_search", { query: "" });
  expect(new Set(w.connections.requests.map((each) => each.headers.get("Authorization")))).toEqual(
    new Set(["Bearer token-g-2-1", "Bearer token-g-2-2", "Bearer token-g-2-3"]),
  );
  const before = w.connections.requests.length;
  await w.call("gmail_search", { query: "", account: "first@example.com" });
  const used = w.connections.requests
    .slice(before)
    .map((each) => each.headers.get("Authorization"));
  expect(used.every((each) => each?.startsWith("Bearer token-g-0-"))).toBe(true);
  expect(await w.call("gmail_search", { query: "", account: "nobody@example.com" })).toContain(
    "No Google account is connected",
  );
});

test("an empty account setting uses the first connected account", async () => {
  const w = started({
    accounts: [SECOND_ACCOUNT, { ...SECOND_ACCOUNT, id: "g-9" }],
    settings: { account: "" },
  });
  await w.call("gmail_search", { query: "" });
  expect(w.connections.requests[0]?.headers.get("Authorization")).toStartWith("Bearer token-g-2-");
});

test("guard: no tool ever sends a request to a /send URL, and every call is a read or a draft", async () => {
  const w = started();
  await w.call("gmail_search", { query: "" });
  await w.call("gmail_thread", { thread_id: "t1" }, temp);
  await w.call("gmail_draft_reply", { thread_id: "t1", body: "a" });
  await w.call("gmail_draft_reply", { thread_id: "t1", body: "b", replace_draft_id: "r1" });
  await w.call("gmail_new_draft", { to: "a@example.com", subject: "s", body: "b" });
  const sent = w.connections.requests.map((each) => `${each.method} ${new URL(each.url).pathname}`);
  expect(sent.length).toBeGreaterThan(8);
  for (const line of sent) expect(line).not.toContain("/send");
  const writes = sent.filter((line) => !line.startsWith("GET "));
  expect(writes.every((line) => line.includes("/drafts"))).toBe(true);
});
