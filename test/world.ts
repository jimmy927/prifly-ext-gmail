/** A fake prifly with a fake Gmail behind its Google connections, for the tests. */

import type { ExtensionToolContext, SettingValues } from "@prifly/extension-api";
import { activate } from "../index";
import { type FakeAccount, fakeApi, fakeConnections } from "./fake-api";
import { type FakeGmail, fakeGmail, SELF } from "./fake-gmail";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
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

export function world(
  options: { accounts?: FakeAccount[]; settings?: SettingValues; folder?: string } = {},
) {
  const gmail: FakeGmail = fakeGmail();
  const connections = fakeConnections({
    accounts: options.accounts ?? [FIRST_ACCOUNT],
    provider: gmail.provider,
  });
  const fake = fakeApi({
    connections: connections.connections,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.folder === undefined ? {} : { folder: options.folder }),
  });
  const stop = activate(fake.api);

  /** Calls a tool as a session would; `scratchpad` is the extra property prifly is adding. */
  const call = (name: string, args: Record<string, unknown>, scratchpad?: string) => {
    const tool = fake.tools().find((each) => each.name === name);
    if (tool === undefined) throw new Error(`No tool ${name}`);
    const ctx: ExtensionToolContext & { scratchpad?: string } = {
      session: "s1",
      pick: async () => null,
      signal: new AbortController().signal,
      ...(scratchpad === undefined ? {} : { scratchpad }),
    };
    return tool.call(args, ctx);
  };

  return { gmail, connections, fake, call, stop };
}
