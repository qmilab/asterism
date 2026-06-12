// The node:http binding (serve-node.ts) — exercised over a real socket. `serve()`
// dispatches to `Bun.serve` under Bun, so to cover the Node bridge we call
// `serveNode` directly; node:http runs under Bun too, so the same bridge code that
// serves Node installs is exercised here. The full path is additionally certified
// on a real Node runtime by `scripts/node-acceptance.mjs`.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { AsterismStore } from "@qmilab/asterism-core";
import type { Agent, RuntimeAdapter, RunOutput } from "@qmilab/asterism-core";

import { handleRequest } from "./index.ts";
import type { ServerDeps } from "./index.ts";
import { serveNode } from "./serve-node.ts";

let store: AsterismStore;
let personal: Agent;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  personal = store.createAgent({
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

/** A substrate stand-in that emits one tool lifecycle, then resolves canned output. */
function eventEmittingAdapter(output: RunOutput): RuntimeAdapter {
  return {
    run() {
      async function* events() {
        yield { type: "tool_execution_start" as const, payload: { tool: "fs.write" } };
        yield { type: "tool_execution_end" as const, payload: { tool: "fs.write", isError: false } };
      }
      return { events: events(), output: Promise.resolve(output) };
    },
  };
}

function bind(adapter: RuntimeAdapter) {
  const deps: ServerDeps = { store, agent: personal, adapter };
  return serveNode({ port: 0, hostname: "127.0.0.1" }, (req) => handleRequest(deps, req));
}

test("serveNode binds node:http: a buffered run round-trips over a real socket", async () => {
  const running = await bind(eventEmittingAdapter({ status: "done", text: "hello over node http" }));
  expect(running.port).toBeGreaterThan(0);
  try {
    const ran = await fetch(`${running.url}/agents/personal/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "ping" }),
    });
    expect(ran.status).toBe(201);
    expect(((await ran.json()) as { output: string }).output).toBe("hello over node http");

    const events = await fetch(`${running.url}/agents/personal/events`);
    expect(events.status).toBe(200);
    const ev = (await events.json()) as { events: { type: string }[] };
    expect(ev.events.some((e) => e.type === "run.started")).toBe(true);

    // One agent per server holds at the network edge, node:http or not.
    const other = await fetch(`${running.url}/agents/work/runs`);
    expect(other.status).toBe(404);
  } finally {
    await running.stop();
  }
});

test("serveNode streams SSE frames as the run unfolds", async () => {
  const running = await bind(eventEmittingAdapter({ status: "done", text: "streamed" }));
  try {
    const res = await fetch(`${running.url}/agents/personal/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ input: "ping" }),
    });
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "").includes("text/event-stream")).toBe(true);

    const body = await res.text();
    // The activity frame (tool lifecycle) and the terminal result frame both arrive.
    expect(body).toContain("event: activity");
    expect(body).toContain("event: result");
  } finally {
    await running.stop();
  }
});

test("serveNode drains an in-flight buffered run on stop() instead of aborting it", async () => {
  // A controllable substrate: it signals when the run reaches it, then blocks on a
  // gate so the request is provably in flight when we call stop().
  let runReached!: () => void;
  const reached = new Promise<void>((r) => {
    runReached = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const adapter: RuntimeAdapter = {
    run() {
      runReached();
      async function* noEvents() {}
      return { events: noEvents(), output: gate.then(() => ({ status: "done" as const, text: "drained cleanly" })) };
    },
  };

  const running = await bind(adapter);

  // Fire a buffered run but do not await it yet.
  const inflight = fetch(`${running.url}/agents/personal/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "slow" }),
  });
  await reached; // the handler is now mid-run — the request is genuinely active

  // Begin shutdown while the run is still executing, then let it finish.
  const stopped = running.stop();
  release();

  // The request was drained, not aborted: it still returns its real result.
  const res = await inflight;
  expect(res.status).toBe(201);
  expect(((await res.json()) as { output: string }).output).toBe("drained cleanly");

  // And stop() only resolves once that in-flight run has drained.
  await stopped;
});

test("serveNode answers a malformed body with a clean 400, not a crash", async () => {
  const running = await bind(eventEmittingAdapter({ status: "done", text: "x" }));
  try {
    const res = await fetch(`${running.url}/agents/personal/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  } finally {
    await running.stop();
  }
});
