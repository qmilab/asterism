// performArtifactFetch — the deferred half of decision D8: materializing an artifact the
// callee produced INTO the caller's workspace, under the CALLER's own destructive-action
// gate. The one operation in Phase 3 where file BYTES cross an agent boundary, so it carries
// the phase's sharpest enforcement, one test per invariant (issue #110):
//
//   1. Fetching without an active `artifact-only` connection is refused — and a `handoff`
//      connection does not satisfy it, nor does the reverse direction.
//   2. Only an artifact the callee actually PRODUCED IN AN EXCHANGE can be fetched — never
//      an arbitrary path in the callee's workspace. This is the sharp one: `fetch` must not
//      become a cross-agent file-read primitive.
//   3. The CALLER's gate fires on the write, per the caller's trust — a destructive
//      classification pauses even an `autonomous` caller, and `propose` withholds entirely.
//   4. Cross-agent memory/credential denial still holds across the live connection.
//   5. Both event logs record content-free references — never file contents.
//
// The host (filesystem) side is a stand-in here: this file proves the KERNEL's decisions.
// The real host's confinement — including symlink escape on both sides — is proven against
// the real filesystem in `capabilities.test.ts`, and the whole path end-to-end in
// `artifact-fetch-acceptance.test.ts`.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { performArtifactExchange, performArtifactFetch, EXCHANGE_FETCH_KEY } from "./run.js";
import type { ArtifactFetchHost, ArtifactFetchRequest } from "./run.js";
import { AsterismStore } from "./store.js";
import type { RuntimeAdapter, RunOutput, ToolResult } from "./adapter.js";
import type { Action, Capability } from "./trust.js";
import type { Agent } from "./types.js";

const ARTIFACT_PATH = "drafts/market.md";
const ARTIFACT_REF = `file:${ARTIFACT_PATH}`;
const ARTIFACT_BYTES = 4300;
// A file that genuinely exists in the callee's workspace but was NEVER handed over. The
// stand-in host below would happily copy it — the kernel must never ask it to.
const NEVER_EXCHANGED = "private/notes.md";

let store: AsterismStore;
let writer: Agent; // the caller — autonomous, to prove even full autonomy still confirms
let helper: Agent; // the callee — produces the artifact

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  writer = store.createAgent({
    name: "writer",
    role: "drafts blog posts",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/writer",
    trustLevel: "autonomous",
  });
  helper = store.createAgent({
    name: "helper",
    role: "researches sections",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/helper",
    trustLevel: "autonomous",
  });
});

afterEach(() => {
  store.close();
});

// --- Host stand-in ----------------------------------------------------------

interface HostLog {
  inspected: ArtifactFetchRequest[];
  materialized: ArtifactFetchRequest[];
}

/**
 * A filesystem stand-in over an in-memory map of the callee's workspace. `destFiles` records
 * what the caller's workspace already holds (so the overwrite path can be exercised) and
 * receives whatever is materialized.
 */
function fakeHost(
  log: HostLog,
  sourceFiles: Map<string, number> = new Map([
    [ARTIFACT_PATH, ARTIFACT_BYTES],
    [NEVER_EXCHANGED, 99],
  ]),
  destFiles: Map<string, number> = new Map(),
): ArtifactFetchHost {
  return {
    inspect: (request) => {
      log.inspected.push(request);
      const size = sourceFiles.get(request.path);
      if (size === undefined) return { ok: false, reason: `cannot read '${request.path}' (ENOENT).` };
      return { ok: true, sizeBytes: size, destExists: destFiles.has(request.path) };
    },
    materialize: (request) => {
      log.materialized.push(request);
      const size = sourceFiles.get(request.path);
      if (size === undefined) return { ok: false, reason: `could not fetch '${request.path}'.` };
      destFiles.set(request.path, size);
      return { ok: true, bytes: size };
    },
  };
}

function emptyLog(): HostLog {
  return { inspected: [], materialized: [] };
}

// --- Producing a real exchange to fetch from --------------------------------

