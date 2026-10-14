/**
 * The tools that change threads and labels: create a label, add or remove
 * labels, archive, mark read or unread, and move to the trash. Each reads the
 * threads it is about first, shows the reader the change on a confirm card,
 * and only then writes. They work on whole threads, as Gmail's inbox does.
 */

import type { ExtensionApi, ExtensionTool } from "@prifly/extension-api";
import { failureText, type GmailClient, type GmailResult, type Label } from "./gmail";
import {
  type Args,
  confirmFirst,
  type Session,
  schema,
  strings,
  text,
  withGmail,
} from "./tool-kit";

const MAX_THREADS = 100;

const THREADS_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: `Thread ids, from gmail_search (up to ${MAX_THREADS}).`,
};

type Change = {
  title: string;
  /** What happens to the threads, as the card's large line ends: "archived". */
  verb: string;
  /** The change itself, as the card's details start. */
  what: string;
  add: string[];
  remove: string[];
};

/** Reads the threads' subjects, confirms the change, then makes it thread by thread. */
async function changeThreads(
  api: ExtensionApi,
  client: GmailClient,
  ids: string[],
  change: Change,
  write: (id: string) => Promise<GmailResult<null>>,
): Promise<string> {
  if (ids.length === 0) return "thread_ids is required.";
  if (ids.length > MAX_THREADS) return `Not done: at most ${MAX_THREADS} threads at a time.`;
  const found = await client.summaries(ids);
  if (!found.ok) return failureText(found);
  const rows = found.value.map(
    (each) => `- ${each.id} | ${each.from.slice(0, 40)} | ${each.subject}`,
  );
  const count = ids.length === 1 ? "1 thread" : `${ids.length} threads`;
  const refused = await confirmFirst(api, {
    title: change.title,
    summary: `${count} will be ${change.verb}`,
    details: [change.what, "", ...rows].join("\n"),
  });
  if (refused !== null) return refused;
  const failed: string[] = [];
  for (const id of ids) {
    const done = await write(id);
    if (!done.ok) failed.push(`${id}: ${failureText(done)}`);
  }
  if (failed.length === 0) return `Done: ${count} ${change.verb}.`;
  return [`${ids.length - failed.length} of ${count} ${change.verb}. Not done:`, ...failed].join(
    "\n",
  );
}

const modify = (api: ExtensionApi, client: GmailClient, args: Args, change: Change) =>
  changeThreads(api, client, strings(args, "thread_ids"), change, (id) =>
    client.modifyThread(id, change.add, change.remove),
  );

/** Each wanted label as Gmail's id, by id or by name (any case); the names not found as text. */
function resolveLabels(all: Label[], wanted: string[]): { ids: string[]; missing: string[] } {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const each of wanted) {
    const label =
      all.find((one) => one.id === each) ??
      all.find((one) => one.name.toLowerCase() === each.toLowerCase());
    if (label === undefined) missing.push(each);
    else ids.push(label.id);
  }
  return { ids, missing };
}

function createLabelTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_label_create",
    description:
      "Creates a Gmail label (`Parent/Child` nests it). The reader confirms on a card first.",
    inputSchema: schema({ name: { type: "string" } }, ["name"]),
    call: (args) =>
      withGmail(getApi(), args, async ({ api, client }) => {
        const name = text(args, "name");
        if (name === "") return "name is required.";
        const refused = await confirmFirst(api, {
          title: "Create a Gmail label",
          summary: `Create the label “${name}”`,
          details: `New label: ${name}`,
        });
        if (refused !== null) return refused;
        const made = await client.createLabel(name);
        return made.ok ? `Created label ${made.value.name} (${made.value.id}).` : failureText(made);
      }),
  };
}

function labelThreadsTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_label_threads",
    description:
      "Adds and removes labels on whole threads. Labels are given by name or id (see gmail_labels); a label that does not exist is not created. The reader confirms on a card first.",
    inputSchema: schema(
      {
        thread_ids: THREADS_PROPERTY,
        add: { type: "array", items: { type: "string" }, description: "Labels to add." },
        remove: { type: "array", items: { type: "string" }, description: "Labels to remove." },
      },
      ["thread_ids"],
    ),
    call: (args) => withGmail(getApi(), args, (session) => relabel(args, session)),
  };
}

async function relabel(args: Args, { api, client }: Session): Promise<string> {
  const add = strings(args, "add");
  const remove = strings(args, "remove");
  if (add.length === 0 && remove.length === 0) return "add or remove is required.";
  const labels = await client.labels();
  if (!labels.ok) return failureText(labels);
  const added = resolveLabels(labels.value, add);
  const removed = resolveLabels(labels.value, remove);
  const missing = [...added.missing, ...removed.missing];
  if (missing.length > 0) {
    return `Not done: no label called ${missing.join(", ")}. See gmail_labels, or create it with gmail_label_create.`;
  }
  const what = [
    add.length > 0 ? `Add: ${add.join(", ")}` : "",
    remove.length > 0 ? `Remove: ${remove.join(", ")}` : "",
  ].filter((line) => line !== "");
  return await modify(api, client, args, {
    title: "Change Gmail labels",
    verb: "relabelled",
    what: what.join("\n"),
    add: added.ids,
    remove: removed.ids,
  });
}

function archiveTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_archive",
    description:
      "Archives whole threads: takes them out of the inbox, keeping them in All Mail. The reader confirms on a card first.",
    inputSchema: schema({ thread_ids: THREADS_PROPERTY }, ["thread_ids"]),
    call: (args) =>
      withGmail(getApi(), args, ({ api, client }) =>
        modify(api, client, args, {
          title: "Archive in Gmail",
          verb: "archived",
          what: "Remove from the inbox (they stay in All Mail).",
          add: [],
          remove: ["INBOX"],
        }),
      ),
  };
}

function markTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_mark",
    description:
      "Marks whole threads read (`read`: true, the default) or unread. The reader confirms on a card first.",
    inputSchema: schema(
      {
        thread_ids: THREADS_PROPERTY,
        read: { type: "boolean", description: "True: mark read (default). False: unread." },
      },
      ["thread_ids"],
    ),
    call: (args) =>
      withGmail(getApi(), args, ({ api, client }) => {
        const read = args["read"] !== false;
        return modify(api, client, args, {
          title: read ? "Mark read in Gmail" : "Mark unread in Gmail",
          verb: read ? "marked read" : "marked unread",
          what: read ? "Mark read." : "Mark unread.",
          add: read ? [] : ["UNREAD"],
          remove: read ? ["UNREAD"] : [],
        });
      }),
  };
}

function trashTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_trash",
    description:
      "Moves whole threads to the trash, where Gmail deletes them for good after 30 days. The reader confirms on a card first.",
    inputSchema: schema({ thread_ids: THREADS_PROPERTY }, ["thread_ids"]),
    call: (args) =>
      withGmail(getApi(), args, ({ api, client }) =>
        changeThreads(
          api,
          client,
          strings(args, "thread_ids"),
          {
            title: "Move to the trash in Gmail",
            verb: "moved to the trash",
            what: "Move to the trash (Gmail deletes them for good after 30 days).",
            add: [],
            remove: [],
          },
          (id) => client.trashThread(id),
        ),
      ),
  };
}

export function changeTools(getApi: () => ExtensionApi | null): ExtensionTool[] {
  return [
    createLabelTool(getApi),
    labelThreadsTool(getApi),
    archiveTool(getApi),
    markTool(getApi),
    trashTool(getApi),
  ];
}
