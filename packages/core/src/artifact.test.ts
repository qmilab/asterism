// performArtifactExchange — the `artifact-only` collaboration mode (Phase 3 · T2a). The
// same five golden-rule-5 invariants `handoff.test.ts` proves, re-proven for the stricter
// mode, plus the exclusions that DEFINE it (design note `phase-3-collaboration.md` §9):
//
//   1. No connection → no interaction — and a `handoff` connection does NOT authorize an
//      `artifact-only` exchange (each mode is its own permission).
//   2. Only the manifest crosses: paths/sizes, never the callee's text, never its memory,
//      never the file contents — and a secret-shaped PATH is redacted.
//   3. The callee's gate is sovereign, and a withheld/paused action contributes NO artifact.
//   4. The caller's memory/credentials stay unreadable from the callee and vice-versa.
//   5. Both event logs record content-free references — no task text, no secret value.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { performArtifactExchange, performHandoff } from "./run.js";
import { AsterismStore } from "./store.js";
import type { RuntimeAdapter, RunOutput, ToolObservation } from "./adapter.js";
import type { Capability } from "./trust.js";
import type { Agent } from "./types.js";

let store: AsterismStore;
let writer: Agent; // the caller — autonomous, so the callee's gate (not the caller's) is what governs
let researcher: Agent; // the callee — propose, so its gate withholds where the caller's would act

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

/** A substrate stand-in that ignores tools and resolves a canned output. */
function cannedAdapter(output: RunOutput): RuntimeAdapter {
  return {
    run() {
      async function* noEvents() {}
      return { events: noEvents(), output: Promise.resolve(output) };
    },
  };
}