/** A write tool that declares the artifact it produced — the T1 observation seam. */
function writeCapability(path = ARTIFACT_PATH, bytes = ARTIFACT_BYTES): Capability {
  return {
    key: "fs.write",
    effect: "write",
    tool: {
      name: "write_file",
      description: "write a file",
      inputSchema: { type: "object", properties: {} },
      execute: (): ToolResult => ({
        output: `wrote ${bytes} bytes`,
        observation: {
          schema: "asterism.fs.write@1",
          facts: [
            { subject: `file:${path}`, relation: "size_bytes", object: bytes },
            { subject: `file:${path}`, relation: "exists", object: true },
          ],
        },
      }),
    },
  };
}

/** A delete tool that declares the artifact it removed. */
function deleteCapability(path: string): Capability {
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
          facts: [{ subject: `file:${path}`, relation: "exists", object: false }],
        },
      }),
    },
  };
}

/** A substrate stand-in that drives a fixed sequence of tool calls through the gate. */
function sequenceAdapter(steps: readonly { tool: string; args?: unknown }[]): RuntimeAdapter {
  return {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        for (const step of steps) {
          if (request.signal?.aborted) break;
          const tool = request.tools.list().find((t) => t.name === step.tool);
          if (!tool) continue;
          const result = await tool.execute({ args: step.args ?? {} }, request.signal);
          if (result.isError) break;
        }
        return { status: "done", text: "HELPER PROSE — never crosses" };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
}

/** Run a real `artifact-only` exchange so there is a recorded manifest to fetch from. */
async function exchangeProducing(
  capabilities: readonly Capability[],
  steps: readonly { tool: string; args?: unknown }[],
): Promise<void> {
  const outcome = await performArtifactExchange(store, writer, helper, "draft the section", {
    adapter: sequenceAdapter(steps),
    capabilities,
    // The callee is autonomous and auto-confirms its own destructive actions, so a delete
    // in the fixture actually happens (this is the CALLEE's gate — not the one under test).
    confirm: () => true,
  });
  expect(outcome.kind).toBe("ok");
}

/** The standard fixture: an active channel and one exchanged artifact. */
async function givenExchangedArtifact(): Promise<void> {
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeProducing([writeCapability()], [{ tool: "write_file" }]);
}

// --- Invariant 1: no connection → no fetch ----------------------------------

test("with no active artifact-only connection, a fetch is refused and no byte is read", async () => {
  // Produce the exchange, then fetch over a connection that does not exist: build the
  // recorded artifact through a live channel first, on a SEPARATE store agent pair.
  await givenExchangedArtifact();
  // A third agent with no channel of its own cannot fetch what writer was handed.
  const outsider = store.createAgent({
    name: "outsider",
    role: "unrelated",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/outsider",
    trustLevel: "autonomous",
  });
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, outsider, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("no_connection");
  // Nothing was even looked at: the refusal precedes any filesystem contact.
  expect(log.inspected).toHaveLength(0);
  expect(log.materialized).toHaveLength(0);
});

test("a handoff-mode connection does not authorize a fetch (modes are distinct permissions)", async () => {
  await givenExchangedArtifact();
  // A second, genuinely active channel between the same pair — in the wrong mode.
  store.createConnection(helper.id, writer.id, "handoff");
  const other = store.createAgent({
    name: "other",
    role: "unrelated",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/other",
    trustLevel: "autonomous",
  });
  store.createConnection(other.id, helper.id, "handoff");
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, other, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("no_connection");
  expect(log.materialized).toHaveLength(0);
});

test("the reverse direction does not authorize a fetch (connections are directional)", async () => {
  await givenExchangedArtifact();
  const log = emptyLog();
  // helper fetching FROM writer, over the writer→helper channel. Not the same permission.
  const outcome = await performArtifactFetch(store, helper, writer, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("no_connection");
  expect(log.materialized).toHaveLength(0);
});

// --- Invariant 2: only what was exchanged — never an arbitrary path ---------

test("a path the callee never handed over is refused, even though it exists in its workspace", async () => {
  await givenExchangedArtifact();
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, writer, helper, `file:${NEVER_EXCHANGED}`, {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("not_exchanged");
  // The decisive assertion: the host was never asked to look, let alone read. `fetch` is not
  // a cross-agent file-read primitive — a reference that never crossed does not reach the
  // filesystem at all, so the caller cannot even probe for existence.
  expect(log.inspected).toHaveLength(0);
  expect(log.materialized).toHaveLength(0);
});

test("a traversal or absolute path never resolves — the argument selects a record, it is not a path", async () => {
  await givenExchangedArtifact();
  const log = emptyLog();
  for (const attempt of [
    "file:../helper-private/keys.txt",
    "file:/etc/passwd",
    "file:drafts/../../escape.md",
    "drafts/market.md", // no `file:` prefix — not a reference at all
    "dir:drafts",
  ]) {
    const outcome = await performArtifactFetch(store, writer, helper, attempt, {
      host: fakeHost(log),
      confirm: () => true,
    });
    expect(outcome.kind).toBe("not_exchanged");
  }
  expect(log.inspected).toHaveLength(0);
  expect(log.materialized).toHaveLength(0);
});

test("an artifact exchanged with ANOTHER caller does not resolve for this one", async () => {
  // helper produces the same artifact over a channel to `editor`, not to `writer`.
  const editor = store.createAgent({
    name: "editor",
    role: "edits",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/editor",
    trustLevel: "autonomous",
  });
  store.createConnection(editor.id, helper.id, "artifact-only");
  const produced = await performArtifactExchange(store, editor, helper, "draft it", {
    adapter: sequenceAdapter([{ tool: "write_file" }]),
    capabilities: [writeCapability()],
  });
  expect(produced.kind).toBe("ok");
  // writer has its own live channel to helper — but was never handed this artifact.
  store.createConnection(writer.id, helper.id, "artifact-only");
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("not_exchanged");
  expect(log.inspected).toHaveLength(0);
});

test("an artifact the exchange recorded as DELETED cannot be fetched", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeProducing(
    [writeCapability(), deleteCapability(ARTIFACT_PATH)],
    [{ tool: "write_file" }, { tool: "delete_file" }],
  );
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("unavailable");
  // Refused from the RECORD, not from disk — so a path that reappears in the callee's
  // workspace later cannot be resurrected through a reference the exchange withdrew.
  expect(log.inspected).toHaveLength(0);
});

test("a directory reference is refused — fetch materializes single files", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  const mkdirCapability: Capability = {
    key: "fs.mkdir",
    effect: "write",
    tool: {
      name: "mkdir",
      description: "make a folder",
      inputSchema: { type: "object", properties: {} },
      execute: (): ToolResult => ({
        output: "made",
        observation: {
          schema: "asterism.fs.mkdir@1",
          facts: [{ subject: "dir:drafts", relation: "exists", object: true }],
        },
      }),
    },
  };
  await exchangeProducing([mkdirCapability], [{ tool: "mkdir" }]);
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, writer, helper, "dir:drafts", {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("unavailable");
  expect(log.materialized).toHaveLength(0);
});

test("the path the host is handed comes from the RECORD, and the two workspaces are the agents' own", async () => {
  await givenExchangedArtifact();
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("ok");
  expect(log.materialized).toHaveLength(1);
  expect(log.materialized[0]).toEqual({
    // Read from the CALLEE's workspace, written into the CALLER's — neither is caller-chosen.
    sourceWorkspaceDir: helper.workspaceDir,
    destWorkspaceDir: writer.workspaceDir,
    path: ARTIFACT_PATH,
  });
});

// --- Invariant 3: the CALLER's gate governs the write -----------------------

test("an AUTONOMOUS caller still confirms — the byte-crossing is destructive at every level", async () => {
  await givenExchangedArtifact();
  expect(writer.trustLevel).toBe("autonomous");
  const log = emptyLog();
  const asked: Action[] = [];
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: (action) => {
      asked.push(action);
      return true;
    },
  });
  expect(outcome.kind).toBe("ok");
  // The gate ran, and it ran on the fetch capability, classified destructive.
  expect(asked).toHaveLength(1);
  expect(asked[0]?.capability).toBe(EXCHANGE_FETCH_KEY);
  expect(asked[0]?.effect).toBe("destructive");
});

