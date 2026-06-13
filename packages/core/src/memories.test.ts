// Phase 1 (#19) — the scoped, filterable read API for `memory inspect`.
//
// Two properties under test: (1) `list` narrows by type / review state / source
// run, AND-combining the filters and validating the closed-enum ones on the read
// path; (2) every filtered shape stays strictly agent-scoped — a filter only ever
// narrows within one agent's own memory, it can never reach across agents.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsterismStore } from "./store";
import type { Agent, MemoryType, ReviewState } from "./types";

let store: AsterismStore;
let alice: Agent;
let bob: Agent;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  alice = store.createAgent({
    name: "alice",
    role: "personal helper",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/alice",
    trustLevel: "autonomous",
  });
  bob = store.createAgent({
    name: "bob",
    role: "careful consultant",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/bob",
    trustLevel: "propose",
  });
});

afterEach(() => {
  store.close();
});

describe("memory list — filters", () => {
  test("filters by exact memory type", () => {
    store.memories.create(alice.id, { memoryType: "semantic", content: "a fact" });
    store.memories.create(alice.id, { memoryType: "procedural", content: "a how-to" });
    expect(
      store.memories.list(alice.id, { memoryType: "semantic" }).map((m) => m.content),
    ).toEqual(["a fact"]);
  });

  test("filters by review state", () => {
    store.memories.create(alice.id, {
      memoryType: "semantic",
      content: "accepted one",
      reviewState: "accepted",
    });
    store.memories.create(alice.id, {
      memoryType: "semantic",
      content: "proposed one",
      reviewState: "proposed",
    });
    expect(
      store.memories.list(alice.id, { reviewState: "proposed" }).map((m) => m.content),
    ).toEqual(["proposed one"]);
  });

  test("filters by source run", () => {
    const run = store.startRun(alice.id, { input: "t" });
    store.memories.create(alice.id, {
      memoryType: "semantic",
      content: "from the run",
      sourceRunId: run.id,
    });
    store.memories.create(alice.id, { memoryType: "semantic", content: "unattached" });
    expect(
      store.memories.list(alice.id, { sourceRunId: run.id }).map((m) => m.content),
    ).toEqual(["from the run"]);
  });

  test("AND-combines filters", () => {
    const run = store.startRun(alice.id, { input: "t" });
    store.memories.create(alice.id, {
      memoryType: "semantic",
      content: "match",
      reviewState: "proposed",
      sourceRunId: run.id,
    });
    store.memories.create(alice.id, {
      memoryType: "procedural",
      content: "wrong type",
      reviewState: "proposed",
      sourceRunId: run.id,
    });
    store.memories.create(alice.id, {
      memoryType: "semantic",
      content: "wrong state",
      reviewState: "accepted",
      sourceRunId: run.id,
    });
    expect(
      store.memories
        .list(alice.id, { memoryType: "semantic", reviewState: "proposed", sourceRunId: run.id })
        .map((m) => m.content),
    ).toEqual(["match"]);
  });

  test("no filter returns the whole memory, oldest-first", () => {
    store.memories.create(alice.id, { memoryType: "semantic", content: "first" });
    store.memories.create(alice.id, { memoryType: "negative", content: "second" });
    expect(store.memories.list(alice.id).map((m) => m.content)).toEqual([
      "first",
      "second",
    ]);
  });

  test("an invalid enum filter is a clear error, not a silent empty result", () => {
    expect(() =>
      store.memories.list(alice.id, { memoryType: "nope" as unknown as MemoryType }),
    ).toThrow(/invalid memoryType/);
    expect(() =>
      store.memories.list(alice.id, { reviewState: "nope" as unknown as ReviewState }),
    ).toThrow(/invalid memory reviewState/);
  });
});

describe("memory list — filters stay agent-scoped", () => {
  test("a source-run filter never reaches another agent's memory", () => {
    const aliceRun = store.startRun(alice.id, { input: "alice work" });
    store.memories.create(alice.id, {
      memoryType: "semantic",
      content: "alice's private note",
      sourceRunId: aliceRun.id,
    });
    // Bob filtering by alice's run id sees nothing — the run is not in his scope.
    expect(store.memories.list(bob.id, { sourceRunId: aliceRun.id })).toEqual([]);
    expect(
      store.memories.list(bob.id, { memoryType: "semantic" }).map((m) => m.content),
    ).not.toContain("alice's private note");
  });

  test("a filtered list still requires an agentId", () => {
    expect(() => store.memories.list("", { memoryType: "semantic" })).toThrow();
  });
});
