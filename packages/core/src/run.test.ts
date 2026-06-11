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

import { executeRun } from "./run.js";
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
