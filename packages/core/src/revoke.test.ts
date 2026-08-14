// Connection revoke — withdrawing a channel that was granted (Phase 3, issue #117).
//
// Before this, a granted cross-agent permission was PERMANENT: T1 shipped the `revoked`
// status and the partial unique index designed for it, then deferred the transition. These
// tests pin the invariants of the transition itself (design note §15):
//
//   1. Revoke withdraws every capability the channel carried — `handoff`, `artifact`,
//      `fetch` (D13) and `summary` (T2b) here; a shared brief in `brief.test.ts` and a
//      delegated tool in `delegation.test.ts`, each beside the mode it belongs to. The
//      summary case is the test T2b dropped rather than fake, because producing a revoked
//      row would have meant reaching past the repository.
//
//      Stated per mode rather than as a COUNT on purpose: "all four" was true when it was
//      written and silently false one mode later, which is the defect this project keeps
//      finding in its own surfaces — a claim of completeness nothing re-checks.
//   2. Revoke is EXACT: it touches only the (from, to, mode) triple it was called for —
//      not the reverse direction, not another mode between the same pair, not another pair.
//   3. Revoke is TERMINAL, and a reconnect is a fresh row over which the OLD artifact
//      references do not resolve (D20). This is what the connection-row keying actually
//      buys — a revoke alone is refused earlier, at the active-connection read.
//   4. Both event logs record `connection.revoked` as content-free references (D21).
//
// The resume half of the same seam — what a revoke does to work already in flight — is in
// `resume-exchange.test.ts`.

import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  performArtifactExchange,
  performArtifactFetch,
  performHandoff,
  performSummaryExchange,
} from "./run.js";
import type { ArtifactFetchHost } from "./run.js";
import { AsterismStore } from "./store.js";
import type { RuntimeAdapter, RunOutput, ToolResult } from "./adapter.js";
import type { Capability } from "./trust.js";
import type { Agent } from "./types.js";

const ARTIFACT_PATH = "drafts/market.md";
const ARTIFACT_REF = `file:${ARTIFACT_PATH}`;
const ARTIFACT_BYTES = 4300;
const CALLEE_PROSE = "HELPER PROSE — the whole point of the mode, and it must not cross";

let store: AsterismStore;
let writer: Agent; // the caller
let helper: Agent; // the callee
let outsider: Agent; // on no channel at all

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  writer = store.createAgent({
    name: "writer",
    role: "drafts",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/writer",
    trustLevel: "autonomous",
  });
  helper = store.createAgent({
    name: "helper",
    role: "researches",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/helper",
    trustLevel: "autonomous",
  });
  outsider = store.createAgent({
    name: "outsider",
    role: "unrelated",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/outsider",
    trustLevel: "autonomous",
  });
});

afterEach(() => {
  store.close();
});

// --- Fixtures ---------------------------------------------------------------

/** A write tool that declares the artifact it produced — the T1 observation seam. */
function writeCapability(): Capability {
  return {
    key: "fs.write",
    effect: "write",
    tool: {
      name: "write_file",
      description: "write a file",
      inputSchema: { type: "object", properties: {} },
      execute: (): ToolResult => ({
        output: `wrote ${ARTIFACT_BYTES} bytes`,
        observation: {
          schema: "asterism.fs.write@1",
          facts: [
            { subject: ARTIFACT_REF, relation: "size_bytes", object: ARTIFACT_BYTES },
            { subject: ARTIFACT_REF, relation: "exists", object: true },
          ],
        },
      }),
    },
  };
}

