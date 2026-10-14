/**
 * Gmail's own API reference, read from its discovery document: the list of
 * its methods, and for the ones asked about their paths, parameters and
 * request and response schemas, as text short enough for a session. A
 * changed API is then a new read, not a new version of the extension.
 */

import { isRecord, list, str } from "./gmail-types";

export const DISCOVERY_URL = "https://gmail.googleapis.com/$discovery/rest?version=v1";

/** Where every method of the users resource lives; `gmail_api` takes paths below it. */
const USER_PREFIX = "gmail/v1/users/{userId}";

const MAX_TEXT = 20_000;
const MAX_METHODS = 5;
/** How many levels of `$ref` a schema is opened into. */
const SCHEMA_DEPTH = 2;

type Json = Record<string, unknown>;

export type Method = {
  id: string;
  httpMethod: string;
  /** Relative to users/me when it is below it ("/messages/send"), else as the document says. */
  path: string;
  description: string;
  parameters: Json;
  request: string;
  response: string;
};

const record = (value: unknown): Json => (isRecord(value) ? value : {});

const short = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

function relativePath(path: string): string {
  return path.startsWith(USER_PREFIX) ? path.slice(USER_PREFIX.length) || "/" : path;
}

/** Every method in the document, depth first, as its resources nest them. */
export function methodsOf(document: unknown): Method[] {
  const out: Method[] = [];
  const walk = (resource: Json) => {
    for (const value of Object.values(record(resource["methods"]))) {
      const method = record(value);
      out.push({
        id: str(method["id"]),
        httpMethod: str(method["httpMethod"]),
        path: relativePath(str(method["path"])),
        description: str(method["description"]),
        parameters: record(method["parameters"]),
        request: str(record(method["request"])["$ref"]),
        response: str(record(method["response"])["$ref"]),
      });
    }
    for (const child of Object.values(record(resource["resources"]))) walk(record(child));
  };
  walk(record(document));
  return out;
}

/** The methods whose id or path holds `wanted`; an exact id or id ending wins over the rest. */
export function matchMethods(methods: Method[], wanted: string): Method[] {
  const asked = wanted.trim().toLowerCase();
  const exact = methods.filter(
    (each) => each.id.toLowerCase() === asked || each.id.toLowerCase().endsWith(`.${asked}`),
  );
  if (exact.length > 0) return exact;
  return methods.filter(
    (each) => each.id.toLowerCase().includes(asked) || each.path.toLowerCase().includes(asked),
  );
}

function typeLabel(property: Json): string {
  const ref = str(property["$ref"]);
  if (ref !== "") return ref;
  if (str(property["type"]) === "array") return `${typeLabel(record(property["items"]))}[]`;
  const format = str(property["format"]);
  const type = str(property["type"]) || "any";
  return format === "" ? type : `${type} (${format})`;
}

/** The `$ref` a property opens into, through an array's items too. */
const refOf = (property: Json): string =>
  str(property["$ref"]) || str(record(property["items"])["$ref"]);

function schemaLines(schemas: Json, name: string, depth: number, indent: string): string[] {
  const properties = record(record(schemas[name])["properties"]);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const property = record(value);
    const about = short(str(property["description"]), 140);
    lines.push(`${indent}${key}: ${typeLabel(property)}${about === "" ? "" : ` — ${about}`}`);
    const ref = refOf(property);
    if (ref !== "" && ref !== name && depth < SCHEMA_DEPTH) {
      lines.push(...schemaLines(schemas, ref, depth + 1, `${indent}  `));
    }
  }
  return lines;
}

function parameterLines(parameters: Json): string[] {
  return Object.entries(parameters)
    .filter(([name]) => name !== "userId")
    .map(([name, value]) => {
      const each = record(value);
      const where = str(each["location"]) === "path" ? "in the path" : "query";
      const required = each["required"] === true ? ", required" : "";
      const repeated = each["repeated"] === true ? ", repeatable" : "";
      const values = list(each["enum"]).map(str).join(" | ");
      const about = short(str(each["description"]), 200);
      return `- ${name} (${typeLabel(each)}, ${where}${required}${repeated})${values === "" ? "" : ` [${values}]`}: ${about}`;
    });
}

function methodText(method: Method, schemas: Json): string {
  const lines = [
    `## ${method.id}`,
    `${method.httpMethod} ${method.path}`,
    short(method.description, 600),
  ];
  const parameters = parameterLines(method.parameters);
  if (parameters.length > 0) lines.push("", "Parameters:", ...parameters);
  if (method.request !== "") {
    lines.push(
      "",
      `Request body: ${method.request}`,
      ...schemaLines(schemas, method.request, 1, "  "),
    );
  }
  if (method.response !== "") {
    lines.push(
      "",
      `Response: ${method.response}`,
      ...schemaLines(schemas, method.response, 1, "  "),
    );
  }
  return lines.join("\n");
}

function trimmed(text: string): string {
  return text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters: ask for one method by its full id)`
    : text;
}

/** One line per method, or the details of the methods matching `wanted`. */
export function docsText(document: unknown, wanted: string): string {
  const methods = methodsOf(document);
  if (wanted.trim() === "") {
    const rows = methods.map((each) => `${each.id} | ${each.httpMethod} ${each.path}`);
    return trimmed(
      [
        "Gmail API methods (paths are relative to users/me, as gmail_api takes them):",
        ...rows,
      ].join("\n"),
    );
  }
  const found = matchMethods(methods, wanted);
  if (found.length === 0)
    return `No Gmail API method matches “${wanted}”. Call without a method for the list.`;
  const schemas = record(record(document)["schemas"]);
  const shown = found.slice(0, MAX_METHODS).map((each) => methodText(each, schemas));
  const more =
    found.length > MAX_METHODS
      ? [
          `(${found.length - MAX_METHODS} more match: ${found
            .slice(MAX_METHODS)
            .map((each) => each.id)
            .join(", ")})`,
        ]
      : [];
  return trimmed([...shown, ...more].join("\n\n"));
}
