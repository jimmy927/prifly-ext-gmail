import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchBoard, LaunchChoice } from "@prifly/extension-api";
import { clock, columnsOf, formatWhen, SWITCH_KEY, withAttachment } from "../board";
import { choices, launch } from "../index";
import { tick } from "../poll";
import { FIRST_ACCOUNT, SECOND_ACCOUNT, world } from "./world";

let temp = "";
let stop: (() => void) | undefined;
const realNow = clock.now;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "gmail-board-"));
  clock.now = () => new Date("Wed, 7 Oct 2026 12:00:00 +0200");
});
afterEach(async () => {
  stop?.();
  clock.now = realNow;
  await rm(temp, { recursive: true, force: true });
});

function started(options: Parameters<typeof world>[0] = {}) {
  const w = world({ folder: temp, ...options });
  stop = w.stop;
  return w;
}

const asBoard = (answer: LaunchChoice[] | LaunchBoard): LaunchBoard => {
  if (Array.isArray(answer)) throw new Error("expected a board, got a plain list");
  return answer;
};

const asRows = (answer: LaunchChoice[] | LaunchBoard): LaunchChoice[] => {
  if (!Array.isArray(answer)) throw new Error("expected a plain list, got a board");
  return answer;
};

test("columnsOf parses Name=query pairs and tolerates spaces and empty parts", () => {
  expect(columnsOf("A = from:ada ;; B=is:starred ; ;")).toEqual([
    { name: "A", query: "from:ada" },
    { name: "B", query: "is:starred" },
  ]);
  expect(columnsOf("Q=a=b")).toEqual([{ name: "Q", query: "a=b" }]);
});

test("columnsOf falls back to the default three when nothing parses", () => {
  const names = ["Unread", "Inbox", "Starred"];
  expect(columnsOf(undefined).map((each) => each.name)).toEqual(names);
  expect(columnsOf("").map((each) => each.name)).toEqual(names);
  expect(columnsOf("junk; =x; y=; ;").map((each) => each.name)).toEqual(names);
  expect(columnsOf(42).map((each) => each.name)).toEqual(names);
  expect(columnsOf(undefined)[0]?.query).toBe("is:unread in:inbox");
});

test("formatWhen writes the time today, yesterday, else day and month", () => {
  const at = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute);
  const now = at(9, 15, 0);
  expect(formatWhen(at(9, 8, 5).toUTCString(), now)).toBe("08:05");
  expect(formatWhen(at(8, 23, 59).toUTCString(), now)).toBe("yesterday");
  expect(formatWhen(at(1, 9, 0).toUTCString(), now)).toBe("1 Oct");
  expect(formatWhen("not a date", now)).toBe("");
  expect(formatWhen("", now)).toBe("");
});

test("the default board has Unread, Inbox and Starred columns, ids c0..c2", async () => {
  const w = started();
  const board = asBoard(await choices("thread", ""));
  expect(board.columns).toEqual([
    { id: "c0", name: "Unread" },
    { id: "c1", name: "Inbox" },
    { id: "c2", name: "Starred" },
  ]);
  const searches = w.connections.requests
    .map((request) => new URL(request.url))
    .filter((url) => url.pathname.endsWith("/threads"))
    .map((url) => url.searchParams.get("q"));
  expect(searches.filter((q) => !q?.endsWith("has:attachment"))).toEqual([
    "is:unread in:inbox",
    "in:inbox",
    "is:starred",
  ]);
  expect(searches.filter((q) => q?.endsWith("has:attachment")).sort()).toEqual([
    "in:inbox has:attachment",
    "is:starred has:attachment",
    "is:unread in:inbox has:attachment",
  ]);
  expect(w.connections.requests.every((request) => !request.url.includes("send"))).toBe(true);
});

test("a thread shown in an earlier column is not repeated in a later one", async () => {
  started({ settings: { columns: "Mine=dana; Rest=in; Again=dana" } });
  const board = asBoard(await choices("thread", ""));
  expect(board.columns.map((each) => each.id)).toEqual(["c0", "c1", "c2"]);
  expect(board.items.map((each) => [each.key, each.group])).toEqual([
    ["t2", "c0"],
    ["t1", "c1"],
  ]);
});

test("a card carries subject, senders and date, people, badges and the Gmail link", async () => {
  started({ settings: { columns: "All=in" } });
  const board = asBoard(await choices("thread", ""));
  const [first, second] = board.items;
  expect(first).toEqual({
    key: "t1",
    group: "c0",
    title: "Plans för Tuesday",
    detail: "Ada, Bob · 5 Oct",
    people: ["Ada Lovelace", "Bob", "carol@example.com"],
    url: "https://mail.google.com/mail/u/0/#all/t1",
    badges: { comments: 2, attachments: 1 },
  });
  expect(second).toEqual({
    key: "t2",
    group: "c0",
    title: "Invoice question",
    detail: "Dana · yesterday",
    people: ["Dana"],
    url: "https://mail.google.com/mail/u/0/#all/t2",
  });
});