function sequenceAdapter(steps: readonly { tool: string }[]): RuntimeAdapter {
  return {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        for (const step of steps) {
          if (request.signal?.aborted) break;
          const tool = request.tools.list().find((t) => t.name === step.tool);
          if (!tool) continue;
          const result = await tool.execute({ args: {} }, request.signal);
          if (result.isError) break;
        }
        return { status: "done", text: "HELPER PROSE — never crosses" };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
}

/** A host that would happily copy the artifact — so a refusal is the kernel's, not its. */
function fakeHost(log: { inspected: number }): ArtifactFetchHost {
  return {
    inspect: (request) => {
      log.inspected += 1;
      if (request.path !== ARTIFACT_PATH) return { ok: false, reason: "ENOENT" };
      // mtime at the epoch: far enough in the past that the staleness check always passes,
      // so nothing below can be refused for a reason other than the one under test.
      return { ok: true, sizeBytes: ARTIFACT_BYTES, modifiedAtMs: 0, destExists: false };
    },
    materialize: () => ({ ok: true, bytes: ARTIFACT_BYTES }),
  };
}

/** Run a real artifact exchange so there is a recorded, fetchable manifest. */
async function exchangeArtifact(): Promise<void> {
  const outcome = await performArtifactExchange(store, writer, helper, "draft it", {
    adapter: sequenceAdapter([{ tool: "write_file" }]),
    capabilities: [writeCapability()],
  });
  expect(outcome.kind).toBe("ok");
}

// --- Invariant 1: revoke withdraws the capabilities this file covers ---------

test("revoke withdraws HANDOFF-ability: the callee can no longer be asked to run work", async () => {
  store.createConnection(writer.id, helper.id, "handoff");
  const before = await performHandoff(store, writer, helper, "do it", {
    adapter: sequenceAdapter([]),
  });
  expect(before.kind).toBe("ok");

  expect(store.revokeConnection(writer.id, helper.id, "handoff")?.status).toBe("revoked");

  const after = await performHandoff(store, writer, helper, "do it again", {
    adapter: sequenceAdapter([]),
  });
  expect(after.kind).toBe("no_connection");
  // Nothing ran: the callee has no second run, so the refusal precedes the substrate.
  expect(store.runs.list(helper.id)).toHaveLength(1);
});

test("revoke withdraws ARTIFACT exchange", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeArtifact();

  store.revokeConnection(writer.id, helper.id, "artifact-only");

  const after = await performArtifactExchange(store, writer, helper, "draft again", {
    adapter: sequenceAdapter([{ tool: "write_file" }]),
    capabilities: [writeCapability()],
  });
  expect(after.kind).toBe("no_connection");
});

test("revoke withdraws FETCHABILITY of everything already exchanged over the channel", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeArtifact();

  // The reference resolves while the channel is open.
  const before = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost({ inspected: 0 }),
    confirm: () => true,
  });
  expect(before.kind).toBe("ok");

  store.revokeConnection(writer.id, helper.id, "artifact-only");

  // ...and stops the moment it is withdrawn — for an artifact that ALREADY crossed. The
  // exchange row still exists; what changed is that nothing authorizes resolving it.
  const log = { inspected: 0 };
  const after = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(after.kind).toBe("no_connection");
  // The filesystem was never even consulted — the refusal precedes any host contact.
  expect(log.inspected).toBe(0);
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(1);
});

test("revoke withdraws READABILITY of ratified memory (the test T2b dropped)", () => {
  store.createConnection(writer.id, helper.id, "read-summary");
  store.recordMemory(helper.id, {
    memoryType: "semantic",
    content: "the client prefers short paragraphs",
    confidence: 0.9,
    reviewState: "accepted",
  });

  const before = performSummaryExchange(store, writer, helper);
  expect(before.kind).toBe("ok");
  if (before.kind === "ok") expect(before.result.items.length).toBeGreaterThan(0);

  store.revokeConnection(writer.id, helper.id, "read-summary");

  // A read-summary grant means "read my other agent's accepted memory, repeatedly,
  // indefinitely" — so this is the sharpest of the four, and the one that most needed a
  // way out. The callee's memory is untouched; it is simply no longer readable across.
  const after = performSummaryExchange(store, writer, helper);
  expect(after.kind).toBe("no_connection");
  expect(store.memories.listActiveAccepted(helper.id)).toHaveLength(1);
});

// --- Invariant 1b: the withdrawal beats work already in progress ------------

