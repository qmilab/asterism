import { expect, test } from "bun:test";

import { createHttpChatClient } from "./model.js";
import type { HttpChatClientConfig } from "./model.js";

interface Captured {
  url: string;
  init: RequestInit;
}

/** A fake `fetch` that records its call and returns a canned Response. */
function fakeFetch(
  response: Response,
  capture: Captured[],
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.push({ url: String(url), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
}

function body(captured: Captured): Record<string, unknown> {
  return JSON.parse(String(captured.init.body)) as Record<string, unknown>;
}

function headers(captured: Captured): Record<string, string> {
  return (captured.init.headers ?? {}) as Record<string, string>;
}

const REQUEST = { system: "be helpful", user: "the transcript" };

test("the OpenAI shape posts chat-completions with a bearer key and reads the message content", async () => {
  const capture: Captured[] = [];
  const response = new Response(
    JSON.stringify({ choices: [{ message: { content: "openai says hi" } }] }),
    { status: 200 },
  );
  const config: HttpChatClientConfig = {
    provider: "openai",
    id: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    fetchImpl: fakeFetch(response, capture),
  };

  const text = await createHttpChatClient(config).complete(REQUEST);
  expect(text).toBe("openai says hi");

  const call = capture[0]!;
  expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
  expect(headers(call)["authorization"]).toBe("Bearer sk-test");
  const sent = body(call);
  expect(sent.model).toBe("gpt-4o-mini");
  expect(sent.temperature).toBe(0);
  expect(typeof sent.max_tokens).toBe("number"); // the cap is sent for OpenAI too
  expect(sent.messages).toEqual([
    { role: "system", content: "be helpful" },
    { role: "user", content: "the transcript" },
  ]);
});

test("an explicit api override wins over the provider name (anthropic name, OpenAI protocol)", async () => {
  const capture: Captured[] = [];
  const response = new Response(
    JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    { status: 200 },
  );
  const config: HttpChatClientConfig = {
    provider: "anthropic",
    api: "openai-completions",
    id: "proxy-model",
    baseUrl: "https://proxy.example/v1",
    apiKey: "sk-test",
    fetchImpl: fakeFetch(response, capture),
  };
  await createHttpChatClient(config).complete(REQUEST);
  // Routed as OpenAI despite the "anthropic" provider name, because api was explicit.
  expect(capture[0]!.url).toBe("https://proxy.example/v1/chat/completions");
  expect(headers(capture[0]!)["authorization"]).toBe("Bearer sk-test");
});

test("a trailing slash on the base URL does not produce a doubled-slash path", async () => {
  const capture: Captured[] = [];
  const response = new Response(
    JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    { status: 200 },
  );
  const config: HttpChatClientConfig = {
    provider: "openai",
    id: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1/",
    apiKey: "sk-test",
    fetchImpl: fakeFetch(response, capture),
  };
  await createHttpChatClient(config).complete(REQUEST);
  expect(capture[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
});

test("a present-but-null OpenAI content is treated as empty, not a hard error", async () => {
  const response = new Response(
    JSON.stringify({ choices: [{ message: { content: null }, finish_reason: "stop" }] }),
    { status: 200 },
  );
  const config: HttpChatClientConfig = {
    provider: "openai",
    id: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    fetchImpl: fakeFetch(response, []),
  };
  expect(await createHttpChatClient(config).complete(REQUEST)).toBe("");
});

test("a truncated OpenAI response raises a clear error instead of returning partial JSON", async () => {
  const response = new Response(
    JSON.stringify({ choices: [{ message: { content: '{"memories":[' }, finish_reason: "length" }] }),
    { status: 200 },
  );
  const config: HttpChatClientConfig = {
    provider: "openai",
    id: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    fetchImpl: fakeFetch(response, []),
  };
  await expect(createHttpChatClient(config).complete(REQUEST)).rejects.toThrow(/truncated/);
});

test("a truncated Anthropic response (stop_reason max_tokens) also raises", async () => {
  const response = new Response(
    JSON.stringify({ content: [{ type: "text", text: '{"memories":[' }], stop_reason: "max_tokens" }),
    { status: 200 },
  );
  const config: HttpChatClientConfig = {
    provider: "anthropic",
    api: "anthropic-messages",
    id: "claude-haiku-4-5",
    baseUrl: "https://api.anthropic.com",
    apiKey: "ak-test",
    fetchImpl: fakeFetch(response, []),
  };
  await expect(createHttpChatClient(config).complete(REQUEST)).rejects.toThrow(/truncated/);
});

test("the Anthropic shape posts /v1/messages with x-api-key and concatenates text blocks", async () => {
  const capture: Captured[] = [];
  const response = new Response(
    JSON.stringify({ content: [{ type: "text", text: "claude " }, { type: "text", text: "says hi" }] }),
    { status: 200 },
  );
  const config: HttpChatClientConfig = {
    provider: "anthropic",
    id: "claude-haiku-4-5",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    apiKey: "ak-test",
    fetchImpl: fakeFetch(response, capture),
  };

  const text = await createHttpChatClient(config).complete(REQUEST);
  expect(text).toBe("claude says hi");

  const call = capture[0]!;
  expect(call.url).toBe("https://api.anthropic.com/v1/messages");
  expect(headers(call)["x-api-key"]).toBe("ak-test");
  expect(headers(call)["anthropic-version"]).toBe("2023-06-01");
  const sent = body(call);
  expect(sent.system).toBe("be helpful");
  expect(sent.messages).toEqual([{ role: "user", content: "the transcript" }]);
  expect(typeof sent.max_tokens).toBe("number");
});

test("a non-2xx response raises a clear error carrying the status", async () => {
  const response = new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
  const config: HttpChatClientConfig = {
    provider: "openai",
    id: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    fetchImpl: fakeFetch(response, []),
  };
  await expect(createHttpChatClient(config).complete(REQUEST)).rejects.toThrow(/429/);
});

test("an unrecognized response shape raises rather than returning junk", async () => {
  const response = new Response(JSON.stringify({ nope: true }), { status: 200 });
  const config: HttpChatClientConfig = {
    provider: "openai",
    id: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    fetchImpl: fakeFetch(response, []),
  };
  await expect(createHttpChatClient(config).complete(REQUEST)).rejects.toThrow(/unexpected OpenAI/);
});
