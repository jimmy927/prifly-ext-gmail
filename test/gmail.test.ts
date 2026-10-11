import { expect, test } from "bun:test";
import { type GmailClient, gmailClient } from "../gmail";
import { fakeConnections } from "./fake-api";
import { fakeGmail } from "./fake-gmail";
import { FIRST_ACCOUNT } from "./world";

function setup() {
  const gmail = fakeGmail();
  const connections = fakeConnections({ accounts: [FIRST_ACCOUNT], provider: gmail.provider });
  const waits: number[] = [];
  const client: GmailClient = gmailClient({
    connections: connections.connections,
    connection: FIRST_ACCOUNT.id,
    account: FIRST_ACCOUNT.account,
    sleep: async (ms) => void waits.push(ms),
  });
  return { gmail, connections, client, waits };
}

test("a 429 waits the Retry-After seconds once and retries once", async () => {
  const { gmail, client, waits } = setup();
  gmail.throttle.times = 1;
  gmail.throttle.retryAfter = "2";
  const profile = await client.profile();
  expect(profile).toEqual({
    ok: true,
    value: { emailAddress: FIRST_ACCOUNT.account, historyId: "12" },
  });
  expect(waits).toEqual([2000]);
  expect(gmail.hits()).toBe(2);
});

test("the wait is capped at 30 seconds, and a second 503 is an error, not a third try", async () => {
  const { gmail, client, waits } = setup();
  gmail.throttle.status = 503;
  gmail.throttle.times = 5;
  gmail.throttle.retryAfter = "999";
  const profile = await client.profile();
  expect(profile).toEqual({
    ok: false,
    kind: "http",
    account: FIRST_ACCOUNT.account,
    status: 503,
    body: "slow down",
  });
  expect(waits).toEqual([30000]);
  expect(gmail.hits()).toBe(2);
});

test("a grant the provider ended comes back as needs-sign-in and nothing reaches Gmail", async () => {
  const { gmail, connections, client } = setup();
  connections.endpoint.revoke(FIRST_ACCOUNT.id);
  expect(await client.profile()).toEqual({
    ok: false,
    kind: "sign-in",
    account: FIRST_ACCOUNT.account,
  });
  expect(await client.searchThreads("x", 5)).toMatchObject({ ok: false, kind: "sign-in" });
  expect(gmail.hits()).toBe(0);
});

test("an error status carries the body", async () => {
  const { client } = setup();
  expect(await client.thread("missing")).toMatchObject({ ok: false, kind: "http", status: 404 });
});

test("search lists thread summaries: last date and sender, first subject", async () => {
  const { client } = setup();
  const found = await client.searchThreads("", 10);
  expect(found).toEqual({
    ok: true,
    value: [
      {
        id: "t1",
        messages: 2,
        date: "Mon, 5 Oct 2026 10:30:00 +0200",
        from: "Bob <bob@example.com>",
        subject: "Plans för Tuesday",
        senders: [
          { name: "Ada Lovelace", address: "ada@example.com" },
          { name: "Bob", address: "bob@example.com" },
        ],
        people: [
          { name: "Ada Lovelace", address: "ada@example.com" },
          { name: "Bob", address: "bob@example.com" },
          { name: "Jimmy", address: "jimmy@example.com" },
          { name: "", address: "carol@example.com" },
        ],
        attachments: 2,
      },
      {
        id: "t2",
        messages: 1,
        date: "Tue, 6 Oct 2026 08:00:00 +0200",
        from: "Dana <dana@example.com>",
        subject: "Invoice question",
        senders: [{ name: "Dana", address: "dana@example.com" }],
        people: [
          { name: "Dana", address: "dana@example.com" },
          { name: "", address: "jimmy@example.com" },
        ],
        attachments: 0,
      },
    ],
  });
});

test("drafts are created and updated through /drafts, with the thread id", async () => {
  const { gmail, client } = setup();
  expect(await client.createDraft("RAW1", "t1")).toEqual({
    ok: true,
    value: { id: "r1", threadId: "t1" },
  });
  expect(await client.updateDraft("r1", "RAW2", "t1")).toEqual({
    ok: true,
    value: { id: "r1", threadId: "t1" },
  });
  expect(gmail.drafts.get("r1")?.message).toEqual({ raw: "RAW2", threadId: "t1" });
  expect(await client.createDraft("RAW3")).toEqual({ ok: true, value: { id: "r2", threadId: "" } });
  expect(gmail.drafts.get("r2")?.message).toEqual({ raw: "RAW3" });
});

test("attachments and history parse tolerantly", async () => {
  const { client } = setup();
  const attachment = await client.attachment("m1", "att-png");
  expect(attachment.ok && attachment.value.length > 0).toBe(true);
  expect(await client.history("10")).toEqual({ ok: true, value: { historyId: "12", added: [] } });
});
