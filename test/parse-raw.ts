/**
 * Reads a raw (base64url RFC 822) mail into the payload shape Gmail's
 * `format=full` answers with: nested parts with their headers, text parts
 * with inline base64url `data`, and parts with a file name with an
 * `attachmentId` instead. A text that is no mail at all becomes one empty
 * text/plain part, so tests with placeholder raws still read back.
 */

export type Payload = {
  partId: string;
  mimeType: string;
  filename: string;
  headers: { name: string; value: string }[];
  body: { size: number; data?: string; attachmentId?: string };
  parts?: Payload[];
};

const splitAt = (text: string, marker: string): [string, string] => {
  const at = text.indexOf(marker);
  return at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at + marker.length)];
};

function parseHeaders(block: string): { name: string; value: string }[] {
  const unfolded = block.replace(/\r\n[ \t]+/g, " ");
  return unfolded.split("\r\n").flatMap((line) => {
    const at = line.indexOf(":");
    return at < 1 ? [] : [{ name: line.slice(0, at), value: line.slice(at + 1).trim() }];
  });
}

const headerOf = (headers: Payload["headers"], name: string): string =>
  headers.find((each) => each.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** A parameter of a header value such as `image/png; name="a.png"`: plain or RFC 2231. */
function parameter(value: string, name: string): string {
  const plain = new RegExp(`${name}="([^"]*)"`, "i").exec(value);
  if (plain) return plain[1] ?? "";
  const extended = new RegExp(`${name}\\*=UTF-8''([^;\\s]*)`, "i").exec(value);
  return extended ? decodeURIComponent(extended[1] ?? "") : "";
}

function parseEntity(
  text: string,
  partId: string,
  counter: { files: number; keep: boolean },
): Payload {
  const [head, body] = splitAt(text, "\r\n\r\n");
  const headers = parseHeaders(head);
  const type = headerOf(headers, "Content-Type");
  const mimeType = (type.split(";")[0] ?? "").trim().toLowerCase() || "text/plain";
  const boundary = parameter(type, "boundary");
  if (mimeType.startsWith("multipart/") && boundary !== "") {
    const chunks = body.split(`--${boundary}`).slice(1, -1);
    const parts = chunks.map((chunk, at) =>
      parseEntity(chunk.replace(/^\r\n/, "").replace(/\r\n$/, ""), `${partId}.${at}`, counter),
    );
    return { partId, mimeType, filename: "", headers, body: { size: 0 }, parts };
  }
  const bytes =
    headerOf(headers, "Content-Transfer-Encoding").toLowerCase() === "base64"
      ? Buffer.from(body.replace(/\s/g, ""), "base64")
      : Buffer.from(body, "utf8");
  const filename =
    parameter(headerOf(headers, "Content-Disposition"), "filename") || parameter(type, "name");
  const leaf = filename === "" ? { size: bytes.length, data: bytes.toString("base64url") } : null;
  return {
    partId,
    mimeType,
    filename,
    headers,
    body: leaf ?? {
      size: bytes.length,
      attachmentId: `att-${++counter.files}`,
      ...(counter.keep ? { data: bytes.toString("base64url") } : {}),
    },
  };
}

/** The payload of a raw mail. */
export function parseRaw(raw: string, keepFileData = false): Payload {
  return parseEntity(Buffer.from(raw, "base64url").toString("utf8"), "0", {
    files: 0,
    keep: keepFileData,
  });
}

/** The payload without any part that has a file name: what a Gmail that lost the pictures and files holds. */
export function withoutFiles(part: Payload): Payload {
  const kept = (part.parts ?? []).filter((each) => each.filename === "").map(withoutFiles);
  return part.parts === undefined ? part : { ...part, parts: kept };
}
