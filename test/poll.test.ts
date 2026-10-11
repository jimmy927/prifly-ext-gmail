import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock } from "../board";
import { choices, launch, launched } from "../index";
import { tick, timers } from "../poll";
import { FIRST_ACCOUNT, SECOND_ACCOUNT, world } from "./world";

let temp = "";
let stop: (() => void) | undefined;
const realNow = clock.now;
const realTimers = { ...timers };

/** The timers the poller asked for and has not seen fire or cleared. */
let pending: { handle: number; run: () => void; ms: number }[] = [];
let cleared: number[] = [];

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "gmail-poll-"));
  clock.now = () => new Date("Wed, 7 Oct 2026 12:00:00 +0200");
  pending = [];
  cleared = [];
  let next = 0;
  timers.set = (run, ms) => {
    const handle = ++next;
    pending.push({
      handle,
      run: () => {
        pending = pending.filter((each) => each.handle !== handle);
        run();
      },
      ms,
    });
    return handle;
  };
  timers.clear = (handle) => {
    cleared.push(handle as number);
    pending = pending.filter((each) => each.handle !== handle);
  };
});
afterEach(async () => {
  stop?.();
  clock.now = realNow;
  timers.set = realTimers.set;
  timers.clear = realTimers.clear;
  await rm(temp, { recursive: true, force: true });
});

function started(options: Parameters<typeof world>[0] = {}) {
  const w = world({ folder: temp, ...options });
  stop = w.stop;
  const prompts: unknown[] = [];
  w.fake.api.prompt = async (...given) => {
    prompts.push(given);
    return { delivered: true };
  };
  const paths = () => w.connections.requests.map((request) => new URL(request.url).pathname);
  const reached = (part: string) => paths().filter((path) => path.endsWith(part)).length;
  return { ...w, prompts, paths, reached };
}

const stateFile = async () => JSON.parse(await readFile(join(temp, "state.json"), "utf8"));

const KARIN = "Karin Lund <karin@example.com>";

/** A session started from thread `t1`, the poller already seeded. */
async function withSession() {
  const w = started();
  await launch("thread", "t1");
  await launched("thread", "t1", "session-1");
  await tick(w.fake.api);
  return w;
}

const chipOf = (w: ReturnType<typeof started>) => w.fake.shown.at(-1)?.bySession["session-1"]?.[0];

test("the first tick seeds the history id from the profile; the next asks history from it", async () => {
  const w = started();
  await tick(w.fake.api);
  expect(w.reached("/profile")).toBe(1);
  expect(w.reached("/history")).toBe(0);
  await tick(w.fake.api);
  const history = w.connections.requests.find((request) => request.url.includes("/history"));
  expect(new URL(history?.url ?? "").searchParams.get("startHistoryId")).toBe("12");
  expect(w.reached("/profile")).toBe(1);
});

test("a tick costs a few requests: history and one ids-only search, no thread metadata", async () => {
  const w = started();
  await tick(w.fake.api);
  const before = w.connections.requests.length;
  await tick(w.fake.api);
  expect(w.paths().slice(before)).toEqual([
    "/gmail/v1/users/me/history",
    "/gmail/v1/users/me/threads",
  ]);
});

test("a new message in a launched thread turns that session's chip into a warning reply chip", async () => {
  const w = await withSession();
  expect(chipOf(w)?.label).toBe("Gmail: Plans för Tuesday");

  w.gmail.deliver("t1", { from: KARIN, text: "Tuesday is fine." });
  await tick(w.fake.api);

  expect(chipOf(w)).toEqual({
    key: "t1",
    icon: "gmail",
    label: "Gmail: new reply from Karin Lund",
    tone: "warning",
    details: ["Plans för Tuesday", "Ada Lovelace, Bob", "1 new since the session started"],
    url: "https://mail.google.com/mail/u/0/#all/t1",
    launcher: "thread",
  });
  const saved = await stateFile();
  expect(saved.threads.t1.newSince).toBe(1);
  expect(saved.threads.t1.lastFrom).toBe("Karin Lund");

  w.gmail.deliver("t1", { from: KARIN, text: "And Wednesday too." });
  await tick(w.fake.api);
  expect(chipOf(w)?.details.at(-1)).toBe("2 new since the session started");
  expect((await stateFile()).threads.t1.newSince).toBe(2);
});

test("the reply chip survives a restart, and launching again from the thread resets it", async () => {
  const first = await withSession();
  first.gmail.deliver("t1", { from: KARIN, text: "Tuesday is fine." });
  await tick(first.fake.api);
  first.stop();

  const again = started();
  await new Promise((done) => setTimeout(done, 50));
  expect(chipOf(again)?.label).toBe("Gmail: new reply from Karin Lund");

  await launch("thread", "t1");
  await launched("thread", "t1", "session-2");
  expect(chipOf(again)?.label).toBe("Gmail: Plans för Tuesday");
  expect(chipOf(again)?.tone).toBe("info");
  expect((await stateFile()).threads.t1.newSince).toBe(0);
});

