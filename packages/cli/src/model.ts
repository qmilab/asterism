// Host wiring for `run`: build the concrete RuntimeAdapter (Pi, behind the
// adapter package) from environment configuration. This is the one place the CLI
// reaches the substrate, and it stays at the surface — the kernel never learns
// which adapter is in use. Imported lazily by the run command so the rest of the
// CLI (init, new, …) never loads the substrate.
//
// Adapter-boundary note: the CLI may wire concrete implementations — that is its
// job. It imports the adapter PACKAGE, never Pi directly; "nothing outside
// adapter-pi imports Pi" holds.

import { PiAdapter } from "@qmilab/asterism-adapter-pi";
import type { PiModelConfig } from "@qmilab/asterism-adapter-pi";
import type { RuntimeAdapter } from "@qmilab/asterism-core";

export interface AdapterResult {
  adapter?: RuntimeAdapter;
  /** When `adapter` is absent, a user-facing explanation of what to configure. */
  reason?: string;
}

type Env = Record<string, string | undefined>;

/** Sensible default endpoints for the providers people are most likely to use. */
const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

/** Resolve the LLM provider API key from the environment (infra, not an agent secret). */
function resolveApiKey(env: Env, provider: string): string | undefined {
  const perProvider: Record<string, string | undefined> = {
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
  };
  return perProvider[provider] ?? env.ASTERISM_API_KEY;
}

/**
 * Build the run adapter from environment configuration, or return a `reason`
 * explaining what to set. Required: `ASTERISM_MODEL_ID`. Optional:
 * `ASTERISM_MODEL_PROVIDER` (default "openai"), `ASTERISM_MODEL_BASE_URL`
 * (defaulted for known providers), `ASTERISM_MODEL_API`. The API key is read per
 * provider (OPENAI_API_KEY / ANTHROPIC_API_KEY) or from ASTERISM_API_KEY.
 */
export function buildAdapterFromEnv(env: Env): AdapterResult {
  const id = env.ASTERISM_MODEL_ID;
  if (!id) {
    return {
      reason:
        "No model configured. Set ASTERISM_MODEL_ID (and an API key, e.g. " +
        "OPENAI_API_KEY) before running an agent.",
    };
  }
  const provider = env.ASTERISM_MODEL_PROVIDER ?? "openai";
  const baseUrl = env.ASTERISM_MODEL_BASE_URL ?? DEFAULT_BASE_URLS[provider];
  if (!baseUrl) {
    return {
      reason:
        `No endpoint for provider "${provider}". Set ASTERISM_MODEL_BASE_URL to ` +
        "the provider's base URL.",
    };
  }

  const model: PiModelConfig = {
    provider,
    id,
    baseUrl,
    ...(env.ASTERISM_MODEL_API ? { api: env.ASTERISM_MODEL_API } : {}),
  };
  const adapter = new PiAdapter({
    model,
    getApiKey: (p: string) => resolveApiKey(env, p),
  });
  return { adapter };
}
