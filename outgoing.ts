/**
 * What an outgoing mail carries besides its headers: the local files and
 * inline images the arguments name, read now and held to Gmail's size limit,
 * the card text that lists them, and the check that Gmail's saved copy still
 * has them all.
 */

import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { failureText, type GmailClient } from "./gmail";
import { type ImageFile, type RichMail, richBody } from "./mail-html";
import { type FileAttachment, type InlineImage, type RichContent, savedCopyProblems } from "./mime";
import { type Args, strings, untrimmed } from "./tool-kit";

/** Gmail's own limit for what a mail carries. */
const MAX_ATTACHED_BYTES = 25 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const ATTACHMENTS_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: "Absolute paths of local files to attach.",
};

export const INLINE_IMAGES_PROPERTY = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string", description: "The name the body's [image:name] marker uses." },
      path: { type: "string", description: "Absolute path of a png, jpeg, gif or webp file." },
    },
    required: ["name", "path"],
    additionalProperties: false,
  },
  description:
    "Pictures that show inside the mail, each at a line of its own in `body` reading [image:name].",
};

export const HTML_PROPERTY = {
  type: "string",
  description:
    "Optional HTML body, which may hold [image:name] markers. Then `body` stays the plain-text alternative. Left out with inline_images: made from `body`.",
};

export function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

const readError = (path: string, error: unknown): string =>
  `Not done: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`;

/** The local files to attach, read now, or why they cannot be. */
async function localFiles(paths: string[]): Promise<FileAttachment[] | string> {
  const files: FileAttachment[] = [];
  for (const path of paths) {
    if (!isAbsolute(path)) return `Not done: ${path} is not an absolute path.`;
    try {
      const bytes = new Uint8Array(await readFile(path));
      const mimeType = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
      files.push({ filename: basename(path), mimeType, bytes });
    } catch (error) {
      return readError(path, error);
    }
  }
  return files;
}

/** One `inline_images` entry, its file read now, or why it cannot be used. */
async function localImage(entry: Args): Promise<ImageFile | string> {
  const name = typeof entry["name"] === "string" ? entry["name"].trim() : "";
  const path = typeof entry["path"] === "string" ? entry["path"].trim() : "";
  if (name === "" || path === "") return "Not done: every inline image needs a name and a path.";
  if (!isAbsolute(path)) return `Not done: ${path} is not an absolute path.`;
  const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (mimeType === undefined) return `Not done: ${path} is not a png, jpeg, gif or webp image.`;
  try {
    return {
      name,
      filename: basename(path),
      mimeType,
      bytes: new Uint8Array(await readFile(path)),
    };
  } catch (error) {
    return readError(path, error);
  }
}

/** The `inline_images` argument, each file read now, or why one cannot be used. */
async function localImages(args: Args): Promise<ImageFile[] | string> {
  const given = args["inline_images"];
  if (given === undefined) return [];
  if (!Array.isArray(given)) return "Not done: inline_images must be a list of {name, path}.";
  const images: ImageFile[] = [];
  for (const each of given as unknown[]) {
    const image = await localImage(typeof each === "object" && each !== null ? (each as Args) : {});
    if (typeof image === "string") return image;
    images.push(image);
  }
  return images;
}

function tooBig(files: { bytes: Uint8Array }[]): string | null {
  const total = files.reduce((sum, each) => sum + each.bytes.length, 0);
  return total > MAX_ATTACHED_BYTES
    ? `Not done: the attachments come to ${size(total)}, over Gmail's 25 MB.`
    : null;
}

/** `more` and the local files `attachments` names, read now, or why they cannot go. */
export async function filesFor(
  args: Args,
  more: FileAttachment[] = [],
): Promise<FileAttachment[] | string> {
  const local = await localFiles(strings(args, "attachments"));
  if (typeof local === "string") return local;
  const files = [...more, ...local];
  return tooBig(files) ?? files;
}

/** The files, pictures and HTML of a mail beside its plain body. */
export type MailContent = {
  /** The plain text that goes out, with the markers resolved. */
  text: string;
  /** The HTML and identified images; undefined for a plain mail. */
  rich: RichContent | undefined;
  images: InlineImage[];
  files: FileAttachment[];
  /** The `html` argument as given, for the card; "" when the tool made the HTML from `body`. */
  html: string;
};

/** What the tool arguments make of `body`: its files, pictures and HTML, or why it cannot go. */
export async function mailContent(
  args: Args,
  body: string,
  more: FileAttachment[] = [],
): Promise<MailContent | string> {
  const files = await filesFor(args, more);
  if (typeof files === "string") return files;
  const imageFiles = await localImages(args);
  if (typeof imageFiles === "string") return imageFiles;
  const big = tooBig([...files, ...imageFiles]);
  if (big !== null) return big;
  const html = untrimmed(args, "html");
  const rich: RichMail | string | null = richBody(body, html, imageFiles);
  if (typeof rich === "string") return rich;
  if (rich === null) return { text: body, rich: undefined, images: [], files, html: "" };
  return {
    text: rich.text,
    rich: { html: rich.html, images: rich.images },
    images: rich.images,
    files,
    html: html.trim() === "" ? "" : html,
  };
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** " with 2 inline images and 1 attachment" for a card summary; "" for a plain mail. */
export function extrasText(content: Pick<MailContent, "images" | "files">): string {
  const parts = [
    content.images.length > 0 ? count(content.images.length, "inline image") : "",
    content.files.length > 0 ? count(content.files.length, "attachment") : "",
  ].filter((each) => each !== "");
  return parts.length === 0 ? "" : ` with ${parts.join(" and ")}`;
}

/** What a confirm card shows of a mail: its headers, its pictures and files, then its text as written. */
export function mailDetails(
  headers: [string, string][],
  content: Pick<MailContent, "images" | "files" | "html">,
  body: string,
): string {
  const lines = headers
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}: ${value}`);
  if (content.images.length > 0) {
    lines.push(
      "Inline images:",
      ...content.images.map(
        (each) => `- ${each.name} (${each.filename}, ${size(each.bytes.length)})`,
      ),
    );
  }
  if (content.files.length > 0) {
    lines.push(
      "Attachments:",
      ...content.files.map((each) => `- ${each.filename} (${size(each.bytes.length)})`),
    );
  }
  const shown = [...lines, "", body];
  if (content.html !== "") shown.push("", "HTML version:", content.html);
  return shown.join("\n");
}

/**
 * Reads the saved message back and answers the error text when Gmail's copy
 * lost a picture or file ("Saved" for a draft, "Sent" for a mail), else null.
 * A plain mail with no files is not worth failing over when the read-back
 * itself fails.
 */
export async function brokenCopy(
  client: GmailClient,
  done: "Saved" | "Sent",
  what: string,
  messageId: string,
  content: MailContent,
): Promise<string | null> {
  const names = [...content.images, ...content.files].map((each) => each.filename);
  const checked = content.rich !== undefined || names.length > 0;
  const got = messageId === "" ? null : await client.message(messageId);
  let problems: string[] = [];
  if (got === null || !got.ok) {
    if (checked) {
      const why = got === null ? "Gmail gave no message id" : failureText(got);
      problems = [`it could not be read back to check it (${why})`];
    }
  } else problems = savedCopyProblems(got.value.payload, names);
  if (problems.length === 0) return null;
  return `${done}, but Gmail's copy is broken: ${what}: ${problems.join("; ")}.`;
}
