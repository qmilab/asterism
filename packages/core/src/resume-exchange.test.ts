// Resuming an exchange-originated run — what a revoke does to work already in flight, and
// what a confirm records (issues #117 / #114, design note §15 D19/D21).
//
// `asterism confirm` drives `resumeRun` directly, not the exchange op, so before this slice
// the kernel could not tell an exchange's callee run from any other. Two questions were
// therefore unanswered, and they are the same seam:
//
//   - does a resume respect a connection revoked in the meantime?
//   - does a resume record what the callee produced after the confirmation?
//
// The settled answer (D19): the run ALWAYS resumes — a connection is permission for a
// crossing, not a lease on the callee's execution, and a revoke must never strand a run
// parked at the callee's own gate. What a revoke withdraws is the CROSSING: the resumed run
// records nothing back over a withdrawn channel.
//
// One property here is a FIX, not just a gap closed. A resume re-enters the loop from the
// start, so the callee's ordinary writes run again and each file's mtime moves past the
// `created_at` its exchange row recorded — after which the fetch staleness check refuses it.
// So before this slice, confirming a paused exchange did not merely fail to record new
// artifacts: it silently un-fetched the ones that had already crossed.

import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  declineRun,
  executeRun,
  performArtifactExchange,
  performArtifactFetch,
  performHandoff,
  resumeRun,
} from "./run.js";
import type { ArtifactFetchHost } from "./run.js";
import { openDatabase } from "./db/index.js";
import { AsterismStore } from "./store.js";
import type { RuntimeAdapter, RunOutput, ToolResult } from "./adapter.js";
import type { Capability } from "./trust.js";
import type { Agent } from "./types.js";

const ARTIFACT_PATH = "drafts/market.md";
const ARTIFACT_REF = `file:${ARTIFACT_PATH}`;
const LATE_PATH = "drafts/final.md";
const LATE_REF = `file:${LATE_PATH}`;
const BYTES = 4300;

let store: AsterismStore;
let writer: Agent; // the caller
let helper: Agent; // the callee — pauses on its own destructive gate

/** The callee's workspace as the host stand-in models it: size + last write, in epoch ms. */
const sourceFiles = new Map<string, { size: number; modifiedAtMs: number }>();

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  sourceFiles.clear();
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
});

afterEach(() => {
  store.close();
});

// --- Fixtures ---------------------------------------------------------------

/**
 * A write tool that stamps a REALISTIC mtime into the shared source map on every call — so
 * a resume's re-execution moves the file's timestamp exactly as a real filesystem would.
 * Modelling that faithfully is the whole point: a stand-in that froze mtime would hide the
 * staleness interaction this file exists to pin.
 */
function writeCapability(path: string): Capability {
  return {
    key: `fs.write.${path}`,
    effect: "write",
    tool: {
      name: `write_${path.replace(/\W/g, "_")}`,
      description: "write a file",
      inputSchema: { type: "object", properties: {} },
      execute: (): ToolResult => {
        sourceFiles.set(path, { size: BYTES, modifiedAtMs: Date.now() });
        return {
          output: `wrote ${BYTES} bytes`,
          observation: {
            schema: "asterism.fs.write@1",
            facts: [
              { subject: `file:${path}`, relation: "size_bytes", object: BYTES },
              { subject: `file:${path}`, relation: "exists", object: true },
            ],
          },
        };
      },
    },
  };
}

/** The destructive step the callee's own gate parks on. */
function deleteCapability(): Capability {
  return {
    key: "fs.delete",
    effect: "destructive",
    tool: {
      name: "delete_file",
      description: "delete a file",
      inputSchema: { type: "object", properties: {} },
      execute: (): ToolResult => ({
        output: "deleted",
        observation: {
          schema: "asterism.fs.delete@1",
          facts: [{ subject: "file:dist/generated.js", relation: "exists", object: false }],
        },
      }),
    },
  };
}

