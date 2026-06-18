// CapabilityStandingRepository — per-capability earned standing, the "trust
// contracts" underneath the coarse trust level. The agent is the isolation
// boundary, so the load-bearing property here is the same as every other scoped
// table: a grant recorded for one agent can never be read (or revoked) through
// another agent's id, and every method refuses a missing agentId.

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

test("a standing grant is scoped: one agent's grant never appears for another", () => {
  store.setCapabilityStanding(alpha.id, "fs.delete", "standing-grant", "earned: x");
  expect(store.capabilityStanding.grantedKeys(alpha.id)).toEqual(["fs.delete"]);
  // Beta shares nothing — a grant is one agent's earned autonomy, never global.
  expect(store.capabilityStanding.grantedKeys(beta.id)).toEqual([]);
  expect(store.capabilityStanding.get(beta.id, "fs.delete")).toBeUndefined();
});

test("setStanding upserts: a downgrade rewrites the row, it does not add a second", () => {
  store.setCapabilityStanding(alpha.id, "fs.delete", "standing-grant", "earned: x");
  store.setCapabilityStanding(alpha.id, "fs.delete", "gated", "revoked");
  // One row, now gated; grantedKeys drops it.
  const rows = store.capabilityStanding.list(alpha.id);
  expect(rows.length).toBe(1);
  expect(rows[0]!.standing).toBe("gated");
  expect(store.capabilityStanding.grantedKeys(alpha.id)).toEqual([]);
});

test("grantedKeys returns only standing-grant rows, not gated ones", () => {
  store.setCapabilityStanding(alpha.id, "fs.delete", "standing-grant", "earned");
  store.setCapabilityStanding(alpha.id, "git.push", "gated", "revoked"); // a recorded-but-gated row
  expect(store.capabilityStanding.grantedKeys(alpha.id)).toEqual(["fs.delete"]);
});

test("createdAt is preserved across an upsert; updatedAt advances", async () => {
  const first = store.capabilityStanding.setStanding(alpha.id, "fs.delete", "standing-grant", "earned");
  await new Promise((r) => setTimeout(r, 2));
  const second = store.capabilityStanding.setStanding(alpha.id, "fs.delete", "gated", "revoked");
  expect(second.createdAt).toBe(first.createdAt);
  expect(second.updatedAt >= first.updatedAt).toBe(true);
});

test("every method requires an agentId", () => {
  expect(() => store.capabilityStanding.get("", "fs.delete")).toThrow();
  expect(() => store.capabilityStanding.list("")).toThrow();
  expect(() => store.capabilityStanding.grantedKeys("")).toThrow();
  expect(() => store.capabilityStanding.setStanding("", "fs.delete", "gated", "x")).toThrow();
});

test("setStanding validates the standing through the enum chokepoint", () => {
  // A bad standing value can never reach a gate decision.
  expect(() =>
    store.capabilityStanding.setStanding(alpha.id, "fs.delete", "wide-open" as never, "x"),
  ).toThrow();
});

test("setCapabilityStanding records an agent.standing_changed event, references only", () => {
  store.setCapabilityStanding(alpha.id, "fs.delete", "standing-grant", "earned: 3 confirmed executions");
  const event = store.events.tail(alpha.id).find((e) => e.type === "agent.standing_changed");
  expect(event).toBeDefined();
  const payload = event!.payload as Record<string, unknown>;
  expect(payload.capability).toBe("fs.delete");
  expect(payload.from).toBe("gated");
  expect(payload.to).toBe("standing-grant");
  // The basis is a references-only count summary — no arguments anywhere in the payload.
  expect(String(payload.basis)).toContain("confirmed executions");
});
