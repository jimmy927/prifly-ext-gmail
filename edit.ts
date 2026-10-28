/**
 * The reader's edit of a mail on the editable card: the text rebuilt the way
 * the session's is, a removed picture marker dropping its image, and the
 * answer that tells the session what went out.
 */

import { markedImageNames, type RichMail, richBody } from "./mail-html";
import { type ReplyEnvelope, rawReply } from "./mime";
import type { MailContent } from "./outgoing";
import type { MailChoice } from "./tool-kit";

/**
 * The mail with the text the reader edited in place of the session's: the
 * HTML is made from it as it is made from `body`, and an image whose marker
 * the reader removed is dropped. A marker naming no image is an error, so
 * nothing goes out with a picture missing.
 */
export function editedContent(content: MailContent, text: string): MailContent | string {
  const names = content.images.map((each) => each.name);
  const marked = markedImageNames(text);
  const unknown = marked.find((name) => !names.includes(name));
  if (unknown !== undefined) {
    return `Not done: [image:${unknown}] names no inline image (the images are ${names.join(", ") || "none"}).`;
  }
  const kept = content.images.filter((each) => marked.includes(each.name));
  const rich: RichMail | string | null = richBody(text, "", kept);
  if (typeof rich === "string") return rich;
  if (rich === null) return { ...content, text, rich: undefined, images: [], html: "" };
  return {
    ...content,
    text: rich.text,
    rich: { html: rich.html, images: rich.images },
    images: rich.images,
    html: "",
  };
}

/** What goes out of a mail: the content and the subject, the session's or the reader's edit of them. */
export type Final = { content: MailContent; subject: string };

/**
 * The session's mail, or the reader's edit of it when they made one: the
 * text rebuilt like the session's (see `editedContent`), the subject as they
 * left it. Why it cannot go, before anything is written. A forward's text is
 * its note, which may be empty.
 */
export function finalMail(
  content: MailContent,
  subject: string,
  choice: MailChoice,
  noteOnly = false,
): Final | string {
  const edit = choice.edit;
  if (edit === undefined) return { content, subject };
  if (!noteOnly && edit.text.trim() === "") {
    return "Not done: the reader emptied the body, so nothing was saved or sent.";
  }
  const edited = editedContent(content, edit.text);
  return typeof edited === "string" ? edited : { content: edited, subject: edit.subject.trim() };
}

/** The answer, with what the reader edited when they did, so the session knows what went out. */
export const withEdit = (choice: MailChoice, answer: string): string =>
  choice.edit === undefined
    ? answer
    : `${answer}\nThe reader edited the mail before it went out. Final subject: “${choice.edit.subject.trim()}”. Final text:\n${choice.edit.text}`;

/** The raw reply; an edited subject replaces the Subject, and the threading headers stay. */
export const replyRaw = (envelope: ReplyEnvelope, final: Final): string =>
  rawReply(
    { ...envelope, subject: final.subject },
    final.content.text,
    final.content.files,
    final.content.rich,
  );
