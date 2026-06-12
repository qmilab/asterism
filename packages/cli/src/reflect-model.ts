// Host wiring for `reflect`: build the concrete ReflectionProvider (a hosted model
// behind the reflect package) from environment configuration. The mirror image of
// `model.ts` for `run` — the CLI is where concrete implementations are wired into
// the kernel's interfaces. Imported lazily by the reflect command so the rest of
// the CLI never loads the reflection model client.
//
// It reuses the SAME model config + API-key resolution as `run` (`model-config.ts`),
// so `reflect` and `run` answer to the one ASTERISM_MODEL_ID / API-key setup. The
// reflect package is Pi-free, so this never touches the adapter.

import {
  createHttpChatClient,
  DefaultReflectionProvider,
} from "@qmilab/asterism-reflect";
import type { ReflectionProvider } from "@qmilab/asterism-core";

import type { ModelResolutionContext } from "./model-config.js";
import {
  providerKeyEnvVar,
  resolveApiKey,
  resolveModelConfig,
} from "./model-config.js";

export interface ReflectionProviderResult {
  provider?: ReflectionProvider;
  /** When `provider` is absent, a user-facing explanation of what to configure. */
  reason?: string;
}

type Env = Record<string, string | undefined>;

/**
 * Build the reflection provider from the resolved model configuration, or return
 * a `reason` explaining what to set. Resolves the model the same way `run` does
 * (config file, env, the agent's own override), so reflecting on an agent uses
 * that agent's model; the provider API key is read from the environment.
 */
export function buildReflectionProvider(
  env: Env,
  context: ModelResolutionContext = {},
): ReflectionProviderResult {
  const { model, reason } = resolveModelConfig(env, context);
  if (!model) {
    return reason !== undefined ? { reason } : {};
  }
  const apiKey = resolveApiKey(env, model.provider);
  if (!apiKey) {
    return {
      reason:
        `No API key for reflection. Set ${providerKeyEnvVar(model.provider)} ` +
        "(or ASTERISM_API_KEY) before reflecting.",
    };
  }
  const client = createHttpChatClient({
    provider: model.provider,
    id: model.id,
    baseUrl: model.baseUrl,
    ...(model.api !== undefined ? { api: model.api } : {}),
    apiKey,
  });
  return { provider: new DefaultReflectionProvider(client) };
}
