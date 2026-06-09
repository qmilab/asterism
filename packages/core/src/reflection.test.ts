import { expect, test } from "bun:test";

import { AsterismStore } from "./store.js";
import {
  isReflectionMemoryType,
  REFLECTION_MEMORY_TYPES,
} from "./reflection.js";
import { MEMORY_TYPES } from "./types.js";

function freshStore(): AsterismStore {
  return AsterismStore.open(":memory:");
}

function makeAgent(store: AsterismStore, name: string) {
  return store.createAgent({
    name,
    role: "",
    soulRef: "casual-helper",
    workspaceDir: `/tmp/${name}`,
    trustLevel: "autonomous",
  });
}

test("reflection may only propose the four durable memory types — never episodic", () => {
  expect([...REFLECTION_MEMORY_TYPES]).toEqual([
    "semantic",
    "procedural",
    "convention",
    "negative",
  ]);
  // The reflectable set is a strict subset of the canonical memory types, and
  // `episodic` (a record of what happened, not a learned lesson) is excluded.
  for (const t of REFLECTION_MEMORY_TYPES) {
    expect(MEMORY_TYPES).toContain(t);
  }
  expect(REFLECTION_MEMORY_TYPES).not.toContain("episodic" as never);
});

test("isReflectionMemoryType accepts the four and rejects episodic / junk", () => {
  expect(isReflectionMemoryType("semantic")).toBe(true);
  expect(isReflectionMemoryType("negative")).toBe(true);
  expect(isReflectionMemoryType("episodic")).toBe(false);
  expect(isReflectionMemoryType("nonsense")).toBe(false);
});

test("a run's output transcript persists and round-trips for later reflection", () => {
  const store = freshStore();
  try {
    const agent = makeAgent(store, "personal");
    const run = store.startRun(agent.id, { input: "write the blog draft" });
    expect(store.runs.get(agent.id, run.id)?.output).toBeUndefined();

    const updated = store.runs.setOutput(agent.id, run.id, "drafted three paragraphs");
    expect(updated?.output).toBe("drafted three paragraphs");
    // Reads it back on a fresh fetch — it is durable, not just on the returned row.
    expect(store.runs.get(agent.id, run.id)?.output).toBe("drafted three paragraphs");
  } finally {
    store.close();
  }
});

test("run output is agent-scoped — one agent cannot stamp output onto another's run", () => {
  const store = freshStore();
  try {
    const alice = makeAgent(store, "alice");
    const bob = makeAgent(store, "bob");
    const aliceRun = store.startRun(alice.id, { input: "alice work" });

    // Bob naming Alice's run id touches nothing and learns nothing.
    expect(store.runs.setOutput(bob.id, aliceRun.id, "leaked")).toBeUndefined();
    expect(store.runs.get(alice.id, aliceRun.id)?.output).toBeUndefined();

    // An empty agentId is rejected outright, like every scoped write.
    expect(() => store.runs.setOutput("", aliceRun.id, "x")).toThrow();
  } finally {
    store.close();
  }
});
