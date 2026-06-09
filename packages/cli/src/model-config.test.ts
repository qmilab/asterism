import { expect, test } from "bun:test";

import { resolveModelConfig } from "./model-config.ts";

test("openai is the default provider with its OpenAI endpoint", () => {
  const { model } = resolveModelConfig({ ASTERISM_MODEL_ID: "gpt-4o-mini" });
  expect(model).toEqual({
    provider: "openai",
    id: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
  });
  // OpenAI uses the adapter's own default protocol, so `api` is left unset.
  expect(model?.api).toBeUndefined();
});

test("the anthropic provider defaults to the Anthropic protocol and endpoint", () => {
  const { model } = resolveModelConfig({
    ASTERISM_MODEL_ID: "claude-haiku-4-5",
    ASTERISM_MODEL_PROVIDER: "anthropic",
  });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-haiku-4-5",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("explicit overrides beat the provider defaults", () => {
  const { model } = resolveModelConfig({
    ASTERISM_MODEL_ID: "x",
    ASTERISM_MODEL_PROVIDER: "anthropic",
    ASTERISM_MODEL_API: "openai-completions",
    ASTERISM_MODEL_BASE_URL: "http://localhost:1234",
  });
  expect(model).toMatchObject({
    api: "openai-completions",
    baseUrl: "http://localhost:1234",
  });
});

test("a missing model id is explained, not silently accepted", () => {
  const { model, reason } = resolveModelConfig({});
  expect(model).toBeUndefined();
  expect(reason).toContain("ASTERISM_MODEL_ID");
});

test("an unknown provider needs an explicit base URL", () => {
  const { model, reason } = resolveModelConfig({
    ASTERISM_MODEL_ID: "x",
    ASTERISM_MODEL_PROVIDER: "cohere",
  });
  expect(model).toBeUndefined();
  expect(reason).toContain("ASTERISM_MODEL_BASE_URL");
});

test("an unknown provider builds once given a base URL", () => {
  const { model } = resolveModelConfig({
    ASTERISM_MODEL_ID: "x",
    ASTERISM_MODEL_PROVIDER: "cohere",
    ASTERISM_MODEL_BASE_URL: "https://api.cohere.example/v1",
  });
  expect(model).toMatchObject({
    provider: "cohere",
    baseUrl: "https://api.cohere.example/v1",
  });
  // No protocol default for an unknown provider — the adapter's default applies.
  expect(model?.api).toBeUndefined();
});
