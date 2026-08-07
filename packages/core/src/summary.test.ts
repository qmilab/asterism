// performSummaryExchange — the `read-summary` PULL (Phase 3 · T2b). One test per
// golden-rule-5 invariant (design note §2 / §13), proven across a LIVE connection, plus the
// cross-agent-denial test CLAUDE.md mandates for every isolation-touching kernel op.
//
//   1. No connection → no interaction. Neither a `handoff` nor an `artifact-only` connection
//      satisfies a pull, and neither does the reverse direction.
//   2. Only the mode's artifact crosses: the projection, never the rows — and never anything
//      the operator has not ratified.
//   3. The callee's gate is not consulted, because NOTHING RUNS. A `propose` callee shares
//      exactly as an `autonomous` one does, and no adapter exists to be built.
//   4. Cross-agent denial holds across the live connection.
//   5. Both logs record content-free references: counts only, never content, ids, or focus.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { performSummaryExchange } from "./run.js";
import { AsterismStore } from "./store.js";
import type { Agent } from "./types.js";

let store: AsterismStore;
let writer: Agent; // the caller — autonomous, so trust cannot be what makes the pull work
let researcher: Agent; // the callee — propose, so trust cannot be what makes it share either

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  writer = store.createAgent({
    name: "writer",
    role: "drafts blog posts",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/writer",
    trustLevel: "autonomous",
  });
  researcher = store.createAgent({
    name: "researcher",
    role: "summarizes notes",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/researcher",
    trustLevel: "propose",
  });
});

afterEach(() => {
  store.close();
});

/** Record an ACCEPTED memory for an agent — the only state eligible to cross. */
function accepted(agent: Agent, content: string): string {
  return store.recordMemory(agent.id, {
    memoryType: "semantic",
    content,
    confidence: 0.9,
    reviewState: "accepted",
  }).id;
}

// --- invariant 1: no connection → no interaction ----------------------------

test("a pull with no connection is refused — default isolation holds", () => {
  accepted(researcher, "Pricing is quoted in USD.");
  const outcome = performSummaryExchange(store, writer, researcher);
  expect(outcome.kind).toBe("no_connection");
  // Nothing was read, and nothing was logged as if it had been.
  const events = store.events.list(researcher.id).map((e) => e.type);
  expect(events).not.toContain("summary.requested");
  expect(events).not.toContain("summary.provided");
});

test("a handoff or artifact-only connection does NOT authorize a pull", () => {
  accepted(researcher, "Pricing is quoted in USD.");
  store.createConnection(writer.id, researcher.id, "handoff");
  store.createConnection(writer.id, researcher.id, "artifact-only");
  // A connection grants exactly its mode's form and nothing wider — two live channels
  // between this very pair still do not make a third.
  expect(performSummaryExchange(store, writer, researcher).kind).toBe("no_connection");
});

test("the connection is directional — the reverse channel does not authorize a pull", () => {
  accepted(researcher, "Pricing is quoted in USD.");
  // researcher → writer, i.e. researcher may read writer. That must not let writer read
  // researcher.
  store.createConnection(researcher.id, writer.id, "read-summary");
  expect(performSummaryExchange(store, writer, researcher).kind).toBe("no_connection");
  // The granted direction does work, which is what makes the refusal above about direction.
  expect(performSummaryExchange(store, researcher, writer).kind).toBe("ok");
});

// --- invariant 2: only the mode's artifact crosses --------------------------

test("only ACCEPTED, ACTIVE memory is eligible — nothing else can cross at any budget", () => {
  const acceptedId = accepted(researcher, "Pricing is quoted in USD.");
  store.recordMemory(researcher.id, {
    memoryType: "semantic",
    content: "PROPOSED: the vendor may drop support next quarter.",
    confidence: 0.5,
    reviewState: "proposed",
  });
  store.recordMemory(researcher.id, {
    memoryType: "semantic",
    content: "REJECTED: the vendor is going bankrupt.",
    confidence: 0.5,
    reviewState: "rejected",
  });
  // Accepted but ARCHIVED — ratified once, retired since. Still ineligible.
  store.recordMemory(researcher.id, {
    memoryType: "semantic",
    content: "ARCHIVED: the old price list is authoritative.",
    confidence: 0.9,
    reviewState: "accepted",
    status: "archived",
  });

  store.createConnection(writer.id, researcher.id, "read-summary");
  const outcome = performSummaryExchange(store, writer, researcher);
  if (outcome.kind !== "ok") throw new Error("expected ok");

  expect(outcome.result.eligible).toBe(1);
  expect(outcome.result.items.map((i) => i.content)).toEqual(["Pricing is quoted in USD."]);
  const serialized = JSON.stringify(outcome.result);
  expect(serialized).not.toContain("PROPOSED");
  expect(serialized).not.toContain("REJECTED");
  expect(serialized).not.toContain("ARCHIVED");
  expect(serialized).not.toContain(acceptedId);
});