test("a revoke landing DURING the fetch confirmation stops the bytes [Codex R1 P2]", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeArtifact();

  const log = { inspected: 0 };
  const materialized: string[] = [];
  const host: ArtifactFetchHost = {
    ...fakeHost(log),
    materialize: (request) => {
      materialized.push(request.path);
      return { ok: true, bytes: ARTIFACT_BYTES };
    },
  };

  // A confirmation is human-length, and the operator on the other side withdraws the channel
  // while the prompt is open. Before the fix the fetch trusted the connection it had read
  // BEFORE the pause: bytes crossed, and `artifact.fetched` was logged on both agents' logs
  // AFTER `connection.revoked` — the revoke failing to withdraw fetchability for exactly the
  // fetch that was in flight.
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host,
    confirm: () => {
      store.revokeConnection(writer.id, helper.id, "artifact-only");
      return true;
    },
  });

  expect(outcome.kind).toBe("no_connection");
  expect(materialized).toHaveLength(0);
  for (const id of [writer.id, helper.id]) {
    expect(store.events.tail(id).filter((e) => e.type === "artifact.fetched")).toHaveLength(0);
  }
});

test("a revoke AND reconnect during the confirmation still stops the bytes", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeArtifact();

  const materialized: string[] = [];
  const host: ArtifactFetchHost = {
    ...fakeHost({ inspected: 0 }),
    materialize: (request) => {
      materialized.push(request.path);
      return { ok: true, bytes: ARTIFACT_BYTES };
    },
  };

  // The re-check compares the connection's IDENTITY, not merely "some active channel
  // exists" — otherwise a revoke followed by a reconnect inside the prompt would leave a
  // fresh channel active and launder a reference the revoke had withdrawn, which is exactly
  // what D20 says a new channel must not inherit.
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host,
    confirm: () => {
      store.revokeConnection(writer.id, helper.id, "artifact-only");
      store.createConnection(writer.id, helper.id, "artifact-only");
      return true;
    },
  });

  // `not_exchanged`, not `no_connection`: a channel IS active — a fresh one — and it carries
  // none of the old channel's references, so that is exactly what re-running the command now
  // answers. Reporting "no connection" would have told the operator to open a channel that
  // was open, which is advice for a recovery the state does not need. What matters for the
  // invariant is unchanged and asserted below: nothing crossed.
  expect(outcome.kind).toBe("not_exchanged");
  expect(materialized).toHaveLength(0);

  // The property behind the choice, stated rather than implied: a refusal that arrives
  // mid-pause reads the same as the refusal a fresh attempt gives.
  const fresh = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host,
    confirm: () => true,
  });
  expect(fresh.kind).toBe(outcome.kind);
  expect(materialized).toHaveLength(0);
});

