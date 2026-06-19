// The Embedder sub-seam — HOW the local recall provider turns text into vectors.
//
// The provider (`provider.ts`) is pure ranking: it embeds the query + the agent's
// candidate memories and orders them by cosine similarity. WHERE those vectors come
// from sits behind this one-method interface, so the same ranking code admits a
// local HTTP endpoint (the shipped backend) and, later, an in-process ONNX model —
// a drop-in, no change to the provider. It mirrors how `@qmilab/asterism-reflect`
// puts its model client behind `ChatModelClient`.
//
// NOTHING here touches the kernel. An Embedder sees only the text the provider hands
// it (one agent's own query + memory contents) and returns vectors. It never reads
// the store, credentials, or another agent's data — and the kernel re-enforces
// isolation/budget on the provider's OUTPUT regardless (`enforceRecall`), so even a
// hostile Embedder cannot widen what frames a run.

/** Turns text into fixed-length vectors — one per input, in input order. */
export interface Embedder {
  /**
   * Embed each input string into a numeric vector. Returns one vector per input, in
   * the SAME order as `texts` (the provider relies on positional correspondence).
   * All returned vectors must share a length (they are compared by cosine). May
   * reject — the provider treats a rejection as "embedder unavailable" and degrades
   * to the dependency-free lexical ranker rather than failing the run.
   */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

/** Configuration for {@link createHttpEmbedder}. */
export interface HttpEmbedderConfig {
  /**
   * The embeddings endpoint URL — an OpenAI-compatible `/embeddings` route. For a
   * local Ollama install this is `http://localhost:11434/v1/embeddings`; LM Studio
   * and other local OpenAI-compatible servers expose the same shape.
   */
  url: string;
  /** The embedding model to request (e.g. `nomic-embed-text`, `all-minilm`). */
  model: string;
  /**
   * Optional bearer token. A purely-local endpoint usually needs none; it is here
   * for OpenAI-compatible servers that require one. Sent as `Authorization: Bearer`.
   */
  apiKey?: string;
  /** Extra request headers, merged after the defaults (and any `Authorization`). */
  headers?: Readonly<Record<string, string>>;
  /** Abort the request after this many milliseconds. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * The `fetch` to use. Defaults to the global `fetch` (Bun/Node 20+). Injectable so
   * a test can drive the client without a real network.
   */
  fetchImpl?: typeof fetch;
}

/** Default request timeout — generous for a cold local model, bounded so a hung server degrades. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The OpenAI-compatible embeddings response shape this client parses. */
interface EmbeddingsResponse {
  data?: { embedding?: unknown; index?: unknown }[];
}

/**
 * A thin HTTP client for an OpenAI-compatible `/embeddings` endpoint — the shipped,
 * zero-ML-dependency backend. It POSTs `{ model, input: texts }` and reads back
 * `data[].embedding`, ordered by each item's `index` (the spec does not guarantee
 * response order), so vector i corresponds to `texts[i]`.
 *
 * It throws on any non-2xx status, a network/timeout failure, or a malformed body —
 * all of which the provider catches as "embedder unavailable" and degrades on. It
 * holds no kernel handle: it only turns text into numbers.
 */
export function createHttpEmbedder(config: HttpEmbedderConfig): Embedder {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      if (texts.length === 0) return [];

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(config.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey !== undefined ? { authorization: `Bearer ${config.apiKey}` } : {}),
            ...config.headers,
          },
          body: JSON.stringify({ model: config.model, input: texts }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error(`embeddings endpoint returned ${response.status} ${response.statusText}`);
      }

      const body = (await response.json()) as EmbeddingsResponse;
      const data = body.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(
          `embeddings response had ${Array.isArray(data) ? data.length : "no"} vectors for ${texts.length} inputs`,
        );
      }

      // The response may arrive out of order; place each vector at its declared index
      // so the result lines up positionally with `texts`. `filled` tracks which slots
      // are taken — a sparse array's holes are invisible to `.some`/`.forEach`, so a
      // duplicate or out-of-range index is caught here (and surfaces as "malformed",
      // which the provider treats as unavailable and degrades on) rather than silently
      // leaving a hole that mis-ranks a memory.
      const vectors: number[][] = new Array(texts.length);
      const filled = new Set<number>();
      data.forEach((item, i) => {
        // Honor a declared index — number OR numeric string (mirroring the `Number()`
        // coercion of the embedding values) — falling back to the response position
        // only when none is given.
        const declared = item.index;
        const at = declared === undefined || declared === null ? i : Number(declared);
        const embedding = item.embedding;
        if (
          !Array.isArray(embedding) ||
          !Number.isInteger(at) ||
          at < 0 ||
          at >= texts.length ||
          filled.has(at)
        ) {
          throw new Error("embeddings response was malformed");
        }
        filled.add(at);
        vectors[at] = embedding.map((n) => Number(n));
      });
      // Defensive postcondition: every slot must be filled exactly once.
      if (filled.size !== texts.length) {
        throw new Error("embeddings response was missing a vector");
      }
      return vectors;
    },
  };
}