test("without a confirmation nothing is written — the safe default holds for a non-interactive caller", async () => {
  await givenExchangedArtifact();
  const log = emptyLog();
  // No `confirm` at all: the destructive gate has nobody to ask.
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log),
  });
  expect(outcome.kind).toBe("not_confirmed");
  expect(log.materialized).toHaveLength(0);
  // The pause is audited on the CALLER's log — its own policy decision.
  const paused = store.events
    .tail(writer.id)
    .filter((e) => e.type === "action.awaiting_confirmation");
  expect(paused).toHaveLength(1);
});

test("a DECLINED confirmation writes nothing", async () => {
  await givenExchangedArtifact();
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => false,
  });
  expect(outcome.kind).toBe("not_confirmed");
  expect(log.materialized).toHaveLength(0);
});

test("a `propose` caller withholds the fetch entirely — it never executes a side effect", async () => {
  store.setTrust(writer.id, "propose");
  const proposeWriter = store.agents.get(writer.id)!;
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeProducing([writeCapability()], [{ tool: "write_file" }]);
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, proposeWriter, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    // Even with a confirmation available, `propose` never gets that far.
    confirm: () => true,
  });
  expect(outcome.kind).toBe("withheld");
  if (outcome.kind !== "withheld") return;
  expect(outcome.path).toBe(ARTIFACT_PATH);
  expect(outcome.sizeBytes).toBe(ARTIFACT_BYTES);
  expect(log.materialized).toHaveLength(0);
  expect(store.events.tail(writer.id).filter((e) => e.type === "action.withheld")).toHaveLength(1);
});

