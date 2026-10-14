/** A fake prifly with a fake Gmail behind its Google connections, for the tests. */

import type { ConfirmSpec, ExtensionToolContext, SettingValues } from "@prifly/extension-api";
import { activate } from "../index";
import { type FakeAccount, fakeApi, fakeConnections } from "./fake-api";
import { type FakeGmail, fakeGmail, SELF } from "./fake-gmail";

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

export const FIRST_ACCOUNT: FakeAccount = {
  id: "g-1",
  provider: "google",
  account: SELF,
  scopes: SCOPES,
};

export const SECOND_ACCOUNT: FakeAccount = {
  id: "g-2",
  provider: "google",
  account: "second@example.com",
  scopes: SCOPES,
};

/** A confirm card the extension showed, and how many write requests had gone out before it. */
export type Shown = { spec: ConfirmSpec; writesBefore: number };

export function world(
  options: {
    accounts?: FakeAccount[];
    settings?: SettingValues;
    folder?: string;
    /** What the reader answers on every confirm card (default: Confirm). */
    confirm?: boolean;
  } = {},
) {
  const gmail: FakeGmail = fakeGmail();
  const connections = fakeConnections({
    accounts: options.accounts ?? [FIRST_ACCOUNT],
    provider: gmail.provider,
  });
  /** The requests that could change the mailbox: everything but GET. */
  const writes = () => connections.requests.filter((each) => each.method !== "GET");
  const confirms: Shown[] = [];
  const fake = fakeApi({
    connections: connections.connections,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.folder === undefined ? {} : { folder: options.folder }),
    confirm: async (spec) => {
      confirms.push({ spec, writesBefore: writes().length });
      return options.confirm ?? true;
    },
  });
  const stop = activate(fake.api);

  /** Calls a tool as a session would; `scratchpad` is the extra property prifly is adding. */
  const call = (name: string, args: Record<string, unknown>, scratchpad?: string) => {
    const tool = fake.tools().find((each) => each.name === name);
    if (tool === undefined) throw new Error(`No tool ${name}`);
    // The api types `scratchpad` as always there; a test without one leaves it out, as an old prifly does.
    const ctx = {
      session: "s1",
      pick: async () => null,
      signal: new AbortController().signal,
      ...(scratchpad === undefined ? {} : { scratchpad }),
    } as ExtensionToolContext;
    return tool.call(args, ctx);
  };

  return { gmail, connections, fake, call, stop, confirms, writes };
}
