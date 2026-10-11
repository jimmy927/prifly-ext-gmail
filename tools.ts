/**
 * The four MCP tools every session sees as `mcp__prifly__gmail_*`. They
 * search, read and write drafts; nothing here sends, and no URL they reach
 * ends in `/send`. A failure comes back as text, not as a throw.
 */

import { join } from "node:path";
import type { ExtensionApi, ExtensionTool, ExtensionToolContext } from "@prifly/extension-api";
import { NO_CONNECTION, pickConnection } from "./connection";
import { failureText, type GmailClient, gmailClient, type ThreadSummary } from "./gmail";
import { buildNew, buildReply, readMessage } from "./mime";
import { saveThread, threadMarkdown } from "./save";

/** prifly is adding `scratchpad` (an absolute folder) to the context; v0.1.0 does not have it. */
type ToolContext = ExtensionToolContext & { scratchpad?: string };

type Args = Record<string, unknown>;

const NOTHING_SENT = "Nothing is ever sent: the reader sends each mail themselves.";

const ACCOUNT_PROPERTY = {
  type: "string",
  description:
    "The Google account's email, when several are connected. Left out: the Gmail setting's account, else the first connected one.",
};

function text(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: { ...properties, account: ACCOUNT_PROPERTY },
    required,
    additionalProperties: false,
  };
}

type Session = { client: GmailClient; account: string };

/** Runs `run` with a client for the right account, or answers why there is none. */
async function withGmail(
  api: ExtensionApi | null,
  args: Args,
  run: (session: Session) => Promise<string>,
): Promise<string> {
  const given = text(args, "account");
  const connection = api === null ? null : pickConnection(api, given === "" ? undefined : given);
  if (api?.connections === undefined || connection === null) return NO_CONNECTION;
  const client = gmailClient({
    connections: api.connections,
    connection: connection.id,
    account: connection.account,
  });
  return await run({ client, account: connection.account });
}

function searchLine(each: ThreadSummary): string {
  return `${each.id} | ${each.messages} msg | ${each.date.slice(0, 31)} | ${each.from.slice(0, 40)} | ${each.subject}`;
}

function searchTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_search",
    description:
      "Searches the reader's Gmail with a Gmail query (for example `is:unread in:inbox`, `from:ada newer_than:2d`). Answers one line per thread: thread_id | messages | date | from | subject. Read-only: nothing is ever sent.",
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

function threadTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_thread",
    description:
      "Reads a whole Gmail thread: every message with from, to, cc, date and text, oldest first. The thread and its attachments are also saved as files, whose paths are listed. Read-only: nothing is ever sent.",
    inputSchema: schema({ thread_id: { type: "string", description: "From gmail_search." } }, [
      "thread_id",
    ]),
    call: (args, ctx: ToolContext) =>
      withGmail(getApi(), args, async ({ client }) => {
        const id = text(args, "thread_id");
        if (id === "") return "thread_id is required.";
        const got = await client.thread(id);
        if (!got.ok) return failureText(got);
        const folder =
          ctx.scratchpad === undefined
            ? join(getApi()?.folder ?? ".", "threads", id)
            : join(ctx.scratchpad, "gmail", id);
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

function draftReplyTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_draft_reply",
    description: `Writes a draft reply inside a Gmail thread, threaded under its last message; \`all\` (default true) also keeps everyone else on Cc. Pass replace_draft_id to change an earlier draft instead of adding a second. ${NOTHING_SENT}`,
    inputSchema: schema(
      {
        thread_id: { type: "string" },
        body: { type: "string", description: "The reply's plain text." },
        all: { type: "boolean", description: "Reply to everyone (default true)." },
        replace_draft_id: { type: "string", description: "A draft to rewrite in place." },
      },
      ["thread_id", "body"],
    ),
    call: (args) =>
      withGmail(getApi(), args, ({ client, account }) => replyDraft(client, account, args)),
  };
}

async function replyDraft(client: GmailClient, account: string, args: Args): Promise<string> {
  const id = text(args, "thread_id");
  const body = typeof args["body"] === "string" ? args["body"] : "";
  if (id === "" || body.trim() === "") return "thread_id and body are required.";
  const got = await client.thread(id);
  if (!got.ok) return failureText(got);
  const raw = buildReply({
    messages: got.value.messages,
    self: account,
    body,
    all: args["all"] !== false,
  });
  if (raw === null) return "The thread has no sent message to reply to.";
  const replace = text(args, "replace_draft_id");
  const made =
    replace === "" ? await client.createDraft(raw, id) : await client.updateDraft(replace, raw, id);
  if (!made.ok) return failureText(made);
  const first = got.value.messages[0];
  const subject = first === undefined ? "" : readMessage(first.payload).subject;
  return `Draft ${made.value.id} is in the thread “${subject}” in Gmail: open the thread to see it under the last message.`;
}

function newDraftTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_new_draft",
    description: `Writes a new draft mail (not a reply) in Gmail's Drafts. ${NOTHING_SENT}`,
    inputSchema: schema(
      {
        to: { type: "string", description: "Addresses, separated by commas." },
        cc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text." },
      },
      ["to", "subject", "body"],
    ),
    call: (args) =>
      withGmail(getApi(), args, async ({ client }) => {
        const to = text(args, "to");
        const body = typeof args["body"] === "string" ? args["body"] : "";
        if (to === "" || body.trim() === "") return "to and body are required.";
        const cc = text(args, "cc");
        const raw = buildNew({
          to,
          cc: cc === "" ? undefined : cc,
          subject: text(args, "subject"),
          body,
        });
        const made = await client.createDraft(raw);
        if (!made.ok) return failureText(made);
        return `Draft ${made.value.id} is in Gmail's Drafts: open Drafts to see it. Nothing was sent.`;
      }),
  };
}

export function gmailTools(getApi: () => ExtensionApi | null): ExtensionTool[] {
  return [searchTool(getApi), threadTool(getApi), draftReplyTool(getApi), newDraftTool(getApi)];
}