function sequenceAdapter(tools: readonly string[]): RuntimeAdapter {
  return {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        for (const name of tools) {
          if (request.signal?.aborted) break;
          const tool = request.tools.list().find((t) => t.name === name);
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

function fetchHost(): ArtifactFetchHost {
  return {
    inspect: (request) => {
      const source = sourceFiles.get(request.path);
      if (!source) return { ok: false, reason: `cannot read '${request.path}' (ENOENT).` };
      return {
        ok: true,
        sizeBytes: source.size,
        modifiedAtMs: source.modifiedAtMs,
        destExists: false,
      };
    },
    materialize: (request) => {
      const source = sourceFiles.get(request.path);
      if (!source) return { ok: false, reason: "gone" };
      // Mirrors the real host's re-check at the read, INCLUDING the floor to whole
      // milliseconds — a mirror that disagreed would refuse what the kernel allows.
      if (
        source.size !== request.expect.sizeBytes ||
        Math.floor(source.modifiedAtMs) > request.expect.notModifiedAfterMs
      ) {
        return { ok: false, reason: "changed while being fetched" };
      }
      return { ok: true, bytes: source.size };
    },
  };
}

/**
 * The scenario every test below shares: an artifact exchange in which the callee writes one
 * artifact, then parks on a destructive action. No `confirm` hook, so the gate pauses it —
 * the safe default for a non-interactive caller.
 *
 * The callee then writes a SECOND artifact on resume (`LATE_PATH`), which is the artifact
 * #114 is about: produced after the confirmation, so before this slice it crossed nowhere.
 */
async function pausedExchange(): Promise<string> {
  const outcome = await performArtifactExchange(store, writer, helper, "draft it and clean dist/", {
    adapter: sequenceAdapter([`write_${ARTIFACT_PATH.replace(/\W/g, "_")}`, "delete_file"]),
    capabilities: [writeCapability(ARTIFACT_PATH), deleteCapability()],
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error("unreachable");
  expect(outcome.result.status).toBe("awaiting_confirmation");
  return outcome.result.runId;
}

/** The callee's operator confirms; the resumed run also produces the late artifact. */
function confirmIt(runId: string) {
  return resumeRun(store, helper, runId, {
    adapter: sequenceAdapter([
      `write_${ARTIFACT_PATH.replace(/\W/g, "_")}`,
      "delete_file",
      `write_${LATE_PATH.replace(/\W/g, "_")}`,
    ]),
    capabilities: [writeCapability(ARTIFACT_PATH), deleteCapability(), writeCapability(LATE_PATH)],
    confirm: () => true,
  });
}

const fetched = (ref: string) =>
  performArtifactFetch(store, writer, helper, ref, { host: fetchHost(), confirm: () => true });

// --- The stamp --------------------------------------------------------------

test("an exchange stamps the callee's run with the connection that asked for it", async () => {
  const connection = store.createConnection(writer.id, helper.id, "artifact-only");
  const runId = await pausedExchange();
  expect(store.runs.get(helper.id, runId)?.exchangeConnectionId).toBe(connection.id);
});

test("an ORDINARY run carries no stamp, and no surface can give it one", async () => {
  // The stamp is not on ExecuteRunOptions, so there is no way for a caller of `executeRun`
  // to mark a run as exchange-originated — which is what keeps a surface bug from becoming a
  // permission bug (a confirm recording a crossing no exchange authorized).
  store.createConnection(writer.id, helper.id, "artifact-only");
  const result = await executeRun(store, helper, "just do this", {
    adapter: sequenceAdapter([`write_${ARTIFACT_PATH.replace(/\W/g, "_")}`]),
    capabilities: [writeCapability(ARTIFACT_PATH)],
  });
  expect(store.runs.get(helper.id, result.run.id)?.exchangeConnectionId).toBeUndefined();
  // ...and confirming such a run records no crossing (there is nothing to resume here, so
  // the direct check on the row is the assertion — no exchange row exists either way).
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(0);
});

// --- D19: the connection is ACTIVE at confirm time --------------------------

test("confirming a paused exchange records the LATE artifact, making it fetchable (#114)", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const runId = await pausedExchange();

  // Before the confirm the late artifact does not exist, so nothing can resolve it.
  expect((await fetched(LATE_REF)).kind).toBe("not_exchanged");

  const resumed = await confirmIt(runId);
  expect(resumed.kind).toBe("resumed");
  if (resumed.kind === "resumed") expect(resumed.result.status).toBe("done");

  // The artifact the callee produced AFTER the confirmation now crosses as a reference and
  // resolves. Before this slice the operator's only recourse was to re-run the whole task.
  expect((await fetched(LATE_REF)).kind).toBe("ok");
});

test("confirming also REFRESHES the pre-pause references a resume would otherwise break", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const runId = await pausedExchange();

  // Fetchable at the pause: this is the manifest the caller was already handed.
  expect((await fetched(ARTIFACT_REF)).kind).toBe("ok");

  // A real confirmation is human-length, and the resume re-runs the callee's ordinary
  // writes — so the file is rewritten and its mtime moves past the original row's
  // `created_at`. Without the resume recording, the staleness check would then refuse a
  // reference that had already legitimately crossed.
  await new Promise((r) => setTimeout(r, 15));
  await confirmIt(runId);

  expect((await fetched(ARTIFACT_REF)).kind).toBe("ok");
  // Recorded rather than mutated: `exchanges` is append-only, so the refreshed row is a NEW
  // one and `findLatest` resolves by recency. The history of what crossed stays intact.
  const rows = store.exchanges.listForAgent(writer.id).filter((r) => r.ref === ARTIFACT_REF);
  expect(rows.length).toBe(2);
});

// --- D19: the connection is REVOKED at confirm time -------------------------

test("a revoke does not strand a paused run: the callee's operator can still confirm it", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const runId = await pausedExchange();

  store.revokeConnection(writer.id, helper.id, "artifact-only");

  // The paused run is the CALLEE's own work, in its own workspace, stopped at its own
  // destructive-action gate — and golden rule 4 puts that confirmation with the callee's
  // operator. A revoke on the caller's side must never be able to take it away.
  const resumed = await confirmIt(runId);
  expect(resumed.kind).toBe("resumed");
  if (resumed.kind === "resumed") expect(resumed.result.status).toBe("done");
});

test("...but nothing it produces afterwards crosses the withdrawn channel", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const runId = await pausedExchange();
  const before = store.exchanges.listForAgent(writer.id).length;

  store.revokeConnection(writer.id, helper.id, "artifact-only");
  await confirmIt(runId);

  // No new rows at all: not the late artifact, and not a refresh of the pre-pause ones.
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(before);
  expect((await fetched(LATE_REF)).kind).toBe("no_connection");
});

test("the grant is re-read AFTER the run, so a revoke landing mid-confirm is caught", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const runId = await pausedExchange();
  const before = store.exchanges.listForAgent(writer.id).length;

  // The connection is active when the confirm STARTS and withdrawn by the time the run
  // ends — the shape of a revoke landing during a long model call. The check that matters
  // is at the moment a crossing would be recorded, mirroring how `performArtifactFetch`
  // reads the connection when the bytes would move rather than when they were made.
  const resumed = await resumeRun(store, helper, runId, {
    adapter: {
      run: (request) => {
        const output = (async (): Promise<RunOutput> => {
          store.revokeConnection(writer.id, helper.id, "artifact-only");
          const tool = request.tools
            .list()
            .find((t) => t.name === `write_${LATE_PATH.replace(/\W/g, "_")}`);
          if (tool) await tool.execute({ args: {} }, request.signal);
          return { status: "done", text: "done" };
        })();
        async function* noEvents() {}
        return { events: noEvents(), output };
      },
    },
    capabilities: [writeCapability(LATE_PATH)],
    confirm: () => true,
  });

  expect(resumed.kind).toBe("resumed");
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(before);
});

