import { afterEach, expect, test } from "bun:test";
import { NOT_CONNECTED, statusText } from "../status";
import { FIRST_ACCOUNT, world } from "./world";

const READ_AND_DRAFT = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

let stop: (() => void) | undefined;
afterEach(() => stop?.());

function started(options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
  stop = w.stop;
  return w;
}

/** Waits until the extension has set `count` status lines (it reads Gmail first). */
async function statuses(w: ReturnType<typeof world>, count = 1): Promise<string[]> {
  for (let tries = 0; tries < 50 && w.fake.statuses.length < count; tries++) await Bun.sleep(1);
  return w.fake.statuses;
}

test("the status line says who is connected, the unread threads and the own labels", async () => {
  const w = started();
  expect(await statuses(w)).toEqual(["Connected as jimmy@example.com · 1 unread · 1 labels"]);
  expect(w.fake.shown).toEqual([]);
  expect(w.fake.flags.size).toBe(0);
});

test("with no Google account the status line says how to connect one", async () => {
  const w = started({ accounts: [] });
  expect(await statuses(w)).toEqual([NOT_CONNECTED]);
});

test("an ended grant is said in plain words", async () => {
  const w = started();
  await statuses(w);
  w.connections.endpoint.revoke(FIRST_ACCOUNT.id);
  expect(await statusText(w.fake.api)).toStartWith(
    "Signed out: Google ended the grant for jimmy@example.com.",
  );
});

test("an older read-and-draft grant asks for approval, and gmail_sign_in fixes it", async () => {
  const w = started({ accounts: [{ ...FIRST_ACCOUNT, scopes: READ_AND_DRAFT }] });
  const [first] = await statuses(w);
  expect(first).toContain("read-only");
  expect(await w.call("gmail_sign_in", {})).toBe("Signed in to Gmail as jimmy@example.com.");
  expect(w.connections.accounts[0]?.scopes).toContain("https://www.googleapis.com/auth/gmail.send");
  expect((await statuses(w, 2))[1]).toBe("Connected as jimmy@example.com · 1 unread · 1 labels");
});

test("stopping the extension stops the status line", async () => {
  const w = world();
  w.stop();
  await Bun.sleep(5);
  expect(w.fake.statuses).toEqual([]);
});