test("a message from today shows its time of day", async () => {
  started({ settings: { columns: "All=in" } });
  clock.now = () => new Date(new Date("Tue, 6 Oct 2026 08:00:00 +0200").getTime() + 3_600_000);
  const board = asBoard(await choices("thread", ""));
  expect(board.items[1]?.detail).toMatch(/^Dana · \d\d:\d\d$/);
});

test("a typed filter is one Results column for that Gmail query", async () => {
  const w = started();
  const board = asBoard(await choices("thread", "  dana "));
  expect(board.columns).toEqual([{ id: "c0", name: "Results" }]);
  expect(board.items.map((each) => each.key)).toEqual(["t2"]);
  const searches = w.connections.requests
    .map((request) => new URL(request.url))
    .filter((url) => url.pathname.endsWith("/threads"));
  expect(searches.map((url) => url.searchParams.get("q"))).toEqual(["dana", "dana has:attachment"]);
});

test("with no Google account the board is the one Connect row, and its launch connects", async () => {
  const w = started({ accounts: [] });
  const rows = asRows(await choices("thread", ""));
  expect(rows.map((each) => each.title)).toEqual(["Connect a Google account"]);
  expect(w.fake.flags.get("thread") ?? null).toBeNull();

  const row = rows[0];
  if (row === undefined) throw new Error("no row");
  const answer = await launch("thread", row.key);
  expect(answer).toEqual({ prompt: "", message: "Signed in as google-1@example.com." });
  expect(w.connections.accounts.map((each) => each.account)).toEqual(["google-1@example.com"]);
  expect(asBoard(await choices("thread", "")).columns).toHaveLength(3);
});

test("a revoked grant is one Sign in again row and a warning flag, both gone once it works", async () => {
  const w = started();
  w.connections.endpoint.revoke("g-1");
  const rows = asRows(await choices("thread", ""));
  expect(rows.map((each) => each.title)).toEqual(["Sign in again as jimmy@example.com"]);
  expect(w.fake.flags.get("thread")).toEqual({ tone: "warning", hint: "Sign in again" });

  const row = rows[0];
  if (row === undefined) throw new Error("no row");
  const answer = await launch("thread", row.key);
  expect(answer.prompt).toBe("");
  expect(answer.message).toBe("Signed in as jimmy@example.com.");
  expect(w.connections.endpoint.isEnded("g-1")).toBe(false);

  expect(asBoard(await choices("thread", "")).columns).toHaveLength(3);
  expect(w.fake.flags.get("thread")).toBeNull();
});

test("a sign-in that fails says why and starts nothing", async () => {
  const w = started({ accounts: [] });
  const original = w.fake.api.connections;
  if (original === undefined) throw new Error("no connections");
  w.fake.api.connections = {
    ...original,
    signIn: async () => ({ ok: false, message: "The reader closed the browser." }),
  };
  const rows = asRows(await choices("thread", ""));
  const row = rows[0];
  if (row === undefined) throw new Error("no row");
  expect(await launch("thread", row.key)).toEqual({
    prompt: "",
    message: "The reader closed the browser.",
  });
});

test("Switch account is offered with two connections only, and moves the board to the second", async () => {
  const one = started();
  const alone = asBoard(await choices("thread", ""));
  expect(alone.actions?.map((each) => each.title)).toEqual(["Add another Google account…"]);
  one.stop();

  const w = started({ accounts: [FIRST_ACCOUNT, SECOND_ACCOUNT] });
  const both = asBoard(await choices("thread", ""));
  expect(both.actions?.map((each) => each.title)).toEqual([
    "Switch account…",
    "Add another Google account…",
  ]);
  const lastBearer = () => w.connections.requests.at(-1)?.headers.get("Authorization") ?? "";
  expect(lastBearer()).toStartWith("Bearer token-g-1-");

  expect(await launch("thread", SWITCH_KEY)).toEqual({
    prompt: "",
    message: "Showing second@example.com.",
  });
  const second = asBoard(await choices("thread", ""));
  expect(lastBearer()).toStartWith("Bearer token-g-2-");
  expect(second.actions?.[0]?.detail).toBe("Showing second@example.com");
  expect(JSON.parse(await readFile(join(temp, "state.json"), "utf8")).account).toBe("g-2");

  await launch("thread", SWITCH_KEY);
  // The first account's board was read a while ago: it is read again.
  clock.now = () => new Date("Wed, 7 Oct 2026 12:05:00 +0200");
  await choices("thread", "");
  expect(lastBearer()).toStartWith("Bearer token-g-1-");
});