test("a reconnect between exchange and confirm does not revive the crossing", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const runId = await pausedExchange();
  store.revokeConnection(writer.id, helper.id, "artifact-only");
  // A brand-new active channel between the same pair, in the same mode.
  store.createConnection(writer.id, helper.id, "artifact-only");
  const before = store.exchanges.listForAgent(writer.id).length;

  await confirmIt(runId);

  // The run is stamped with the connection that ASKED for it, and that one is revoked. A
  // fresh channel is a different grant — it did not request this work and does not inherit
  // its crossing, exactly as it does not inherit the old channel's references (D20).
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(before);
  expect((await fetched(LATE_REF)).kind).toBe("not_exchanged");
});

// --- D21: the completion the caller's log never got -------------------------

test("a resumed exchange emits handoff.completed with the FINAL status, on both logs", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const runId = await pausedExchange();
  await confirmIt(runId);

  for (const id of [writer.id, helper.id]) {
    const completed = store.events
      .tail(id)
      .filter((e) => e.type === "handoff.completed")
      .map((e) => (e.payload as { status: string }).status);
    // Two rows for one run, with different statuses, is the honest reading: it paused, then
    // it finished. Before this, the caller's log ended on the pause forever.
    expect(completed).toEqual(["awaiting_confirmation", "done"]);
  }
});

