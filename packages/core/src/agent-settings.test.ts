// AgentSettingsRepository — per-agent kernel tunables (recall budget today; more
// later). The agent is the isolation boundary, so the load-bearing property is the
// same as every other scoped table: a setting written for one agent can never be
// read (or cleared) through another agent's id, and every method refuses a missing
// agentId. The audited store ops (`setRecallBudget` / `clearRecallBudget`) are
// covered here too — they must log references only and only on a real transition.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { AsterismStore } from "./store.js";
import type { Agent } from "./types.js";

let store: AsterismStore;
let alpha: Agent;
let beta: Agent;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  alpha = store.createAgent({
    name: "alpha",
    role: "",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/alpha",
    trustLevel: "autonomous",
  });
  beta = store.createAgent({
    name: "beta",
    role: "",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/beta",
    trustLevel: "autonomous",
  });
});

afterEach(() => {
  store.close();
});

test("a recall budget is scoped: one agent's setting never appears for another", () => {
  store.setRecallBudget(alpha.id, 40);
  expect(store.agentSettings.getRecallBudget(alpha.id)).toBe(40);
  // Beta shares nothing — a per-agent setting is one agent's, never global.
  expect(store.agentSettings.getRecallBudget(beta.id)).toBeUndefined();
  expect(store.agentSettings.get(beta.id)).toBeUndefined();
});

test("an unset agent has no settings row and no recall budget", () => {
  expect(store.agentSettings.get(alpha.id)).toBeUndefined();
  expect(store.agentSettings.getRecallBudget(alpha.id)).toBeUndefined();
});

test("setRecallBudget upserts: setting again rewrites the row, it does not add a second", () => {
  store.setRecallBudget(alpha.id, 40);
  store.setRecallBudget(alpha.id, 5);
  expect(store.agentSettings.getRecallBudget(alpha.id)).toBe(5);
  // Still one row — the upsert is on agent_id.
  expect(store.agentSettings.get(alpha.id)?.recallBudget).toBe(5);
});

test("createdAt is preserved across an upsert; updatedAt advances", async () => {
  const first = store.agentSettings.setRecallBudget(alpha.id, 40);
  await new Promise((r) => setTimeout(r, 2));
  const second = store.agentSettings.setRecallBudget(alpha.id, 10);
  expect(second.createdAt).toBe(first.createdAt);
  expect(second.updatedAt >= first.updatedAt).toBe(true);
});

test("clearRecallBudget returns the agent to the default; the row persists with no budget", () => {
  store.setRecallBudget(alpha.id, 40);
  store.clearRecallBudget(alpha.id);
  // Override gone (resolver will fall back to the default)...
  expect(store.agentSettings.getRecallBudget(alpha.id)).toBeUndefined();
  // ...but the row is kept (NULL budget) so a later set preserves created_at.
  const row = store.agentSettings.get(alpha.id);
  expect(row).toBeDefined();
  expect(row?.recallBudget).toBeUndefined();
});

test("clearRecallBudget on an agent that never set one is a no-op (no row, no throw)", () => {
  expect(store.clearRecallBudget(alpha.id)).toBeUndefined();
  expect(store.agentSettings.getRecallBudget(alpha.id)).toBeUndefined();
});

test("setRecallBudget validates a positive whole number at the write boundary", () => {
  // Zero, negatives, fractions, and the non-finite values all fail — a bad budget can
  // never reach a stored setting the resolver later trusts.
  expect(() => store.setRecallBudget(alpha.id, 0)).toThrow();
  expect(() => store.setRecallBudget(alpha.id, -5)).toThrow();
  expect(() => store.setRecallBudget(alpha.id, 2.5)).toThrow();
  expect(() => store.setRecallBudget(alpha.id, Number.NaN)).toThrow();
  expect(() => store.setRecallBudget(alpha.id, Number.POSITIVE_INFINITY)).toThrow();
  // A rejected write leaves nothing behind.
  expect(store.agentSettings.get(alpha.id)).toBeUndefined();
});

test("every repository method requires an agentId", () => {
  expect(() => store.agentSettings.get("")).toThrow();
  expect(() => store.agentSettings.getRecallBudget("")).toThrow();
  expect(() => store.agentSettings.setRecallBudget("", 40)).toThrow();
  expect(() => store.agentSettings.clearRecallBudget("")).toThrow();
});

test("setRecallBudget records an agent.setting_changed event, references only", () => {
  store.setRecallBudget(alpha.id, 40);
  const event = store.events.tail(alpha.id).find((e) => e.type === "agent.setting_changed");
  expect(event).toBeDefined();
  const payload = event!.payload as Record<string, unknown>;
  expect(payload.setting).toBe("recallBudget");
  expect(payload.from).toBe(null); // was unset
  expect(payload.to).toBe(40);
});