test("a session launched while the poller fetches a sender is not lost from the state file", async () => {
  const w = await withSession();
  const connections = w.fake.api.connections;
  if (connections === undefined) throw new Error("no connections");
  const original = connections.fetch;
  connections.fetch = async (id, request, options) => {
    const url = typeof request === "string" ? request : request.url;
    if (url.includes("/messages/")) await launched("thread", "t2", "session-9");
    return await original(id, request, options);
  };
  w.gmail.deliver("t1", { from: KARIN, text: "Tuesday is fine." });
  await tick(w.fake.api);
  const saved = await stateFile();
  expect(saved.threads.t1.newSince).toBe(1);
  expect(saved.threads.t2.sessions).toEqual(["session-9"]);
});

test("mail in a thread no session came from costs no sender request", async () => {
  const w = await withSession();
  w.gmail.deliver("t2", { from: "Dana <dana@example.com>", text: "Yes." });
  await tick(w.fake.api);
  expect(w.reached("/messages/d1")).toBe(0);
});

test("switching account drops the previous account's flag and cached board is skipped while signed out", async () => {
  const w = started({ accounts: [FIRST_ACCOUNT, SECOND_ACCOUNT] });
  await tick(w.fake.api);
  expect(w.fake.flags.get("thread")).toEqual({ tone: "info", hint: "2 unread" });
  await launch("thread", "gmail:switch");
  expect(w.fake.flags.get("thread")).toBeNull();

  await choices("thread", "");
  const sent = w.connections.requests.length;
  await choices("thread", "");
  expect(w.connections.requests.length).toBe(sent);
  w.connections.endpoint.revoke("g-2");
  await tick(w.fake.api);
  const rows = await choices("thread", "");
  expect(Array.isArray(rows)).toBe(true);
});

test("the reader's own drafts and sent mail in the thread are no reply", async () => {
  const w = await withSession();
  w.gmail.deliver("t1", { from: "Jimmy <jimmy@example.com>", text: "Draft", labels: ["DRAFT"] });
  w.gmail.deliver("t1", { from: "Jimmy <jimmy@example.com>", text: "Sent", labels: ["SENT"] });
  await tick(w.fake.api);
  expect(chipOf(w)?.label).toBe("Gmail: Plans för Tuesday");
});

test("a message in another thread leaves the chips alone but marks the board stale", async () => {
  const w = await withSession();
  await choices("thread", "");
  const shown = w.fake.shown.length;
  const cached = w.connections.requests.length;
  await choices("thread", "");
  expect(w.connections.requests.length).toBe(cached);

  w.gmail.deliver("t2", { from: "Dana <dana@example.com>", text: "Yes." });
  await tick(w.fake.api);
  expect(w.fake.shown.length).toBe(shown);
  expect(chipOf(w)?.label).toBe("Gmail: Plans för Tuesday");

  const afterTick = w.connections.requests.length;
  await choices("thread", "");
  expect(w.connections.requests.length).toBeGreaterThan(afterTick);
});

test("a 404 from history reseeds from the profile and marks the board stale", async () => {
  const w = started();
  await tick(w.fake.api);
  await choices("thread", "");
  w.gmail.deliver("t2", { from: "Dana <dana@example.com>", text: "Yes." });
  w.gmail.expireHistory();

  await tick(w.fake.api);
  expect(w.reached("/profile")).toBe(2);
  expect(w.fake.logs.filter((each) => each.event === "poll-failed")).toEqual([]);

  // The new id is the mailbox's now: history from it works and is empty.
  const before = w.connections.requests.length;
  await tick(w.fake.api);
  const sent = w.connections.requests.slice(before).find((r) => r.url.includes("/history"));
  expect(new URL(sent?.url ?? "").searchParams.get("startHistoryId")).toBe("13");

  const cachedAt = w.connections.requests.length;
  await choices("thread", "");
  expect(w.connections.requests.length).toBeGreaterThan(cachedAt);
});

test("an HTTP error is logged and the next tick carries on", async () => {
  const w = started();
  await tick(w.fake.api);
  w.gmail.throttle.status = 500;
  w.gmail.throttle.times = 1;
  await tick(w.fake.api);
  expect(w.fake.logs.filter((each) => each.event === "poll-failed")).toEqual([
    { event: "poll-failed", fields: { account: "jimmy@example.com", status: 500 } },
  ]);
  expect(w.fake.flags.get("thread") ?? null).not.toEqual({
    tone: "warning",
    hint: "Sign in again",
  });
  await tick(w.fake.api);
  expect(w.reached("/history")).toBe(2);
});

