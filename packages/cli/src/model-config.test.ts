import { expect, test } from "bun:test";

import type { AsterismConfig } from "./config.ts";
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
  // The message names both ways to set a model: the config command and the env var.
  expect(reason).toContain("asterism config set");
  expect(reason).toContain("ASTERISM_MODEL_ID");
});

// --- config file + per-agent layering --------------------------------------

test("the config file supplies the model when no env var is set", () => {
  const config: AsterismConfig = { model: { id: "gpt-4o", provider: "openai" } };
  const { model } = resolveModelConfig({}, { config });
  expect(model).toEqual({
    provider: "openai",
    id: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
  });
});

test("an env var overrides the config-file default", () => {
  const config: AsterismConfig = { model: { id: "gpt-4o" } };
  const { model } = resolveModelConfig({ ASTERISM_MODEL_ID: "gpt-4o-mini" }, { config });
  expect(model?.id).toBe("gpt-4o-mini");
});

test("a per-agent override beats both the env var and the config default", () => {
  const config: AsterismConfig = {
    model: { id: "gpt-4o" },
    agents: { work: { model: { id: "claude-opus-4-8", provider: "anthropic" } } },
  };
  const { model } = resolveModelConfig({ ASTERISM_MODEL_ID: "gpt-4o-mini" }, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("a per-agent override is field-level: it can change just the id", () => {
  // The agent sets only `id`; `provider` falls through to the install default.
  const config: AsterismConfig = {
    model: { id: "claude-sonnet-4-6", provider: "anthropic" },
    agents: { work: { model: { id: "claude-opus-4-8" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("switching provider in an override drops the lower layer's endpoint", () => {
  // Install default points at an OpenAI-compatible gateway (OpenRouter); the agent
  // switches to anthropic without restating an endpoint. It must resolve to
  // anthropic's OWN endpoint, never the gateway URL the default carried.
  const config: AsterismConfig = {
    model: {
      id: "anthropic/claude-sonnet-4-6",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    },
    agents: { work: { model: { id: "claude-opus-4-8", provider: "anthropic" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("an env provider switch drops a config-default endpoint for the old provider", () => {
  const config: AsterismConfig = {
    model: { id: "x", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  };
  const { model } = resolveModelConfig(
    { ASTERISM_MODEL_ID: "claude-sonnet-4-6", ASTERISM_MODEL_PROVIDER: "anthropic" },
    { config },
  );
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("a custom endpoint for the SAME provider survives a model-only override", () => {
  // No provider change in the override, so the lower layer's custom endpoint stays.
  const config: AsterismConfig = {
    model: { id: "claude-sonnet-4-6", provider: "anthropic", baseUrl: "https://anthropic.internal" },
    agents: { work: { model: { id: "claude-opus-4-8" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-8",
    baseUrl: "https://anthropic.internal",
    api: "anthropic-messages",
  });
});

test("a bare base-url survives an override that keeps the implied (default) provider", () => {
  // A base-url with no provider belongs to the default provider (openai). An agent
  // that pins openai explicitly matches that, so the custom endpoint is preserved.
  const config: AsterismConfig = {
    model: { baseUrl: "https://gateway.internal/v1" },
    agents: { work: { model: { id: "gpt-4o", provider: "openai" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "openai",
    id: "gpt-4o",
    baseUrl: "https://gateway.internal/v1",
  });
});

test("a bare base-url belongs to the default provider and is dropped on a switch", () => {
  // `config set gpt-4o --base-url <local>` is an OpenAI-compatible endpoint (no
  // provider ⇒ the default, openai). An agent that switches to anthropic must NOT
  // inherit that local OpenAI endpoint/protocol — it falls back to anthropic's.
  const config: AsterismConfig = {
    model: { id: "gpt-4o", baseUrl: "http://localhost:1234/v1" },
    agents: { work: { model: { id: "claude-opus-4-8", provider: "anthropic" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("an agent without its own override falls back to env, then config", () => {
  const config: AsterismConfig = {
    model: { id: "gpt-4o" },
    agents: { work: { model: { id: "claude-opus-4-8", provider: "anthropic" } } },
  };
  // `personal` has no override, so it resolves to the install default.
  const fromConfig = resolveModelConfig({}, { config, agentName: "personal" });
  expect(fromConfig.model?.id).toBe("gpt-4o");
  // ...and an env var still overrides that default for the un-pinned agent.
  const fromEnv = resolveModelConfig({ ASTERISM_MODEL_ID: "gpt-4o-mini" }, { config, agentName: "personal" });
  expect(fromEnv.model?.id).toBe("gpt-4o-mini");
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
