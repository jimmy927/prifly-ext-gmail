/**
 * What every Gmail tool shares: reading its arguments, the `account`
 * argument, picking the connection, and the confirm card every write waits
 * for. A write that is not confirmed sends nothing and says so.
 */

import type { ConfirmSpec, ExtensionApi } from "@prifly/extension-api";
import { NO_CONNECTION, pickConnection } from "./connection";
import { type GmailClient, gmailClient } from "./gmail";

export type Args = Record<string, unknown>;

/**
 * The mail as prifly draws it on a confirm card. Switch to the package's
 * `ConfirmMail` and `ConfirmSpec` when the dependency is bumped to v0.8.0,
 * which adds them; an older prifly ignores `mail` and shows summary/details.
 */
export type ConfirmMail = {
  from?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  draft?: boolean;
  text: string;
  html?: string;
  images?: { id: string; mimeType: string; bytes: Uint8Array }[];
  attachments?: { filename: string; mimeType: string; size: number }[];
};

/** A confirm spec that may carry the mail itself. */
export type MailConfirmSpec = ConfirmSpec & { mail?: ConfirmMail };

export const CANCELLED = "Not done: you cancelled";

export const NO_CONFIRM =
  "Not done: this prifly cannot show a confirm card, and Gmail is never changed without one. Update prifly.";

const ACCOUNT_PROPERTY = {
  type: "string",
  description:
    "The Google account's email, when several are connected. Left out: the Gmail setting's account, else the first connected one.",
};

/** A string argument, trimmed; "" when missing. */
export function text(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

/** A string argument as given, for a mail's body. */
export function untrimmed(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/** A list argument: an array of strings, or one string split on commas. */
export function strings(args: Args, key: string): string[] {
  const value = args[key];
  const all = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return all
    .filter((each): each is string => typeof each === "string")
    .map((each) => each.trim())
    .filter((each) => each !== "");
}

export function schema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties: { ...properties, account: ACCOUNT_PROPERTY },
    required,
    additionalProperties: false,
  };
}

export type Session = { api: ExtensionApi; client: GmailClient; account: string };

/** Runs `run` with a client for the right account, or answers why there is none. */
export async function withGmail(
  api: ExtensionApi | null,
  args: Args,
  run: (session: Session) => Promise<string>,
): Promise<string> {
  const given = text(args, "account");
  const connection = api === null ? null : pickConnection(api, given === "" ? undefined : given);
  if (api === null || api.connections === undefined || connection === null) return NO_CONNECTION;
  const client = gmailClient({
    connections: api.connections,
    connection: connection.id,
    account: connection.account,
  });
  return await run({ api, client, account: connection.account });
}

/**
 * Shows the confirm card for a write. Null when the reader confirmed, so the
 * write goes ahead; otherwise the text the tool answers instead of writing.
 */
export async function confirmFirst(
  api: ExtensionApi,
  spec: MailConfirmSpec,
): Promise<string | null> {
  if (api.confirm === undefined) return NO_CONFIRM;
  return (await api.confirm(spec)) ? null : CANCELLED;
}