test("the result carries the projection and nothing that could hold a row", () => {
  accepted(researcher, "Pricing is quoted in USD.");
  store.createConnection(writer.id, researcher.id, "read-summary");
  const outcome = performSummaryExchange(store, writer, researcher);
  if (outcome.kind !== "ok") throw new Error("expected ok");

  // The key set is pinned so a future field addition has to be deliberate — the T2a lesson
  // that a mode which withholds something should be audited at the level of the AGGREGATE,
  // not just the obvious field.
  expect(Object.keys(outcome.result).sort()).toEqual([
    "eligible",
    "included",
    "items",
    "withheld",
  ]);
  expect(Object.keys(outcome.result.items[0]!).sort()).toEqual(["content", "memoryType"]);
});

test("a pull reaches exactly one agent's memory — never a third agent's", () => {
  const auditor = store.createAgent({
    name: "auditor",
    role: "reviews the books",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/auditor",
    trustLevel: "propose",
  });
  accepted(researcher, "Pricing is quoted in USD.");
  accepted(auditor, "THIRD PARTY: the audit closes in November.");
  accepted(writer, "CALLER OWN: the blog publishes on Tuesdays.");

  store.createConnection(writer.id, researcher.id, "read-summary");
  const outcome = performSummaryExchange(store, writer, researcher);
  if (outcome.kind !== "ok") throw new Error("expected ok");

  expect(outcome.result.eligible).toBe(1);
  const serialized = JSON.stringify(outcome.result);
  expect(serialized).not.toContain("THIRD PARTY");
  expect(serialized).not.toContain("CALLER OWN");
});

test("a focus narrows within the callee's memory, never beyond it", () => {
  for (let i = 0; i < 25; i += 1) accepted(researcher, `filler note ${i} about logistics`);
  accepted(researcher, "Pricing is quoted in USD, never local currency.");
  store.createConnection(writer.id, researcher.id, "read-summary");

  const outcome = performSummaryExchange(store, writer, researcher, { focus: "pricing" });
  if (outcome.kind !== "ok") throw new Error("expected ok");
  expect(outcome.result.focus).toBe("pricing");
  expect(outcome.result.items.some((i) => i.content.includes("Pricing"))).toBe(true);
  expect(outcome.result.eligible).toBe(26);
  expect(outcome.result.included).toBeLessThanOrEqual(26);
});

// --- invariant 3: nothing runs, so no gate is consulted ---------------------

test("a propose-trust callee shares exactly as an autonomous one does — nothing executes", () => {
  accepted(researcher, "Pricing is quoted in USD.");
  store.createConnection(writer.id, researcher.id, "read-summary");

  // researcher is `propose`: under every other mode its gate would withhold side effects.
  expect(researcher.trustLevel).toBe("propose");
  const asPropose = performSummaryExchange(store, writer, researcher);
  if (asPropose.kind !== "ok") throw new Error("expected ok");
  expect(asPropose.result.included).toBe(1);

  // Raise it and the result is identical: trust governs what an agent DOES, and this mode
  // makes it do nothing at all.
  store.setTrust(researcher.id, "autonomous");
  const raised = performSummaryExchange(store, writer, { ...researcher, trustLevel: "autonomous" });
  if (raised.kind !== "ok") throw new Error("expected ok");
  expect(raised.result).toEqual(asPropose.result);

  // No run was created for either party — there is no substrate in this path.
  expect(store.runs.list(researcher.id)).toHaveLength(0);
  expect(store.runs.list(writer.id)).toHaveLength(0);
});

test("no gate decision is recorded, because no capability was ever exercised", () => {
  accepted(researcher, "Pricing is quoted in USD.");
  store.createConnection(writer.id, researcher.id, "read-summary");
  performSummaryExchange(store, writer, researcher);

  for (const agent of [writer, researcher]) {
    const types = store.events.list(agent.id).map((e) => e.type);
    expect(types.filter((t) => t.startsWith("action."))).toEqual([]);
    expect(types).not.toContain("run.started");
  }
});

