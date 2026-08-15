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
import { resolveModelConfig, resolveProviderAuth } from "./model-config.js";

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
 * that agent's model — and resolves what to authenticate with the same way too
 * ({@link resolveProviderAuth}), including deciding that a model served from this
 * machine needs no key. Reflecting must not be the one command that still demands
 * a key for a local model the agent already ran on.
 */
export function buildReflectionProvider(
  env: Env,
  context: ModelResolutionContext = {},
): ReflectionProviderResult {
  const { model, reason } = resolveModelConfig(env, context);
  if (!model) {
    return reason !== undefined ? { reason } : {};
  }
  const auth = resolveProviderAuth(env, model);
  const apiKey = auth.apiKey;
  if (apiKey === undefined) {
    return auth.reason !== undefined ? { reason: auth.reason } : {};
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
