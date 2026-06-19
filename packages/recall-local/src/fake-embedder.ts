// A deterministic, network-free Embedder for tests — both this package's and a
// host's. It is NOT an ML model: it builds a hashed bag-of-words vector so that
// texts sharing words land near each other under cosine similarity. That is enough
// to exercise the provider's ranking deterministically (same input → same vectors →
// same order) without standing up a real embedding server.

import type { Embedder } from "./embedder.js";

/** Default dimensionality — small but wide enough that distinct words rarely collide. */
const DEFAULT_DIMS = 64;

/** Lower-cased alphanumeric word tokens of length ≥ 2. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** A small deterministic string hash (FNV-1a, 32-bit) — stable across runs and platforms. */
function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Build a deterministic {@link Embedder} that maps each text to a hashed bag-of-words
 * vector of `dims` dimensions. Texts with overlapping vocabulary score higher cosine
 * similarity; a text with no tokens maps to the zero vector (cosine 0 with anything).
 * Purely a test aid — deterministic, offline, dependency-free.
 */
export function createFakeEmbedder(dims: number = DEFAULT_DIMS): Embedder {
  return {
    embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      const vectors = texts.map((text) => {
        const vec = new Array<number>(dims).fill(0);
        for (const token of tokens(text)) {
          const dim = hash(token) % dims;
          vec[dim] = (vec[dim] ?? 0) + 1;
        }
        return vec;
      });
      return Promise.resolve(vectors);
    },
  };
}
