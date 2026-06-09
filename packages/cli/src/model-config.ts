// Pure model-configuration resolution for `run`. Kept free of any runtime Pi
// import (the `PiModelConfig` import is type-only and erased), so it is unit
// testable without loading the substrate; `model.ts` adds the adapter on top.
//
// Each supported provider carries its own protocol (`api`) and default endpoint,
// so naming a provider is enough — a user does not have to also know the wire
// format. Explicit ASTERISM_MODEL_* overrides always win over these defaults.

import type { PiModelConfig } from "@qmilab/asterism-adapter-pi";

type Env = Record<string, string | undefined>;

interface ProviderDefaults {
  /** Default base URL for the provider's API. */
  baseUrl: string;
  /**
   * Default Pi API/protocol. Omitted for OpenAI, whose protocol is the adapter's
   * own default (`openai-completions`); set explicitly where it differs.
   */
  api?: string;
}

/**
 * Built-in defaults for the providers Asterism configures out of the box. The
 * Anthropic entry sets `api` so an Anthropic provider/key is never silently sent
 * over the OpenAI protocol. Other providers are reachable by supplying
 * ASTERISM_MODEL_BASE_URL (and ASTERISM_MODEL_API where it is not OpenAI-shaped).
 */
export const PROVIDER_DEFAULTS: Readonly<Record<string, ProviderDefaults>> = {
  openai: { baseUrl: "https://api.openai.com/v1" },
  anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
};

export interface ModelConfigResult {
  model?: PiModelConfig;
  /** When `model` is absent, a user-facing explanation of what to configure. */
  reason?: string;
}

/**
 * The environment variable that holds a given provider's API key: the well-known
 * name for the providers we configure out of the box, else a derived
 * `<PROVIDER>_API_KEY`. So an OpenAI-compatible provider like `openrouter` reads
 * `OPENROUTER_API_KEY`, and the "no key" message can name the variable that
 * actually works instead of always pointing at `OPENAI_API_KEY`.
 */
export function providerKeyEnvVar(provider: string): string {
  const known: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  };
  return known[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/**
 * Resolve the LLM provider API key from the environment — infrastructure, never an
 * agent-scoped credential. Read from the provider's own variable
 * ({@link providerKeyEnvVar}), falling back to `ASTERISM_API_KEY`. Shared by `run`
 * (the adapter) and `reflect` (the reflection model), so both resolve it the same way.
 */
export function resolveApiKey(env: Env, provider: string): string | undefined {
  return env[providerKeyEnvVar(provider)] ?? env.ASTERISM_API_KEY;
}

/**
 * Resolve the model config from the environment, applying provider defaults.
 * Required: `ASTERISM_MODEL_ID`. Optional: `ASTERISM_MODEL_PROVIDER`
 * (default "openai"), `ASTERISM_MODEL_BASE_URL`, `ASTERISM_MODEL_API` — each
 * overrides the provider default when set.
 */
export function resolveModelConfig(env: Env): ModelConfigResult {
  const id = env.ASTERISM_MODEL_ID;
  if (!id) {
    return {
      reason:
        "No model configured. Set ASTERISM_MODEL_ID (and an API key, e.g. " +
        "OPENAI_API_KEY) before running an agent.",
    };
  }
  const provider = env.ASTERISM_MODEL_PROVIDER ?? "openai";
  const defaults = PROVIDER_DEFAULTS[provider];
  const baseUrl = env.ASTERISM_MODEL_BASE_URL ?? defaults?.baseUrl;
  if (!baseUrl) {
    return {
      reason:
        `No endpoint for provider "${provider}". Set ASTERISM_MODEL_BASE_URL to ` +
        "the provider's base URL.",
    };
  }
  const api = env.ASTERISM_MODEL_API ?? defaults?.api;
  const model: PiModelConfig = {
    provider,
    id,
    baseUrl,
    ...(api !== undefined ? { api } : {}),
  };
  return { model };
}
