import { afterEach, expect, test } from "bun:test";
import type { ExtensionModule } from "@prifly/extension-api";
import * as extension from "../index";
import { world } from "./world";

// The module is what prifly imports: it must fit the contract as a whole.
const module: ExtensionModule = extension;

let stop: (() => void) | undefined;
afterEach(() => stop?.());

test("activate registers exactly the four Gmail tools", () => {
  const w = world();
  stop = w.stop;
  expect(w.fake.tools().map((tool) => tool.name)).toEqual([
    "gmail_search",
    "gmail_thread",
    "gmail_draft_reply",
    "gmail_new_draft",
  ]);
  expect(w.fake.logs).toEqual([{ event: "activated", fields: undefined }]);
  expect(typeof module.activate).toBe("function");
});

test("every tool says that nothing is sent or only reads", () => {
  const w = world();
  stop = w.stop;
  for (const tool of w.fake.tools()) {
    expect(tool.description).toMatch(/nothing is ever sent/i);
    expect(tool.inputSchema["type"]).toBe("object");
  }
});

test("stopping makes the tools answer that no account is connected", async () => {
  const w = world();
  w.stop();
  expect(await w.call("gmail_search", { query: "x" })).toContain("No Google account is connected");
});