test("an HTTP 500 from Gmail is one muted row with the error text, not a throw", async () => {
  const w = started();
  w.gmail.throttle.status = 500;
  w.gmail.throttle.times = 99;
  const rows = asRows(await choices("thread", ""));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.title).toStartWith("Gmail answered 500 for jimmy@example.com:");
  expect(rows[0]?.tone).toBe("muted");
  expect(w.fake.flags.get("thread") ?? null).toBeNull();
});

const requestsOf = (w: ReturnType<typeof started>) => w.connections.requests.length;

test("a second choices within pollSeconds makes no Gmail request", async () => {
  const w = started();
  const first = asBoard(await choices("thread", ""));
  const sent = requestsOf(w);
  expect(sent).toBeGreaterThan(0);
  clock.now = () => new Date("Wed, 7 Oct 2026 12:01:00 +0200");
  expect(asBoard(await choices("thread", ""))).toEqual(first);
  expect(requestsOf(w)).toBe(sent);
});

test("the cache is read again once pollSeconds have passed", async () => {
  const w = started({ settings: { pollSeconds: 60 } });
  await choices("thread", "");
  const sent = requestsOf(w);
  clock.now = () => new Date("Wed, 7 Oct 2026 12:00:59 +0200");
  await choices("thread", "");
  expect(requestsOf(w)).toBe(sent);
  clock.now = () => new Date("Wed, 7 Oct 2026 12:01:00 +0200");
  await choices("thread", "");
  expect(requestsOf(w)).toBeGreaterThan(sent);
});

test("after the poller marks it stale the board reads Gmail again", async () => {
  const w = started();
  await tick(w.fake.api);
  await choices("thread", "");
  const sent = requestsOf(w);
  await choices("thread", "");
  expect(requestsOf(w)).toBe(sent);

  w.gmail.deliver("t3", { from: "Karin <karin@example.com>", text: "Hi", subject: "New" });
  await tick(w.fake.api);
  const afterTick = requestsOf(w);
  const board = asBoard(await choices("thread", ""));
  expect(requestsOf(w)).toBeGreaterThan(afterTick);
  expect(board.items.map((each) => each.key)).toContain("t3");
  // Read once more, the board is cached again.
  const cached = requestsOf(w);
  await choices("thread", "");
  expect(requestsOf(w)).toBe(cached);
});

test("each account has its own cached board", async () => {
  const w = started({ accounts: [FIRST_ACCOUNT, SECOND_ACCOUNT] });
  await choices("thread", "");
  const sent = requestsOf(w);
  await launch("thread", SWITCH_KEY);
  await choices("thread", "");
  expect(requestsOf(w)).toBeGreaterThan(sent);
});

test("a typed filter reads Gmail, but the same one within 2 s reuses the answer", async () => {
  const w = started();
  await choices("thread", "");
  const first = asBoard(await choices("thread", "dana"));
  const sent = requestsOf(w);
  expect(asBoard(await choices("thread", "dana"))).toEqual(first);
  expect(requestsOf(w)).toBe(sent);

  await choices("thread", "ada");
  expect(requestsOf(w)).toBeGreaterThan(sent);

  const second = requestsOf(w);
  clock.now = () => new Date("Wed, 7 Oct 2026 12:00:03 +0200");
  await choices("thread", "ada");
  expect(requestsOf(w)).toBeGreaterThan(second);
});

test("metadata answers carry no parts, as in Gmail", async () => {
  const w = started();
  const url = "https://gmail.googleapis.com/gmail/v1/users/me/threads/t1?format=metadata";
  const answer = await w.gmail.provider(new Request(`${url}&metadataHeaders=Subject`));
  const thread = (await answer.json()) as { messages: { payload: Record<string, unknown> }[] };
  expect(thread.messages.length).toBe(2);
  for (const message of thread.messages) {
    expect(message.payload["parts"]).toBeUndefined();
    expect(JSON.stringify(message.payload)).not.toContain("attachmentId");
  }
});

test("the paperclip comes from the has:attachment search, with no count", async () => {
  const w = started({ settings: { columns: "All=in" } });
  const board = asBoard(await choices("thread", ""));
  const badges = Object.fromEntries(board.items.map((each) => [each.key, each.badges]));
  expect(badges["t1"]).toEqual({ comments: 2, attachments: 1 });
  expect(badges["t2"]).toBeUndefined();
  const searches = w.connections.requests
    .map((request) => new URL(request.url))
    .filter((url) => url.pathname.endsWith("/threads"))
    .map((url) => url.searchParams.get("q"));
  expect(searches.sort()).toEqual(["in", "in has:attachment"]);
});

test("a column with OR is bracketed before has:attachment is added", () => {
  expect(withAttachment("from:a OR from:b")).toBe("(from:a OR from:b) has:attachment");
  expect(withAttachment("is:starred")).toBe("is:starred has:attachment");
});
