// @qmilab/asterism-recall-local — the OPT-IN, local-embeddings RecallProvider.
//
// An alternative `RecallProvider` (core's seam) that ranks an agent's own candidate
// memories by MEANING — embedding cosine similarity — against a LOCAL embedding
// endpoint, instead of the default keyword overlap. It is strictly opt-in and lives
// OUTSIDE the default install path: nothing in core/cli/server imports it statically;
// the CLI loads it lazily only when an agent is configured to use it. It carries no
// ML dependency of its own — the embeddings come from a local HTTP endpoint (Ollama /
// any OpenAI-compatible `/embeddings`) behind the `Embedder` seam, so an in-process
// model can drop in later without touching the provider.
//
// It never reaches the kernel: it ranks a handed-in list and returns a subset, and
// the kernel re-enforces isolation/budget on that output (`enforceRecall`). The
// agent stays the isolation boundary; this only changes WHICH of one agent's
// memories frame its run.

export { EmbeddingRecallProvider } from "./provider.js";
export type { EmbeddingRecallProviderOptions } from "./provider.js";

export { createHttpEmbedder, DEFAULT_TIMEOUT_MS } from "./embedder.js";
export type { Embedder, HttpEmbedderConfig } from "./embedder.js";

export { createFakeEmbedder } from "./fake-embedder.js";
