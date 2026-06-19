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

  test("throws when the response has the wrong number of vectors", async () => {
    const f = fakeFetch(200, { data: [{ index: 0, embedding: [1] }] });
    const embedder = createHttpEmbedder({ url: "x", model: "m", fetchImpl: f.fetch });
    await expect(embedder.embed(["a", "b"])).rejects.toThrow(/vectors/);
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
