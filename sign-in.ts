/**
 * Signing in: the scopes the manifest asks for, whether a connection holds
 * them all, and `gmail_sign_in`, the tool a session runs when the reader
 * asks to connect Gmail or to approve the scopes again.
 */

import type { ExtensionApi, ExtensionConnection, ExtensionTool } from "@prifly/extension-api";
import { pickConnection } from "./connection";
import manifest from "./prifly-extension.json";
import { text } from "./tool-kit";

/** The scopes the manifest asks for; `signIn` accepts nothing else. */
export const SCOPES: string[] = manifest.connections.flatMap((each) =>
  each.provider === "google" ? each.scopes : [],
);

/** The manifest's scopes the connection was not granted (an older grant: read and draft only). */
export function missingScopes(connection: ExtensionConnection): string[] {
  return SCOPES.filter((scope) => !connection.scopes.includes(scope));
}

/** Signs in a new Google account, or again for the one in use (more scopes, or an ended grant). */
export async function signIn(api: ExtensionApi | null, account: string): Promise<string> {
  if (api?.connections === undefined) return "This prifly cannot sign in to Google for extensions.";
  const existing = pickConnection(api, account === "" ? undefined : account);
  const asNew = existing === null || account === "new";
  try {
    const answer = await api.connections.signIn(
      "google",
      SCOPES,
      asNew ? undefined : { connection: existing.id },
    );
    return answer.ok
      ? `Signed in to Gmail as ${answer.account}.`
      : `Not signed in: ${answer.message}`;
  } catch (error) {
    return `Not signed in: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function signInTool(
  getApi: () => ExtensionApi | null,
  onSignedIn: () => void = () => {},
): ExtensionTool {
  return {
    name: "gmail_sign_in",
    description:
      'Opens the reader\'s browser to sign in to Google for Gmail: for the account in use when its grant ended or lacks the scopes to send and label, else a new account. `account: "new"` always adds another account. Only when the reader asks, or a Gmail tool said to sign in.',
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description:
            'The account\'s email, or "new" for another account. Left out: the one in use.',
        },
      },
      additionalProperties: false,
    },
    async call(args) {
      const answer = await signIn(getApi(), text(args, "account"));
      onSignedIn();
      return answer;
    },
  };
}