test("a revoked grant sets the sign-in warning and pauses; a working grant resumes it", async () => {
  const w = started();
  await tick(w.fake.api);
  w.connections.endpoint.revoke("g-1");
  await tick(w.fake.api);
  expect(w.fake.flags.get("thread")).toEqual({ tone: "warning", hint: "Sign in again" });

  // Each paused tick tries one call, the probe, and goes no further.
  const connections = w.fake.api.connections;
  if (connections === undefined) throw new Error("no connections");
  const original = connections.fetch;
  const probes: string[] = [];
  connections.fetch = (id, request, options) => {
    probes.push(typeof request === "string" ? request : request.url);
    return original(id, request, options);
  };
  await tick(w.fake.api);
  expect(probes).toHaveLength(1);
  expect(probes[0]).toContain("/history");
  connections.fetch = original;
  expect(w.fake.flags.get("thread")).toEqual({ tone: "warning", hint: "Sign in again" });

  w.connections.endpoint.revive("g-1");
  await tick(w.fake.api);
  expect(w.fake.flags.get("thread")).toEqual({ tone: "info", hint: "2 unread" });
});

test("a board that reads fine after the grant is back clears the warning without a tick", async () => {
  const w = started();
  await tick(w.fake.api);
  w.connections.endpoint.revoke("g-1");
  await tick(w.fake.api);
  w.connections.endpoint.revive("g-1");
  await choices("thread", "");
  // The warning is gone; the unread count the poller had before is what shows.
  expect(w.fake.flags.get("thread")).toEqual({ tone: "info", hint: "2 unread" });
  const before = w.reached("/history");
  await tick(w.fake.api);
  expect(w.reached("/history")).toBe(before + 1);
});

test("the sign-in warning wins over the unread count", async () => {
  const w = started();
  await tick(w.fake.api);
  expect(w.fake.flags.get("thread")).toEqual({ tone: "info", hint: "2 unread" });
  w.connections.endpoint.revoke("g-1");
  await tick(w.fake.api);
  expect(w.fake.flags.get("thread")?.tone).toBe("warning");
});

test("the unread flag shows the first column's thread count and clears at 0", async () => {
  const w = started();
  w.gmail.deliver("t3", { from: KARIN, text: "Hi", subject: "Hello" });
  await tick(w.fake.api);
  expect(w.fake.flags.get("thread")).toEqual({ tone: "info", hint: "3 unread" });
  const searched = w.connections.requests
    .map((request) => new URL(request.url))
    .filter((url) => url.pathname.endsWith("/threads"));
  expect(
    searched.map((url) => [url.searchParams.get("q"), url.searchParams.get("maxResults")]),
  ).toEqual([["is:unread in:inbox", "100"]]);

  w.gmail.threads.clear();
  await tick(w.fake.api);
  expect(w.fake.flags.get("thread")).toBeNull();
});

test("the unread count uses the first column of the columns setting", async () => {
  const w = started({ settings: { columns: "Mine=dana; Rest=in" } });
  await tick(w.fake.api);
  const url = w.connections.requests.map((request) => new URL(request.url)).at(-1);
  expect(url?.searchParams.get("q")).toBe("dana");
});

test("activate starts the poller on a timer, each tick schedules the next after pollSeconds, and stop clears it", async () => {
  const w = started({ settings: { pollSeconds: 60 } });
  expect(pending.map((each) => each.ms)).toEqual([3000]);

  pending[0]?.run();
  await new Promise((done) => setTimeout(done, 50));
  expect(w.reached("/profile")).toBe(1);
  expect(pending.map((each) => each.ms)).toEqual([60_000]);
  const handle = pending[0]?.handle;

  w.stop();
  expect(cleared).toEqual([handle as number]);
  expect(pending).toEqual([]);
});

test("pollSeconds is held between 30 and 900, 90 by default", async () => {
  for (const [given, wanted] of [
    [undefined, 90_000],
    [5, 30_000],
    [5000, 900_000],
  ] as const) {
    const w = started(given === undefined ? {} : { settings: { pollSeconds: given } });
    pending[0]?.run();
    await new Promise((done) => setTimeout(done, 30));
    expect(pending.map((each) => each.ms)).toEqual([wanted]);
    w.stop();
  }
});

test("nothing is ever sent, notified or prompted into a session", async () => {
  const w = await withSession();
  w.gmail.deliver("t1", { from: KARIN, text: "Tuesday is fine." });
  w.gmail.deliver("t2", { from: "Dana <dana@example.com>", text: "Yes." });
  await tick(w.fake.api);
  w.connections.endpoint.revoke("g-1");
  await tick(w.fake.api);
  expect(w.connections.requests.every((request) => !request.url.includes("/send"))).toBe(true);
  expect(w.connections.requests.every((request) => request.method === "GET")).toBe(true);
  expect(w.prompts).toEqual([]);
  expect(w.fake.notices).toEqual([]);
});