test("a standing grant cannot make a byte cross without a human", async () => {
  await givenExchangedArtifact();
  // Even an explicitly granted standing on the fetch capability does not auto-approve it:
  // `performArtifactFetch` builds the caller's profile with an EMPTY autoApprove set (D15).
  store.setCapabilityStanding(writer.id, EXCHANGE_FETCH_KEY, "standing-grant", "granted", undefined);
  expect(store.capabilityStanding.grantedKeys(writer.id)).toContain(EXCHANGE_FETCH_KEY);
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log),
  });
  expect(outcome.kind).toBe("not_confirmed");
  expect(log.materialized).toHaveLength(0);
});

test("the callee's trust is irrelevant — it is the CALLER's gate that decides", async () => {
  // A `propose` callee still produced the artifact under its own gate; the fetch that
  // follows is governed entirely by the caller's level.
  store.setTrust(helper.id, "propose");
  await givenExchangedArtifact();
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  // The caller is autonomous and confirmed, so it lands — the callee's `propose` did not
  // block it, exactly as an `autonomous` caller did not skip its own confirmation above.
  expect(outcome.kind).toBe("ok");
});

test("an overwrite is reported to the human and to the caller, never silent", async () => {
  await givenExchangedArtifact();
  const log = emptyLog();
  const destFiles = new Map([[ARTIFACT_PATH, 12]]); // the caller already has a file there
  const asked: Action[] = [];
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log, undefined, destFiles),
    confirm: (action) => {
      asked.push(action);
      return true;
    },
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;
  expect(outcome.result.overwrote).toBe(true);
  // The human was told, in the arguments they approved.
  expect(asked[0]?.args).toMatchObject({ overwrites: true, ref: ARTIFACT_REF });
});

test("an unreadable source is reported before the human is asked to approve anything", async () => {
  await givenExchangedArtifact();
  const log = emptyLog();
  const asked: Action[] = [];
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    // The callee deleted the file outside any exchange: the record stands, the bytes do not.
    host: fakeHost(log, new Map()),
    confirm: (action) => {
      asked.push(action);
      return true;
    },
  });
  expect(outcome.kind).toBe("unavailable");
  expect(asked).toHaveLength(0);
  expect(log.materialized).toHaveLength(0);
});

// --- Invariant 4: cross-agent denial still holds ----------------------------

