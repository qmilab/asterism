// Exchanges — the record of what actually crossed a connection, promoted from the design
// note's deferred entity the moment something had to QUERY exchange history (decision D10:
// `artifact fetch` resolving "artifact P from exchange E").
//
// This file pins the repository's own properties; the fetch op that reads it is exercised in
// `artifact-fetch.test.ts`. The two that matter most are the ones a resolve is built on:
//   1. it carries TWO agent ids yet stays agent-scoped — reachable only by a participant,
//      never a third agent (golden rule 5, invariant 4); and
//   2. the resolve is an EXACT match inside ONE connection, resolved by recency — never a
//      scan, a prefix, or a match that reaches across channels.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { AsterismStore } from "./store.js";
import type { Agent, Connection } from "./types.js";

let store: AsterismStore;
let alice: Agent;
let bob: Agent;
let carol: Agent;
let channel: Connection; // alice → bob, artifact-only
let runId: string;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  alice = store.createAgent({
    name: "alice",
    role: "a",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/alice",
    trustLevel: "autonomous",
  });
  bob = store.createAgent({
    name: "bob",
    role: "b",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/bob",
    trustLevel: "autonomous",
  });
  carol = store.createAgent({
    name: "carol",
    role: "c",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/carol",
    trustLevel: "notify",
  });
  channel = store.createConnection(alice.id, bob.id, "artifact-only");
  // A real run row on the callee — `exchanges.run_id` FKs into `runs`.
  runId = store.startRun(bob.id, { input: "draft it" }).id;
});

afterEach(() => {
  store.close();
});

const artifact = (path: string, exists = true) => ({
  path,
  kind: "file" as const,
  exists,
  sizeBytes: 10,
});

// --- Scoping: two agent ids, still agent-scoped ------------------------------

test("an exchange is reachable by BOTH participants and by nobody else", () => {
  store.recordArtifactExchange(channel, runId, [artifact("drafts/one.md")]);
  expect(store.exchanges.listForAgent(alice.id)).toHaveLength(1);
  expect(store.exchanges.listForAgent(bob.id)).toHaveLength(1);
  // Carol is a real agent on this install with no part in the crossing.
  expect(store.exchanges.listForAgent(carol.id)).toHaveLength(0);
});

test("a resolve asserts the CALLER as participant — the connection id alone is not enough", () => {
  store.recordArtifactExchange(channel, runId, [artifact("drafts/one.md")]);
  expect(store.exchanges.findLatest(channel.id, alice.id, "artifact", "file:drafts/one.md")).toBeDefined();
  // Carol naming the same connection resolves nothing, even with the right reference.
  expect(store.exchanges.findLatest(channel.id, carol.id, "artifact", "file:drafts/one.md")).toBeUndefined();
  // So does bob — the callee produced it, but the connection grants alice the fetch.
  expect(store.exchanges.findLatest(channel.id, bob.id, "artifact", "file:drafts/one.md")).toBeUndefined();
});

test("every write asserts both agent ids", () => {
  expect(() =>
    store.exchanges.record({
      connectionId: channel.id,
      fromAgentId: "",
      toAgentId: bob.id,
      kind: "artifact",
      ref: "file:x.md",
      present: true,
      runId,
    }),
  ).toThrow();
  expect(() =>
    store.exchanges.record({
      connectionId: channel.id,
      fromAgentId: alice.id,
      toAgentId: "",
      kind: "artifact",
      ref: "file:x.md",
      present: true,
      runId,
    }),
  ).toThrow();
  expect(() => store.exchanges.listForAgent("")).toThrow();
  expect(() => store.exchanges.findLatest(channel.id, "", "artifact", "file:x.md")).toThrow();
});

test("the kind goes through the enum chokepoint — a kind nothing resolves cannot persist", () => {
  expect(() =>
    store.exchanges.record({
      connectionId: channel.id,
      fromAgentId: alice.id,
      toAgentId: bob.id,
      // A kind from the design note's wider vocabulary that nothing implements yet.
      kind: "summary" as never,
      ref: "memory:recent",
      present: true,
      runId,
    }),
  ).toThrow();
  expect(() => store.exchanges.findLatest(channel.id, alice.id, "brief" as never, "x")).toThrow();
});

