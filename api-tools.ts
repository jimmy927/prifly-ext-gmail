/**
 * The whole Gmail API, for what the curated tools do not cover: `gmail_api`
 * makes any call below users/me with the reader's connection (a GET at once,
 * anything else only after the reader confirms the exact request), and
 * `gmail_api_docs` reads Gmail's own reference to find the call to make.
 */

import type { ExtensionApi, ExtensionTool } from "@prifly/extension-api";
import { DISCOVERY_URL, docsText } from "./discovery";
import { failureText, GMAIL_API } from "./gmail";
import { isRecord } from "./gmail-types";
import { decodeBase64url } from "./mime";
import { type Args, confirmFirst, schema, text, withGmail } from "./tool-kit";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX_ANSWER = 30_000;
const MAX_RAW_SHOWN = 4_000;

export type ApiToolsOptions = {
  /** Fetches the discovery document; replaced in tests. */
  fetch?: (url: string) => Promise<Response>;
};

/** The path below users/me, from what a session wrote; null when it would leave it. */
export function userPath(given: string): string | null {
  const path = given.trim().replace(/^\/?(gmail\/v1\/)?users\/me(?=\/|$)/, "");
  const outside = ["://", "..", "?", "#"].some((each) => path.includes(each));
  if (outside || path === "" || path === "/") return null;
  return path.startsWith("/") ? path : `/${path}`;
}

/** The query as URL parameters: each value a string, number or boolean, or a list of them. */
function queryString(query: unknown): string {
  if (!isRecord(query)) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const each of Array.isArray(value) ? value : [value]) {
      if (["string", "number", "boolean"].includes(typeof each)) params.append(key, String(each));
    }
  }
  const out = params.toString();
  return out === "" ? "" : `?${out}`;
}

/** The base64url `raw` of a message or draft body, decoded, so the card shows the mail itself. */
function rawShown(body: unknown): string {
  if (!isRecord(body)) return "";
  const message = isRecord(body["message"]) ? body["message"] : body;
  const raw = message["raw"];
  if (typeof raw !== "string" || raw === "") return "";
  const decoded = decodeBase64url(raw);
  const cut = decoded.length > MAX_RAW_SHOWN ? `${decoded.slice(0, MAX_RAW_SHOWN)}\n…` : decoded;
  return `\n\nThe raw mail, decoded:\n${cut}`;
}

function answerText(method: string, answer: string): string {
  if (answer.trim() === "") return method === "GET" ? "Gmail answered with no content." : "Done.";
  return answer.length > MAX_ANSWER
    ? `${answer.slice(0, MAX_ANSWER)}\n… (cut at ${MAX_ANSWER} characters: ask for less with \`fields\` or \`maxResults\`)`
    : answer;
}

async function callApi(getApi: () => ExtensionApi | null, args: Args): Promise<string> {
  const method = (text(args, "method") || "GET").toUpperCase();
  if (!METHODS.includes(method)) return `method must be one of ${METHODS.join(", ")}.`;
  const path = userPath(text(args, "path"));
  if (path === null) {
    return "path must be a path below gmail/v1/users/me, like /messages or /labels/INBOX, with the query in `query`.";
  }
  const target = `${path}${queryString(args["query"])}`;
  const body = args["body"];
  return await withGmail(getApi(), args, async ({ api, client }) => {
    if (method !== "GET") {
      const shown = body === undefined ? "" : `\n\n${JSON.stringify(body, null, 2)}`;
      const refused = await confirmFirst(api, {
        title: "Gmail API call",
        summary: `${method} ${target}`,
        details: `${method} ${GMAIL_API}${target}${shown}${rawShown(body)}`,
      });
      if (refused !== null) return refused;
    }
    const got = await client.request(method, target, method === "GET" ? undefined : body);
    return got.ok ? answerText(method, got.value) : failureText(got);
  });
}

export function apiTool(getApi: () => ExtensionApi | null): ExtensionTool {
  return {
    name: "gmail_api",
    description:
      "Calls any Gmail REST method below gmail/v1/users/me with the reader's account, for what the other gmail_ tools do not do (filters, settings, history, single messages…). See gmail_api_docs for the methods. A GET runs at once; any other method shows the reader the exact request on a confirm card first. Answers Gmail's JSON.",
    inputSchema: schema(
      {
        method: { type: "string", description: "GET (default), POST, PUT, PATCH or DELETE." },
        path: {
          type: "string",
          description: "Relative to gmail/v1/users/me, e.g. /messages/{id} or /settings/filters.",
        },
        query: {
          type: "object",
          description: "Query parameters; a list repeats the parameter.",
          additionalProperties: true,
        },
        body: { type: "object", description: "The JSON request body.", additionalProperties: true },
      },
      ["path"],
    ),
    call: (args) => callApi(getApi, args),
  };
}

export function apiDocsTool(options: ApiToolsOptions): ExtensionTool {
  const fetchDocs = options.fetch ?? ((url: string) => fetch(url));
  let cached: unknown = null;
  const load = async (): Promise<unknown> => {
    if (cached !== null) return cached;
    const answer = await fetchDocs(DISCOVERY_URL);
    if (!answer.ok) throw new Error(`Gmail's discovery document answered ${answer.status}.`);
    cached = (await answer.json()) as unknown;
    return cached;
  };
  return {
    name: "gmail_api_docs",
    description:
      "Gmail's own API reference, read from its discovery document. Without `method`: every method with its HTTP verb and path (relative to users/me, as gmail_api takes it). With `method` (an id like `users.messages.send` or a part of one, like `filters`): the matching methods' parameters and request and response fields. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "A method id or part of one; left out, the list." },
      },
      additionalProperties: false,
    },
    async call(args) {
      try {
        return docsText(await load(), text(args, "method"));
      } catch (error) {
        return `Could not read Gmail's API reference: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
