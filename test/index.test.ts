import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionModule } from "@prifly/extension-api";
import * as extension from "../index";
import manifest from "../prifly-extension.json";
import { world } from "./world";

// The module is what prifly imports: it must fit the contract as a whole.
const module: ExtensionModule = extension;

const ROOT = join(import.meta.dir, "..");

let stop: (() => void) | undefined;
afterEach(() => stop?.());

test("activate registers the Gmail tools, every one named gmail_*", () => {
  const w = world();
  stop = w.stop;
  expect(w.fake.tools().map((tool) => tool.name)).toEqual([
    "gmail_search",
    "gmail_thread",
    "gmail_labels",
    "gmail_draft_reply",
    "gmail_new_draft",
    "gmail_send",
    "gmail_reply",
    "gmail_forward",
    "gmail_label_create",
    "gmail_label_threads",
    "gmail_archive",
    "gmail_mark",
    "gmail_trash",
    "gmail_api",
    "gmail_api_docs",
    "gmail_sign_in",
  ]);
  for (const tool of w.fake.tools()) expect(tool.inputSchema["type"]).toBe("object");
  expect(w.fake.logs).toEqual([{ event: "activated", fields: undefined }]);
  expect(typeof module.activate).toBe("function");
});

test("the module exports only activate: no launcher", () => {
  expect(Object.keys(extension)).toEqual(["activate"]);
});

test("the manifest has no launcher and asks for gmail.modify and gmail.send", () => {
  expect("launch" in manifest).toBe(false);
  expect(manifest.connections.flatMap((each) => each.scopes)).toEqual([
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
  ]);
});

test("no source file shows a chip, flags the launcher or answers a launch", () => {
  const sources = readdirSync(ROOT).filter((name) => name.endsWith(".ts"));
  expect(sources.length).toBeGreaterThan(5);
  for (const name of sources) {
    const code = readFileSync(join(ROOT, name), "utf8");
    expect(`${name}: ${code.match(/\.(show|flag|snoozeOptions)\??\.?\(/)?.[0] ?? ""}`).toBe(
      `${name}: `,
    );
    expect(
      `${name}: ${code.match(/export\s+(async\s+)?function\s+(choices|open|launch|launched)\b/)?.[0] ?? ""}`,
    ).toBe(`${name}: `);
  }
});

test("stopping makes the tools answer that no account is connected", async () => {
  const w = world();
  w.stop();
  expect(await w.call("gmail_search", { query: "x" })).toContain("No Google account is connected");
});
