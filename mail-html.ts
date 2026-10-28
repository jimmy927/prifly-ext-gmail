/**
 * Pictures inside a mail's text: the `[image:name]` markers a body carries,
 * the HTML made from a plain body, and the plain and HTML versions with the
 * markers resolved. Pure; the files are read by the tools.
 */

import type { InlineImage } from "./mime";

/** An image as the tool read it, before it gets its Content-ID. */
export type ImageFile = Omit<InlineImage, "id">;

/** A mail with pictures or HTML: its plain alternative, its HTML and the images with their ids. */
export type RichMail = { text: string; html: string; images: InlineImage[] };

const MARKER_LINE = /^\s*\[image:\s*([^\]\r\n]+?)\s*\]\s*$/;
const MARKER_ANY = /\[image:\s*([^\]\r\n]+?)\s*\]/g;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `ii_` and twelve random hex digits: Gmail's own style of inline image id. */
function newImageId(): string {
  return `ii_${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex")}`;
}

const imageTag = (image: InlineImage): string =>
  `<img src="cid:${image.id}" alt="${escapeHtml(image.name)}" style="max-width:100%">`;

type Run = { kind: "p" | "ul" | "ol"; items: string[] };

function runHtml(run: Run): string {
  const items = run.items.map(escapeHtml);
  if (run.kind === "p") return `<p>${items.join("<br>")}</p>`;
  return `<${run.kind}>${items.map((each) => `<li>${each}</li>`).join("")}</${run.kind}>`;
}

/** A non-blank line as a list item (without its bullet or number) or paragraph text. */
function classify(line: string): { kind: Run["kind"]; text: string } {
  const bullet = BULLET.exec(line);
  if (bullet !== null) return { kind: "ul", text: bullet[1] ?? "" };
  const number = NUMBER.exec(line);
  if (number !== null) return { kind: "ol", text: number[1] ?? "" };
  return { kind: "p", text: line.trim() };
}

/**
 * A plain body as HTML: blank lines split paragraphs, a single line break
 * inside one becomes `<br>`, `- ` / `* ` lines a `<ul>`, `1. ` / `1) ` lines
 * an `<ol>`, and a marker line the picture in a paragraph of its own.
 */
export function textToHtml(body: string, images: InlineImage[]): string {
  const byName = new Map(images.map((each) => [each.name, each]));
  const out: string[] = [];
  const open: { run: Run | null } = { run: null };
  const flush = () => {
    if (open.run !== null) out.push(runHtml(open.run));
    open.run = null;
  };
  for (const line of body.split(/\r?\n/)) {
    const marker = MARKER_LINE.exec(line);
    if (marker !== null || line.trim() === "") {
      flush();
      const image = byName.get(marker?.[1] ?? "");
      if (image !== undefined) out.push(`<p>${imageTag(image)}</p>`);
      continue;
    }
    const { kind, text } = classify(line);
    if (open.run?.kind !== kind) {
      flush();
      open.run = { kind, items: [] };
    }
    open.run.items.push(text);
  }
  flush();
  return out.join("\n");
}

/** The names in the markers on a line of their own (`lines`) or anywhere in the text. */
function markerNames(text: string, onOwnLine: boolean): string[] {
  if (onOwnLine) {
    return text.split(/\r?\n/).flatMap((line) => MARKER_LINE.exec(line)?.[1] ?? []);
  }
  return [...text.matchAll(MARKER_ANY)].flatMap((found) => found[1] ?? []);
}

/** The image names the markers on a line of their own in `text` use, in order. */
export const markedImageNames = (text: string): string[] => markerNames(text, true);

/** Why the images and markers do not fit together, or null. */
function markerProblem(
  names: string[],
  bodyMarkers: string[],
  htmlMarkers: string[],
  htmlGiven: boolean,
): string | null {
  if (new Set(names).size !== names.length)
    return "Not done: two inline images have the same name.";
  for (const name of [...bodyMarkers, ...htmlMarkers]) {
    if (!names.includes(name)) {
      return `Not done: [image:${name}] names no inline image (the images are ${names.join(", ") || "none"}).`;
    }
  }
  const shown = htmlGiven ? htmlMarkers : bodyMarkers;
  const lost = names.find((name) => !shown.includes(name));
  if (lost === undefined) return null;
  return `Not done: inline image “${lost}” is never referenced: put [image:${lost}] ${
    htmlGiven ? "in the html" : "on a line of its own in the body"
  }.`;
}

/**
 * The plain text, the HTML and the identified images of a mail, or why the
 * markers do not match the images; null when the mail has neither images nor
 * html and goes out as plain text alone.
 */
export function richBody(body: string, html: string, files: ImageFile[]): RichMail | string | null {
  const htmlGiven = html.trim() !== "";
  const bodyMarkers = markerNames(body, true);
  if (files.length === 0 && !htmlGiven && bodyMarkers.length === 0) return null;
  const names = files.map((each) => each.name);
  const problem = markerProblem(names, bodyMarkers, markerNames(html, false), htmlGiven);
  if (problem !== null) return problem;
  const images = files.map((each) => ({ ...each, id: newImageId() }));
  const byName = new Map(images.map((each) => [each.name, each]));
  const text = body
    .split(/\r?\n/)
    .map((line) => {
      const marker = MARKER_LINE.exec(line);
      return marker === null ? line : `[image: ${marker[1]}]`;
    })
    .join("\n");
  const withImages = html.replace(MARKER_ANY, (_, name: string) => {
    const image = byName.get(name);
    return image === undefined ? "" : imageTag(image);
  });
  return { text, html: htmlGiven ? withImages : textToHtml(body, images), images };
}
