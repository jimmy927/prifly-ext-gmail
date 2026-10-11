/**
 * A thread, as the first thing a session is told: every message in order,
 * who is on it, where each attachment was saved and which pictures travel in
 * the message itself, and how to answer.
 */

import { readFile } from "node:fs/promises";
import type { Launch } from "@prifly/extension-api";
import type { GmailThread } from "./gmail-types";
import { readMessage } from "./mime";
import { participants, type Saved, type SavedFile } from "./save";

export const MAX_IMAGES = 20;
/** The most the API takes in one picture. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
type LaunchImage = NonNullable<Launch["images"]>[number];

export const isImageType = (mimeType: string): mimeType is ImageType =>
  (IMAGE_TYPES as readonly string[]).includes(mimeType.toLowerCase());

export const DRAFT_RULE = "Answer by drafting with `gmail_draft_reply`; nothing is ever sent.";

/** The saved pictures that travel in the opening message: up to twenty, none over 5 MB. */
export async function carriedImages(
  saved: Saved,
): Promise<{ files: SavedFile[]; images: LaunchImage[] }> {
  const files: SavedFile[] = [];
  const images: LaunchImage[] = [];
  for (const file of saved.files) {
    const mediaType = file.mimeType.toLowerCase();
    if (images.length >= MAX_IMAGES) break;
    if (!isImageType(mediaType) || file.size > MAX_IMAGE_BYTES) continue;
    const bytes = await readFile(file.path);
    images.push({ mediaType, data: bytes.toString("base64") });
    files.push(file);
  }
  return { files, images };
}

export type PromptParts = {
  thread: GmailThread;
  url: string;
  account: string;
  saved: Saved;
  /** The saved pictures that travel in the message itself. */
  carried: SavedFile[];
};

function messages(thread: GmailThread): string {
  return thread.messages
    .map((message, index) => {
      const mail = readMessage(message.payload);
      const lines = [
        `### ${index + 1}. ${mail.from}${message.labelIds.includes("DRAFT") ? " (draft)" : ""}`,
      ];
      lines.push(`From: ${mail.from}`, `To: ${mail.to}`);
      if (mail.cc !== "") lines.push(`Cc: ${mail.cc}`);
      lines.push(`Date: ${mail.date}`, "", mail.text === "" ? "(no text)" : mail.text);
      return lines.join("\n");
    })
    .join("\n\n");
}

function files(parts: PromptParts): string {
  const { saved, carried } = parts;
  const inMessage = new Set(carried.map((file) => file.path));
  const rows = saved.paths.map(
    (path) => `- ${path}${inMessage.has(path) ? " (in this message)" : ""}`,
  );
  const notSaved = saved.notSaved.map((each) => `- ${each}`);
  return [
    `## Saved files\n\nSaved in ${saved.folder}:\n${rows.join("\n")}`,
    notSaved.length === 0 ? "" : `Not saved:\n${notSaved.join("\n")}`,
  ]
    .filter((block) => block !== "")
    .join("\n\n");
}

function pictures(count: number): string {
  if (count === 0) return "";
  const these = count === 1 ? "The picture is" : `The ${count} pictures are`;
  return `${these} in this message: look at ${count === 1 ? "it" : "them"}. The other attachments are saved beside them; open one with the Read tool when you need it.`;
}

export function threadPrompt(parts: PromptParts): string {
  const { thread, url, account } = parts;
  const first = thread.messages[0];
  const subject = first === undefined ? "" : readMessage(first.payload).subject;
  const blocks = [
    `# ${subject === "" ? "(no subject)" : subject}`,
    `${url} · Gmail account ${account}`,
    `Participants: ${participants(thread.messages.map((each) => readMessage(each.payload)))}`,
    `## Messages (${thread.messages.length}, oldest first)\n\n${messages(thread)}`,
    files(parts),
    pictures(parts.carried.length),
    DRAFT_RULE,
  ];
  return blocks.filter((block) => block !== "").join("\n\n");
}

/** A short name for the session and its worktree: "Plans för Tuesday" → "plans-for-tuesday". */
export function slugOf(subject: string): string {
  const slug = subject
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" ? "gmail-thread" : slug;
}