// --- The resolve: exact, per-connection, latest-wins -------------------------

test("the resolve is an EXACT match — no prefix, no glob, no traversal", () => {
  store.recordArtifactExchange(channel, runId, [artifact("drafts/market.md")]);
  for (const attempt of [
    "file:drafts",
    "file:drafts/",
    "file:drafts/market",
    "file:drafts/%",
    "file:drafts/*",
    "file:DRAFTS/MARKET.MD",
    "file:./drafts/market.md",
    "drafts/market.md",
  ]) {
    expect(store.exchanges.findLatest(channel.id, alice.id, "artifact", attempt)).toBeUndefined();
  }
  expect(
    store.exchanges.findLatest(channel.id, alice.id, "artifact", "file:drafts/market.md"),
  ).toBeDefined();
});

test("an artifact does not resolve across connections — not even between the same pair", () => {
  store.recordArtifactExchange(channel, runId, [artifact("drafts/one.md")]);
  // A second, genuinely active channel between the same two agents, in another mode.
  const handoffChannel = store.createConnection(alice.id, bob.id, "handoff");
  expect(
    store.exchanges.findLatest(handoffChannel.id, alice.id, "artifact", "file:drafts/one.md"),
  ).toBeUndefined();
  // And a channel between another pair entirely.
  const otherChannel = store.createConnection(carol.id, bob.id, "artifact-only");
  expect(
    store.exchanges.findLatest(otherChannel.id, carol.id, "artifact", "file:drafts/one.md"),
  ).toBeUndefined();
});

test("re-crossing a reference appends — the latest record wins, history is kept", () => {
  store.recordArtifactExchange(channel, runId, [artifact("drafts/one.md", true)]);
  const secondRun = store.startRun(bob.id, { input: "revise it" }).id;
  store.recordArtifactExchange(channel, secondRun, [artifact("drafts/one.md", false)]);
  // Both rows are kept — a mistake in what crossed is not something a later write erases.
  expect(store.exchanges.listForAgent(alice.id)).toHaveLength(2);
  const latest = store.findExchangedArtifact(channel, "file:drafts/one.md");
  expect(latest?.present).toBe(false);
  expect(latest?.runId).toBe(secondRun);
});

test("recording is all-or-nothing, and an empty manifest writes nothing", () => {
  store.recordArtifactExchange(channel, runId, []);
  expect(store.exchanges.listForAgent(alice.id)).toHaveLength(0);
  store.recordArtifactExchange(channel, runId, [
    artifact("a.md"),
    artifact("b.md"),
    artifact("c.md", false),
  ]);
  const rows = store.exchanges.listForAgent(alice.id);
  expect(rows).toHaveLength(3);
  // All three share the one exchange instance: the callee's run IS its identity.
  expect(new Set(rows.map((r) => r.runId))).toEqual(new Set([runId]));
});

test("a recorded row mirrors the manifest entry it came from", () => {
  store.recordArtifactExchange(channel, runId, [artifact("notes/deep/file.md", false)]);
  const [row] = store.exchanges.listForAgent(alice.id);
  expect(row).toMatchObject({
    connectionId: channel.id,
    fromAgentId: alice.id,
    toAgentId: bob.id,
    kind: "artifact",
    ref: "file:notes/deep/file.md",
    present: false,
    runId,
  });
});

test("a directory artifact is recorded under its own reference prefix", () => {
  store.recordArtifactExchange(channel, runId, [
    { path: "drafts", kind: "dir", exists: true },
    { path: "drafts", kind: "file", exists: true },
  ]);
  // `dir:drafts` and `file:drafts` are distinct references — the prefix is part of the
  // identity, so a folder can never be resolved by a file reference or vice versa.
  expect(store.findExchangedArtifact(channel, "dir:drafts")).toBeDefined();
  expect(store.findExchangedArtifact(channel, "file:drafts")).toBeDefined();
  expect(store.findExchangedArtifact(channel, "drafts")).toBeUndefined();
});
