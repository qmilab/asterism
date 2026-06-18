// Trust contracts — the evidence reader and the propose pipeline. These pin the
// EARNING policy: a destructive capability is proposed for an auto-approve grant
// only on a clean track record (enough confirmed executions, across enough distinct
// targets, with no regressions), the evidence is read from the agent's OWN scoped
// event log (so it can never be earned from another agent's history), a regression
// resets the ramp, and nothing here ever persists — it only proposes.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { AsterismStore } from "./store.js";
import {
  DEFAULT_STANDING_POLICY,
  evidenceBasis,
  gatherEvidence,
  proposeStandingGrants,
  qualifies,
} from "./standing.js";
import type { Agent } from "./types.js";

let store: AsterismStore;
let agent: Agent;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  agent = store.createAgent({
    name: "cleaner",
    role: "",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/cleaner",
    trustLevel: "autonomous",
  });
});

afterEach(() => {
  store.close();
});

/** A confirmed destructive execution of `capability` on `target`, in a run that finished `done`. */
function cleanExec(agentId: string, capability: string, target: string): void {
  const run = store.startRun(agentId, { input: `do ${target}` });
  store.events.append(agentId, {
    runId: run.id,
    type: "action.executed",
    payload: { capability, effect: "destructive", fingerprint: target },
  });
  store.finishRun(agentId, run.id, "ok", "done");
}

/** A declined destructive action of `capability` on `target` — a refusal regression. */
function declined(agentId: string, capability: string, target: string): void {
  const run = store.startRun(agentId, { input: `do ${target}` });
  store.setRunStatus(agentId, run.id, "running");
  store.setRunStatus(agentId, run.id, "awaiting_confirmation");
  store.events.append(agentId, {
    runId: run.id,
    type: "action.awaiting_confirmation",
    payload: { capability, effect: "destructive", fingerprint: target },
  });
  store.declineRun(agentId, run.id);
}

/** A destructive action of `capability` on `target` that executed in a run that then FAILED. */
function failedExec(agentId: string, capability: string, target: string): void {
  const run = store.startRun(agentId, { input: `do ${target}` });
  store.events.append(agentId, {
    runId: run.id,
    type: "action.executed",
    payload: { capability, effect: "destructive", fingerprint: target },
  });
  store.finishRun(agentId, run.id, "", "failed");
}

test("a clean track record across distinct targets earns a candidate", () => {
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "build");
  cleanExec(agent.id, "fs.delete", "cache");
  const candidates = proposeStandingGrants(store, agent);
  expect(candidates.map((c) => c.capability)).toEqual(["fs.delete"]);
  const c = candidates[0]!;
  expect(c.cleanExecutions).toBe(3);
  expect(c.distinctTargets).toBe(3);
  expect(c.regressions).toBe(0);
  expect(c.basis).toBe("earned: 3 confirmed executions across 3 distinct targets, 0 regressions");
});

test("breadth is required: the same target repeated does not earn a grant", () => {
  // Three confirmed executions, but all the same target ⇒ distinctTargets = 1, below
  // the bar. This is exactly the guard against a broad capability-key grant earned
  // from a single repeated action.
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "dist");
  expect(proposeStandingGrants(store, agent)).toEqual([]);
});

test("too few clean executions does not earn a grant", () => {
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "build");
  expect(proposeStandingGrants(store, agent)).toEqual([]);
});

test("a single decline in the window blocks earning (zero-regression bar)", () => {
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "build");
  cleanExec(agent.id, "fs.delete", "cache");
  declined(agent.id, "fs.delete", "secrets");
  expect(proposeStandingGrants(store, agent)).toEqual([]);
});

test("a failed run that ran the capability is a regression and blocks earning", () => {
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "build");
  cleanExec(agent.id, "fs.delete", "cache");
  failedExec(agent.id, "fs.delete", "tmp");
  expect(proposeStandingGrants(store, agent)).toEqual([]);
});

