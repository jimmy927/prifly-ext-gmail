/**
 * What every Gmail tool shares: reading its arguments, the `account`
 * argument, picking the connection, and the card every write waits for (for
 * a mail, the card where the reader chooses draft or send). A write that is
 * not confirmed sends nothing and says so.
 */

import type { ConfirmMail, ConfirmSpec, ExtensionApi } from "@prifly/extension-api";
import { NO_CONNECTION, pickConnection } from "./connection";
import { type GmailClient, gmailClient } from "./gmail";

export type Args = Record<string, unknown>;

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
export async function confirmFirst(api: ExtensionApi, spec: ConfirmSpec): Promise<string | null> {
  if (api.confirm === undefined) return NO_CONFIRM;
  return (await api.confirm(spec)) ? null : CANCELLED;
}

/** What becomes of a mail: saved in Drafts, or sent. */
export type MailKind = "draft" | "send";

/** What a mail tool does, and whether the reader chose it on a two-way card (else the tool's name said it). */
export type MailChoice = { kind: MailKind; chosen: boolean };

/** prifly's two-way mail card (extension API v0.10.0), not yet in the API types this builds against. */
type ChooseMail = (spec: ConfirmSpec & { mail: ConfirmMail }) => Promise<MailKind | null>;

/**
 * Asks the reader about a mail. Where prifly has the two-way card
 * ("choose-mail"), it shows `card`'s neutral title and summary over the mail
 * and the reader picks Save as draft or Send now, whatever the tool is
 * called. An older prifly shows `spec` on a confirm card, and confirming does
 * `kind`, what the tool's name says. Answers the choice, or the text the
 * tool answers instead of writing.
 */
export async function askMail(
  api: ExtensionApi,
  spec: ConfirmSpec & { mail: ConfirmMail },
  kind: MailKind,
  card: { title: string; summary: string },
): Promise<MailChoice | string> {
  const choose = (api as ExtensionApi & { chooseMail?: ChooseMail }).chooseMail;
  if (api.features?.includes("choose-mail") && choose !== undefined) {
    const chosen = await choose.call(api, {
      ...spec,
      ...card,
      mail: { ...spec.mail, draft: false },
    });
    return chosen === null ? CANCELLED : { kind: chosen, chosen: true };
  }
  return (await confirmFirst(api, spec)) ?? { kind, chosen: false };
}
