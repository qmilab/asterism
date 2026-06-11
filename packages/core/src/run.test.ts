// executeRun — the shared kernel run flow. These tests pin the three outcomes a
// surface must be able to rely on identically (CLI or HTTP):
//   1. a clean run finishes `done`, persists its output, and logs the lifecycle;
//   2. a substrate failure finishes `failed` and surfaces the error;
//   3. a destructive action pauses the run at `awaiting_confirmation` — the gate
//      fires even at `autonomous`, and a paused run is left non-terminal yet still
//      keeps whatever it produced (so it stays reflectable).
// Cross-agent scoping is covered by the repository/event tests; here we prove the
// orchestration wires status, persistence, and the gate together correctly.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { executeRun, resumeRun } from "./run.js";
import { AsterismStore } from "./store.js";
import type { RuntimeAdapter, RunEvent, RunOutput } from "./adapter.js";
import type { Capability } from "./trust.js";
import type { Agent } from "./types.js";

let store: AsterismStore;
let agent: Agent;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  agent = store.createAgent({
    name: "personal",
    role: "personal helper",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/personal",
    trustLevel: "autonomous",
  });
});

afterEach(() => {
  store.close();
});

/** A substrate stand-in that ignores tools and resolves a canned output. */
function cannedAdapter(output: RunOutput): RuntimeAdapter {
  return {
    run() {
      async function* noEvents() {
        // No lifecycle events for the canned run.
      }
      return { events: noEvents(), output: Promise.resolve(output) };
    },
  };
}

/**
 * A substrate stand-in that drives the one scoped tool through the gate, the way
 * a real loop would when the model calls it. Whatever the gated tool returns
 * becomes the run's text; if the gate aborted the run, the kernel's recorded
 * status wins regardless of what we report here.
 */
