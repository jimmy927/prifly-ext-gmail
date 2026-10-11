/**
 * A thread as Markdown, and on disk: `thread.md` plus every attachment,
 * in one folder.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { failureText, type GmailClient } from "./gmail";
import type { GmailThread } from "./gmail-types";
import { base64urlBytes, type ReadMessage, readMessage } from "./mime";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function kib(size: number): string {
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(size / 1024)} KB`;
}

function messageMarkdown(mail: ReadMessage, isDraft: boolean): string {
  const lines = [`## ${mail.from}${isDraft ? " (draft)" : ""}`, `- From: ${mail.from}`];
  lines.push(`- To: ${mail.to}`);
  if (mail.cc !== "") lines.push(`- Cc: ${mail.cc}`);
  lines.push(`- Date: ${mail.date}`, "", mail.text === "" ? "(no text)" : mail.text);
  return lines.join("\n");
}

export function participants(mails: ReadMessage[]): string {
  const seen = new Set<string>();
  for (const mail of mails) {
    for (const field of [mail.from, mail.to, mail.cc]) {
      for (const each of field.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
        if (each.trim() !== "") seen.add(each.trim());
      }
    }
  }
  return [...seen].join("; ");
}

/** The whole thread as Markdown, oldest message first. */
export function threadMarkdown(thread: GmailThread): string {
  const mails = thread.messages.map((each) => readMessage(each.payload));
  const subject = mails[0]?.subject ?? "";
  const parts = [
    `# ${subject === "" ? "(no subject)" : subject}`,
    `Participants: ${participants(mails)}`,
  ];
  thread.messages.forEach((message, index) => {
    const mail = mails[index];
    if (mail !== undefined) {
      parts.push(messageMarkdown(mail, message.labelIds.includes("DRAFT")));
    }
  });
  const attachments = mails.flatMap((mail) => mail.attachments);
  if (attachments.length > 0) {
    const rows = attachments.map(
      (each) => `- ${each.filename} (${each.mimeType}, ${kib(each.size)})`,
    );
    parts.push(["## Attachments", ...rows].join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

/** A file name that stays inside its folder on every system. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const swapped = [...base].map((char) =>
    char.charCodeAt(0) < 32 || '<>:"|?*'.includes(char) ? "_" : char,
  );
  const cleaned = swapped.join("").replace(/^\.+/, "").trim();
  return cleaned === "" ? "attachment" : cleaned.slice(0, 150);
}

/** `name`, or `name (2).ext` and so on, until it is not in `taken`. */
export function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let candidate = name;
  for (let count = 2; taken.has(candidate.toLowerCase()); count++)
    candidate = `${stem} (${count})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

export type SavedFile = { path: string; name: string; mimeType: string; size: number };

export type Saved = {
  folder: string;
  /** `thread.md`, then every attachment, in order. */
  paths: string[];
  /** The attachments among `paths`, with what Gmail said they are. */
  files: SavedFile[];
  notSaved: string[];
};

/** Writes `thread.md` and every attachment into `folder`; one too big or failing is listed, not saved. */
export async function saveThread(
  client: GmailClient,
  thread: GmailThread,
  folder: string,
): Promise<Saved> {
  await mkdir(folder, { recursive: true });
  const taken = new Set<string>(["thread.md"]);
  const markdown = join(folder, "thread.md");
  await writeFile(markdown, threadMarkdown(thread));
  const saved: Saved = { folder, paths: [markdown], files: [], notSaved: [] };
  for (const message of thread.messages) {
    for (const each of readMessage(message.payload).attachments) {
      if (each.size > MAX_ATTACHMENT_BYTES) {
        saved.notSaved.push(`${each.filename}: ${kib(each.size)} is over 25 MB`);
        continue;
      }
      if (each.attachmentId === "") {
        saved.notSaved.push(`${each.filename}: Gmail gave no attachment id`);
        continue;
      }
      const got = await client.attachment(message.id, each.attachmentId);
      if (!got.ok) {
        saved.notSaved.push(`${each.filename}: ${failureText(got)}`);
        continue;
      }
      const path = join(folder, uniqueName(safeFilename(each.filename), taken));
      await writeFile(path, base64urlBytes(got.value));
      saved.paths.push(path);
      saved.files.push({ path, name: each.filename, mimeType: each.mimeType, size: each.size });
    }
  }
  return saved;
}