test("setRecallBudget to the unchanged value is a no-op: no phantom event, no row churn", () => {
  const first = store.setRecallBudget(alpha.id, 40); // the audited store op — emits once
  store.setRecallBudget(alpha.id, 40); // same value again — should record nothing
  // Exactly one transition is on the log — the redundant set recorded nothing.
  expect(store.events.tail(alpha.id).filter((e) => e.type === "agent.setting_changed").length).toBe(1);
  // The value is still 40, and the row was not rewritten (updatedAt unchanged).
  expect(store.agentSettings.getRecallBudget(alpha.id)).toBe(40);
  expect(store.agentSettings.get(alpha.id)?.updatedAt).toBe(first.updatedAt);
});

test("setRecallBudget again records the prior value as `from`", () => {
  store.setRecallBudget(alpha.id, 40);
  store.setRecallBudget(alpha.id, 10);
  const last = store.events
    .tail(alpha.id)
    .filter((e) => e.type === "agent.setting_changed")
    .at(-1);
  const payload = last!.payload as Record<string, unknown>;
  expect(payload.from).toBe(40);
  expect(payload.to).toBe(10);
});

test("clearRecallBudget logs a transition to null only when something was set", () => {
  // A real clear is audited (from the prior value → null)...
  store.setRecallBudget(alpha.id, 40);
  store.clearRecallBudget(alpha.id);
  const cleared = store.events
    .tail(alpha.id)
    .filter((e) => e.type === "agent.setting_changed")
    .at(-1);
  expect((cleared!.payload as Record<string, unknown>).to).toBe(null);
  expect((cleared!.payload as Record<string, unknown>).from).toBe(40);

  // ...a clear with nothing set emits nothing — count is unchanged by the no-op.
  const before = store.events.tail(beta.id).filter((e) => e.type === "agent.setting_changed").length;
  store.clearRecallBudget(beta.id);
  const after = store.events.tail(beta.id).filter((e) => e.type === "agent.setting_changed").length;
  expect(after).toBe(before);
});

// --- earned-standing thresholds (the second per-agent tunable) ---------------

/** Count an agent's `agent.setting_changed` events whose `setting` is `field`. */
function settingEvents(agentId: string, field: string): number {
  return store.events
    .tail(agentId)
    .filter((e) => e.type === "agent.setting_changed" && (e.payload as Record<string, unknown>).setting === field)
    .length;
}

test("standing thresholds are scoped: one agent's bar never appears for another", () => {
  store.setStandingThresholds(alpha.id, { minCleanExecutions: 5, minDistinctTargets: 4 });
  expect(store.agentSettings.getStandingThresholds(alpha.id)).toEqual({
    minCleanExecutions: 5,
    minDistinctTargets: 4,
  });
  // Beta shares nothing — a per-agent bar is one agent's, never global.
  expect(store.agentSettings.getStandingThresholds(beta.id)).toEqual({});
  expect(store.agentSettings.get(beta.id)).toBeUndefined();
});

test("an unset agent has no threshold overrides", () => {
  expect(store.agentSettings.getStandingThresholds(alpha.id)).toEqual({});
});

test("setting one threshold leaves the other untouched (no clobber)", () => {
  store.setStandingThresholds(alpha.id, { minCleanExecutions: 5 });
  expect(store.agentSettings.getStandingThresholds(alpha.id)).toEqual({ minCleanExecutions: 5 });
  // Now set only the breadth half — the execution half must survive.
  store.setStandingThresholds(alpha.id, { minDistinctTargets: 4 });
  expect(store.agentSettings.getStandingThresholds(alpha.id)).toEqual({
    minCleanExecutions: 5,
    minDistinctTargets: 4,
  });
});

test("the recall budget and the standing thresholds never clobber each other", () => {
  store.setRecallBudget(alpha.id, 40);
  store.setStandingThresholds(alpha.id, { minCleanExecutions: 5, minDistinctTargets: 4 });
  // Both tunables coexist on the one row...
  expect(store.agentSettings.getRecallBudget(alpha.id)).toBe(40);
  expect(store.agentSettings.getStandingThresholds(alpha.id)).toEqual({
    minCleanExecutions: 5,
    minDistinctTargets: 4,
  });
  // ...and clearing one leaves the other intact, in both directions.
  store.clearStandingThresholds(alpha.id);
  expect(store.agentSettings.getRecallBudget(alpha.id)).toBe(40);
  expect(store.agentSettings.getStandingThresholds(alpha.id)).toEqual({});
  store.setStandingThresholds(alpha.id, { minCleanExecutions: 2, minDistinctTargets: 1 });
  store.clearRecallBudget(alpha.id);
  expect(store.agentSettings.getRecallBudget(alpha.id)).toBeUndefined();
  expect(store.agentSettings.getStandingThresholds(alpha.id)).toEqual({
    minCleanExecutions: 2,
    minDistinctTargets: 1,
  });
});

