import { expect, test } from "bun:test";
import { apiDocsTool } from "../api-tools";
import { DISCOVERY_URL, docsText } from "../discovery";

/** A small slice of Gmail's discovery document, shaped as the real one is. */
const DOCUMENT = {
  resources: {
    users: {
      methods: {
        getProfile: {
          id: "gmail.users.getProfile",
          httpMethod: "GET",
          path: "gmail/v1/users/{userId}/profile",
          description: "Gets the current user's Gmail profile.",
          parameters: { userId: { location: "path", type: "string", required: true } },
          response: { $ref: "Profile" },
        },
      },
      resources: {
        messages: {
          methods: {
            send: {
              id: "gmail.users.messages.send",
              httpMethod: "POST",
              path: "gmail/v1/users/{userId}/messages/send",
              description: "Sends the specified message to the recipients.",
              parameters: { userId: { location: "path", type: "string", required: true } },
              request: { $ref: "Message" },
              response: { $ref: "Message" },
            },
            list: {
              id: "gmail.users.messages.list",
              httpMethod: "GET",
              path: "gmail/v1/users/{userId}/messages",
              description: "Lists the messages in the user's mailbox.",
              parameters: {
                userId: { location: "path", type: "string", required: true },
                q: { location: "query", type: "string", description: "Only matching messages." },
                labelIds: { location: "query", type: "string", repeated: true },
              },
              response: { $ref: "ListMessagesResponse" },
            },
          },
        },
      },
    },
  },
  schemas: {
    Profile: { properties: { emailAddress: { type: "string" } } },
    Message: {
      properties: {
        raw: { type: "string", format: "byte", description: "The entire email, base64url." },
        threadId: { type: "string" },
        payload: { $ref: "MessagePart" },
      },
    },
    MessagePart: {
      properties: {
        mimeType: { type: "string" },
        parts: { type: "array", items: { $ref: "MessagePart" } },
      },
    },
    ListMessagesResponse: {
      properties: { messages: { type: "array", items: { $ref: "Message" } } },
    },
  },
};

test("without a method the docs list every method with its path below users/me", () => {
  expect(docsText(DOCUMENT, "")).toBe(
    [
      "Gmail API methods (paths are relative to users/me, as gmail_api takes them):",
      "gmail.users.getProfile | GET /profile",
      "gmail.users.messages.send | POST /messages/send",
      "gmail.users.messages.list | GET /messages",
    ].join("\n"),
  );
});

test("a method shows its parameters and its request and response fields", () => {
  const send = docsText(DOCUMENT, "messages.send");
  expect(send).toContain("## gmail.users.messages.send\nPOST /messages/send");
  expect(send).toContain("Request body: Message");
  expect(send).toContain("  raw: string (byte) — The entire email, base64url.");
  expect(send).toContain("  payload: MessagePart\n    mimeType: string");
  expect(send).not.toContain("userId");
  const list = docsText(DOCUMENT, "gmail.users.messages.list");
  expect(list).toContain("- q (string, query): Only matching messages.");
  expect(list).toContain("- labelIds (string, query, repeatable)");
  expect(list).not.toContain("messages.send");
  expect(docsText(DOCUMENT, "filters")).toContain("No Gmail API method matches");
});

test("gmail_api_docs reads the discovery document once and says when it cannot", async () => {
  const asked: string[] = [];
  const tool = apiDocsTool({
    fetch: async (url) => {
      asked.push(url);
      return Response.json(DOCUMENT);
    },
  });
  const ctx = {} as Parameters<typeof tool.call>[1];
  expect(await tool.call({ method: "getProfile" }, ctx)).toContain("GET /profile");
  expect(await tool.call({}, ctx)).toContain("gmail.users.messages.list | GET /messages");
  expect(asked).toEqual([DISCOVERY_URL]);
  const broken = apiDocsTool({ fetch: async () => new Response("down", { status: 503 }) });
  expect(await broken.call({}, ctx)).toBe(
    "Could not read Gmail's API reference: Gmail's discovery document answered 503.",
  );
});
