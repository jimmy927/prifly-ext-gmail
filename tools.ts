/**
 * Every MCP tool the extension serves, as `mcp__prifly__gmail_*`, and the
 * ones that only read: search, a whole thread with its attachments saved,
 * and the labels. Reads run at once; every tool that changes the mailbox
 * (`compose-tools.ts`, `change-tools.ts`, `api-tools.ts`) waits for the
 * reader's confirm first. A failure comes back as text, not as a throw.
 */

import { join } from "node:path";
import type { ExtensionApi, ExtensionTool, ExtensionToolContext } from "@prifly/extension-api";
import { type ApiToolsOptions, apiDocsTool, apiTool } from "./api-tools";
import { changeTools } from "./change-tools";
import { composeTools } from "./compose-tools";
import { failureText, type ThreadSummary } from "./gmail";
import { safeFilename, saveThread, threadMarkdown } from "./save";
import { signInTool } from "./sign-in";
import { type Args, schema, text, withGmail } from "./tool-kit";

function searchLine(each: ThreadSummary): string {
  return `${each.id} | ${each.messages} msg | ${each.date.slice(0, 31)} | ${each.from.slice(0, 40)} | ${each.subject}`;
}

function searchTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_search",
    description:
      "Searches the reader's Gmail with a Gmail query (for example `is:unread in:inbox`, `from:ada newer_than:2d`). Answers one line per thread: thread_id | messages | date | from | subject. Read-only.",
    inputSchema: schema(
      {
        query: { type: "string", description: "A Gmail search query." },
        max: { type: "number", description: "How many threads at most (default 20, up to 100)." },
      },
      ["query"],
    ),
    call: (args) =>
      withGmail(getApi(), args, async ({ client }) => {
        const requested = Number(args["max"]);
        const max =
          Number.isFinite(requested) && requested >= 1 ? Math.min(Math.floor(requested), 100) : 20;
        const found = await client.searchThreads(text(args, "query"), max);
        if (!found.ok) return failureText(found);
        return found.value.length === 0
          ? "No threads found."
          : found.value.map(searchLine).join("\n");
      }),
  };
}

/** The session's scratchpad, or undefined where prifly cannot give one (reading it may throw). */
function scratchpadOf(ctx: ExtensionToolContext): string | undefined {
  try {
    return (ctx as { scratchpad?: string }).scratchpad;
  } catch {
    return undefined;
  }
}

/** Where a thread is saved: the session's scratchpad, else the extension's folder; null with neither. */
function threadFolder(
  scratchpad: string | undefined,
  extensionFolder: string | undefined,
  threadId: string,
): string | null {
  const name = safeFilename(threadId);
  if (scratchpad !== undefined && scratchpad !== "") return join(scratchpad, "gmail", name);
  if (extensionFolder !== undefined && extensionFolder !== "") {
    return join(extensionFolder, "threads", name);
  }
  return null;
}

function threadTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_thread",
    description:
      "Reads a whole Gmail thread: every message with from, to, cc, date and text, oldest first. The thread and its attachments are also saved as files, whose paths are listed. Read-only.",
    inputSchema: schema({ thread_id: { type: "string", description: "From gmail_search." } }, [
      "thread_id",
    ]),
    call: (args: Args, ctx) =>
      withGmail(getApi(), args, async ({ api, client }) => {
        const id = text(args, "thread_id");
        if (id === "") return "thread_id is required.";
        const got = await client.thread(id);
        if (!got.ok) return failureText(got);
        const folder = threadFolder(scratchpadOf(ctx), api.folder, id);
        if (folder === null) {
          return `${threadMarkdown(got.value)}\n---\nNothing was saved: this session has no scratchpad and the extension has no folder.`;
        }
        const saved = await saveThread(client, got.value, folder);
        const lines = [threadMarkdown(got.value), "---", `Saved in ${saved.folder}:`];
        lines.push(...saved.paths.map((path) => `- ${path}`));
        if (saved.notSaved.length > 0) {
          lines.push("Not saved:", ...saved.notSaved.map((each) => `- ${each}`));
        }
        return lines.join("\n");
      }),
  };
}

function labelsTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_labels",
    description:
      "Lists the reader's Gmail labels, one per line: id | name | system or user. Read-only.",
    inputSchema: schema({}, []),
    call: (args) =>
      withGmail(getApi(), args, async ({ client }) => {
        const got = await client.labels();
        if (!got.ok) return failureText(got);
        if (got.value.length === 0) return "No labels.";
        return got.value.map((each) => `${each.id} | ${each.name} | ${each.type}`).join("\n");
      }),
  };
}

export type ToolsOptions = ApiToolsOptions & {
  /** Called after `gmail_sign_in`, to read the status line again. */
  onSignedIn?: () => void;
};

export function gmailTools(
  getApi: () => ExtensionApi | null,
  options: ToolsOptions = {},
): ExtensionTool[] {
  return [
    searchTool(getApi),
    threadTool(getApi),
    labelsTool(getApi),
    ...composeTools(getApi),
    ...changeTools(getApi),
    apiTool(getApi),
    apiDocsTool(options),
    signInTool(getApi, options.onSignedIn),
  ];
}