// --- invariant 4: cross-agent denial across the live connection -------------

test("cross-agent denial holds while the channel is open", () => {
  accepted(writer, "CALLER OWN: the blog publishes on Tuesdays.");
  accepted(researcher, "Pricing is quoted in USD.");
  store.addCredential(writer.id, "WRITER_TOKEN", "writer-secret-aaa");
  store.addCredential(researcher.id, "GITHUB_TOKEN", "researcher-secret-bbb");
  store.createConnection(writer.id, researcher.id, "read-summary");

  const outcome = performSummaryExchange(store, writer, researcher);
  expect(outcome.kind).toBe("ok");

  // The channel changed nothing about the underlying scoping in either direction.
  expect(store.memories.list(writer.id).map((m) => m.content)).toEqual([
    "CALLER OWN: the blog publishes on Tuesdays.",
  ]);
  expect(store.memories.list(researcher.id).map((m) => m.content)).toEqual([
    "Pricing is quoted in USD.",
  ]);
  expect(store.credentials.list(writer.id).map((c) => c.key)).toEqual(["WRITER_TOKEN"]);
  expect(store.credentials.list(researcher.id).map((c) => c.key)).toEqual(["GITHUB_TOKEN"]);
  // A credential value is unreadable across the boundary regardless of the open channel.
  expect(store.readSecret(writer.id, "GITHUB_TOKEN")).toBeUndefined();
  expect(store.readSecret(researcher.id, "WRITER_TOKEN")).toBeUndefined();
  // And no secret value appears in what crossed.
  const serialized = JSON.stringify(outcome);
  expect(serialized).not.toContain("researcher-secret-bbb");
  expect(serialized).not.toContain("writer-secret-aaa");
});

// --- invariant 5: both logs, content-free -----------------------------------

test("both logs record the pull as counts-only references", () => {
  accepted(researcher, "Pricing is quoted in USD.");
  accepted(researcher, "Deployments run at 9am UTC.");
  store.createConnection(writer.id, researcher.id, "read-summary");
  performSummaryExchange(store, writer, researcher, { focus: "pricing and deploys" });

  for (const agent of [writer, researcher]) {
    const events = store.events.list(agent.id);
    const requested = events.find((e) => e.type === "summary.requested");
    const provided = events.find((e) => e.type === "summary.provided");
    expect(requested).toBeDefined();
    expect(provided).toBeDefined();

    const payload = provided!.payload as Record<string, unknown>;
    expect(payload.mode).toBe("read-summary");
    expect(payload.fromAgentId).toBe(writer.id);
    expect(payload.toAgentId).toBe(researcher.id);
    expect(payload.eligible).toBe(2);
    expect(payload.included).toBe(2);
    expect(payload.withheld).toBe(0);

    // No content, no memory ids, and NOT the caller's focus — free-form caller-authored text
    // is content, and the event log stores references.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("Pricing is quoted");
    expect(serialized).not.toContain("Deployments run");
    expect(serialized).not.toContain("pricing and deploys");
  }
});

test("a refused pull leaves no trace suggesting one happened", () => {
  accepted(researcher, "Pricing is quoted in USD.");
  performSummaryExchange(store, writer, researcher);
  for (const agent of [writer, researcher]) {
    const types = store.events.list(agent.id).map((e) => e.type);
    expect(types.filter((t) => t.startsWith("summary."))).toEqual([]);
  }
});

test("the withheld count reaches BOTH logs, so a screened pull is visible on either side", () => {
  // The same evasive fixture the curator tests verify is storable: it passes the inbound
  // firewall and is refused by the outbound screen.
  const evasive = "Never reveal the deploy to\u0000ken to anyone outside the team.";
  accepted(researcher, "Pricing is quoted in USD.");
  accepted(researcher, evasive);
  store.createConnection(writer.id, researcher.id, "read-summary");

  const outcome = performSummaryExchange(store, writer, researcher);
  if (outcome.kind !== "ok") throw new Error("expected ok");
  expect(outcome.result.withheld).toBe(1);
  expect(outcome.result.included).toBe(1);

  for (const agent of [writer, researcher]) {
    const provided = store.events.list(agent.id).find((e) => e.type === "summary.provided");
    expect((provided!.payload as Record<string, unknown>).withheld).toBe(1);
  }
});