test("setStandingThresholds upserts: setting again rewrites the row, it does not add a second", () => {
  store.setStandingThresholds(alpha.id, { minCleanExecutions: 5, minDistinctTargets: 4 });
  store.setStandingThresholds(alpha.id, { minCleanExecutions: 2 });
  expect(store.agentSettings.getStandingThresholds(alpha.id)).toEqual({
    minCleanExecutions: 2,
    minDistinctTargets: 4,
  });
});

test("createdAt is preserved across a threshold upsert; updatedAt advances", async () => {
  const first = store.agentSettings.setStandingThresholds(alpha.id, { minCleanExecutions: 5 });
  await new Promise((r) => setTimeout(r, 2));
  const second = store.agentSettings.setStandingThresholds(alpha.id, { minDistinctTargets: 4 });
  expect(second.createdAt).toBe(first.createdAt);
  expect(second.updatedAt >= first.updatedAt).toBe(true);
});

test("clearStandingThresholds returns the agent to the default; the row persists", () => {
  store.setStandingThresholds(alpha.id, { minCleanExecutions: 5, minDistinctTargets: 4 });
  store.clearStandingThresholds(alpha.id);
  expect(store.agentSettings.getStandingThresholds(alpha.id)).toEqual({});
  // The row is kept (NULL thresholds) so a later set preserves created_at.
  expect(store.agentSettings.get(alpha.id)).toBeDefined();
});

test("clearStandingThresholds on an agent that never set one is a no-op", () => {
  expect(store.clearStandingThresholds(alpha.id)).toBeUndefined();
  expect(store.agentSettings.getStandingThresholds(alpha.id)).toEqual({});
});

test("setStandingThresholds validates each value as a positive whole number", () => {
  expect(() => store.setStandingThresholds(alpha.id, { minCleanExecutions: 0 })).toThrow();
  expect(() => store.setStandingThresholds(alpha.id, { minDistinctTargets: -2 })).toThrow();
  expect(() => store.setStandingThresholds(alpha.id, { minCleanExecutions: 2.5 })).toThrow();
  expect(() => store.setStandingThresholds(alpha.id, { minDistinctTargets: Number.NaN })).toThrow();
  // A rejected write leaves nothing behind.
  expect(store.agentSettings.get(alpha.id)).toBeUndefined();
});

test("setStandingThresholds with no field provided is rejected", () => {
  expect(() => store.setStandingThresholds(alpha.id, {})).toThrow();
  expect(() => store.agentSettings.setStandingThresholds(alpha.id, {})).toThrow();
});

test("the threshold repository methods require an agentId", () => {
  expect(() => store.agentSettings.getStandingThresholds("")).toThrow();
  expect(() => store.agentSettings.setStandingThresholds("", { minCleanExecutions: 2 })).toThrow();
  expect(() => store.agentSettings.clearStandingThresholds("")).toThrow();
});

test("setStandingThresholds records one references-only event per changed field", () => {
  store.setStandingThresholds(alpha.id, { minCleanExecutions: 5, minDistinctTargets: 4 });
  const events = store.events
    .tail(alpha.id)
    .filter((e) => e.type === "agent.setting_changed")
    .map((e) => e.payload as Record<string, unknown>);
  expect(events).toContainEqual({ setting: "minCleanExecutions", from: null, to: 5 });
  expect(events).toContainEqual({ setting: "minDistinctTargets", from: null, to: 4 });
});

test("setting a threshold to its current value is a no-op: no phantom event", () => {
  store.setStandingThresholds(alpha.id, { minCleanExecutions: 5, minDistinctTargets: 4 });
  // Re-set the same clean value plus a genuinely new targets value: only targets logs.
  store.setStandingThresholds(alpha.id, { minCleanExecutions: 5, minDistinctTargets: 2 });
  expect(settingEvents(alpha.id, "minCleanExecutions")).toBe(1); // unchanged half logged once
  expect(settingEvents(alpha.id, "minDistinctTargets")).toBe(2); // changed both times
  expect(store.agentSettings.getStandingThresholds(alpha.id)).toEqual({
    minCleanExecutions: 5,
    minDistinctTargets: 2,
  });
});

test("clearStandingThresholds logs to null only for the fields that were set", () => {
  store.setStandingThresholds(alpha.id, { minCleanExecutions: 5 }); // only clean set
  store.clearStandingThresholds(alpha.id);
  // The set half logs a clear; the never-set half logs nothing.
  const cleared = store.events
    .tail(alpha.id)
    .filter((e) => e.type === "agent.setting_changed")
    .at(-1);
  expect(cleared!.payload).toEqual({ setting: "minCleanExecutions", from: 5, to: null });
  expect(settingEvents(alpha.id, "minDistinctTargets")).toBe(0);
});