/** An adapter that withdraws the channel MID-RUN, then produces the callee's text. */
function revokingAdapter(mode: "handoff" | "artifact-only"): RuntimeAdapter {
  return {
    run: (request) => {
      const output = (async () => {
        const tool = request.tools.list().find((t) => t.name === "write_file");
        if (tool) await tool.execute({ args: {} }, request.signal);
        store.revokeConnection(writer.id, helper.id, mode);
        return { status: "done" as const, text: CALLEE_PROSE };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
}

test("a revoke landing DURING an artifact run withholds BOTH the manifest and the record", async () => {
  const connection = store.createConnection(writer.id, helper.id, "artifact-only");

  // A run is the longest window in the phase, and the crossing happens when the work is
  // handed back — not when the operator typed the command. So the grant is re-read before
  // anything is projected, the same as before a fetch moves bytes.
  const outcome = await performArtifactExchange(store, writer, helper, "draft it", {
    adapter: revokingAdapter("artifact-only"),
    capabilities: [writeCapability()],
  });

  // NOT `ok`: the manifest is a list of the callee's filenames, which is exactly what this
  // mode exists to control — so it does not come back over a channel that no longer exists.
  // (An earlier version of this test asserted the manifest still crossed, on the reasoning
  // that the operator had asked for the work. That preserved the old behaviour rather than
  // deciding it, and left the returned half laxer than the recorded half. [Codex R3 P2.])
  expect(outcome.kind).toBe("withdrawn");
  if (outcome.kind === "withdrawn") {
    // The work is not lost, and the callee's own operator can still read it.
    expect(outcome.status).toBe("done");
    expect(store.runs.get(helper.id, outcome.runId)?.status).toBe("done");
  }
  // Nor is anything resolvable later.
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(0);
  expect(store.getConnection(writer.id, connection.id)?.status).toBe("revoked");
});

test("a revoke landing DURING a handoff run withholds the callee's TEXT", async () => {
  store.createConnection(writer.id, helper.id, "handoff");

  const outcome = await performHandoff(store, writer, helper, "do it", {
    adapter: revokingAdapter("handoff"),
    capabilities: [writeCapability()],
  });

  // `handoff` has no durable record to suppress instead — its projection IS its crossing, so
  // returning the text anyway would make a revoke a no-op for the exchange in flight.
  expect(outcome.kind).toBe("withdrawn");
  if (outcome.kind === "withdrawn") {
    expect(JSON.stringify(outcome)).not.toContain(CALLEE_PROSE);
    expect(store.runs.get(helper.id, outcome.runId)?.status).toBe("done");
  }
  // The audit is still honest on both logs: the exchange was requested, and the callee ran.
  for (const id of [writer.id, helper.id]) {
    const types = store.events.tail(id).map((e) => e.type);
    expect(types).toContain("handoff.requested");
    expect(types).toContain("handoff.completed");
    expect(types).toContain("connection.revoked");
    // ...and carries none of the callee's words.
    expect(JSON.stringify(store.events.tail(id))).not.toContain(CALLEE_PROSE);
  }
});

test("a revoke landing BEFORE the run starts is a clean refusal, not an internal error", async () => {
  store.createConnection(writer.id, helper.id, "handoff");

  // The narrowest window in the flow: AFTER the permission read has succeeded and BEFORE the
  // callee's run row exists. Another operator's `disconnect` can land exactly there, so the
  // revoke is injected between the two reads rather than before either — revoking up front
  // would be caught by the first check and would exercise nothing.
  const realFindActive = store.connections.findActive.bind(store.connections);
  let reads = 0;
  store.connections.findActive = (f, t, m) => {
    const found = realFindActive(f, t, m);
    // Let the permission read succeed, then withdraw before anyone can act on it.
    if (++reads === 1) store.revokeConnection(writer.id, helper.id, "handoff");
    return found;
  };
  let emitted = 0;
  const realEmit = store.recordHandoffRequested.bind(store);
  store.recordHandoffRequested = (c) => {
    emitted += 1;
    realEmit(c);
  };

  // A legitimate concurrent revoke must resolve to the outcome this flow already models —
  // an internal error message would be the surface admitting it has no answer for a race the
  // operator caused on purpose. [Codex R4 P2.]
  const outcome = await performHandoff(store, writer, helper, "do it", {
    adapter: sequenceAdapter([]),
  });
  expect(outcome.kind).toBe("no_connection");
  // Nothing ran, and — because the run row is created BEFORE the audit — nothing was logged
  // either. An earlier ordering could strand `handoff.requested` with no completion, an event
  // pair describing an exchange that never began.
  expect(store.runs.list(helper.id)).toHaveLength(0);
  expect(emitted).toBe(0);
  for (const id of [writer.id, helper.id]) {
    expect(store.events.tail(id).filter((e) => e.type === "handoff.requested")).toHaveLength(0);
  }
});

test("a reconnect DURING the run does not stand in for the channel that asked", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const outcome = await performArtifactExchange(store, writer, helper, "draft it", {
    adapter: {
      run: (request) => {
        const output = (async () => {
          const tool = request.tools.list().find((t) => t.name === "write_file");
          if (tool) await tool.execute({ args: {} }, request.signal);
          store.revokeConnection(writer.id, helper.id, "artifact-only");
          store.createConnection(writer.id, helper.id, "artifact-only");
          return { status: "done" as const, text: CALLEE_PROSE };
        })();
        async function* noEvents() {}
        return { events: noEvents(), output };
      },
    },
    capabilities: [writeCapability()],
  });

  // A channel is active again, so an existence check would pass — but a fresh grant did not
  // ask for this work and does not inherit its crossing (D20). Identity is what is compared.
  expect(outcome.kind).toBe("withdrawn");
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(0);
});

// --- Invariant 2: revoke is exact ------------------------------------------

test("revoke is DIRECTIONAL: withdrawing A→B leaves B→A untouched", () => {
  store.createConnection(writer.id, helper.id, "handoff");
  const reverse = store.createConnection(helper.id, writer.id, "handoff");

  store.revokeConnection(writer.id, helper.id, "handoff");

  expect(store.connections.findActive(writer.id, helper.id, "handoff")).toBeUndefined();
  expect(store.connections.findActive(helper.id, writer.id, "handoff")?.id).toBe(reverse.id);
});

test("revoke is MODE-SPECIFIC: withdrawing one mode leaves the pair's other channels open", () => {
  store.createConnection(writer.id, helper.id, "handoff");
  store.createConnection(writer.id, helper.id, "artifact-only");
  store.createConnection(writer.id, helper.id, "read-summary");

  store.revokeConnection(writer.id, helper.id, "artifact-only");

  expect(store.connections.findActive(writer.id, helper.id, "artifact-only")).toBeUndefined();
  expect(store.connections.findActive(writer.id, helper.id, "handoff")).toBeDefined();
  expect(store.connections.findActive(writer.id, helper.id, "read-summary")).toBeDefined();
  expect(store.listActiveConnectionsForPair(writer.id, helper.id).map((c) => c.mode).sort()).toEqual(
    ["handoff", "read-summary"],
  );
});

test("revoke is PAIR-SPECIFIC: another pair's identical channel is untouched", () => {
  store.createConnection(writer.id, helper.id, "handoff");
  const other = store.createConnection(writer.id, outsider.id, "handoff");

  store.revokeConnection(writer.id, helper.id, "handoff");

  expect(store.connections.findActive(writer.id, outsider.id, "handoff")?.id).toBe(other.id);
});

test("revoking a channel that is not open is a no-op — no row, no event", () => {
  // Never connected at all.
  expect(store.revokeConnection(writer.id, helper.id, "handoff")).toBeUndefined();

  // Connected, revoked, then revoked AGAIN: the second is a clean no-op rather than a
  // second withdrawal in the audit. The CAS (`WHERE status = 'active'`) is what makes this
  // true for two concurrent revokes as well — exactly one UPDATE can match the row.
  store.createConnection(writer.id, helper.id, "handoff");
  expect(store.revokeConnection(writer.id, helper.id, "handoff")).toBeDefined();
  expect(store.revokeConnection(writer.id, helper.id, "handoff")).toBeUndefined();

  for (const id of [writer.id, helper.id]) {
    expect(store.events.tail(id).filter((e) => e.type === "connection.revoked")).toHaveLength(1);
  }
});

test("a mode outside the enum is refused at the revoke write boundary", () => {
  // Named `delegated-tool` until T3b made that mode real. The property is the enum's, not
  // any particular absent mode's — see the twin assertion in `connections.test.ts`.
  expect(() =>
    // @ts-expect-error deliberately outside the enum — the storage layer never trusts the type
    store.revokeConnection(writer.id, helper.id, "delegated_tool"),
  ).toThrow(/invalid connection mode/);
});

test("every scoped revoke path requires both agent ids", () => {
  expect(() => store.revokeConnection("", helper.id, "handoff")).toThrow();
  expect(() => store.revokeConnection(writer.id, "", "handoff")).toThrow();
  expect(() => store.listActiveConnectionsForPair("", helper.id)).toThrow();
  expect(() => store.listActiveConnectionsForPair(writer.id, "")).toThrow();
});

// --- Invariant 3: terminal, and a reconnect is a fresh row ------------------

test("revoke is TERMINAL: a reconnect mints a FRESH row, leaving the revoked one intact", () => {
  const first = store.createConnection(writer.id, helper.id, "handoff");
  store.revokeConnection(writer.id, helper.id, "handoff");

  const second = store.createConnection(writer.id, helper.id, "handoff");
  expect(second.id).not.toBe(first.id);
  expect(second.status).toBe("active");

  // Both rows coexist — the partial unique index is on ACTIVE rows only, so history is kept
  // rather than overwritten. There is no transition back: the old row stays revoked.
  const all = store.listConnections(writer.id);
  expect(all).toHaveLength(2);
  expect(store.getConnection(writer.id, first.id)?.status).toBe("revoked");
});

test("old artifact references do NOT travel to a reconnected channel", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeArtifact();
  store.revokeConnection(writer.id, helper.id, "artifact-only");

  // Reconnect: a fresh, fully valid, active artifact-only channel between the same pair.
  store.createConnection(writer.id, helper.id, "artifact-only");

  // THIS is what keying authorization on the connection ROW actually buys. The revoke alone
  // is refused earlier (`no_connection`, at the active-connection read). Here the connection
  // read SUCCEEDS — and the reference still does not resolve, because the exchange row is
  // keyed on the connection that was withdrawn. So a caller cannot recover what a revoke
  // took away by simply asking the operator to reconnect.
  const log = { inspected: 0 };
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("not_exchanged");
  expect(log.inspected).toBe(0);
});

test("a reconnected channel carries its own new exchanges normally", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeArtifact();
  store.revokeConnection(writer.id, helper.id, "artifact-only");
  store.createConnection(writer.id, helper.id, "artifact-only");

  // The withdrawal is of the old channel, not a penalty on the pair: a fresh exchange over
  // the new connection is fetchable exactly as any other would be.
  await exchangeArtifact();
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost({ inspected: 0 }),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("ok");
});

// --- Invariant 4: the audit ------------------------------------------------

test("connection.revoked is recorded on BOTH participants' logs, references only", () => {
  const conn = store.createConnection(writer.id, helper.id, "artifact-only");
  store.revokeConnection(writer.id, helper.id, "artifact-only");

  for (const id of [writer.id, helper.id]) {
    const revoked = store.events.tail(id).filter((e) => e.type === "connection.revoked");
    expect(revoked).toHaveLength(1);
    // References only — the same payload shape as `connection.created`, and nothing that
    // could carry content across the boundary the revoke just closed.
    expect(revoked[0]!.payload).toEqual({
      connectionId: conn.id,
      fromAgentId: writer.id,
      toAgentId: helper.id,
      mode: "artifact-only",
    });
  }
  // ...and on nobody else's.
  expect(store.events.tail(outsider.id).filter((e) => e.type === "connection.revoked")).toHaveLength(
    0,
  );
});

// --- Cross-agent denial across the whole transition -------------------------

test("cross-agent denial: a third agent can neither see nor reach a revoked channel", () => {
  const conn = store.createConnection(writer.id, helper.id, "handoff");
  store.revokeConnection(writer.id, helper.id, "handoff");

  // The revoked row is history the PARTICIPANTS keep — not something a third agent can read,
  // exactly as when it was active. A revoke changes what a channel permits, never who may
  // see that the channel existed.
  expect(store.getConnection(outsider.id, conn.id)).toBeUndefined();
  expect(store.listConnections(outsider.id)).toHaveLength(0);
  expect(store.getConnection(writer.id, conn.id)?.status).toBe("revoked");
  expect(store.getConnection(helper.id, conn.id)?.status).toBe("revoked");
});

test("a revoked channel cannot be reached through a third agent's own connection", async () => {
  // outsider → helper is open; writer → helper has been withdrawn. The open channel must not
  // become a route to what the withdrawn one used to allow.
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeArtifact();
  store.revokeConnection(writer.id, helper.id, "artifact-only");
  store.createConnection(outsider.id, helper.id, "artifact-only");

  const log = { inspected: 0 };
  const outcome = await performArtifactFetch(store, outsider, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  // outsider holds an active channel to the same callee, so the connection read succeeds —
  // and the reference still misses, because it crossed a connection outsider was never on.
  expect(outcome.kind).toBe("not_exchanged");
  expect(log.inspected).toBe(0);
});
