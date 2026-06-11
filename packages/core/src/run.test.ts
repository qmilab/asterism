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
import type { RuntimeAdapter, RunOutput } from "./adapter.js";
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
