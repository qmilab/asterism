// performHandoff — the kernel handoff op, Phase 3's first cross-agent operation. This is
// the Phase-3 analogue of the Phase-0 five-claim demo: one test per golden-rule-5 invariant
// (design note `phase-3-collaboration.md` §2 / §7), proven across a LIVE connection.
//
//   1. No connection → no interaction (the handoff is refused; default isolation holds).
//   2. The callee runs in its OWN workspace/trust/tools; the caller receives only the
//      callee's final output — never its memory or secrets.
//   3. The callee's gate is sovereign — it fires per the CALLEE's trust, independent of the
//      caller's autonomy. A handoff can neither raise nor lower the callee's trust.
//   4. The caller's memory/credentials stay unreadable from the callee and vice-versa.
//   5. Both event logs record content-free connection.created / handoff.requested /
//      handoff.completed references — no task text, no output text, no secret value.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { performHandoff } from "./run.js";
import { AsterismStore } from "./store.js";
import type { RuntimeAdapter, RunOutput } from "./adapter.js";
import type { Capability } from "./trust.js";
import type { Agent } from "./types.js";

let store: AsterismStore;
let writer: Agent; // the caller — autonomous, so we can prove the callee's gate, not the caller's, governs
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

/** Captures the framed system prompt, so a test can assert WHOSE context framed the run. */
function capturingAdapter(sink: { systemPrompt?: string }): RuntimeAdapter {
  return {
    run(request) {
      sink.systemPrompt = request.systemPrompt;
      async function* noEvents() {}
      return { events: noEvents(), output: Promise.resolve({ status: "done", text: "ok" }) };
    },
  };
}

function deleteFilesCapability(): Capability {
  return {
    key: "delete_files",
    effect: "destructive",
    tool: {
      name: "delete_files",
      description: "delete files",
      inputSchema: { type: "object", properties: {} },
      execute: () => ({ output: "deleted" }),
    },
  };
}

function writeFileCapability(): Capability {
  return {
    key: "write_file",
    effect: "write",
    tool: {
      name: "write_file",
      description: "write a file",
      inputSchema: { type: "object", properties: {} },
      execute: () => ({ output: "written" }),
    },
  };
}

// --- Invariant 1: no connection → no interaction ---------------------------

test("with no connection, a handoff is refused and nothing runs on the callee", async () => {
  const outcome = await performHandoff(store, writer, researcher, "summarize the notes", {
    adapter: cannedAdapter({ status: "done", text: "summary" }),
  });
  expect(outcome.kind).toBe("no_connection");
  // Default isolation held: the callee was never run, neither agent logged a handoff.
  expect(store.runs.list(researcher.id)).toHaveLength(0);
  expect(store.events.tail(writer.id).filter((e) => e.type.startsWith("handoff."))).toHaveLength(0);
  expect(store.events.tail(researcher.id).filter((e) => e.type.startsWith("handoff."))).toHaveLength(0);
});

test("a B→A connection does NOT authorize an A→B handoff (directional)", async () => {
  // Connect researcher → writer, then try to hand off writer → researcher (the reverse).
  store.createConnection(researcher.id, writer.id, "handoff");
  const outcome = await performHandoff(store, writer, researcher, "do the thing", {
    adapter: cannedAdapter({ status: "done", text: "x" }),
  });
  expect(outcome.kind).toBe("no_connection");
});

// --- Invariant 2: the callee runs as itself; only its output crosses --------