function toolCallingAdapter(toolName: string, args: unknown): RuntimeAdapter {
  return {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        const tool = request.tools.list().find((t) => t.name === toolName);
        if (!tool) return { status: "done", text: "(no such tool)" };
        const result = await tool.execute({ args }, request.signal);
        return { status: "done", text: result.output };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
}

/** A destructive capability the kernel would normally never expose without allow-listing. */
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

/** A second destructive capability, so two destructive calls can overlap in one run. */
function dropTableCapability(): Capability {
  return {
    key: "drop_table",
    effect: "destructive",
    tool: {
      name: "drop_table",
      description: "drop a database table",
      inputSchema: { type: "object", properties: {} },
      execute: () => ({ output: "dropped" }),
    },
  };
}

/** An ordinary side-effecting capability — executes under notify/autonomous, withheld under propose. */
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

/** A substrate stand-in that emits a fixed sequence of lifecycle events, then resolves. */
function eventEmittingAdapter(events: readonly RunEvent[], output: RunOutput): RuntimeAdapter {
  return {
    run() {
      async function* emit() {
        for (const event of events) yield event;
      }
      return { events: emit(), output: Promise.resolve(output) };
    },
  };
}

test("a clean run finishes done, persists output, and logs the lifecycle", async () => {
  const result = await executeRun(store, agent, "write the blog draft", {
    adapter: cannedAdapter({ status: "done", text: "hello from the agent" }),
  });

  expect(result.status).toBe("done");
  expect(result.output).toBe("hello from the agent");
  expect(result.run.status).toBe("done");
  expect(result.run.output).toBe("hello from the agent");
  expect(result.run.finishedAt).toBeDefined();

  // The run row is persisted and scoped to the agent.
  const persisted = store.runs.get(agent.id, result.run.id);
  expect(persisted?.status).toBe("done");
  expect(persisted?.output).toBe("hello from the agent");

  // The lifecycle is on the event log: started → running → done.
  const types = store.events.tail(agent.id).map((e) => e.type);
  expect(types).toEqual([
    "agent.created",
    "run.started",
    "run.status_changed", // → running
    "run.status_changed", // → done
  ]);
});

test("a substrate failure finishes failed and surfaces the error", async () => {
  const result = await executeRun(store, agent, "do the thing", {
    adapter: cannedAdapter({ status: "failed", text: "", error: "model unreachable" }),
  });

  expect(result.status).toBe("failed");
  expect(result.error).toBe("model unreachable");
  expect(result.run.status).toBe("failed");
  expect(result.run.finishedAt).toBeDefined();
});

test("an adapter that throws synchronously from run() drives the run to failed", async () => {
  // The substrate can blow up while constructing its handle — before it ever
  // returns events/output. That synchronous throw must still be caught and driven
  // to a terminal `failed`, not left stranded in `running` (the streaming rework
  // must keep `run(request)` itself inside the failure guard).
  const throwingAdapter: RuntimeAdapter = {
    run() {
      throw new Error("could not start the substrate");
    },
  };

  const result = await executeRun(store, agent, "do the thing", { adapter: throwingAdapter });

  expect(result.status).toBe("failed");
  expect(result.error).toBe("could not start the substrate");
  expect(result.run.status).toBe("failed");
  expect(result.run.finishedAt).toBeDefined();
  // Nothing left mid-flight in the store.
  expect(store.runs.get(agent.id, result.run.id)?.status).toBe("failed");
});

test("an adapter that rejects drives the run to failed, not stuck running", async () => {
  // A non-conforming/crashing substrate rejects its output promise instead of
  // resolving with status "failed". The run must still reach a terminal state.
  const rejectingAdapter: RuntimeAdapter = {
    run() {
      async function* noEvents() {}
      return { events: noEvents(), output: Promise.reject(new Error("socket hang up")) };
    },
  };

  const result = await executeRun(store, agent, "do the thing", { adapter: rejectingAdapter });

  expect(result.status).toBe("failed");
  expect(result.error).toBe("socket hang up");
  expect(result.run.status).toBe("failed");
  expect(result.run.finishedAt).toBeDefined();
  // Nothing is left mid-flight in the store.
  expect(store.runs.get(agent.id, result.run.id)?.status).toBe("failed");
});

test("a destructive action pauses an autonomous run at awaiting_confirmation", async () => {
  // No `confirm` callback ⇒ the gate cannot be approved, so the action stays
  // paused. The agent is `autonomous`, proving the gate fires regardless of trust.
  const result = await executeRun(store, agent, "delete the dist files", {
    adapter: toolCallingAdapter("delete_files", { command: "rm -rf dist" }),
    capabilities: [deleteFilesCapability()],
  });

  expect(result.status).toBe("awaiting_confirmation");
  // The run is left non-terminal — it did not "finish".
  expect(result.run.status).toBe("awaiting_confirmation");
  expect(result.run.finishedAt).toBeUndefined();
  // It kept what it produced (the awaiting-confirmation notice), so it stays
  // reflectable rather than losing its transcript.
  expect(result.output).toContain("awaiting confirmation");
  expect(store.runs.get(agent.id, result.run.id)?.output).toContain("awaiting confirmation");

  // The gate decision and the status pause are both on the record.
  const types = store.events.tail(agent.id).map((e) => e.type);
  expect(types).toContain("action.awaiting_confirmation");
  expect(types).toContain("run.status_changed");
});

test("a confirmed destructive action resumes and finishes done, not stranded paused", async () => {
  // `confirm` resolves truthy ⇒ the gate pauses, gets its yes, and runs the
  // action. The run must then finish `done` — the confirmed side effect actually
  // happened, so leaving it stuck at `awaiting_confirmation` would misreport a
  // completed deletion as still pending (the gate's "resume" contract).
  const result = await executeRun(store, agent, "delete the dist files", {
    adapter: toolCallingAdapter("delete_files", { command: "rm -rf dist" }),
    capabilities: [deleteFilesCapability()],
    confirm: () => true,
  });

  expect(result.status).toBe("done");
  expect(result.run.status).toBe("done");
  expect(result.run.finishedAt).toBeDefined();
  // The tool truly ran — its output, not the awaiting-confirmation notice.
  expect(result.output).toBe("deleted");
  expect(result.output).not.toContain("awaiting confirmation");
  expect(store.runs.get(agent.id, result.run.id)?.status).toBe("done");

  // The record shows confirmation was required AND then the action executed.
  const types = store.events.tail(agent.id).map((e) => e.type);
  expect(types).toContain("action.awaiting_confirmation");
  expect(types).toContain("action.executed");
});

// --- streaming + action summary (#16) ------------------------------------

test("forwards the substrate's lifecycle events to onEvent, in order", async () => {
  const seen: RunEvent[] = [];
  const events: RunEvent[] = [
    { type: "agent_start", payload: {} },
    { type: "tool_execution_start", payload: { tool: "write_file" } },
    { type: "tool_execution_end", payload: { tool: "write_file", isError: false } },
    { type: "agent_end", payload: { messages: 2 } },
  ];
  await executeRun(store, agent, "do it", {
    adapter: eventEmittingAdapter(events, { status: "done", text: "ok" }),
    onEvent: (event) => seen.push(event),
  });
  expect(seen).toEqual(events);
});

test("still forwards events when the run fails, draining before it returns", async () => {
  const seen: string[] = [];
  const events: RunEvent[] = [
    { type: "agent_start", payload: {} },
    { type: "run_error", payload: { error: "boom" } },
  ];
  const result = await executeRun(store, agent, "do it", {
    adapter: eventEmittingAdapter(events, { status: "failed", text: "", error: "boom" }),
    onEvent: (event) => seen.push(event.type),
  });
  expect(result.status).toBe("failed");
  // The stream was fully drained before the function returned, not dropped on failure.
  expect(seen).toEqual(["agent_start", "run_error"]);
});

test("a throwing onEvent sink never breaks the run", async () => {
  const result = await executeRun(store, agent, "do it", {
    adapter: eventEmittingAdapter([{ type: "agent_start", payload: {} }], {
      status: "done",
      text: "ok",
    }),
    onEvent: () => {
      throw new Error("faulty sink");
    },
  });
  expect(result.status).toBe("done");
  expect(result.output).toBe("ok");
});

test("summarizes an executed action by capability + classified effect, never its args", async () => {
  const result = await executeRun(store, agent, "write a file", {
    adapter: toolCallingAdapter("write_file", { path: "notes.md", content: "secret-ish" }),
    capabilities: [writeFileCapability()],
  });
  expect(result.status).toBe("done");
  expect(result.actions).toEqual([
    { capability: "write_file", effect: "write", decision: "executed" },
  ]);
  // References only: an argument value never appears in the summary.
  expect(JSON.stringify(result.actions)).not.toContain("notes.md");
  expect(JSON.stringify(result.actions)).not.toContain("secret-ish");
});

test("summarizes a withheld action under propose", async () => {
  const proposer = store.createAgent({
    name: "work",
    role: "careful consultant",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/work",
    trustLevel: "propose",
  });
  const result = await executeRun(store, proposer, "write a file", {
    adapter: toolCallingAdapter("write_file", { path: "notes.md" }),
    capabilities: [writeFileCapability()],
  });
  expect(result.status).toBe("done");
  expect(result.actions).toEqual([
    { capability: "write_file", effect: "write", decision: "withheld" },
  ]);
});

test("summarizes a paused destructive action", async () => {
  const result = await executeRun(store, agent, "delete the dist files", {
    adapter: toolCallingAdapter("delete_files", { command: "rm -rf dist" }),
    capabilities: [deleteFilesCapability()],
  });
  expect(result.status).toBe("awaiting_confirmation");
  expect(result.actions).toEqual([
    { capability: "delete_files", effect: "destructive", decision: "paused" },
  ]);
});

test("a confirmed destructive action is summarized as executed, not paused", async () => {
  // The transient pause must not double-count: once confirmed and run, it is one
  // executed action, not a pause AND an execution.
  const result = await executeRun(store, agent, "delete the dist files", {
    adapter: toolCallingAdapter("delete_files", { command: "rm -rf dist" }),
    capabilities: [deleteFilesCapability()],
    confirm: () => true,
  });
  expect(result.status).toBe("done");
  expect(result.actions).toEqual([
    { capability: "delete_files", effect: "destructive", decision: "executed" },
  ]);
});

test("a run that takes no actions has an empty summary", async () => {
  const result = await executeRun(store, agent, "just answer", {
    adapter: cannedAdapter({ status: "done", text: "answered" }),
  });
  expect(result.actions).toEqual([]);
});

test("a concurrently-started action does not drop the paused destructive one", async () => {
  // The substrate had a write call already in flight when a destructive call
  // paused the run. The write's `onExecute` fires after the pause, but it must NOT
  // clear it — the summary has to keep the action that actually required
  // confirmation. (Aborting the run cannot retract a call already started.)
  const concurrentAdapter: RuntimeAdapter = {
    run(request) {
      const tools = request.tools.list();
      const del = tools.find((t) => t.name === "delete_files");
      const write = tools.find((t) => t.name === "write_file");
      const output = (async (): Promise<RunOutput> => {
        // del.execute pauses + aborts; write.execute (already in flight) still runs.
        await Promise.allSettled([
          del?.execute({ args: { command: "rm -rf dist" } }, request.signal),
          write?.execute({ args: { path: "notes.md" } }, request.signal),
        ]);
        return { status: "done", text: "ran" };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };

  const result = await executeRun(store, agent, "tidy and delete dist", {
    adapter: concurrentAdapter,
    capabilities: [deleteFilesCapability(), writeFileCapability()],
  });

  // The destructive action paused the run, and the concurrent write did not undo it.
  expect(result.status).toBe("awaiting_confirmation");
  expect(result.actions).toContainEqual({
    capability: "delete_files",
    effect: "destructive",
    decision: "paused",
  });
  expect(result.actions).toContainEqual({
    capability: "write_file",
    effect: "write",
    decision: "executed",
  });
});

test("two destructive actions that pause concurrently are both kept, in order", async () => {
  // The substrate starts two destructive calls before either aborts. The summary
  // must keep BOTH paused gate decisions (a single pending slot would drop the
  // first), in the order they occurred.
  const twoDestructiveAdapter: RuntimeAdapter = {
    run(request) {
      const tools = request.tools.list();
      const del = tools.find((t) => t.name === "delete_files");
      const drop = tools.find((t) => t.name === "drop_table");
      const output = (async (): Promise<RunOutput> => {
        await Promise.allSettled([
          del?.execute({ args: { command: "rm -rf dist" } }, request.signal),
          drop?.execute({ args: { command: "DROP TABLE users" } }, request.signal),
        ]);
        return { status: "done", text: "ran" };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };

  const result = await executeRun(store, agent, "delete dist and drop the table", {
    adapter: twoDestructiveAdapter,
    capabilities: [deleteFilesCapability(), dropTableCapability()],
  });

  expect(result.status).toBe("awaiting_confirmation");
  expect(result.actions).toEqual([
    { capability: "delete_files", effect: "destructive", decision: "paused" },
    { capability: "drop_table", effect: "destructive", decision: "paused" },
  ]);
});

// --- resume a gate-paused run out-of-band (#17) --------------------------

/**
 * A substrate stand-in that drives a sequence of tools in order, stopping the
 * moment one returns an error (the gate's awaiting-confirmation result) or the run
 * is aborted — exactly like a real loop. Re-invoked on resume, it replays the same
 * sequence, so a now-approved destructive tool gets past the gate this time.
 */
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

test("resumeRun reports not_found for an unknown run", async () => {
  const outcome = await resumeRun(store, agent, "no-such-run", {
    adapter: cannedAdapter({ status: "done", text: "x" }),
  });
  expect(outcome.kind).toBe("not_found");
});

test("resumeRun reports not_paused for a run that already finished", async () => {
  const done = await executeRun(store, agent, "just answer", {
    adapter: cannedAdapter({ status: "done", text: "answered" }),
  });
  const outcome = await resumeRun(store, agent, done.run.id, {
    adapter: cannedAdapter({ status: "done", text: "again" }),
  });
  expect(outcome.kind).toBe("not_paused");
  if (outcome.kind === "not_paused") expect(outcome.run.status).toBe("done");
});

test("a confirmed resume re-enters the loop, executes the action, and finishes done", async () => {
  const adapter = sequenceAdapter([{ tool: "delete_files", args: { command: "rm -rf dist" } }]);
  // First run parks: no confirm, so the destructive action stops the run.
  const parked = await executeRun(store, agent, "delete the dist files", {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(parked.status).toBe("awaiting_confirmation");

  // Confirming resumes the SAME run and lets the pending capability through.
  const outcome = await resumeRun(store, agent, parked.run.id, {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(outcome.kind).toBe("resumed");
  if (outcome.kind !== "resumed") return;
  expect(outcome.result.status).toBe("done");
  expect(outcome.result.output).toBe("deleted");
  // Same run row, now terminal — not a new run.
  expect(outcome.result.run.id).toBe(parked.run.id);
  expect(store.runs.list(agent.id)).toHaveLength(1);
  expect(store.runs.get(agent.id, parked.run.id)?.status).toBe("done");

  // The resume is on the record: the grant (run.resumed, naming the confirmed
  // capability) precedes the action it permitted (action.executed).
  const types = store.events.tail(agent.id).map((e) => e.type);
  expect(types).toContain("run.resumed");
  const resumed = store.events
    .tail(agent.id)
    .find((e) => e.type === "run.resumed");
  expect((resumed?.payload as { confirmed: string[] }).confirmed).toEqual(["delete_files"]);
  // The summary counts ONE executed action, not a pause-then-execute pair.
  expect(outcome.result.actions).toEqual([
    { capability: "delete_files", effect: "destructive", decision: "executed" },
  ]);
});

test("a resume approves only the pending capability; a different destructive action re-pauses", async () => {
  // The agent deletes (the pending action) and then drops a table (a NEW
  // destructive action). The first run parks on the delete before it ever reaches
  // the drop.
  const adapter = sequenceAdapter([
    { tool: "delete_files", args: { command: "rm -rf dist" } },
    { tool: "drop_table", args: { command: "DROP TABLE users" } },
  ]);
  const parked = await executeRun(store, agent, "delete dist then drop the table", {
    adapter,
    capabilities: [deleteFilesCapability(), dropTableCapability()],
  });
  expect(parked.status).toBe("awaiting_confirmation");

  // Confirming the delete lets it through — but the drop is a different capability
  // the human never confirmed, so the gate pauses the run again rather than
  // auto-running it. The confirmation did NOT become a blanket destructive grant.
  const first = await resumeRun(store, agent, parked.run.id, {
    adapter,
    capabilities: [deleteFilesCapability(), dropTableCapability()],
  });
  expect(first.kind).toBe("resumed");
  if (first.kind !== "resumed") return;
  expect(first.result.status).toBe("awaiting_confirmation");

  // Confirming again converges: the second pending capability now runs and the run
  // completes.
  const second = await resumeRun(store, agent, parked.run.id, {
    adapter,
    capabilities: [deleteFilesCapability(), dropTableCapability()],
  });
  expect(second.kind).toBe("resumed");
  if (second.kind !== "resumed") return;
  expect(second.result.status).toBe("done");
  expect(store.runs.get(agent.id, parked.run.id)?.status).toBe("done");
});

test("a resume approves only the count confirmed, not every call of a capability", async () => {
  // Two deletes through the SAME capability with different targets. The run parks on
  // the first; confirming it must clear ONLY that one — the second is a distinct
  // destructive action and pauses on its own. A capability-blanket grant would
  // wrongly delete the second, unconfirmed target too.
  const deleted: string[] = [];
  const recordingDelete: Capability = {
    key: "delete_files",
    effect: "destructive",
    tool: {
      name: "delete_files",
      description: "delete a path",
      inputSchema: { type: "object", properties: {} },
      execute: (inv) => {
        const path = (inv.args as { path?: string } | undefined)?.path ?? "?";
        deleted.push(path);
        return { output: `deleted ${path}` };
      },
    },
  };
  const adapter = sequenceAdapter([
    { tool: "delete_files", args: { path: "dist" } },
    { tool: "delete_files", args: { path: "cache" } },
  ]);

  const parked = await executeRun(store, agent, "delete dist and cache", {
    adapter,
    capabilities: [recordingDelete],
  });
  expect(parked.status).toBe("awaiting_confirmation");
  expect(deleted).toEqual([]); // parked before anything was deleted

  // First confirm clears exactly one delete; the second re-pauses.
  const first = await resumeRun(store, agent, parked.run.id, {
    adapter,
    capabilities: [recordingDelete],
  });
  expect(first.kind).toBe("resumed");
  if (first.kind !== "resumed") return;
  expect(first.result.status).toBe("awaiting_confirmation");
  expect(deleted).toEqual(["dist"]); // ONLY the confirmed delete ran — never cache

  // Confirming again clears the second delete and the run completes. The replay
  // re-ran the first delete (a documented re-execution cost); what matters is that
  // `cache` was never deleted without its own confirmation.
  const second = await resumeRun(store, agent, parked.run.id, {
    adapter,
    capabilities: [recordingDelete],
  });
  expect(second.kind).toBe("resumed");
  if (second.kind !== "resumed") return;
  expect(second.result.status).toBe("done");
  expect(deleted).toEqual(["dist", "dist", "cache"]);
});

test("a confirm clears one concurrently-paused action at a time, not all at once", async () => {
  // A substrate that fires two destructive calls before the abort lands, so the run
  // pauses on BOTH at once. A single confirm must approve only ONE of them — the
  // other re-pauses and needs its own confirm. One "yes" never green-lights both.
  const executed: string[] = [];
  const recording = (key: string): Capability => ({
    key,
    effect: "destructive",
    tool: {
      name: key,
      description: key,
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        executed.push(key);
        return { output: `${key} ran` };
      },
    },
  });
  const concurrentAdapter: RuntimeAdapter = {
    run(request) {
      const tools = request.tools.list();
      const del = tools.find((t) => t.name === "delete_files");
      const drop = tools.find((t) => t.name === "drop_table");
      const output = (async (): Promise<RunOutput> => {
        await Promise.allSettled([
          del?.execute({ args: { command: "rm -rf dist" } }, request.signal),
          drop?.execute({ args: { command: "DROP TABLE users" } }, request.signal),
        ]);
        return { status: "done", text: "ran" };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };

  const caps = [recording("delete_files"), recording("drop_table")];
  const parked = await executeRun(store, agent, "delete dist and drop the table", {
    adapter: concurrentAdapter,
    capabilities: caps,
  });
  expect(parked.status).toBe("awaiting_confirmation");
  expect(executed).toEqual([]); // both paused, nothing ran

  // First confirm: exactly ONE of the two concurrently-paused actions runs.
  const first = await resumeRun(store, agent, parked.run.id, {
    adapter: concurrentAdapter,
    capabilities: caps,
  });
  expect(first.kind).toBe("resumed");
  if (first.kind !== "resumed") return;
  expect(first.result.status).toBe("awaiting_confirmation");
  expect(executed).toHaveLength(1); // only one — a single confirm did not approve both

  // A second confirm clears the other; now both have run and the run completes.
  const second = await resumeRun(store, agent, parked.run.id, {
    adapter: concurrentAdapter,
    capabilities: caps,
  });
  expect(second.kind).toBe("resumed");
  if (second.kind !== "resumed") return;
  expect(second.result.status).toBe("done");
  expect(new Set(executed)).toEqual(new Set(["delete_files", "drop_table"]));
});

test("a resume binds approval to the exact action: a reordered same-capability target re-pauses", async () => {
  // The replay is not guaranteed to reproduce the original order. Here the agent
  // paused on a delete of `dist`, but on resume the replay tries `cache` FIRST — a
  // target the human never confirmed. The grant is fingerprinted to `dist`, so the
  // gate must NOT spend it on `cache`; `cache` re-pauses and is never deleted.
  const deleted: string[] = [];
  const recordingDelete: Capability = {
    key: "delete_files",
    effect: "destructive",
    tool: {
      name: "delete_files",
      description: "delete a path",
      inputSchema: { type: "object", properties: {} },
      execute: (inv) => {
        const path = (inv.args as { path?: string } | undefined)?.path ?? "?";
        deleted.push(path);
        return { output: `deleted ${path}` };
      },
    },
  };
  // Invocation 0 (initial run) deletes dist; invocation 1+ (resume) reorders to cache-first.
  let invocation = 0;
  const reorderingAdapter: RuntimeAdapter = {
    run(request) {
      const calls =
        invocation++ === 0
          ? [{ path: "dist" }]
          : [{ path: "cache" }, { path: "dist" }];
      const output = (async (): Promise<RunOutput> => {
        const texts: string[] = [];
        for (const args of calls) {
          if (request.signal?.aborted) break;
          const tool = request.tools.list().find((t) => t.name === "delete_files");
          if (!tool) continue;
          const result = await tool.execute({ args }, request.signal);
          texts.push(result.output);
          if (result.isError) break;
        }
        return { status: "done", text: texts.join("\n") };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };

  const parked = await executeRun(store, agent, "delete dist (cache comes later)", {
    adapter: reorderingAdapter,
    capabilities: [recordingDelete],
  });
  expect(parked.status).toBe("awaiting_confirmation");
  expect(deleted).toEqual([]);

  // Confirm the `dist` pause. The replay reorders to `cache` first — but that is a
  // different invocation than was confirmed, so the gate pauses on it.
  const resumed = await resumeRun(store, agent, parked.run.id, {
    adapter: reorderingAdapter,
    capabilities: [recordingDelete],
  });
  expect(resumed.kind).toBe("resumed");
  if (resumed.kind !== "resumed") return;
  expect(resumed.result.status).toBe("awaiting_confirmation");
  // The unconfirmed target was NOT deleted — the approval did not transfer to it.
  expect(deleted).not.toContain("cache");
  expect(deleted).toEqual([]);
});

test("a resume that re-pauses with no new text does not keep the prior attempt's transcript", async () => {
  // The first pause persisted a transcript. The resume re-runs from the start and
  // pauses again before producing any text; the row must not still carry the stale
  // first-attempt transcript (which `reflect` could otherwise pick up).
  let invocation = 0;
  const adapter: RuntimeAdapter = {
    run(request) {
      const n = invocation++;
      const output = (async (): Promise<RunOutput> => {
        const tool = request.tools.list().find((t) => t.name === "delete_files");
        if (n === 0) {
          await tool?.execute({ args: { path: "dist" } }, request.signal);
          return { status: "done", text: "STALE-FIRST-ATTEMPT" };
        }
        // On resume the replay reaches a NEW destructive target first, which has no
        // budget, so it pauses again — and this attempt produced no text.
        await tool?.execute({ args: { path: "cache" } }, request.signal);
        return { status: "done", text: "" };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };

  const parked = await executeRun(store, agent, "delete dist", {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(parked.status).toBe("awaiting_confirmation");
  expect(store.runs.get(agent.id, parked.run.id)?.output).toBe("STALE-FIRST-ATTEMPT");

  const resumed = await resumeRun(store, agent, parked.run.id, {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(resumed.kind).toBe("resumed");
  if (resumed.kind !== "resumed") return;
  expect(resumed.result.status).toBe("awaiting_confirmation");
  // The re-run cleared the stale transcript; nothing for `reflect` to pick up.
  expect(store.runs.get(agent.id, parked.run.id)?.output ?? "").not.toContain("STALE-FIRST-ATTEMPT");
});

test("recordRunResumed is an atomic claim: a second confirm on a claimed run loses", async () => {
  // The store-level guard behind concurrent-confirm safety. Two confirms racing the
  // same parked run must not both proceed: the compare-and-set lets exactly one flip
  // awaiting_confirmation → running.
  const adapter = sequenceAdapter([{ tool: "delete_files", args: { command: "rm -rf dist" } }]);
  const parked = await executeRun(store, agent, "delete the dist files", {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(parked.status).toBe("awaiting_confirmation");

  // First claim wins and flips the run to running.
  const won = store.recordRunResumed(agent.id, parked.run.id, ["delete_files"], []);
  expect(won?.status).toBe("running");
  // A second claim on the now-running run claims nothing.
  const lost = store.recordRunResumed(agent.id, parked.run.id, ["delete_files"], []);
  expect(lost).toBeUndefined();
  // Exactly one run.resumed was recorded — the resume that actually happened.
  expect(
    store.events.tail(agent.id, { type: "run.resumed" }),
  ).toHaveLength(1);
});

test("resumeRun treats a lost claim as not_paused and never re-runs the loop", async () => {
  const ran: string[] = [];
  const spyDelete: Capability = {
    key: "delete_files",
    effect: "destructive",
    tool: {
      name: "delete_files",
      description: "delete",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        ran.push("delete_files");
        return { output: "deleted" };
      },
    },
  };
  const adapter = sequenceAdapter([{ tool: "delete_files", args: { command: "rm -rf dist" } }]);
  const parked = await executeRun(store, agent, "delete the dist files", {
    adapter,
    capabilities: [spyDelete],
  });
  expect(parked.status).toBe("awaiting_confirmation");

  // A concurrent confirm already claimed the run (it is now `running`).
  store.recordRunResumed(agent.id, parked.run.id, ["delete_files"], []);
  // This confirm must NOT execute the destructive action a second time.
  const outcome = await resumeRun(store, agent, parked.run.id, {
    adapter,
    capabilities: [spyDelete],
  });
  expect(outcome.kind).toBe("not_paused");
  expect(ran).toEqual([]);
});

test("resume never crosses agents: one agent cannot confirm another's parked run", async () => {
  const other = store.createAgent({
    name: "work",
    role: "careful consultant",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/work",
    trustLevel: "autonomous",
  });
  const adapter = sequenceAdapter([{ tool: "delete_files", args: { command: "rm -rf dist" } }]);
  const parked = await executeRun(store, agent, "delete the dist files", {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(parked.status).toBe("awaiting_confirmation");

  // `work` resuming `personal`'s run id finds nothing — the lookup is agent-scoped,
  // so a foreign run is indistinguishable from a missing one.
  const outcome = await resumeRun(store, other, parked.run.id, {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(outcome.kind).toBe("not_found");
  // personal's run is untouched — still parked, never resumed by another agent.
  expect(store.runs.get(agent.id, parked.run.id)?.status).toBe("awaiting_confirmation");
});

test("a run completes even if the adapter never closes its event stream", async () => {
  // The RunHandle contract settles output and events independently. An adapter that
  // resolves output but leaves its event stream open forever must not hang the run:
  // once output settles the kernel stops waiting on the stream.
  const neverClosingAdapter: RuntimeAdapter = {
    run() {
      async function* events() {
        yield { type: "agent_start", payload: {} } as const;
        await new Promise<void>(() => {}); // never resolves ⇒ stream never closes
      }
      return { events: events(), output: Promise.resolve({ status: "done", text: "ok" }) };
    },
  };

  const result = await executeRun(store, agent, "do it", {
    adapter: neverClosingAdapter,
    onEvent: () => {
      // A sink is present, so the stream is actually consumed (and would hang here
      // without the bound).
    },
  });
  expect(result.status).toBe("done");
  expect(result.output).toBe("ok");
});
