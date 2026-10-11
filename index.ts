/**
 * The Gmail extension: what prifly imports. `activate` is given the api and
 * registers the four MCP tools that search, read and draft Gmail through the
 * reader's Google connection. Types come from `@prifly/extension-api` with
 * `import type`, so nothing of it is loaded at run time.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { gmailTools } from "./tools";

let api: ExtensionApi | null = null;

export function activate(given: ExtensionApi): () => void {
  api = given;
  // Absent on an older prifly: optional, like every part added after the first version.
  given.tools?.register(gmailTools(() => api));
  given.log("activated");
  return () => {
    api = null;
  };
}
