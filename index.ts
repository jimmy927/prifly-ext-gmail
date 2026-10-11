/**
 * The Gmail extension: what prifly imports. `activate` is given the api,
 * registers the four MCP tools that search, read and draft Gmail through the
 * reader's Google connection, and puts back the chips of the sessions started
 * from a thread. `choices`, `open`, `launch` and `launched` are the launcher
 * "From a Gmail thread…" (`launcher.ts`). Types come from
 * `@prifly/extension-api` with `import type`, so nothing of it is loaded at
 * run time.
 */

import type {
  ExtensionApi,
  Launch,
  LaunchBoard,
  LaunchChoice,
  LaunchItem,
} from "@prifly/extension-api";
import * as launcher from "./launcher";
import { readState } from "./state";
import { gmailTools } from "./tools";

let api: ExtensionApi | null = null;

export function activate(given: ExtensionApi): () => void {
  api = given;
  // Absent on an older prifly: optional, like every part added after the first version.
  given.tools?.register(gmailTools(() => api));
  void readState(given.folder).then((state) => {
    if (api === given) launcher.showChips(given, state);
  });
  given.log("activated");
  return () => {
    api = null;
  };
}

export async function choices(
  _launchId: string,
  query: string,
): Promise<LaunchChoice[] | LaunchBoard> {
  return api === null ? [] : await launcher.choices(api, query);
}

export async function open(_launchId: string, key: string): Promise<LaunchItem> {
  if (api === null) return { title: "Gmail", markdown: "Gmail is not running." };
  return await launcher.open(api, key);
}

export async function launch(_launchId: string, key: string): Promise<Launch> {
  if (api === null) return { prompt: "", message: "Gmail is not running." };
  return await launcher.launch(api, key);
}

export async function launched(_launchId: string, key: string, sessionId: string): Promise<void> {
  if (api !== null) await launcher.launched(api, key, sessionId);
}
