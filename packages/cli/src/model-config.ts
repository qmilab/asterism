// Pure model-configuration resolution for `run` and `reflect`. Kept free of any
// runtime Pi import (the `PiModelConfig` import is type-only and erased), so it is
// unit testable without loading the substrate; `model.ts` adds the adapter on top.
//
// Resolution layers a config file, the environment, and a per-agent override.
// Precedence, most specific first:
//   1. the agent's own model override (config file `agents.<name>.model`)
//   2. ASTERISM_MODEL_* environment variables
//   3. the install-wide default (config file `model`)
//   4. built-in provider defaults (endpoint + wire protocol)
// Each field resolves independently, so an override may set just `id` and inherit
// the endpoint/protocol from a lower layer. Each supported provider carries its
// own protocol (`api`) and default endpoint, so naming a provider is enough — a
// user does not have to also know the wire format.

import type { PiModelConfig } from "@qmilab/asterism-adapter-pi";

import type { AsterismConfig, ModelSettings } from "./config.js";

type Env = Record<string, string | undefined>;

/**
 * The sources resolution draws on beyond the environment: the loaded config file
 * and which agent (by name) the model is being resolved for. Both optional — with
 * neither, resolution is environment-only, exactly as it was before the config
 * file existed. Shared as the wiring context passed to `buildAdapter` /
 * `buildReflectionProvider`.
 */
export interface ModelResolutionContext {
  config?: AsterismConfig;
  agentName?: string;
}

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

/** The model coordinates carried by the ASTERISM_MODEL_* environment variables. */
function settingsFromEnv(env: Env): ModelSettings {
  const s: ModelSettings = {};
  if (env.ASTERISM_MODEL_ID !== undefined) s.id = env.ASTERISM_MODEL_ID;
  if (env.ASTERISM_MODEL_PROVIDER !== undefined) s.provider = env.ASTERISM_MODEL_PROVIDER;
  if (env.ASTERISM_MODEL_BASE_URL !== undefined) s.baseUrl = env.ASTERISM_MODEL_BASE_URL;
  if (env.ASTERISM_MODEL_API !== undefined) s.api = env.ASTERISM_MODEL_API;
  return s;
}

/** Merge layers low → high precedence: each set field overrides the ones before it. */
function mergeSettings(layers: readonly ModelSettings[]): ModelSettings {
  const out: ModelSettings = {};
  for (const layer of layers) {
    if (layer.id !== undefined) out.id = layer.id;
    if (layer.provider !== undefined) out.provider = layer.provider;
    if (layer.baseUrl !== undefined) out.baseUrl = layer.baseUrl;
    if (layer.api !== undefined) out.api = layer.api;
  }
  return out;
}

/**
 * Resolve the model config from the config file, environment, and a per-agent
 * override, then apply provider defaults. See the module header for the
 * precedence order. A resolved model needs at minimum an `id`; an endpoint comes
 * from a built-in provider default or must be supplied. Pass only `env` for
 * environment-only resolution.
 */
export function resolveModelConfig(env: Env, context: ModelResolutionContext = {}): ModelConfigResult {
  const { config, agentName } = context;
  const agentSettings = agentName ? config?.agents?.[agentName]?.model : undefined;
  // Low → high precedence: install default, environment, per-agent override.
  const merged = mergeSettings([
    config?.model ?? {},
    settingsFromEnv(env),
    agentSettings ?? {},
  ]);

  const id = merged.id;
  if (!id) {
    return {
      reason:
        "No model configured. Set one with `asterism config set <model-id>` or the " +
        "ASTERISM_MODEL_ID environment variable, plus an API key (e.g. OPENAI_API_KEY), " +
        "before running an agent.",
    };
  }
  const provider = merged.provider ?? "openai";
  const defaults = PROVIDER_DEFAULTS[provider];
  const baseUrl = merged.baseUrl ?? defaults?.baseUrl;
  if (!baseUrl) {
    return {
      reason:
        `No endpoint for provider "${provider}". Set a base URL ` +
        `(asterism config set ${id} --provider ${provider} --base-url <url>, or ` +
        "ASTERISM_MODEL_BASE_URL).",
    };
  }
  const api = merged.api ?? defaults?.api;
  const model: PiModelConfig = {
    provider,
    id,
    baseUrl,
    ...(api !== undefined ? { api } : {}),
  };
  return { model };
}
