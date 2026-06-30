// Connections — the Phase 3 collaboration primitive (the permission object). These
// tests pin the entity's two distinguishing properties:
//   1. it is DIRECTIONAL (`from → to`), so a connection is not symmetric; and
//   2. it carries TWO agent ids yet stays agent-scoped — reachable only by a
//      participant, never a third agent (golden rule 5, invariant 4).
// Plus the store's audited create: `connection.created` on BOTH logs, idempotent, and a
// refused self-connection. The cross-connection handoff op is exercised in handoff.test.ts.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { AsterismStore } from "./store.js";
import type { Agent } from "./types.js";

let store: AsterismStore;
let alice: Agent;
let bob: Agent;
let carol: Agent;

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
    trustLevel: "propose",
  });
  carol = store.createAgent({
    name: "carol",
    role: "c",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/carol",
    trustLevel: "notify",
  });
});

afterEach(() => {
  store.close();
});

test("createConnection persists a directional, active handoff connection", () => {
  const conn = store.createConnection(alice.id, bob.id, "handoff");
  expect(conn.fromAgentId).toBe(alice.id);
  expect(conn.toAgentId).toBe(bob.id);
  expect(conn.mode).toBe("handoff");
  expect(conn.status).toBe("active");
});

test("a connection is DIRECTIONAL: findActive(A→B) matches, findActive(B→A) does not", () => {
  store.createConnection(alice.id, bob.id, "handoff");
  expect(store.connections.findActive(alice.id, bob.id, "handoff")).toBeDefined();
  // The reverse direction is a separate connection that was never created.
  expect(store.connections.findActive(bob.id, alice.id, "handoff")).toBeUndefined();
});

test("connection.created is recorded on BOTH participants' logs, references only", () => {
  const conn = store.createConnection(alice.id, bob.id, "handoff");

  for (const id of [alice.id, bob.id]) {
    const created = store.events.tail(id).filter((e) => e.type === "connection.created");
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toEqual({
      connectionId: conn.id,
      fromAgentId: alice.id,
      toAgentId: bob.id,
      mode: "handoff",
    });
  }
  // A third agent's log records nothing about a connection it is not on.
  expect(store.events.tail(carol.id).filter((e) => e.type === "connection.created")).toHaveLength(0);
});

test("createConnection is idempotent — same active connection, no second event", () => {
  const first = store.createConnection(alice.id, bob.id, "handoff");
  const second = store.createConnection(alice.id, bob.id, "handoff");
  expect(second.id).toBe(first.id);
  // Exactly one connection row, and exactly one create event per log — not two.
  expect(store.listConnections(alice.id)).toHaveLength(1);
  expect(
    store.events.tail(alice.id).filter((e) => e.type === "connection.created"),
  ).toHaveLength(1);
});

test("an agent cannot connect to itself", () => {
  expect(() => store.createConnection(alice.id, alice.id, "handoff")).toThrow(
    /cannot connect to itself/,
  );
  // Nothing persisted, nothing logged.
  expect(store.listConnections(alice.id)).toHaveLength(0);
});

test("listConnections returns an agent's inbound AND outbound channels", () => {
  const out = store.createConnection(alice.id, bob.id, "handoff"); // alice → bob (alice outbound)
  const inc = store.createConnection(carol.id, alice.id, "handoff"); // carol → alice (alice inbound)

  const aliceConns = store.listConnections(alice.id).map((c) => c.id).sort();
  expect(aliceConns).toEqual([out.id, inc.id].sort());
  // Bob sees only the one it is on; carol sees only the one it is on.
  expect(store.listConnections(bob.id).map((c) => c.id)).toEqual([out.id]);
  expect(store.listConnections(carol.id).map((c) => c.id)).toEqual([inc.id]);
});

test("cross-agent denial: a third agent can neither list nor read a connection it is not on", () => {
  const conn = store.createConnection(alice.id, bob.id, "handoff");
  // Carol is on neither end.
  expect(store.listConnections(carol.id)).toHaveLength(0);
  expect(store.getConnection(carol.id, conn.id)).toBeUndefined();
  // Both participants CAN read it by id; the non-participant cannot — same scoping every
  // other entity uses (an unknown id and a foreign one are indistinguishable).
  expect(store.getConnection(alice.id, conn.id)?.id).toBe(conn.id);
  expect(store.getConnection(bob.id, conn.id)?.id).toBe(conn.id);
});

test("every scoped connection method requires an agentId", () => {
  expect(() => store.listConnections("")).toThrow(/agentId is required/);
  expect(() => store.getConnection("", "x")).toThrow(/agentId is required/);
  expect(() => store.connections.findActive("", bob.id, "handoff")).toThrow(/agentId is required/);
  expect(() => store.connections.findActive(alice.id, "", "handoff")).toThrow(/agentId is required/);
});

test("an unimplemented mode is refused at the write boundary", () => {
  // The repository validates the mode through the same enum chokepoint the kernel uses,
  // so a connection in a mode nothing consumes can never be persisted.
  expect(() => store.createConnection(alice.id, bob.id, "artifact-only" as "handoff")).toThrow(
    /invalid connection mode/,
  );
});
