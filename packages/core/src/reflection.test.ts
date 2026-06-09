import { expect, test } from "bun:test";

import { AsterismStore } from "./store.js";
import { openDatabase } from "./db/index.js";
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

test("finishRun persists output and terminal status together and logs the transition", () => {
  const store = freshStore();
  try {
    const agent = makeAgent(store, "personal");
    const run = store.startRun(agent.id, { input: "do it" });
    const finished = store.finishRun(agent.id, run.id, "the result", "done");
    expect(finished?.output).toBe("the result");
    expect(finished?.status).toBe("done");
    // The status transition is on the event log; output (content) is not.
    const types = store.events.list(agent.id).map((e) => e.type);
    expect(types).toContain("run.status_changed");
  } finally {
    store.close();
  }
});

test("latestWithOutput returns the most recent run that has non-empty output", () => {
  const store = freshStore();
  try {
    const agent = makeAgent(store, "personal");
    const r1 = store.startRun(agent.id, { input: "first" });
    store.finishRun(agent.id, r1.id, "first output", "done");
    const r2 = store.startRun(agent.id, { input: "second" });
    store.finishRun(agent.id, r2.id, "second output", "done");
    // A later run with empty/whitespace output is skipped, not chosen.
    const r3 = store.startRun(agent.id, { input: "third" });
    store.finishRun(agent.id, r3.id, "   ", "done");

    expect(store.runs.latestWithOutput(agent.id)?.id).toBe(r2.id);

    // Scoped: another agent's runs are never returned.
    const other = makeAgent(store, "work");
    expect(store.runs.latestWithOutput(other.id)).toBeUndefined();
  } finally {
    store.close();
  }
});

test("listActiveAccepted returns only active, accepted memories", () => {
  const store = freshStore();
  try {
    const agent = makeAgent(store, "personal");
    store.recordMemory(agent.id, { memoryType: "semantic", content: "accepted one", reviewState: "accepted", status: "active" });
    store.recordMemory(agent.id, { memoryType: "semantic", content: "still proposed", reviewState: "proposed", status: "active" });
    store.recordMemory(agent.id, { memoryType: "semantic", content: "archived one", reviewState: "accepted", status: "archived" });

    const contents = store.memories.listActiveAccepted(agent.id).map((m) => m.content);
    expect(contents).toEqual(["accepted one"]);
  } finally {
    store.close();
  }
});

test("opening a pre-existing database without runs.output migrates the column in", () => {
  const driver = openDatabase(":memory:");
  // Simulate an older schema: a runs table created before the output column existed.
  driver.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, soul_ref TEXT NOT NULL,
      workspace_dir TEXT NOT NULL, trust_level TEXT NOT NULL, created_at TEXT NOT NULL,
      team_id TEXT, owner_principal_id TEXT
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, input TEXT NOT NULL,
      status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT
    );
  `);
  // Opening the store applies the additive migration over the old table.
  const store = new AsterismStore(driver);
  try {
    const agent = store.createAgent({
      name: "personal",
      role: "",
      soulRef: "casual-helper",
      workspaceDir: "/tmp/personal",
      trustLevel: "autonomous",
    });
    const run = store.startRun(agent.id, { input: "t" });
    // The write that would throw "no such column: output" on the un-migrated table works.
    expect(store.finishRun(agent.id, run.id, "result text", "done")?.output).toBe("result text");
  } finally {
    store.close();
  }
});
