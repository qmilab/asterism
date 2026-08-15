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

import type { ModelResolutionContext } from "./model-config.js";
import { resolveModelConfig, resolveProviderAuth } from "./model-config.js";

export interface AdapterResult {
  adapter?: RuntimeAdapter;
  /** When `adapter` is absent, a user-facing explanation of what to configure. */
  reason?: string;
}

type Env = Record<string, string | undefined>;

/**
 * Build the run adapter from the resolved model configuration, or return a
 * `reason` explaining what to set. Configuration (config file, env, per-agent
 * override, provider defaults) is resolved by {@link resolveModelConfig}; what to
 * authenticate with by {@link resolveProviderAuth} — the provider's own variable,
 * the shared fallback, or nothing at all for a model served from this machine.
 * Keys stay in the environment, never the config file.
 *
 * The key is checked HERE, before the adapter exists, for the same reason
 * `reflect` checks it before building its client: without this, a missing key
 * surfaced at the first token as the substrate's own "No API key for provider: x"
 * arriving down the adapter's unexpected-fault path — a failed run, in the
 * substrate's vocabulary, for a setup problem the CLI could see up front.
 */
export function buildAdapter(env: Env, context: ModelResolutionContext = {}): AdapterResult {
  const { model, reason } = resolveModelConfig(env, context);
  if (!model) {
    return reason !== undefined ? { reason } : {};
  }
  const auth = resolveProviderAuth(env, model);
  if (auth.apiKey === undefined) {
    return auth.reason !== undefined ? { reason: auth.reason } : {};
  }
  const adapter = new PiAdapter({
    model,
    // Kept a callback rather than a captured value: the substrate re-resolves it
    // per request, which is what lets an expiring token be replaced in place.
    getApiKey: () => resolveProviderAuth(env, model).apiKey,
  });
  return { adapter };
}