test("the handoff runs AS the callee — the run is the callee's, not the caller's", async () => {
  store.createConnection(writer.id, researcher.id, "handoff");
  const outcome = await performHandoff(store, writer, researcher, "summarize the notes", {
    adapter: cannedAdapter({ status: "done", text: "here is the summary" }),
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;
  // The run belongs to the callee, executed in the callee's identity.
  expect(outcome.result.run.agentId).toBe(researcher.id);
  expect(store.runs.list(researcher.id)).toHaveLength(1);
  // The CALLER started no run of its own — it only received the callee's output back.
  expect(store.runs.list(writer.id)).toHaveLength(0);
  expect(outcome.result.output).toBe("here is the summary");
});

test("the callee's run is framed by the CALLEE's memory, never the caller's", async () => {
  store.createConnection(writer.id, researcher.id, "handoff");
  // A distinctive accepted memory for each agent.
  store.recordMemory(researcher.id, {
    memoryType: "semantic",
    content: "RESEARCHER_PRIVATE_LESSON",
    confidence: 1,
    reviewState: "accepted",
    status: "active",
  });
  store.recordMemory(writer.id, {
    memoryType: "semantic",
    content: "WRITER_PRIVATE_LESSON",
    confidence: 1,
    reviewState: "accepted",
    status: "active",
  });
  const sink: { systemPrompt?: string } = {};
  const outcome = await performHandoff(store, writer, researcher, "summarize", {
    adapter: capturingAdapter(sink),
  });
  expect(outcome.kind).toBe("ok");
  // The callee's run saw ITS OWN memory and not a trace of the caller's.
  expect(sink.systemPrompt).toContain("RESEARCHER_PRIVATE_LESSON");
  expect(sink.systemPrompt).not.toContain("WRITER_PRIVATE_LESSON");
});

// --- Invariant 3: the callee's gate is sovereign ----------------------------

test("the callee's trust governs — a `propose` callee withholds, despite an `autonomous` caller", async () => {
  store.createConnection(writer.id, researcher.id, "handoff");
  // writer is autonomous and would EXECUTE a write; researcher is propose and WITHHOLDS it.
  // The handoff runs as researcher, so the write is withheld — the caller's autonomy is irrelevant.
  const outcome = await performHandoff(store, writer, researcher, "write the file", {
    adapter: sequenceAdapter([{ tool: "write_file", args: {} }]),
    capabilities: [writeFileCapability()],
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;
  expect(outcome.result.actions).toEqual([
    { capability: "write_file", effect: "write", decision: "withheld" },
  ]);
});

test("a destructive action pauses the handoff per the callee's gate, even with an autonomous caller", async () => {
  // A `notify` callee acts on writes on its own, but a DESTRUCTIVE action still pauses for
  // confirmation at every trust level — and that gate fires in the CALLEE's context.
  const helper = store.createAgent({
    name: "helper",
    role: "does chores",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/helper",
    trustLevel: "notify",
  });
  store.createConnection(writer.id, helper.id, "handoff");
  const outcome = await performHandoff(store, writer, helper, "delete the dist files", {
    adapter: sequenceAdapter([{ tool: "delete_files", args: { command: "rm -rf dist" } }]),
    capabilities: [deleteFilesCapability()],
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;
  expect(outcome.result.status).toBe("awaiting_confirmation");
  // The pause is on the CALLEE's run, recorded on the CALLEE's log.
  expect(store.runs.get(helper.id, outcome.result.run.id)?.status).toBe("awaiting_confirmation");
});

// --- Invariant 4: cross-agent denial across a live connection ---------------

test("the caller's secret stays unreadable from the callee and vice-versa, with a connection open", () => {
  store.createConnection(writer.id, researcher.id, "handoff");
  store.addCredential(writer.id, "WRITER_TOKEN", "writer-secret-value");
  store.addCredential(researcher.id, "RESEARCHER_TOKEN", "researcher-secret-value");

  // Each agent reads only its own secret; the connection grants NO access to the other's.
  expect(store.readSecret(writer.id, "WRITER_TOKEN")).toBe("writer-secret-value");
  expect(store.readSecret(researcher.id, "WRITER_TOKEN")).toBeUndefined();
  expect(store.readSecret(researcher.id, "RESEARCHER_TOKEN")).toBe("researcher-secret-value");
  expect(store.readSecret(writer.id, "RESEARCHER_TOKEN")).toBeUndefined();
});

test("a handoff never copies the callee's memory into the caller's scope", async () => {
  store.createConnection(writer.id, researcher.id, "handoff");
  store.recordMemory(researcher.id, {
    memoryType: "semantic",
    content: "RESEARCHER_PRIVATE_LESSON",
    confidence: 1,
    reviewState: "accepted",
    status: "active",
  });
  await performHandoff(store, writer, researcher, "summarize", {
    adapter: cannedAdapter({ status: "done", text: "done" }),
  });
  // After a live handoff, the caller's memory is still empty — nothing of the callee's crossed.
  expect(store.memories.listActiveAccepted(writer.id)).toHaveLength(0);
  expect(store.memories.listActiveAccepted(researcher.id)).toHaveLength(1);
});

// --- Invariant 5: both logs record content-free references ------------------

test("both logs record handoff.requested / handoff.completed as content-free references", async () => {
  store.createConnection(writer.id, researcher.id, "handoff");
  const SECRET = "super-secret-token-123";
  store.addCredential(researcher.id, "RESEARCHER_TOKEN", SECRET);
  const TASK = "SENTINEL_TASK_TEXT summarize the notes";
  const OUTPUT = "SENTINEL_OUTPUT_TEXT the summary";

  const outcome = await performHandoff(store, writer, researcher, TASK, {
    adapter: cannedAdapter({ status: "done", text: OUTPUT }),
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") return;
  const runId = outcome.result.run.id;

  // Each participant's log carries the requested + completed markers.
  for (const id of [writer.id, researcher.id]) {
    const requested = store.events.tail(id).filter((e) => e.type === "handoff.requested");
    const completed = store.events.tail(id).filter((e) => e.type === "handoff.completed");
    expect(requested).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toEqual({
      connectionId: expect.any(String),
      fromAgentId: writer.id,
      toAgentId: researcher.id,
      runId,
      status: "done",
    });
  }

  // Content-free: NO connection/handoff event payload, on EITHER log, carries the task
  // text, the callee's output, or the secret value.
  const collabTypes = new Set(["connection.created", "handoff.requested", "handoff.completed"]);
  for (const id of [writer.id, researcher.id]) {
    const payloads = store.events
      .tail(id)
      .filter((e) => collabTypes.has(e.type))
      .map((e) => JSON.stringify(e.payload));
    for (const p of payloads) {
      expect(p).not.toContain("SENTINEL_TASK_TEXT");
      expect(p).not.toContain("SENTINEL_OUTPUT_TEXT");
      expect(p).not.toContain(SECRET);
    }
  }

  // The CALLER's log holds ONLY its own creation plus the collaboration markers — none of
  // the callee's run lifecycle (run.started / run.status_changed are the callee's, scoped
  // to the callee). So a handoff never spills the callee's run activity onto the caller.
  const writerTypes = new Set(store.events.tail(writer.id).map((e) => e.type));
  expect(writerTypes).toEqual(
    new Set(["agent.created", "connection.created", "handoff.requested", "handoff.completed"]),
  );
});

test("handoff.completed records a paused run honestly (status awaiting_confirmation)", async () => {
  const helper = store.createAgent({
    name: "helper",
    role: "does chores",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/helper",
    trustLevel: "autonomous",
  });
  store.createConnection(writer.id, helper.id, "handoff");
  const outcome = await performHandoff(store, writer, helper, "delete dist", {
    adapter: sequenceAdapter([{ tool: "delete_files", args: { command: "rm -rf dist" } }]),
    capabilities: [deleteFilesCapability()],
  });
  expect(outcome.kind).toBe("ok");
  const completed = store.events.tail(writer.id).find((e) => e.type === "handoff.completed");
  expect((completed?.payload as { status: string }).status).toBe("awaiting_confirmation");
});