/** A substrate stand-in that drives a fixed sequence of tool calls through the gate. */
function sequenceAdapter(steps: readonly { tool: string; args: unknown }[]): RuntimeAdapter {
  return {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        const texts: string[] = [];
        for (const step of steps) {
          if (request.signal?.aborted) break;
          const tool = request.tools.list().find((t) => t.name === step.tool);
          if (!tool) continue;
          const result = await tool.execute({ args: step.args }, request.signal);
          texts.push(result.output);
          if (result.isError) break;
        }
        return { status: "done", text: texts.join("\n") };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
}

/** A `write`-effect tool that declares the artifact it produced. */
function writingCapability(key: string, observation: ToolObservation): Capability {
  return {
    key,
    effect: "write",
    tool: {
      name: key,
      description: "writes something",
      inputSchema: { type: "object", properties: {} },
      execute: () => ({ output: "written", observation }),
    },
  };
}

/** A `destructive` tool that declares the path it removed. */
function deletingCapability(path: string): Capability {
  return {
    key: "delete_file",
    effect: "destructive",
    tool: {
      name: "delete_file",
      description: "deletes a file",
      inputSchema: { type: "object", properties: {} },
      execute: () => ({
        output: "deleted",
        observation: {
          schema: "asterism.fs.delete@1",
          facts: [{ subject: `file:${path}`, relation: "exists", object: false }],
        },
      }),
    },
  };
}

function wrote(path: string, sizeBytes: number): ToolObservation {
  return {
    schema: "asterism.fs.write@1",
    facts: [
      { subject: `file:${path}`, relation: "exists", object: true },
      { subject: `file:${path}`, relation: "size_bytes", object: sizeBytes },
    ],
  };
}

// --- Invariant 1: no connection → no interaction ---------------------------

test("with no connection, an artifact exchange is refused and nothing runs on the callee", async () => {
  const outcome = await performArtifactExchange(store, writer, researcher, "draft the section", {
    adapter: cannedAdapter({ status: "done", text: "summary" }),
  });
  expect(outcome.kind).toBe("no_connection");
  expect(store.runs.list(researcher.id)).toHaveLength(0);
  expect(store.events.tail(researcher.id).filter((e) => e.type.startsWith("handoff."))).toHaveLength(
    0,
  );
});

test("a handoff connection does NOT authorize an artifact-only exchange (modes are distinct permissions)", async () => {
  store.createConnection(writer.id, researcher.id, "handoff");
  const outcome = await performArtifactExchange(store, writer, researcher, "draft it", {
    adapter: cannedAdapter({ status: "done", text: "x" }),
  });
  expect(outcome.kind).toBe("no_connection");
  // ...and the converse: an artifact-only channel does not authorize a handoff.
  const other = store.createAgent({
    name: "other",
    role: "helps",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/other",
    trustLevel: "propose",
  });
  store.createConnection(writer.id, other.id, "artifact-only");
  const handoff = await performHandoff(store, writer, other, "do it", {
    adapter: cannedAdapter({ status: "done", text: "x" }),
  });
  expect(handoff.kind).toBe("no_connection");
});

test("a B→A artifact-only connection does NOT authorize an A→B exchange (directional)", async () => {
  store.createConnection(researcher.id, writer.id, "artifact-only");
  const outcome = await performArtifactExchange(store, writer, researcher, "draft it", {
    adapter: cannedAdapter({ status: "done", text: "x" }),
  });
  expect(outcome.kind).toBe("no_connection");
});

// --- Invariant 2: only the manifest crosses --------------------------------

test("the caller receives the artifact manifest — and NOT the callee's text", async () => {
  store.createConnection(writer.id, researcher.id, "artifact-only");
  const helper = store.createAgent({
    name: "helper",
    role: "writes files",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/helper",
    trustLevel: "autonomous",
  });
  store.createConnection(writer.id, helper.id, "artifact-only");

  const outcome = await performArtifactExchange(store, writer, helper, "draft the section", {
    adapter: sequenceAdapter([{ tool: "write_file", args: {} }]),
    capabilities: [writingCapability("write_file", wrote("drafts/market-section.md", 4300))],
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;

  expect(outcome.result.artifacts).toEqual([
    { path: "drafts/market-section.md", kind: "file", exists: true, sizeBytes: 4300 },
  ]);
  // The result type has NOWHERE to put the callee's text — invariant 2 is a property of the
  // type, not of a caller remembering not to read a field. Assert the shape stays that way.
  expect(Object.keys(outcome.result).sort()).toEqual(["actions", "artifacts", "runId", "status"]);
  expect(JSON.stringify(outcome.result)).not.toContain("written");
});

test("the callee's Run row never crosses — only its run id (the row carries its output text)", async () => {
  const helper = store.createAgent({
    name: "helper",
    role: "writes files",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/helper",
    trustLevel: "autonomous",
  });
  store.createConnection(writer.id, helper.id, "artifact-only");
  const OUTPUT = "SENTINEL_CALLEE_PROSE the market looks strong";

  const outcome = await performArtifactExchange(store, writer, helper, "draft it", {
    adapter: cannedAdapter({ status: "done", text: OUTPUT }),
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;

  // The callee DID produce and persist that text on its own run row...
  expect(store.runs.get(helper.id, outcome.result.runId)?.output).toBe(OUTPUT);
  // ...and none of it crossed the boundary.
  expect(JSON.stringify(outcome.result)).not.toContain("SENTINEL_CALLEE_PROSE");
});

test("a secret VALUE in a file's contents never crosses — and a secret-shaped PATH is redacted", async () => {
  const helper = store.createAgent({
    name: "helper",
    role: "writes files",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/helper",
    trustLevel: "autonomous",
  });
  store.createConnection(writer.id, helper.id, "artifact-only");
  const SECRET = "sk-live-000011112222333344445555";

  const outcome = await performArtifactExchange(store, writer, helper, "write the keys", {
    adapter: sequenceAdapter([
      { tool: "write_secret_named", args: {} },
      { tool: "write_plain", args: {} },
    ]),
    capabilities: [
      // The path itself carries a secret-shaped token — the agent CHOSE this path.
      writingCapability("write_secret_named", wrote(`keys/${SECRET}.env`, 64)),
      // A file whose CONTENTS hold the secret; only path + size are ever observed.
      writingCapability("write_plain", wrote("config/settings.env", 128)),
    ],
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;

  const serialized = JSON.stringify(outcome.result);
  expect(serialized).not.toContain(SECRET);
  // The plain file crossed as a reference: its path and size, never a byte of its contents.
  expect(outcome.result.artifacts).toContainEqual({
    path: "config/settings.env",
    kind: "file",
    exists: true,
    sizeBytes: 128,
  });
});

test("a pure READ contributes no artifact — the manifest is not a record of what the callee looked at", async () => {
  const helper = store.createAgent({
    name: "helper",
    role: "reads files",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/helper",
    trustLevel: "autonomous",
  });
  store.createConnection(writer.id, helper.id, "artifact-only");

  const outcome = await performArtifactExchange(store, writer, helper, "look around", {
    adapter: sequenceAdapter([{ tool: "read_file", args: {} }]),
    capabilities: [
      {
        key: "read_file",
        effect: "read",
        tool: {
          name: "read_file",
          description: "reads a file",
          inputSchema: { type: "object", properties: {} },
          execute: () => ({
            output: "contents",
            observation: {
              schema: "asterism.fs.read@1",
              facts: [{ subject: "file:private/notes.md", relation: "exists", object: true }],
            },
          }),
        },
      },
    ],
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;
  expect(outcome.result.artifacts).toEqual([]);
  expect(JSON.stringify(outcome.result)).not.toContain("private/notes.md");
});

// --- Invariant 3: the callee's gate is sovereign ----------------------------

test("a `propose` callee withholds the write — and contributes NO artifact, despite an autonomous caller", async () => {
  store.createConnection(writer.id, researcher.id, "artifact-only");
  const outcome = await performArtifactExchange(store, writer, researcher, "write the file", {
    adapter: sequenceAdapter([{ tool: "write_file", args: {} }]),
    capabilities: [writingCapability("write_file", wrote("drafts/withheld.md", 99))],
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;
  expect(outcome.result.actions).toEqual([
    { capability: "write_file", effect: "write", decision: "withheld" },
  ]);
  // The gate never let the tool run, so it emitted no observation — and the manifest cannot
  // claim an artifact that was never produced.
  expect(outcome.result.artifacts).toEqual([]);
});

test("a destructive action pauses per the callee's gate; the manifest reflects only what executed", async () => {
  const helper = store.createAgent({
    name: "helper",
    role: "does chores",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/helper",
    trustLevel: "autonomous", // destructive still pauses at EVERY trust level
  });
  store.createConnection(writer.id, helper.id, "artifact-only");

  const outcome = await performArtifactExchange(store, writer, helper, "write then delete", {
    adapter: sequenceAdapter([
      { tool: "write_file", args: {} },
      { tool: "delete_file", args: {} },
    ]),
    capabilities: [
      writingCapability("write_file", wrote("drafts/kept.md", 512)),
      deletingCapability("drafts/kept.md"),
    ],
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;

  expect(outcome.result.status).toBe("awaiting_confirmation");
  expect(store.runs.get(helper.id, outcome.result.runId)?.status).toBe("awaiting_confirmation");
  // The write executed and IS in the manifest; the delete only paused, so the file is still
  // reported present — the manifest never describes an action the gate is still holding.
  expect(outcome.result.artifacts).toEqual([
    { path: "drafts/kept.md", kind: "file", exists: true, sizeBytes: 512 },
  ]);
});

// --- Invariant 4: cross-agent denial across a live connection ---------------

test("with an artifact-only channel open, each agent's secrets and memory stay its own", async () => {
  store.createConnection(writer.id, researcher.id, "artifact-only");
  store.addCredential(writer.id, "WRITER_TOKEN", "writer-secret-value");
  store.addCredential(researcher.id, "RESEARCHER_TOKEN", "researcher-secret-value");

  expect(store.readSecret(writer.id, "WRITER_TOKEN")).toBe("writer-secret-value");
  expect(store.readSecret(researcher.id, "WRITER_TOKEN")).toBeUndefined();
  expect(store.readSecret(researcher.id, "RESEARCHER_TOKEN")).toBe("researcher-secret-value");
  expect(store.readSecret(writer.id, "RESEARCHER_TOKEN")).toBeUndefined();

  store.recordMemory(researcher.id, {
    memoryType: "semantic",
    content: "RESEARCHER_PRIVATE_LESSON",
    confidence: 1,
    reviewState: "accepted",
    status: "active",
  });
  await performArtifactExchange(store, writer, researcher, "summarize", {
    adapter: cannedAdapter({ status: "done", text: "done" }),
  });
  // After a live exchange the caller's memory is still empty — nothing of the callee's crossed.
  expect(store.memories.listActiveAccepted(writer.id)).toHaveLength(0);
  expect(store.memories.listActiveAccepted(researcher.id)).toHaveLength(1);
});

// --- Invariant 5: both logs record content-free references ------------------

test("both logs record the exchange as content-free references carrying the mode", async () => {
  const helper = store.createAgent({
    name: "helper",
    role: "writes files",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/helper",
    trustLevel: "autonomous",
  });
  store.createConnection(writer.id, helper.id, "artifact-only");
  const SECRET = "super-secret-token-123";
  store.addCredential(helper.id, "HELPER_TOKEN", SECRET);
  const TASK = "SENTINEL_TASK_TEXT draft the section";

  const outcome = await performArtifactExchange(store, writer, helper, TASK, {
    adapter: sequenceAdapter([{ tool: "write_file", args: {} }]),
    capabilities: [
      {
        key: "write_file",
        effect: "write",
        tool: {
          name: "write_file",
          description: "writes a file",
          inputSchema: { type: "object", properties: {} },
          // The tool's own output text becomes the run's final text, so the sentinel below
          // is genuinely present on the callee's side and the assertion is not vacuous.
          execute: () => ({
            output: "SENTINEL_OUTPUT_TEXT the draft",
            observation: wrote("drafts/section.md", 2048),
          }),
        },
      },
    ],
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;

  const collabTypes = new Set(["connection.created", "handoff.requested", "handoff.completed"]);
  for (const id of [writer.id, helper.id]) {
    const events = store.events.tail(id).filter((e) => collabTypes.has(e.type));
    expect(events.filter((e) => e.type === "handoff.requested")).toHaveLength(1);
    expect(events.filter((e) => e.type === "handoff.completed")).toHaveLength(1);
    for (const p of events.map((e) => JSON.stringify(e.payload))) {
      expect(p).not.toContain("SENTINEL_TASK_TEXT");
      expect(p).not.toContain("SENTINEL_OUTPUT_TEXT");
      expect(p).not.toContain(SECRET);
      // Nor the artifact paths — the log records the exchange, not its payload.
      expect(p).not.toContain("drafts/section.md");
    }
    // The mode rides along on EVERY collaboration event, so both logs distinguish the
    // exchange forms — including a `handoff.completed` read on its own, or a log filtered to
    // completions only, where the mode is otherwise the one thing that tells an artifact
    // exchange from a handoff. [Codex review P2.]
    for (const type of ["connection.created", "handoff.requested", "handoff.completed"]) {
      const event = events.find((e) => e.type === type);
      expect((event?.payload as { mode?: string })?.mode).toBe("artifact-only");
    }
  }

  // The CALLER's log holds only its own creation plus the collaboration markers — none of
  // the callee's run lifecycle, which stays scoped to the callee.
  expect(new Set(store.events.tail(writer.id).map((e) => e.type))).toEqual(
    new Set(["agent.created", "connection.created", "handoff.requested", "handoff.completed"]),
  );
  // The sentinel really did exist on the callee's side — so the log assertions above are
  // proving its absence, not passing because it was never produced.
  expect(store.runs.get(helper.id, outcome.result.runId)?.output).toContain("SENTINEL_OUTPUT_TEXT");
});
