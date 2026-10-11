import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchBoard } from "@prifly/extension-api";
import { clock } from "../board";
import { choices, launch, launched, open } from "../index";
import { DRAFT_RULE } from "../thread-prompt";
import { PDF_BYTES, PNG_BYTES } from "./fake-gmail";
import { world } from "./world";

let temp = "";
let stop: (() => void) | undefined;
const realNow = clock.now;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "gmail-launch-"));
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

const startedKeys = async (): Promise<string[]> => {
  const answer = await choices("thread", "");
  if (Array.isArray(answer)) throw new Error("expected a board");
  return (answer as LaunchBoard).items.filter((each) => each.started).map((each) => each.key);
};

test("launch saves thread.md, the png and the pdf under the extension folder's threads/<id>", async () => {
  started();
  await launch("thread", "t1");
  const folder = join(temp, "threads", "t1");
  expect(await readFile(join(folder, "thread.md"), "utf8")).toContain("# Plans för Tuesday");
  expect(new Uint8Array(await readFile(join(folder, "logo.png")))).toEqual(PNG_BYTES);
  expect(new Uint8Array(await readFile(join(folder, "invoice.pdf")))).toEqual(PDF_BYTES);
});

test("the prompt holds every message in order, the participants and the saved paths", async () => {
  started();
  const answer = await launch("thread", "t1");
  const folder = join(temp, "threads", "t1");
  const prompt = answer.prompt;
  expect(prompt.startsWith("# Plans för Tuesday\n")).toBe(true);
  expect(prompt).toContain(
    "https://mail.google.com/mail/u/0/#all/t1 · Gmail account jimmy@example.com",
  );
  expect(prompt).toContain("Participants: Ada Lovelace <ada@example.com>");
  expect(prompt).toContain("From: Ada Lovelace <ada@example.com>");
  expect(prompt).toContain("Cc: carol@example.com");
  expect(prompt).toContain("Date: Mon, 5 Oct 2026 10:30:00 +0200");
  expect(prompt.indexOf("Can we meet Tuesday? Café at 10.")).toBeGreaterThan(-1);
  expect(prompt.indexOf("Can we meet Tuesday?")).toBeLessThan(prompt.indexOf("Works for me."));
  expect(prompt).toContain(`Saved in ${folder}:`);
  expect(prompt).toContain(`- ${join(folder, "thread.md")}\n`);
  expect(prompt).toContain(`- ${join(folder, "logo.png")} (in this message)`);
  expect(prompt).toContain(`- ${join(folder, "invoice.pdf")}\n`);
  expect(prompt).not.toContain(`${join(folder, "invoice.pdf")} (in this message)`);
  expect(prompt.split("\n").at(-1)).toBe(DRAFT_RULE);
  expect(DRAFT_RULE).toBe("Answer by drafting with `gmail_draft_reply`; nothing is ever sent.");
  expect(answer.name).toBe("plans-for-tuesday");
});

test("images carries the png only, as base64", async () => {
  started();
  const answer = await launch("thread", "t1");
  expect(answer.images).toEqual([
    { mediaType: "image/png", data: Buffer.from(PNG_BYTES).toString("base64") },
  ]);
});

test("a thread with no picture sends no images", async () => {
  started();
  const answer = await launch("thread", "t2");
  expect(answer.images).toBeUndefined();
  expect(answer.prompt).toContain("Is the invoice paid?");
  expect(answer.prompt).not.toContain("in this message");
});

test("launch on a thread that does not exist says so and starts nothing", async () => {
  started();
  const answer = await launch("thread", "missing");
  expect(answer.prompt).toBe("");
  expect(answer.message).toStartWith("Gmail answered 404 for jimmy@example.com");
  expect(existsSync(join(temp, "threads", "missing"))).toBe(false);
});