test("a live fetch channel leaks neither memory nor credentials in either direction", async () => {
  await givenExchangedArtifact();
  store.addCredential(helper.id, "HELPER_TOKEN", "helper-secret-value");
  store.recordMemory(helper.id, {
    memoryType: "semantic",
    content: "HELPER_PRIVATE_LESSON",
    confidence: 1,
    reviewState: "accepted",
    status: "active",
  });
  const log = emptyLog();
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("ok");
  // The fetch crossed a file reference and nothing else. Reading the callee's rows through
  // the caller's id misses, exactly as it did before the fetch.
  expect(store.memories.list(writer.id, {})).toHaveLength(0);
  expect(store.credentials.list(writer.id)).toHaveLength(0);
  expect(store.readSecret(writer.id, "HELPER_TOKEN")).toBeUndefined();
  expect(store.credentials.getByKey(writer.id, "HELPER_TOKEN")).toBeUndefined();
});

test("an exchange row is unreachable through a third agent's id", async () => {
  await givenExchangedArtifact();
  const outsider = store.createAgent({
    name: "outsider",
    role: "unrelated",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/outsider",
    trustLevel: "autonomous",
  });
  expect(store.exchanges.listForAgent(outsider.id)).toHaveLength(0);
  // Both participants see it; nobody else does.
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(1);
  expect(store.exchanges.listForAgent(helper.id)).toHaveLength(1);
});

// --- Invariant 5: both logs record content-free references ------------------

test("artifact.fetched is recorded on BOTH logs, as references only", async () => {
  await givenExchangedArtifact();
  const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(emptyLog()),
    confirm: () => true,
  });
  expect(outcome.kind).toBe("ok");
  const connection = store.connections.findActive(writer.id, helper.id, "artifact-only")!;
  for (const agent of [writer, helper]) {
    const fetched = store.events.tail(agent.id).filter((e) => e.type === "artifact.fetched");
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.payload).toEqual({
      connectionId: connection.id,
      fromAgentId: writer.id,
      toAgentId: helper.id,
      mode: "artifact-only",
      ref: ARTIFACT_REF,
      bytes: ARTIFACT_BYTES,
    });
  }
});

test("a refused fetch records nothing on the CALLEE's log — nothing crossed it", async () => {
  await givenExchangedArtifact();
  const before = store.events.tail(helper.id).length;
  await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(emptyLog()),
    confirm: () => false,
  });
  // The caller's own gate decision is on the caller's log; the callee's is untouched.
  expect(store.events.tail(helper.id)).toHaveLength(before);
  expect(
    store.events.tail(writer.id).filter((e) => e.type === "action.awaiting_confirmation"),
  ).toHaveLength(1);
});

test("no event payload anywhere carries the artifact's contents", async () => {
  await givenExchangedArtifact();
  await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
    host: fakeHost(emptyLog()),
    confirm: () => true,
  });
  const serialized = [
    ...store.events.tail(writer.id),
    ...store.events.tail(helper.id),
  ]
    .map((e) => JSON.stringify(e.payload))
    .join(" ");
  expect(serialized).not.toContain("PROSE");
  expect(serialized).not.toContain("helper-secret");
  // A gate audit records the capability and effect, never the arguments it was given.
  expect(serialized).not.toContain("overwrites");
});

// --- The exchange record itself ---------------------------------------------

test("an artifact-only exchange records its manifest as resolvable references", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeProducing(
    [writeCapability(), writeCapability("notes/two.md", 12), deleteCapability("gone.md")],
    [{ tool: "write_file" }, { tool: "delete_file" }],
  );
  const rows = store.exchanges.listForAgent(writer.id);
  // Deletions are recorded too, so the row set mirrors the manifest that crossed exactly.
  expect(rows.map((r) => `${r.ref}:${r.present}`).sort()).toEqual([
    `${ARTIFACT_REF}:true`,
    "file:gone.md:false",
  ]);
  for (const row of rows) {
    expect(row.kind).toBe("artifact");
    expect(row.fromAgentId).toBe(writer.id);
    expect(row.toAgentId).toBe(helper.id);
    expect(row.runId).toBe(store.runs.list(helper.id)[0]!.id);
  }
});

