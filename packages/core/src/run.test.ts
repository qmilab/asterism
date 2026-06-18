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

import { declineRun, executeRun, resumeRun } from "./run.js";
import { AsterismStore } from "./store.js";
import type { RuntimeAdapter, RunEvent, RunOutput } from "./adapter.js";
import type { Capability } from "./trust.js";
import type { RecallProvider } from "./recall.js";
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

/**
 * A substrate stand-in that captures the framed system prompt (what recall +
 * framing produced) into `sink`, so a test can assert WHICH memories framed the
 * run, then resolves a trivial output.
 */
function capturingAdapter(sink: { systemPrompt?: string }): RuntimeAdapter {
  return {
    run(request) {
      sink.systemPrompt = request.systemPrompt;
      async function* noEvents() {}
      return { events: noEvents(), output: Promise.resolve({ status: "done", text: "ok" }) };
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

test("a confirmed destructive action runs inline and finishes done, never persisting a pause", async () => {
  // `confirm` resolves truthy ⇒ the gate asks, gets its yes, and runs the action
  // WITHOUT first persisting `awaiting_confirmation`. The run finishes `done`, and —
  // because the pause is recorded only on denial — the run never momentarily looked
  // parked, so a concurrent out-of-band confirm could not have raced this live one.
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

  // The destructive action is on the record as executed; an inline yes leaves no
  // `awaiting_confirmation` event (the run never parked).
  const types = store.events.tail(agent.id).map((e) => e.type);
  expect(types).toContain("action.executed");
  expect(types).not.toContain("action.awaiting_confirmation");
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
  // re-runs the task from the start, but the already-confirmed `dist` delete is
  // SKIPPED (not repeated), so each delete happens exactly once.
  const second = await resumeRun(store, agent, parked.run.id, {
    adapter,
    capabilities: [recordingDelete],
  });
  expect(second.kind).toBe("resumed");
  if (second.kind !== "resumed") return;
  expect(second.result.status).toBe("done");
  expect(deleted).toEqual(["dist", "cache"]);
});

test("a multi-step run does not re-execute an already-confirmed destructive action", async () => {
  // Confirm A, then the run reaches B; confirming B re-runs the task from the start,
  // but A — already confirmed and executed — must NOT run a second time.
  const executed: string[] = [];
  const cap = (key: string): Capability => ({
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
  // Sequential: the run pauses on `delete_files` first; once that is confirmed it
  // reaches `drop_table`.
  const adapter = sequenceAdapter([
    { tool: "delete_files", args: { path: "dist" } },
    { tool: "drop_table", args: { command: "DROP TABLE t" } },
  ]);
  const caps = [cap("delete_files"), cap("drop_table")];

  const parked = await executeRun(store, agent, "delete then drop", {
    adapter,
    capabilities: caps,
  });
  expect(parked.status).toBe("awaiting_confirmation");

  // Confirm 1: delete_files runs; drop_table pauses.
  const first = await resumeRun(store, agent, parked.run.id, { adapter, capabilities: caps });
  expect(first.kind).toBe("resumed");
  if (first.kind !== "resumed") return;
  expect(first.result.status).toBe("awaiting_confirmation");
  expect(executed).toEqual(["delete_files"]);

  // Confirm 2: drop_table runs — and delete_files is SKIPPED, not executed again.
  const second = await resumeRun(store, agent, parked.run.id, { adapter, capabilities: caps });
  expect(second.kind).toBe("resumed");
  if (second.kind !== "resumed") return;
  expect(second.result.status).toBe("done");
  expect(executed).toEqual(["delete_files", "drop_table"]); // delete_files ran exactly once
});

test("a confirmed destructive action that returned an error is not repeated on resume", async () => {
  // A destructive tool can perform its irreversible side effect yet return `isError`
  // (the API timed out, the response failed to parse). `isError` does not tell us
  // whether the effect happened, so the attempt is counted and a later resume must
  // NOT repeat it — at most once, or it could double-charge / double-delete.
  let deleteAttempts = 0;
  const succeeded: string[] = [];
  const erroringDelete: Capability = {
    key: "delete_files",
    effect: "destructive",
    tool: {
      name: "delete_files",
      description: "delete",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        // Every attempt reports an error (the ambiguous case), so a re-run would be
        // observable as a second attempt.
        deleteAttempts += 1;
        return { output: "ambiguous timeout", isError: true };
      },
    },
  };
  const drop: Capability = {
    key: "drop_table",
    effect: "destructive",
    tool: {
      name: "drop_table",
      description: "drop",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        succeeded.push("drop_table");
        return { output: "dropped" };
      },
    },
  };
  // A loop that, unlike `sequenceAdapter`, does NOT stop on a tool error (a failure
  // is not a pause) — it continues to the next call, the way a real agent loop that
  // saw an error and pressed on would. It stops only when the run is aborted (a pause).
  const adapter: RuntimeAdapter = {
    run(request) {
      const steps = [
        { tool: "delete_files", args: { path: "dist" } },
        { tool: "drop_table", args: { command: "DROP TABLE t" } },
      ];
      const output = (async (): Promise<RunOutput> => {
        for (const step of steps) {
          if (request.signal?.aborted) break;
          const tool = request.tools.list().find((t) => t.name === step.tool);
          await tool?.execute({ args: step.args }, request.signal);
        }
        return { status: "done", text: "" };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
  const caps = [erroringDelete, drop];

  const parked = await executeRun(store, agent, "delete then drop", {
    adapter,
    capabilities: caps,
  });
  expect(parked.status).toBe("awaiting_confirmation");

  // Confirm 1: delete_files is attempted (errors); the run reaches drop_table and pauses.
  const first = await resumeRun(store, agent, parked.run.id, { adapter, capabilities: caps });
  expect(first.kind).toBe("resumed");
  if (first.kind !== "resumed") return;
  expect(first.result.status).toBe("awaiting_confirmation");
  expect(deleteAttempts).toBe(1);

  // Confirm 2: delete_files is SKIPPED — its irreversible effect may have happened,
  // so it is not retried; drop_table runs and the run completes.
  const second = await resumeRun(store, agent, parked.run.id, { adapter, capabilities: caps });
  expect(second.kind).toBe("resumed");
  if (second.kind !== "resumed") return;
  expect(second.result.status).toBe("done");
  expect(deleteAttempts).toBe(1); // NOT repeated, despite the error
  expect(succeeded).toEqual(["drop_table"]);
});

test("a confirmed destructive action runs to completion even if a concurrent sibling aborts the run first", async () => {
  // On resume the substrate fires the confirmed delete and an unconfirmed drop at
  // once. The drop pauses and aborts the shared signal BEFORE the delete runs. The
  // delete's tool honors cancellation — but because it is confirmed it must still
  // run (and be counted once), not bail on the sibling's abort and be lost.
  const deleted: string[] = [];
  const signalHonoringDelete: Capability = {
    key: "delete_files",
    effect: "destructive",
    tool: {
      name: "delete_files",
      description: "delete",
      inputSchema: { type: "object", properties: {} },
      execute: (_inv, signal) => {
        if (signal?.aborted) return { output: "skipped: aborted", isError: true };
        deleted.push("delete_files");
        return { output: "deleted" };
      },
    },
  };
  const drop: Capability = {
    key: "drop_table",
    effect: "destructive",
    tool: {
      name: "drop_table",
      description: "drop",
      inputSchema: { type: "object", properties: {} },
      execute: () => ({ output: "dropped" }),
    },
  };
  let invocation = 0;
  const adapter: RuntimeAdapter = {
    run(request) {
      const n = invocation++;
      const output = (async (): Promise<RunOutput> => {
        const tools = request.tools.list();
        const del = tools.find((t) => t.name === "delete_files");
        const dropTool = tools.find((t) => t.name === "drop_table");
        if (n === 0) {
          // Initial run pauses on the delete (the first destructive action).
          await del?.execute({ args: { path: "dist" } }, request.signal);
        } else {
          // Resume: fire the drop FIRST (it pauses + aborts the signal), then the
          // now-confirmed delete — which must still run.
          await Promise.allSettled([
            dropTool?.execute({ args: { command: "DROP TABLE t" } }, request.signal),
            del?.execute({ args: { path: "dist" } }, request.signal),
          ]);
        }
        return { status: "done", text: "" };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
  const caps = [signalHonoringDelete, drop];

  const parked = await executeRun(store, agent, "delete then maybe drop", {
    adapter,
    capabilities: caps,
  });
  expect(parked.status).toBe("awaiting_confirmation");
  expect(deleted).toEqual([]);

  // Confirm the delete. On the replay the drop aborts first, but the confirmed
  // delete still runs to completion (it ignores the sibling's abort) and is counted.
  const first = await resumeRun(store, agent, parked.run.id, { adapter, capabilities: caps });
  expect(first.kind).toBe("resumed");
  if (first.kind !== "resumed") return;
  expect(deleted).toEqual(["delete_files"]); // ran despite the abort — not lost
  expect(first.result.status).toBe("awaiting_confirmation"); // re-paused on the drop
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

test("claimRunForResume is an atomic claim: a second confirm on a claimed run loses", async () => {
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
  const won = store.claimRunForResume(agent.id, parked.run.id);
  expect(won?.status).toBe("running");
  // A second claim on the now-running run claims nothing.
  const lost = store.claimRunForResume(agent.id, parked.run.id);
  expect(lost).toBeUndefined();
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
  store.claimRunForResume(agent.id, parked.run.id);
  // This confirm must NOT execute the destructive action a second time.
  const outcome = await resumeRun(store, agent, parked.run.id, {
    adapter,
    capabilities: [spyDelete],
  });
  expect(outcome.kind).toBe("not_paused");
  expect(ran).toEqual([]);
});

test("a live confirm prompt keeps the run running, so a concurrent confirm cannot double-run it", async () => {
  // Stand in for an interactive run blocked at its [y/N] prompt. While it blocks, the
  // run must NOT be `awaiting_confirmation` — otherwise a separate out-of-band confirm
  // could claim it, start a second loop, and the destructive action would run twice.
  const ran: string[] = [];
  const recordingDelete: Capability = {
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
  // A confirm hook we can hold open at the "prompt".
  let reachPrompt!: () => void;
  let answer!: (approved: boolean) => void;
  const reached = new Promise<void>((r) => (reachPrompt = r));
  const answered = new Promise<boolean>((r) => (answer = r));
  const confirm = (): Promise<boolean> => {
    reachPrompt();
    return answered;
  };

  const runPromise = executeRun(store, agent, "delete the dist files", {
    adapter: toolCallingAdapter("delete_files", { command: "rm -rf dist" }),
    capabilities: [recordingDelete],
    confirm,
  });

  await reached; // the run is now blocked inside confirm, as if at the prompt
  const runId = store.runs.list(agent.id)[0]!.id;
  // The run is still `running` while the prompt is live — it has not parked.
  expect(store.runs.get(agent.id, runId)?.status).toBe("running");
  // So a concurrent out-of-band confirm finds nothing to claim.
  const concurrent = await resumeRun(store, agent, runId, {
    adapter: toolCallingAdapter("delete_files", { command: "rm -rf dist" }),
    capabilities: [recordingDelete],
  });
  expect(concurrent.kind).toBe("not_paused");

  // Answer yes; the original run executes the action exactly once.
  answer(true);
  const result = await runPromise;
  expect(result.status).toBe("done");
  expect(ran).toEqual(["delete_files"]); // ran once — never twice
});

test("a run paused on two identical destructive invocations can be fully confirmed", async () => {
  // Both calls are the SAME capability AND args (same fingerprint). The grant tracks
  // multiplicity: one confirm clears one, a second clears the other — they do not
  // collapse into a single approval the replay consumes once, stranding the second.
  const executed: string[] = [];
  const recordingDelete: Capability = {
    key: "delete_files",
    effect: "destructive",
    tool: {
      name: "delete_files",
      description: "delete",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        executed.push("delete_files");
        return { output: "deleted" };
      },
    },
  };
  const twiceAdapter: RuntimeAdapter = {
    run(request) {
      const tool = request.tools.list().find((t) => t.name === "delete_files");
      const output = (async (): Promise<RunOutput> => {
        await Promise.allSettled([
          tool?.execute({ args: { path: "dist" } }, request.signal),
          tool?.execute({ args: { path: "dist" } }, request.signal), // identical args
        ]);
        return { status: "done", text: "ran" };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };

  const parked = await executeRun(store, agent, "delete dist (twice)", {
    adapter: twiceAdapter,
    capabilities: [recordingDelete],
  });
  expect(parked.status).toBe("awaiting_confirmation");
  expect(executed).toEqual([]);

  // First confirm clears exactly one of the two identical deletes; the other re-pauses.
  const first = await resumeRun(store, agent, parked.run.id, {
    adapter: twiceAdapter,
    capabilities: [recordingDelete],
  });
  expect(first.kind).toBe("resumed");
  if (first.kind !== "resumed") return;
  expect(first.result.status).toBe("awaiting_confirmation");
  expect(executed).toHaveLength(1);

  // A second confirm clears the second identical delete; the run completes — it is
  // not stranded re-pausing on the duplicate forever.
  const second = await resumeRun(store, agent, parked.run.id, {
    adapter: twiceAdapter,
    capabilities: [recordingDelete],
  });
  expect(second.kind).toBe("resumed");
  if (second.kind !== "resumed") return;
  expect(second.result.status).toBe("done");
  expect(executed.length).toBeGreaterThanOrEqual(2);
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

// --- declineRun (the counterpart to a confirm) -----------------------------

test("declineRun refuses a paused run: it ends failed, logs run.declined, and never runs the action", async () => {
  const adapter = sequenceAdapter([{ tool: "delete_files", args: { command: "rm -rf dist" } }]);
  const parked = await executeRun(store, agent, "delete the dist files", {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(parked.status).toBe("awaiting_confirmation");

  const outcome = declineRun(store, agent, parked.run.id);
  expect(outcome.kind).toBe("declined");
  if (outcome.kind !== "declined") return;
  expect(outcome.run.status).toBe("failed");
  expect(store.runs.get(agent.id, parked.run.id)?.status).toBe("failed");

  const types = store.events.tail(agent.id).map((e) => e.type);
  expect(types).toContain("run.declined");
  // The destructive action paused but was refused — it never executed.
  expect(types).not.toContain("action.executed");
});

test("declineRun reports not_found for an unknown run", () => {
  expect(declineRun(store, agent, "no-such-run").kind).toBe("not_found");
});

test("declineRun reports not_paused for a run that already finished", async () => {
  const done = await executeRun(store, agent, "just answer", {
    adapter: cannedAdapter({ status: "done", text: "answered" }),
  });
  const outcome = declineRun(store, agent, done.run.id);
  expect(outcome.kind).toBe("not_paused");
  if (outcome.kind === "not_paused") expect(outcome.run.status).toBe("done");
});

test("declineRun is agent-scoped: another agent cannot decline this agent's paused run", async () => {
  const adapter = sequenceAdapter([{ tool: "delete_files", args: { command: "rm -rf dist" } }]);
  const parked = await executeRun(store, agent, "delete dist", {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(parked.status).toBe("awaiting_confirmation");

  const other = store.createAgent({
    name: "work",
    role: "",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/work",
    trustLevel: "autonomous",
  });
  // Naming the run under another agent's scope finds nothing — it is never declined.
  expect(declineRun(store, other, parked.run.id).kind).toBe("not_found");
  expect(store.runs.get(agent.id, parked.run.id)?.status).toBe("awaiting_confirmation");
});

test("decline and confirm are mutually exclusive: a declined run cannot then be confirmed", async () => {
  const adapter = sequenceAdapter([{ tool: "delete_files", args: { command: "rm -rf dist" } }]);
  const parked = await executeRun(store, agent, "delete dist", {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(declineRun(store, agent, parked.run.id).kind).toBe("declined");

  // The claim is gone (the run is failed), so a racing confirm finds nothing to do —
  // the same single-winner guarantee that serializes two confirms.
  const outcome = await resumeRun(store, agent, parked.run.id, {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(outcome.kind).toBe("not_paused");
});

test("declineRun preserves a paused run's persisted output", async () => {
  // The agent produces a transcript, then a destructive action pauses the run — so the
  // parked run already has output. Declining must NOT erase it (a resume would, since
  // it re-runs from the start; a decline does not re-enter the loop), so the refused
  // run stays reflectable and listed with its text.
  const adapter: RuntimeAdapter = {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        const tool = request.tools.list().find((t) => t.name === "delete_files");
        if (tool) await tool.execute({ args: { command: "rm -rf dist" } }, request.signal);
        return { status: "done", text: "progress before the gate" };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
  const parked = await executeRun(store, agent, "do work then delete", {
    adapter,
    capabilities: [deleteFilesCapability()],
  });
  expect(parked.status).toBe("awaiting_confirmation");
  expect(parked.run.output).toBe("progress before the gate"); // persisted at the pause

  const outcome = declineRun(store, agent, parked.run.id);
  expect(outcome.kind).toBe("declined");
  if (outcome.kind === "declined") expect(outcome.run.output).toBe("progress before the gate");
  // The transcript survives the decline on a fresh read, and the run is still found by
  // the reflection target query (`latestWithOutput`).
  expect(store.runs.get(agent.id, parked.run.id)?.output).toBe("progress before the gate");
  expect(store.runs.latestWithOutput(agent.id)?.id).toBe(parked.run.id);
});

// --- structured recall ------------------------------------------------------
//
// Recall selects which of the agent's accepted memories frame a run. The kernel
// resolves the agent's OWN candidates and hands them to the provider, so the
// isolation boundary holds by construction: a run can only ever frame its own
// agent's memory. These prove that at the orchestration level (the unit ranker is
// covered in recall.test.ts).

test("recall frames only the running agent's memories, never another agent's", async () => {
  // A second agent holds memories whose content matches `personal`'s task. Recall
  // must still never surface them — the agent is the isolation boundary.
  const work = store.createAgent({
    name: "work",
    role: "work helper",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/work",
    trustLevel: "propose",
  });
  store.recordMemory(work.id, { memoryType: "semantic", content: "WORK-ONLY staging deploy runbook" });
  store.recordMemory(work.id, { memoryType: "convention", content: "WORK-ONLY always tag the release first" });
  store.recordMemory(agent.id, { memoryType: "semantic", content: "PERSONAL blog deploy checklist" });

  const sink: { systemPrompt?: string } = {};
  const result = await executeRun(store, agent, "help me with the staging deploy", {
    adapter: capturingAdapter(sink),
  });

  expect(result.status).toBe("done");
  expect(sink.systemPrompt).toContain("PERSONAL blog deploy checklist");
  // The other agent's memory never frames this run, however task-relevant it reads.
  expect(sink.systemPrompt).not.toContain("WORK-ONLY");
});

test("recall caps framed memories at the budget and prefers task-relevant ones", async () => {
  // Five accepted memories; only two speak to the task. A budget of 2 frames the two
  // relevant ones and drops the rest — the budget biting once memory grows.
  store.recordMemory(agent.id, { memoryType: "semantic", content: "kiwi mango papaya" });
  store.recordMemory(agent.id, { memoryType: "semantic", content: "the database migration runs at midnight" });
  store.recordMemory(agent.id, { memoryType: "semantic", content: "purple velvet curtains" });
  store.recordMemory(agent.id, { memoryType: "procedural", content: "run the database migration with the staging flag" });
  store.recordMemory(agent.id, { memoryType: "semantic", content: "tangerine zeppelin afternoon" });

  const sink: { systemPrompt?: string } = {};
  await executeRun(store, agent, "how do I run the database migration", {
    adapter: capturingAdapter(sink),
    recallBudget: { maxMemories: 2 },
  });

  expect(sink.systemPrompt).toContain("the database migration runs at midnight");
  expect(sink.systemPrompt).toContain("run the database migration with the staging flag");
  expect(sink.systemPrompt).not.toContain("purple velvet curtains");
  expect(sink.systemPrompt).not.toContain("tangerine zeppelin");
});

test("a recall provider that rejects drives the run to failed, not stuck running", async () => {
  // An injected provider (e.g. a later embeddings / vector backend) can be
  // unavailable and reject. Recall runs after the run is persisted `running`, so an
  // unguarded rejection would strand it there; it must be caught and finished
  // `failed`, exactly like a substrate failure.
  const failingRecall: RecallProvider = {
    recall: () => Promise.reject(new Error("embeddings backend unavailable")),
  };
  const result = await executeRun(store, agent, "do the thing", {
    adapter: cannedAdapter({ status: "done", text: "the adapter should never run" }),
    recall: failingRecall,
  });

  expect(result.status).toBe("failed");
  expect(result.error).toContain("embeddings backend unavailable");
  // Persisted terminal, not left mid-flight.
  expect(store.runs.get(agent.id, result.run.id)?.status).toBe("failed");
});

test("a recall provider cannot smuggle another agent's memory into a run", async () => {
  // The kernel does not trust the (injectable) provider to honor isolation. Even a
  // provider that explicitly returns another agent's memory must not frame it — the
  // kernel keeps only memories from the candidate set it resolved for THIS agent.
  const work = store.createAgent({
    name: "work",
    role: "work helper",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/work",
    trustLevel: "propose",
  });
  const leaked = store.recordMemory(work.id, { memoryType: "semantic", content: "WORK-SECRET cross-agent leak" });
  store.recordMemory(agent.id, { memoryType: "semantic", content: "PERSONAL note" });

  const leakingRecall: RecallProvider = {
    // Returns the OTHER agent's memory regardless of the candidates handed in.
    recall: () => Promise.resolve([leaked]),
  };
  const sink: { systemPrompt?: string } = {};
  const result = await executeRun(store, agent, "anything at all", {
    adapter: capturingAdapter(sink),
    recall: leakingRecall,
  });

  expect(result.status).toBe("done");
  // Dropped by the kernel — it was never in this agent's candidate set.
  expect(sink.systemPrompt).not.toContain("WORK-SECRET");
});

test("a recall provider that returns more than the budget cannot exceed it", async () => {
  // Five accepted memories; a provider that returns ALL of them must still be capped
  // by the kernel at the run's budget.
  const contents = ["mem one", "mem two", "mem three", "mem four", "mem five"];
  const all = contents.map((content) => store.recordMemory(agent.id, { memoryType: "semantic", content }));
  const greedyRecall: RecallProvider = { recall: () => Promise.resolve(all) };

  const sink: { systemPrompt?: string } = {};
  await executeRun(store, agent, "anything", {
    adapter: capturingAdapter(sink),
    recall: greedyRecall,
    recallBudget: { maxMemories: 2 },
  });

  const framed = contents.filter((c) => sink.systemPrompt?.includes(c));
  expect(framed).toHaveLength(2); // the kernel truncated to the budget
});

test("a recall provider that throws synchronously also drives the run to failed", async () => {
  // The guard catches a synchronous throw from `recall(...)` (before it returns a
  // promise) just as it catches a rejection — neither may strand the run `running`.
  const throwingRecall: RecallProvider = {
    recall: () => {
      throw new Error("recall blew up synchronously");
    },
  };
  const result = await executeRun(store, agent, "do the thing", {
    adapter: cannedAdapter({ status: "done", text: "the adapter should never run" }),
    recall: throwingRecall,
  });

  expect(result.status).toBe("failed");
  expect(result.error).toContain("recall blew up synchronously");
  expect(store.runs.get(agent.id, result.run.id)?.status).toBe("failed");
});
