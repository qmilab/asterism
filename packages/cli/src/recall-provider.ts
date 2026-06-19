// Host wiring for opt-in local recall: build the embeddings `RecallProvider` from
// environment configuration. The mirror image of `reflect-model.ts` for reflection —
// the CLI is where a concrete implementation is wired into the kernel's interface.
// Imported LAZILY (a dynamic import in `cli.ts`), and only for an agent that has
// opted in, so the default CLI path never loads the recall-local package and an
// install that never opts in carries none of it.
//
// The embeddings come from a LOCAL HTTP endpoint (Ollama / any OpenAI-compatible
// `/embeddings`), configured by environment:
//   ASTERISM_RECALL_EMBED_URL    the endpoint, e.g. http://localhost:11434/v1/embeddings
//   ASTERISM_RECALL_EMBED_MODEL  the embedding model, e.g. nomic-embed-text
//   ASTERISM_RECALL_EMBED_KEY    optional bearer token (local endpoints usually need none)
//
// An agent opted in WITHOUT a configured endpoint is a misconfiguration: this returns
// a `reason` and the caller refuses to run (hard-fail), so the mistake is visible
// rather than silently ignored. A configured endpoint that is merely unreachable at
// run time is a different case — the provider degrades to the lexical ranker and
// reports it through `onDegrade`; this builder is only about whether one is configured.

import { EmbeddingRecallProvider, createHttpEmbedder } from "@qmilab/asterism-recall-local";
import type { RecallProvider } from "@qmilab/asterism-core";

export interface RecallProviderResult {
  provider?: RecallProvider;
  /** When `provider` is absent, a user-facing explanation of what to configure. */
  reason?: string;
}

type Env = Record<string, string | undefined>;

/** Options for {@link buildEmbeddingRecallProvider}. */
export interface BuildRecallOptions {
  /**
   * Called when recall falls back to the lexical ranker because the endpoint was
   * unreachable at run time. The CLI wires this to a loud stderr line.
   */
  onDegrade?: (error: unknown) => void;
}

/**
 * Build the local embeddings recall provider from the environment, or return a
 * `reason` naming what to set. Requires both an endpoint URL and a model; either
 * missing is a misconfiguration (an agent opted in with nowhere to embed), so the
 * caller hard-fails rather than silently using keyword ranking.
 */
export function buildEmbeddingRecallProvider(
  env: Env,
  options: BuildRecallOptions = {},
): RecallProviderResult {
  const url = env.ASTERISM_RECALL_EMBED_URL?.trim();
  const model = env.ASTERISM_RECALL_EMBED_MODEL?.trim();
  if (!url || !model) {
    return {
      reason:
        "This agent is set to use local-embeddings recall, but the endpoint is not configured. " +
        "Set ASTERISM_RECALL_EMBED_URL (e.g. http://localhost:11434/v1/embeddings) and " +
        "ASTERISM_RECALL_EMBED_MODEL (e.g. nomic-embed-text), or switch it back with " +
        "`asterism config recall-provider <agent> --unset`.",
    };
  }
  const apiKey = env.ASTERISM_RECALL_EMBED_KEY?.trim();
  const embedder = createHttpEmbedder({
    url,
    model,
    ...(apiKey ? { apiKey } : {}),
  });
  return {
    provider: new EmbeddingRecallProvider({
      embedder,
      ...(options.onDegrade ? { onDegrade: options.onDegrade } : {}),
    }),
  };
}
