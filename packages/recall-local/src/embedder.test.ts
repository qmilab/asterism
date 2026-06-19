import { describe, expect, test } from "bun:test";

import { createHttpEmbedder } from "./embedder.js";

/** A fake `fetch` returning a JSON body with a chosen status. Records the last request. */
function fakeFetch(
  status: number,
  body: unknown,
): { fetch: typeof fetch; lastInit: () => RequestInit | undefined; lastUrl: () => string | undefined } {
  let lastInit: RequestInit | undefined;
  let lastUrl: string | undefined;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    lastUrl = String(url);
    lastInit = init;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, lastInit: () => lastInit, lastUrl: () => lastUrl };
}

describe("createHttpEmbedder", () => {
  test("posts {model, input} to the endpoint and parses data[].embedding", async () => {
    const f = fakeFetch(200, {
      data: [
        { index: 0, embedding: [1, 0, 0] },
        { index: 1, embedding: [0, 1, 0] },
      ],
    });
    const embedder = createHttpEmbedder({
      url: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
      fetchImpl: f.fetch,
    });

    const vectors = await embedder.embed(["alpha", "beta"]);
    expect(vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);

    expect(f.lastUrl()).toBe("http://localhost:11434/v1/embeddings");
    const init = f.lastInit()!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ model: "nomic-embed-text", input: ["alpha", "beta"] });
  });

  test("reorders vectors by their declared index so they line up with the inputs", async () => {
    const f = fakeFetch(200, {
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    });
    const embedder = createHttpEmbedder({ url: "x", model: "m", fetchImpl: f.fetch });
    const vectors = await embedder.embed(["first", "second"]);
    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  test("sends a bearer token when an apiKey is configured", async () => {
    const f = fakeFetch(200, { data: [{ index: 0, embedding: [1] }] });
    const embedder = createHttpEmbedder({ url: "x", model: "m", apiKey: "secret", fetchImpl: f.fetch });
    await embedder.embed(["one"]);
    const headers = f.lastInit()!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
  });

  test("throws on a non-2xx status (the provider degrades on this)", async () => {
    const f = fakeFetch(503, { error: "model loading" });
    const embedder = createHttpEmbedder({ url: "x", model: "m", fetchImpl: f.fetch });
    await expect(embedder.embed(["q"])).rejects.toThrow(/503/);
  });

  test("throws on a duplicate index rather than returning a vector with a hole", async () => {
    // Two items claim index 0 → slot 1 would be a sparse hole. The guard must catch it,
    // not silently return a malformed array (a hole mis-ranks a memory downstream).
    const f = fakeFetch(200, {
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 0, embedding: [0, 1] },
      ],
    });
    const embedder = createHttpEmbedder({ url: "x", model: "m", fetchImpl: f.fetch });
    await expect(embedder.embed(["a", "b"])).rejects.toThrow(/malformed/);
  });

  test("throws on an out-of-range index", async () => {
    const f = fakeFetch(200, { data: [{ index: 5, embedding: [1] }] });
    const embedder = createHttpEmbedder({ url: "x", model: "m", fetchImpl: f.fetch });
    await expect(embedder.embed(["only"])).rejects.toThrow(/malformed/);
  });

  test("honors a numeric-string index (coerced, like the embedding values)", async () => {
    const f = fakeFetch(200, {
      data: [
        { index: "1", embedding: [0, 1] },
        { index: "0", embedding: [1, 0] },
      ],
    });
    const embedder = createHttpEmbedder({ url: "x", model: "m", fetchImpl: f.fetch });
    expect(await embedder.embed(["first", "second"])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  test("throws when the response has the wrong number of vectors", async () => {
    const f = fakeFetch(200, { data: [{ index: 0, embedding: [1] }] });
    const embedder = createHttpEmbedder({ url: "x", model: "m", fetchImpl: f.fetch });
    await expect(embedder.embed(["a", "b"])).rejects.toThrow(/vectors/);
  });

  test("the timeout covers the response body, not just the headers", async () => {
    // A server that returns headers immediately but stalls forever on the body. The
    // body read only settles if the request is aborted — so this hangs (and the test
    // times out) unless the abort timer stays armed THROUGH `response.json()`.
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const embedder = createHttpEmbedder({ url: "x", model: "m", fetchImpl: impl, timeoutMs: 20 });
    await expect(embedder.embed(["q"])).rejects.toThrow();
  });

  test("makes no request for an empty input list", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const embedder = createHttpEmbedder({ url: "x", model: "m", fetchImpl: impl });
    expect(await embedder.embed([])).toEqual([]);
    expect(called).toBe(false);
  });
});