test("launched records the session, puts the chip on it, and the card is then started", async () => {
  const w = started();
  expect(await startedKeys()).toEqual([]);
  await launch("thread", "t1");
  await launched("thread", "t1", "session-1");

  const shown = w.fake.shown.at(-1);
  expect(shown?.statusBar).toEqual([]);
  expect(shown?.bySession).toEqual({
    "session-1": [
      {
        key: "t1",
        // "mail" is not in v0.1.0 of the api's icon list yet; prifly is adding it.
        icon: "mail" as never,
        label: "Gmail: Plans för Tuesday",
        tone: "info",
        details: ["Plans för Tuesday", "Ada Lovelace, Bob"],
        url: "https://mail.google.com/mail/u/0/#all/t1",
        launcher: "thread",
      },
    ],
  });
  expect(await startedKeys()).toEqual(["t1"]);
  const state = JSON.parse(await readFile(join(temp, "state.json"), "utf8"));
  expect(state.threads.t1.sessions).toEqual(["session-1"]);
});

test("every recorded session keeps its chips on each launched", async () => {
  const w = started();
  await launch("thread", "t1");
  await launched("thread", "t1", "session-1");
  await launched("thread", "t1", "session-2");
  await launched("thread", "t1", "session-2");
  await launch("thread", "t2");
  await launched("thread", "t2", "session-1");

  const bySession = w.fake.shown.at(-1)?.bySession ?? {};
  expect(Object.keys(bySession).sort()).toEqual(["session-1", "session-2"]);
  expect(bySession["session-1"]?.map((chip) => chip.key)).toEqual(["t1", "t2"]);
  expect(bySession["session-2"]?.map((chip) => chip.key)).toEqual(["t1"]);
  expect(await startedKeys()).toEqual(["t1", "t2"]);
});

test("a long subject is cut on the chip's label but whole in its details", async () => {
  const w = started();
  const subject = "A very long subject line that goes on and on and on past fifty characters";
  const message = w.gmail.threads.get("t2")?.[0] as {
    payload: { headers: { name: string; value: string }[] };
  };
  const header = message.payload.headers.find((each) => each.name === "Subject");
  if (header === undefined) throw new Error("no subject header");
  header.value = subject;
  await launch("thread", "t2");
  await launched("thread", "t2", "session-9");
  const chip = w.fake.shown.at(-1)?.bySession["session-9"]?.[0];
  expect(chip?.label).toBe("Gmail: A very long subject line that goes on and on and…");
  expect(chip?.details[0]).toBe(subject);
});

test("activate puts the chips back from the state file after a restart", async () => {
  const first = started();
  await launch("thread", "t1");
  await launched("thread", "t1", "session-1");
  first.stop();

  const again = started();
  await new Promise((done) => setTimeout(done, 50));
  expect(again.fake.shown.at(-1)?.bySession["session-1"]?.map((chip) => chip.key)).toEqual(["t1"]);
});

test("activate shows nothing when no session was started", async () => {
  const w = started();
  await new Promise((done) => setTimeout(done, 20));
  expect(w.fake.shown).toEqual([]);
});

test("open returns the first message as text, the rest as notes, and the png as a data: URI", async () => {
  started();
  const item = await open("thread", "t1");
  expect(item.title).toBe("Plans för Tuesday");
  expect(item.url).toBe("https://mail.google.com/mail/u/0/#all/t1");
  expect(item.markdown).toBe("Hello Jimmy,\nCan we meet Tuesday? Café at 10.");
  expect(item.notes).toEqual([
    {
      by: "Bob <bob@example.com>",
      at: "Mon, 5 Oct 2026 10:30:00 +0200",
      text: "Works for me.\nBob & co",
    },
  ]);
  expect(item.people).toEqual(["Ada Lovelace", "Bob"]);
  const [png, pdf] = item.files ?? [];
  expect(png?.name).toBe("logo.png");
  expect(png?.data).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`);
  expect(pdf?.name).toBe("invoice.pdf");
  expect(pdf?.data).toBeUndefined();
});

test("open on an ended grant answers text, not a throw", async () => {
  const w = started();
  w.connections.endpoint.revoke("g-1");
  const item = await open("thread", "t1");
  expect(item.markdown).toContain("The Gmail grant for jimmy@example.com ended");
});
