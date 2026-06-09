// Host wiring for `run`: build the concrete RuntimeAdapter (Pi, behind the
// adapter package) from environment configuration. This is the one place the CLI
// reaches the substrate, and it stays at the surface — the kernel never learns
// which adapter is in use. Imported lazily by the run command so the rest of the
// CLI (init, new, …) never loads the substrate.
//
// Adapter-boundary note: the CLI may wire concrete implementations — that is its
// job. It imports the adapter PACKAGE, never Pi directly; "nothing outside
// adapter-pi imports Pi" holds. The pure config resolution lives in
// `model-config.ts`; this module only adds the adapter construction.

import { PiAdapter } from "@qmilab/asterism-adapter-pi";
import type { RuntimeAdapter } from "@qmilab/asterism-core";

import { resolveApiKey, resolveModelConfig } from "./model-config.js";

export interface AdapterResult {
  adapter?: RuntimeAdapter;
  /** When `adapter` is absent, a user-facing explanation of what to configure. */
  reason?: string;
}

type Env = Record<string, string | undefined>;

/**
 * Build the run adapter from environment configuration, or return a `reason`
 * explaining what to set. Configuration (provider defaults included) is resolved
 * by {@link resolveModelConfig}; the API key is read per provider
 * (OPENAI_API_KEY / ANTHROPIC_API_KEY) or from ASTERISM_API_KEY.
 */
export function buildAdapterFromEnv(env: Env): AdapterResult {
  const { model, reason } = resolveModelConfig(env);
  if (!model) {
    return reason !== undefined ? { reason } : {};
  }
  const adapter = new PiAdapter({
    model,
    getApiKey: (p: string) => resolveApiKey(env, p),
  });
  return { adapter };
}
