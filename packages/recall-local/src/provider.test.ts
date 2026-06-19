import { describe, expect, test } from "bun:test";
import { selectRecall } from "@qmilab/asterism-core";
import type { Memory, RecallInput } from "@qmilab/asterism-core";

import { EmbeddingRecallProvider } from "./provider.js";
import { createFakeEmbedder } from "./fake-embedder.js";
import type { Embedder } from "./embedder.js";

let seq = 0;
function mem(content: string, over: Partial<Memory> = {}): Memory {
  seq += 1;
  return {
    id: `m${seq}`,
    agentId: "agent-a",
    memoryType: "semantic",
    content,
    confidence: 0.5,
    status: "active",
    reviewState: "accepted",
    // Increasing timestamps so list order = store order (oldest first).
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    ...over,
  };
}

/** An embedder that fails the test if it is ever called. */
const throwingEmbedder: Embedder = {
  embed() {
    throw new Error("embedder should not have been called");
  },
};

/** An embedder that rejects — simulates a local server being down. */
const unavailableEmbedder: Embedder = {
  embed() {
    return Promise.reject(new Error("ECONNREFUSED"));
  },
};

describe("EmbeddingRecallProvider", () => {
  test("ranks the most semantically-similar candidates and presents them in store order", async () => {
    const candidates = [
      mem("kubernetes cluster scaling"), // shares: kubernetes, cluster
      mem("deploy the release"), // shares: deploy
      mem("favorite coffee blends"), // shares: nothing
      mem("kubernetes deploy cluster checklist"), // shares: kubernetes, deploy, cluster
    ];
    const provider = new EmbeddingRecallProvider({ embedder: createFakeEmbedder() });
    const input: RecallInput = {
      agentId: "agent-a",
      query: "deploy kubernetes cluster",
      candidates,
      budget: { maxMemories: 2 },
    };

    const out = await provider.recall(input);
    // The two highest-overlap memories are the 4th (3 shared) and the 1st (2 shared),
    // returned chronologically (store order): m1 before m4.
    expect(out.map((m) => m.content)).toEqual([
      "kubernetes cluster scaling",
      "kubernetes deploy cluster checklist",
    ]);
  });

  test("is deterministic — same inputs yield the same selection and order", async () => {
    const candidates = [
      mem("alpha beta gamma"),
      mem("beta gamma delta"),
      mem("gamma delta epsilon"),
      mem("nothing relevant here"),
    ];
    const provider = new EmbeddingRecallProvider({ embedder: createFakeEmbedder() });
    const input: RecallInput = {
      agentId: "agent-a",
      query: "beta gamma",
      candidates,
      budget: { maxMemories: 2 },
    };
    const first = await provider.recall(input);
    const second = await provider.recall(input);
    expect(second.map((m) => m.id)).toEqual(first.map((m) => m.id));
  });

  test("under budget is a no-op — returns candidates unchanged and never calls the embedder", async () => {
    const candidates = [mem("one"), mem("two"), mem("three")];
    const provider = new EmbeddingRecallProvider({ embedder: throwingEmbedder });
    const out = await provider.recall({
      agentId: "agent-a",
      query: "anything",
      candidates,
      budget: { maxMemories: 10 },
    });
    expect(out).toEqual(candidates);
  });

  test("max <= 0 frames nothing", async () => {
    const provider = new EmbeddingRecallProvider({ embedder: throwingEmbedder });
    const out = await provider.recall({
      agentId: "agent-a",
      query: "q",
      candidates: [mem("one")],
      budget: { maxMemories: 0 },
    });
    expect(out).toEqual([]);
  });

  test("degrades to the lexical ranker (and reports it) when the embedder is unavailable", async () => {
    const candidates = [
      mem("kubernetes cluster scaling"),
      mem("deploy the release"),
      mem("favorite coffee blends"),
      mem("kubernetes deploy cluster checklist"),
    ];
    const degrades: unknown[] = [];
    const provider = new EmbeddingRecallProvider({
      embedder: unavailableEmbedder,
      onDegrade: (e) => degrades.push(e),
    });
    const input: RecallInput = {
      agentId: "agent-a",
      query: "deploy kubernetes cluster",
      candidates,
      budget: { maxMemories: 2 },
    };

    const out = await provider.recall(input);
    // It did not throw, it reported the degrade, and it returned exactly what the
    // dependency-free lexical ranker would — correct memories, no crashed run.
    expect(degrades.length).toBe(1);
    expect(out).toEqual(selectRecall(input));
    expect(out.length).toBe(2);
  });

  test("a throwing onDegrade still degrades to the lexical ranker (never aborts the run)", async () => {
    const candidates = [mem("alpha one"), mem("beta two"), mem("gamma three"), mem("delta four")];
    const provider = new EmbeddingRecallProvider({
      embedder: unavailableEmbedder,
      onDegrade: () => {
        throw new Error("the sink itself blew up");
      },
    });
    const input: RecallInput = {
      agentId: "agent-a",
      query: "alpha",
      candidates,
      budget: { maxMemories: 2 },
    };
    // The misbehaving sink must not turn a recoverable outage into a failed run.
    const out = await provider.recall(input);
    expect(out).toEqual(selectRecall(input));
  });

  test("degrades when the embedder returns the wrong number of vectors", async () => {
    const shortEmbedder: Embedder = {
      embed: (texts) => Promise.resolve(texts.slice(0, 1).map(() => [1, 0])),
    };
    const candidates = [mem("aa"), mem("bb"), mem("cc")];
    let degraded = false;
    const provider = new EmbeddingRecallProvider({
      embedder: shortEmbedder,
      onDegrade: () => {
        degraded = true;
      },
    });
    const input: RecallInput = {
      agentId: "agent-a",
      query: "aa",
      candidates,
      budget: { maxMemories: 2 },
    };
    const out = await provider.recall(input);
    expect(degraded).toBe(true);
    expect(out).toEqual(selectRecall(input));
  });
});
