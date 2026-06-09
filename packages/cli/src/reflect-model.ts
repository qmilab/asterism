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

import { resolveApiKey, resolveModelConfig } from "./model-config.js";

export interface ReflectionProviderResult {
  provider?: ReflectionProvider;
  /** When `provider` is absent, a user-facing explanation of what to configure. */
  reason?: string;
}

type Env = Record<string, string | undefined>;

/**
 * Build the reflection provider from environment configuration, or return a
 * `reason` explaining what to set. Needs the same ASTERISM_MODEL_ID as `run`, plus
 * a provider API key — reflection calls a hosted model directly over HTTP.
 */
export function buildReflectionProviderFromEnv(env: Env): ReflectionProviderResult {
  const { model, reason } = resolveModelConfig(env);
  if (!model) {
    return reason !== undefined ? { reason } : {};
  }
  const apiKey = resolveApiKey(env, model.provider);
  if (!apiKey) {
    return {
      reason:
        `No API key for reflection. Set ${model.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}` +
        " (or ASTERISM_API_KEY) before reflecting.",
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
