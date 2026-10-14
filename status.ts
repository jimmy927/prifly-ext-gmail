/**
 * The extension's one line in Settings → Extensions: "Connected as
 * ada@example.com · 3 unread · 12 labels", or what is wrong with the sign-in
 * in plain words. Read at start, after a sign-in or a settings change, and
 * then every 15 minutes; it is the only thing the extension shows.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { pickConnection } from "./connection";
import { gmailClient } from "./gmail";
import { missingScopes } from "./sign-in";

export const STATUS_EVERY_MS = 15 * 60 * 1000;

export const NOT_CONNECTED =
  "Not connected: connect a Google account in Vault → Connections, or ask a session to sign in to Gmail.";

const signedOut = (account: string): string =>
  `Signed out: Google ended the grant for ${account}. Ask a session to sign in to Gmail again, or sign in again in Vault → Connections.`;

/** The status line as it stands now; never throws. */
export async function statusText(api: ExtensionApi): Promise<string> {
  const connection = pickConnection(api);
  if (api.connections === undefined || connection === null) return NOT_CONNECTED;
  if (connection.state === "needs-sign-in") return signedOut(connection.account);
  if (missingScopes(connection).length > 0) {
    return `Connected as ${connection.account}, read-only: ask a session to sign in to Gmail again to approve sending, labelling and archiving.`;
  }
  const client = gmailClient({
    connections: api.connections,
    connection: connection.id,
    account: connection.account,
  });
  try {
    const [inbox, labels] = await Promise.all([client.label("INBOX"), client.labels()]);
    if (!inbox.ok && inbox.kind === "sign-in") return signedOut(connection.account);
    if (!inbox.ok) return `Connected as ${connection.account}, but Gmail answered ${inbox.status}.`;
    const own = labels.ok ? labels.value.filter((each) => each.type === "user").length : 0;
    return `Connected as ${connection.account} · ${inbox.value.threadsUnread} unread · ${own} labels`;
  } catch (error) {
    return `Connected as ${connection.account}, but Gmail could not be reached: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Keeps the status line current: now, then every 15 minutes. `refresh` reads
 * it again at once (after a sign-in); the returned `stop` ends the timer.
 */
export function startStatus(api: ExtensionApi): { refresh: () => void; stop: () => void } {
  let stopped = false;
  const refresh = () => {
    if (api.status === undefined) return;
    void statusText(api).then((line) => {
      if (!stopped) api.status?.(line);
    });
  };
  refresh();
  const timer = setInterval(refresh, STATUS_EVERY_MS);
  return {
    refresh,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