test("the completion is emitted even when the channel was revoked", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const runId = await pausedExchange();
  store.revokeConnection(writer.id, helper.id, "artifact-only");
  await confirmIt(runId);

  // Content-free audit of what became of a run. An operator who revoked must not end up
  // seeing LESS history than one who did not — a revoke withdraws what may cross, never what
  // may be recorded about the past.
  for (const id of [writer.id, helper.id]) {
    const completed = store.events
      .tail(id)
      .filter((e) => e.type === "handoff.completed")
      .map((e) => (e.payload as { status: string }).status);
    expect(completed).toEqual(["awaiting_confirmation", "done"]);
  }
});

test("a run that re-pauses emits awaiting_confirmation again and records no crossing", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const runId = await pausedExchange();

  // Resume with a SECOND destructive action and no confirm hook for it: the run clears the
  // first gate and parks on the next one.
  const resumed = await resumeRun(store, helper, runId, {
    adapter: sequenceAdapter(["delete_file", "delete_other"]),
    capabilities: [
      deleteCapability(),
      {
        key: "fs.delete.other",
        effect: "destructive",
        tool: {
          name: "delete_other",
          description: "delete another file",
          inputSchema: { type: "object", properties: {} },
          execute: (): ToolResult => ({ output: "deleted" }),
        },
      },
    ],
  });
  expect(resumed.kind).toBe("resumed");
  if (resumed.kind === "resumed") expect(resumed.result.status).toBe("awaiting_confirmation");

  const statuses = store.events
    .tail(writer.id)
    .filter((e) => e.type === "handoff.completed")
    .map((e) => (e.payload as { status: string }).status);
  expect(statuses).toEqual(["awaiting_confirmation", "awaiting_confirmation"]);
});

// --- declining is the other terminal outcome, and closes the same loop -------

test("DECLINING a paused exchange records the completion as failed, and no crossing", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const runId = await pausedExchange();
  const before = store.exchanges.listForAgent(writer.id).length;

  expect(declineRun(store, helper, runId).kind).toBe("declined");

  for (const id of [writer.id, helper.id]) {
    const completed = store.events
      .tail(id)
      .filter((e) => e.type === "handoff.completed")
      .map((e) => (e.payload as { status: string }).status);
    // Without this the caller's log would end on the pause for a run that was in fact
    // resolved — the same gap a resume closes, reached through the other door.
    expect(completed).toEqual(["awaiting_confirmation", "failed"]);
  }
  // A declined run re-enters no loop and produces nothing new, so nothing crosses.
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(before);
});

test("declining an ORDINARY paused run emits no exchange audit", async () => {
  const result = await executeRun(store, helper, "clean up dist/", {
    adapter: sequenceAdapter(["delete_file"]),
    capabilities: [deleteCapability()],
  });
  expect(result.status).toBe("awaiting_confirmation");
  expect(declineRun(store, helper, result.run.id).kind).toBe("declined");
  expect(store.events.tail(helper.id).filter((e) => e.type === "handoff.completed")).toHaveLength(0);
});