test("a handoff records no exchange row — its crossing is text, not a resolvable reference", async () => {
  store.createConnection(writer.id, helper.id, "handoff");
  const { performHandoff } = await import("./run.js");
  const outcome = await performHandoff(store, writer, helper, "summarize", {
    adapter: sequenceAdapter([{ tool: "write_file" }]),
    capabilities: [writeCapability()],
  });
  expect(outcome.kind).toBe("ok");
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(0);
});

test("a later exchange's record wins — a re-crossed reference resolves to its latest state", async () => {
  store.createConnection(writer.id, helper.id, "artifact-only");
  await exchangeProducing([writeCapability()], [{ tool: "write_file" }]);
  await exchangeProducing([deleteCapability(ARTIFACT_PATH)], [{ tool: "delete_file" }]);
  const connection = store.connections.findActive(writer.id, helper.id, "artifact-only")!;
  // Two rows for the same ref; the resolve returns the newer (the deletion), so the
  // reference is withdrawn rather than outvoted by history.
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(2);
  expect(store.findExchangedArtifact(connection, ARTIFACT_REF)?.present).toBe(false);
  const log = emptyLog();
  expect(
    (
      await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
        host: fakeHost(log),
        confirm: () => true,
      })
    ).kind,
  ).toBe("unavailable");
  // ...and a re-creation makes it fetchable again.
  await exchangeProducing([writeCapability()], [{ tool: "write_file" }]);
  expect(store.findExchangedArtifact(connection, ARTIFACT_REF)?.present).toBe(true);
  expect(
    (
      await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
        host: fakeHost(log),
        confirm: () => true,
      })
    ).kind,
  ).toBe("ok");
});

test("an action the callee's gate withheld contributes no fetchable artifact", async () => {
  store.setTrust(helper.id, "propose");
  const proposeHelper = store.agents.get(helper.id)!;
  store.createConnection(writer.id, proposeHelper.id, "artifact-only");
  const outcome = await performArtifactExchange(store, writer, proposeHelper, "draft it", {
    adapter: sequenceAdapter([{ tool: "write_file" }]),
    capabilities: [writeCapability()],
  });
  expect(outcome.kind).toBe("ok");
  // The write was withheld, so it produced no observation, no manifest entry — and
  // therefore nothing to dereference. The authorization chain has no gap to slip through.
  expect(store.exchanges.listForAgent(writer.id)).toHaveLength(0);
  const log = emptyLog();
  const fetched = await performArtifactFetch(store, writer, proposeHelper, ARTIFACT_REF, {
    host: fakeHost(log),
    confirm: () => true,
  });
  expect(fetched.kind).toBe("not_exchanged");
  expect(log.inspected).toHaveLength(0);
});

test("a fetch never becomes a standing-grant candidate — it has no run to earn in", async () => {
  await givenExchangedArtifact();
  // Two successful fetches, which for an in-run capability would start an earning window.
  for (let i = 0; i < 2; i += 1) {
    const outcome = await performArtifactFetch(store, writer, helper, ARTIFACT_REF, {
      host: fakeHost(emptyLog()),
      confirm: () => true,
    });
    expect(outcome.kind).toBe("ok");
  }
  // They are audited honestly...
  expect(
    store.events.tail(writer.id).filter((e) => e.type === "action.succeeded"),
  ).toHaveLength(2);
  // ...but carry no run id, so the standing reader skips them entirely and `trust --review`
  // can never propose a grant the fetch gate would then ignore.
  for (const event of store.events.tail(writer.id)) {
    if (event.payload && JSON.stringify(event.payload).includes(EXCHANGE_FETCH_KEY)) {
      expect(event.runId).toBeUndefined();
    }
  }
  const { proposeStandingGrants } = await import("./standing.js");
  const candidates = proposeStandingGrants(store, writer);
  expect(candidates.map((c) => c.capability)).not.toContain(EXCHANGE_FETCH_KEY);
});
