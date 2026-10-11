/**
 * Signing in, on the board and nowhere else: the one row that fixes a missing
 * or ended grant, and the launch behind it. A launch here starts no session:
 * its prompt is empty and its `message` says how the sign-in went, so the
 * chooser lists again.
 */

import type { ExtensionApi, Launch, LaunchChoice } from "@prifly/extension-api";
import manifest from "./prifly-extension.json";
import { readState, writeState } from "./state";

/** The scopes the manifest asks for; `signIn` accepts nothing else. */
export const SCOPES: string[] = manifest.connections.flatMap((each) =>
  each.provider === "google" ? each.scopes : [],
);

export const CONNECT_KEY = "gmail:connect";
export const ADD_KEY = "gmail:add";
const REAUTH_PREFIX = "gmail:reauth:";

/** The launcher's flag while a grant is ended. */
export const SIGN_IN_FLAG = { tone: "warning", hint: "Sign in again" } as const;

/** With no Google account connected: the board is this one row. */
export function connectRows(): LaunchChoice[] {
  return [
    {
      key: CONNECT_KEY,
      title: "Connect a Google account",
      detail: "Opens your browser to sign in. Gmail is only read, and drafts are only written.",
      tone: "warning",
    },
  ];
}

/** When a call answered `needsSignIn`: the board is this one row. */
export function signInRows(connection: string, account: string): LaunchChoice[] {
  return [
    {
      key: `${REAUTH_PREFIX}${connection}`,
      title: `Sign in again as ${account}`,
      detail: "Google ended the grant for this account.",
      tone: "warning",
    },
  ];
}

/** The row that adds a second account, at the end of the board. */
export function addAccountRow(): LaunchChoice {
  return {
    key: ADD_KEY,
    title: "Add another Google account…",
    group: "prifly",
    tone: "muted",
  };
}

/** The launch behind a sign-in row, or null when `key` is not one. */
export async function signInLaunch(api: ExtensionApi, key: string): Promise<Launch | null> {
  const reauth = key.startsWith(REAUTH_PREFIX) ? key.slice(REAUTH_PREFIX.length) : null;
  if (key !== CONNECT_KEY && key !== ADD_KEY && reauth === null) return null;
  if (api.connections === undefined) {
    return { prompt: "", message: "This prifly cannot sign in to Google for extensions." };
  }
  try {
    const answer = await api.connections.signIn(
      "google",
      SCOPES,
      reauth === null ? undefined : { connection: reauth },
    );
    if (!answer.ok) return { prompt: "", message: answer.message };
    // The account just connected is the one to look at next.
    const state = await readState(api.folder);
    await writeState(api.folder, { ...state, account: answer.connection });
    return { prompt: "", message: `Signed in as ${answer.account}.` };
  } catch (error) {
    return { prompt: "", message: error instanceof Error ? error.message : String(error) };
  }
}