// --- handoff keeps writing no rows -----------------------------------------

test("a resumed HANDOFF records the completion but still writes no exchanges row", async () => {
  store.createConnection(writer.id, helper.id, "handoff");
  const outcome = await performHandoff(store, writer, helper, "do it and clean dist/", {
    adapter: sequenceAdapter([`write_${ARTIFACT_PATH.replace(/\W/g, "_")}`, "delete_file"]),
    capabilities: [writeCapability(ARTIFACT_PATH), deleteCapability()],
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error("unreachable");
  expect(outcome.result.status).toBe("awaiting_confirmation");

  await confirmIt(outcome.result.run.id);

  // A handoff's crossing is the callee's TEXT — not a durable reference, and nothing
  // resolves it later — so it writes no row (D13). The resume must not quietly start
  // recording rows for a mode that has never had them.
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(0);
  const completed = store.events.tail(writer.id).filter((e) => e.type === "handoff.completed");
  expect(completed).toHaveLength(2);
});

// --- an existing install upgrades cleanly -----------------------------------

test("opening a pre-existing database without runs.exchange_connection_id migrates it in", () => {
  const driver = openDatabase(":memory:");
  // An older schema: a runs table created before the column existed.
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
  const migrated = new AsterismStore(driver);
  try {
    const caller = migrated.createAgent({
      name: "personal",
      role: "",
      soulRef: "casual-helper",
      workspaceDir: "/tmp/personal",
      trustLevel: "autonomous",
    });
    const callee = migrated.createAgent({
      name: "work",
      role: "",
      soulRef: "casual-helper",
      workspaceDir: "/tmp/work",
      trustLevel: "autonomous",
    });
    // The write that would throw "no such column" on the un-migrated table works...
    const connection = migrated.createConnection(caller.id, callee.id, "artifact-only");
    const run = migrated.startExchangeRun(connection, "t");
    expect(run.exchangeConnectionId).toBe(connection.id);
    // ...and an ordinary run reads as "not from an exchange", which is also the conservative
    // backfill for every run recorded before the column existed: its confirm records no
    // crossing, exactly as it already did.
    const plain = migrated.startRun(callee.id, { input: "u" });
    expect(plain.exchangeConnectionId).toBeUndefined();
  } finally {
    migrated.close();
  }
});

// --- the stamp cannot be conjured -------------------------------------------

test("the ORDINARY run path cannot express an exchange stamp at all [Codex R2 P2]", async () => {
  const connection = store.createConnection(writer.id, helper.id, "artifact-only");

  // `CreateRunInput` has no such field, so this is the whole surface a caller of `startRun`
  // has — and there is nothing on it to set. Before the fix, adding one property here was
  // enough to make an ordinary run's artifacts fetchable by the other agent.
  const run = store.startRun(helper.id, { input: "private work" });
  expect(run.exchangeConnectionId).toBeUndefined();
  expect(Object.keys(run)).not.toContain("exchangeConnectionId");
  // Passing it anyway (as untyped JS would) changes nothing — it is not read from the input.
  const sneaky = store.startRun(helper.id, {
    input: "private work",
    ...({ exchangeConnectionId: connection.id } as object),
  });
  expect(sneaky.exchangeConnectionId).toBeUndefined();
});

test("an exchange run is DERIVED from the connection, so it cannot be misattributed", () => {
  const connection = store.createConnection(writer.id, helper.id, "artifact-only");
  // The agent is never passed — it is `connection.toAgentId`, so an exchange run always
  // belongs to the callee of the channel it names.
  const run = store.startExchangeRun(connection, "do it");
  expect(run.agentId).toBe(helper.id);
  expect(store.runs.get(writer.id, run.id)).toBeUndefined();
});

test("the grant test is INSIDE the insert, so there is no window to lose [Codex R5 P2]", () => {
  const connection = store.createConnection(writer.id, helper.id, "artifact-only");

  // `startExchangeRun` used to READ the grant and then insert. Another process committing a
  // `disconnect` between those two statements got a run created and executed over a withdrawn
  // channel — demonstrated by making the read return a value already stale by insert time.
  // That probe is inert now, and the reason is the fix: the read no longer exists.
  const realFindActive = store.connections.findActive.bind(store.connections);
  let reads = 0;
  store.connections.findActive = (f, t, m) => {
    reads += 1;
    return realFindActive(f, t, m);
  };
  expect(store.startExchangeRun(connection, "do it")).toBeDefined();
  // No separate permission read to race with — the `WHERE EXISTS` inside the INSERT is the
  // whole check, so there is no instant between deciding and writing.
  expect(reads).toBe(0);
  store.connections.findActive = realFindActive;
});

test("a stale or withdrawn connection cannot start an exchange run", () => {
  const connection = store.createConnection(writer.id, helper.id, "artifact-only");
  store.revokeConnection(writer.id, helper.id, "artifact-only");
  // The connection OBJECT is still in hand and still looks active to anyone holding it; the
  // grant is re-asserted against the store, so it cannot be used after withdrawal.
  //
  // It RETURNS rather than throws: a withdrawal landing in this window is an ordinary race
  // (another operator ran `disconnect` a moment ago), and the exchange already models that
  // outcome. Throwing turned a legitimate concurrent revoke into an internal error message.
  // [Codex review R4 P2.]
  expect(store.startExchangeRun(connection, "do it")).toBeUndefined();
  // Nor can a reconnected channel's object be swapped for the old one's identity.
  store.createConnection(writer.id, helper.id, "artifact-only");
  expect(store.startExchangeRun(connection, "do it")).toBeUndefined();
  // Nothing was recorded for a run that never began.
  expect(store.runs.list(helper.id)).toHaveLength(0);
});

test("a CALLER-side run wearing the stamp records nothing on resume", async () => {
  // Defence at the read side: `getConnection` is scoped to a PARTICIPANT, so it matches the
  // caller's side too. A caller-side run wearing this stamp would otherwise record the
  // CALLER's own artifacts as though the callee had handed them over.
  const connection = store.createConnection(writer.id, helper.id, "artifact-only");
  // Reach past the store to construct the state the write path now refuses to create, so the
  // read path is proven independently of it.
  const run = store.startExchangeRun(connection, "callee work");
  store.driver.exec(
    `UPDATE runs SET agent_id = '${writer.id}', status = 'awaiting_confirmation' WHERE id = '${run.id}'`,
  );

  const resumed = await resumeRun(store, writer, run.id, {
    adapter: sequenceAdapter([`write_${ARTIFACT_PATH.replace(/\W/g, "_")}`]),
    capabilities: [writeCapability(ARTIFACT_PATH)],
    confirm: () => true,
  });
  expect(resumed.kind).toBe("resumed");
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(0);
  expect(store.events.tail(writer.id).filter((e) => e.type === "handoff.completed")).toHaveLength(
    0,
  );
});

// --- an ordinary run's resume is untouched ----------------------------------

test("resuming an ORDINARY paused run emits no exchange audit at all", async () => {
  // Nothing about the resume path may change for the overwhelmingly common case: a run the
  // operator started directly, which has no connection and no crossing.
  store.createConnection(writer.id, helper.id, "artifact-only");
  const result = await executeRun(store, helper, "clean up dist/", {
    adapter: sequenceAdapter(["delete_file"]),
    capabilities: [deleteCapability()],
  });
  expect(result.status).toBe("awaiting_confirmation");

  const resumed = await resumeRun(store, helper, result.run.id, {
    adapter: sequenceAdapter(["delete_file"]),
    capabilities: [deleteCapability()],
    confirm: () => true,
  });
  expect(resumed.kind).toBe("resumed");

  for (const id of [writer.id, helper.id]) {
    expect(store.events.tail(id).filter((e) => e.type === "handoff.completed")).toHaveLength(0);
  }
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(0);
});
