/**
 * Which Google connection a Gmail call uses, and the words for the ways it
 * can fail. A failure is text a tool returns, never a throw.
 */

import type { ExtensionApi, ExtensionConnection } from "@prifly/extension-api";

export const NO_CONNECTION =
  "No Google account is connected for Gmail: connect one in prifly's Vault → Connections.";

export function signInText(account: string): string {
  return `The Gmail grant for ${account} ended: sign in again in prifly's Vault → Connections.`;
}

export function httpText(status: number, account: string, body: string): string {
  const said = `Gmail answered ${status} for ${account}: ${body.slice(0, 300)}`;
  // A grant from before sending and labelling was added: approving the scopes again fixes it.
  return status === 403 && /insufficient.*scope/i.test(body)
    ? `${said}\nThe Google grant for ${account} only allows reading and drafting: run gmail_sign_in so the reader approves sending and labelling, then try again.`
    : said;
}

/** The connected account to use: `account` argument, else the `account` setting, else the first. */
export function pickConnection(api: ExtensionApi, account?: string): ExtensionConnection | null {
  const all = api.connections?.list("google") ?? [];
  const setting = api.settings?.["account"];
  const wanted = (account ?? (typeof setting === "string" ? setting : "")).trim().toLowerCase();
  if (wanted === "") return all[0] ?? null;
  return all.find((each) => each.account.toLowerCase() === wanted) ?? null;
}
