/**
 * What Gmail's REST answers look like, as far as the extension reads them,
 * and tolerant parsers for them: unknown fields are ignored and a missing
 * optional field becomes "" or [].
 */

export type Header = { name: string; value: string };

/** One MIME part of a message payload; `parts` nests for multipart. */
export type Part = {
  partId: string;
  mimeType: string;
  filename: string;
  headers: Header[];
  /** The part's body: base64url `data` inline, or an `attachmentId` to fetch. */
  body: { size: number; data: string; attachmentId: string };
  parts: Part[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  historyId: string;
  payload: Part;
};

export type GmailThread = { id: string; messages: GmailMessage[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function parseHeader(value: unknown): Header {
  const each = isRecord(value) ? value : {};
  return { name: str(each["name"]), value: str(each["value"]) };
}

export function parsePart(value: unknown): Part {
  const part = isRecord(value) ? value : {};
  const body = isRecord(part["body"]) ? part["body"] : {};
  return {
    partId: str(part["partId"]),
    mimeType: str(part["mimeType"]),
    filename: str(part["filename"]),
    headers: list(part["headers"]).map(parseHeader),
    body: {
      size: num(body["size"]),
      data: str(body["data"]),
      attachmentId: str(body["attachmentId"]),
    },
    parts: list(part["parts"]).map(parsePart),
  };
}

export function parseMessage(value: unknown): GmailMessage {
  const message = isRecord(value) ? value : {};
  return {
    id: str(message["id"]),
    threadId: str(message["threadId"]),
    labelIds: list(message["labelIds"]).map(str),
    historyId: str(message["historyId"]),
    payload: parsePart(message["payload"]),
  };
}

export function parseThread(value: unknown): GmailThread {
  const thread = isRecord(value) ? value : {};
  return { id: str(thread["id"]), messages: list(thread["messages"]).map(parseMessage) };
}

export { isRecord, list };