test("a regression on one capability does not block another's earning", () => {
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "build");
  cleanExec(agent.id, "fs.delete", "cache");
  declined(agent.id, "git.push", "main"); // a refusal of a DIFFERENT capability
  expect(proposeStandingGrants(store, agent).map((c) => c.capability)).toEqual(["fs.delete"]);
});

test("an already-granted capability is not re-proposed", () => {
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "build");
  cleanExec(agent.id, "fs.delete", "cache");
  store.setCapabilityStanding(agent.id, "fs.delete", "standing-grant", "earned");
  expect(proposeStandingGrants(store, agent)).toEqual([]);
});

test("a regression resets the ramp: pre-downgrade evidence no longer counts", () => {
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "build");
  cleanExec(agent.id, "fs.delete", "cache");
  // A downgrade (e.g. a revoke) marks a reset point — earlier evidence is behind the window.
  store.setCapabilityStanding(agent.id, "fs.delete", "gated", "revoked");
  expect(proposeStandingGrants(store, agent)).toEqual([]);
  // A FRESH clean track record after the reset re-earns the grant.
  cleanExec(agent.id, "fs.delete", "logs");
  cleanExec(agent.id, "fs.delete", "tmp");
  cleanExec(agent.id, "fs.delete", "out");
  expect(proposeStandingGrants(store, agent).map((c) => c.capability)).toEqual(["fs.delete"]);
});

test("standing is earned from one agent's own log — never another's", () => {
  const other = store.createAgent({
    name: "other",
    role: "",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/other",
    trustLevel: "autonomous",
  });
  // `agent` builds a spotless fs.delete record...
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "build");
  cleanExec(agent.id, "fs.delete", "cache");
  // ...but `other` has done nothing, so it earns nothing. Standing never crosses agents.
  expect(proposeStandingGrants(store, other)).toEqual([]);
  expect(proposeStandingGrants(store, agent).length).toBe(1);
});

test("only destructive executions count toward earning", () => {
  // A non-destructive (write) execution is not evidence for a destructive grant.
  const run = store.startRun(agent.id, { input: "write" });
  store.events.append(agent.id, {
    runId: run.id,
    type: "action.executed",
    payload: { capability: "fs.write", effect: "write", fingerprint: "notes" },
  });
  store.finishRun(agent.id, run.id, "ok", "done");
  expect(proposeStandingGrants(store, agent)).toEqual([]);
});

test("a custom policy can raise or lower the bar", () => {
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "build");
  // Two distinct clean targets: below the default (3) but above a relaxed bar.
  expect(proposeStandingGrants(store, agent, DEFAULT_STANDING_POLICY)).toEqual([]);
  const relaxed = proposeStandingGrants(store, agent, {
    minCleanExecutions: 2,
    minDistinctTargets: 2,
    maxRegressions: 0,
  });
  expect(relaxed.map((c) => c.capability)).toEqual(["fs.delete"]);
});

test("gatherEvidence and qualifies are pure over the event list", () => {
  cleanExec(agent.id, "fs.delete", "dist");
  cleanExec(agent.id, "fs.delete", "build");
  const evidence = gatherEvidence(store.events.list(agent.id));
  const fsDelete = evidence.get("fs.delete")!;
  expect(fsDelete.cleanExecutions).toBe(2);
  expect(fsDelete.distinctTargets).toBe(2);
  expect(qualifies(fsDelete, DEFAULT_STANDING_POLICY)).toBe(false); // 2 < 3
  expect(qualifies(fsDelete, { minCleanExecutions: 2, minDistinctTargets: 2, maxRegressions: 0 })).toBe(true);
});

test("evidenceBasis is references-only counts, with correct pluralization", () => {
  expect(evidenceBasis({ capability: "x", cleanExecutions: 1, distinctTargets: 1, regressions: 0 })).toBe(
    "earned: 1 confirmed execution across 1 distinct target, 0 regressions",
  );
});
