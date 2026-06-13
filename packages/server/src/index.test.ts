// The HTTP surface — tested against `handleRequest` directly, so no socket binds.
// What we pin: the three endpoints work and stay agent-scoped; the server is bound
// to one agent and refuses any other name; malformed requests fail cleanly; and a
// run with no model configured is declined rather than crashing.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { AsterismStore } from "@qmilab/asterism-core";
import type { Agent, Capability, RuntimeAdapter, RunOutput } from "@qmilab/asterism-core";

import { handleRequest, serve } from "./index.ts";
import type { ServerDeps } from "./index.ts";

let store: AsterismStore;
let personal: Agent;
let work: Agent;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  personal = store.createAgent({
    name: "personal",
    role: "personal helper",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/personal",
    trustLevel: "autonomous",
  });
  work = store.createAgent({
    name: "work",
    role: "careful consultant",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/work",
    trustLevel: "propose",
  });
});

afterEach(() => {
  store.close();
});

/** A substrate stand-in that resolves canned output without touching the network. */
function cannedAdapter(output: RunOutput): RuntimeAdapter {
  return {
    run() {
      async function* noEvents() {}
      return { events: noEvents(), output: Promise.resolve(output) };
    },
  };
}

/** Deps bound to `personal` with a working substrate, unless overridden. */
function deps(over: Partial<ServerDeps> = {}): ServerDeps {
  return {
    store,
    agent: personal,
    adapter: cannedAdapter({ status: "done", text: "hello from the agent" }),
    ...over,
  };
}

const BASE = "http://127.0.0.1:4831";

function get(path: string): Request {
  return new Request(`${BASE}${path}`, { method: "GET" });
}
function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST /agents/:agent/runs starts a run and returns its result", async () => {
  const res = await handleRequest(deps(), post("/agents/personal/runs", { input: "write the blog draft" }));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { status: string; output: string; run: { input: string } };
  expect(json.status).toBe("done");
  expect(json.output).toBe("hello from the agent");
  expect(json.run.input).toBe("write the blog draft");

  // The run was actually persisted, scoped to the agent.
  expect(store.runs.list(personal.id)).toHaveLength(1);
  expect(store.runs.list(work.id)).toHaveLength(0);
});

test("GET /agents/:agent/runs lists only the served agent's runs", async () => {
  await handleRequest(deps(), post("/agents/personal/runs", { input: "task one" }));
  await handleRequest(deps(), post("/agents/personal/runs", { input: "task two" }));

  const res = await handleRequest(deps(), get("/agents/personal/runs"));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { runs: { input: string }[] };
  expect(json.runs.map((r) => r.input)).toEqual(["task one", "task two"]);
});

test("GET /agents/:agent/events returns the agent's log and honors tail params", async () => {
  await handleRequest(deps(), post("/agents/personal/runs", { input: "do a thing" }));

  const all = await handleRequest(deps(), get("/agents/personal/events"));
  expect(all.status).toBe(200);
  const allJson = (await all.json()) as { events: { type: string }[] };
  expect(allJson.events.length).toBeGreaterThan(0);
  expect(allJson.events[0]!.type).toBe("agent.created");

  // --type filter is passed through to the kernel's tail.
  const filtered = await handleRequest(deps(), get("/agents/personal/events?type=run.started"));
  const filteredJson = (await filtered.json()) as { events: { type: string }[] };
  expect(filteredJson.events.every((e) => e.type === "run.started")).toBe(true);
  expect(filteredJson.events).toHaveLength(1);

  // --limit caps the result.
  const limited = await handleRequest(deps(), get("/agents/personal/events?limit=1"));
  const limitedJson = (await limited.json()) as { events: unknown[] };
  expect(limitedJson.events).toHaveLength(1);
});

test("GET /agents/:agent/events ?run= filters to one run and stays agent-scoped", async () => {
  // Give personal a run to filter on, and give work its own run — whose id must
  // never address personal's log.
  const personalRun = store.startRun(personal.id, { input: "personal task" });
  const workRun = store.startRun(work.id, { input: "work task" });

  const mine = await handleRequest(
    deps(),
    get(`/agents/personal/events?run=${personalRun.id}`),
  );
  expect(mine.status).toBe(200);
  const mineJson = (await mine.json()) as { events: { type: string; runId?: string }[] };
  expect(mineJson.events.length).toBeGreaterThan(0);
  expect(mineJson.events.every((e) => e.runId === personalRun.id)).toBe(true);
  // agent.created carries no runId, so a run filter excludes it.
  expect(mineJson.events.some((e) => e.type === "agent.created")).toBe(false);

  // work's run id, ANDed with personal's scope, matches nothing — never work's log.
  const foreign = await handleRequest(
    deps(),
    get(`/agents/personal/events?run=${workRun.id}`),
  );
  expect(foreign.status).toBe(200);
  const foreignJson = (await foreign.json()) as { events: unknown[] };
  expect(foreignJson.events).toEqual([]);
});

test("a server bound to one agent 404s any other agent name", async () => {
  // `work` exists in the store, but this server serves only `personal`. It must
  // not be a back door to another agent's runs or events.
  const runs = await handleRequest(deps(), get("/agents/work/runs"));
  expect(runs.status).toBe(404);
  const events = await handleRequest(deps(), get("/agents/work/events"));
  expect(events.status).toBe(404);
  const start = await handleRequest(deps(), post("/agents/work/runs", { input: "leak" }));
  expect(start.status).toBe(404);
  // Nothing ran for `work`.
  expect(store.runs.list(work.id)).toHaveLength(0);
});

test("a run with no model configured is declined with 503", async () => {
  const res = await handleRequest(
    deps({ adapter: undefined, adapterReason: "Set ASTERISM_MODEL_ID and an API key." }),
    post("/agents/personal/runs", { input: "go" }),
  );
  expect(res.status).toBe(503);
  const json = (await res.json()) as { error: string };
  expect(json.error).toContain("ASTERISM_MODEL_ID");
  expect(store.runs.list(personal.id)).toHaveLength(0);
});

test("a malformed run request is a 400", async () => {
  const notJson = await handleRequest(deps(), post("/agents/personal/runs", "not json{"));
  expect(notJson.status).toBe(400);

  const noInput = await handleRequest(deps(), post("/agents/personal/runs", { nope: 1 }));
  expect(noInput.status).toBe(400);

  const blank = await handleRequest(deps(), post("/agents/personal/runs", { input: "   " }));
  expect(blank.status).toBe(400);

  const badLimit = await handleRequest(deps(), get("/agents/personal/events?limit=-1"));
  expect(badLimit.status).toBe(400);

  // None of the rejected requests started a run.
  expect(store.runs.list(personal.id)).toHaveLength(0);
});

test("a malformed percent-encoded agent name is a clean 404, not a 500", async () => {
  // decodeURIComponent('%') throws; the handler must not leak that as a 500.
  const res = await handleRequest(deps(), get("/agents/%/runs"));
  expect(res.status).toBe(404);
  const bad = await handleRequest(deps(), get("/agents/%ZZ/events"));
  expect(bad.status).toBe(404);
});

test("an empty filter param means 'no filter', not an empty result", async () => {
  await handleRequest(deps(), post("/agents/personal/runs", { input: "do a thing" }));

  // ?type= (empty) must return the whole log, the same as omitting it — not filter
  // on type='' and return nothing.
  const emptyType = await handleRequest(deps(), get("/agents/personal/events?type="));
  expect(emptyType.status).toBe(200);
  const ev = (await emptyType.json()) as { events: unknown[] };
  expect(ev.events.length).toBeGreaterThan(0);

  // ?since= (empty) likewise returns the full log rather than nothing.
  const emptySince = await handleRequest(deps(), get("/agents/personal/events?since="));
  const sinceEv = (await emptySince.json()) as { events: unknown[] };
  expect(sinceEv.events.length).toBeGreaterThan(0);

  // ?run= (empty) returns the whole log rather than filtering on run_id=''.
  const emptyRun = await handleRequest(deps(), get("/agents/personal/events?run="));
  const runEv = (await emptyRun.json()) as { events: unknown[] };
  expect(runEv.events.length).toBeGreaterThan(0);

  // ?limit= (empty) is ignored, not a 400.
  const emptyLimit = await handleRequest(deps(), get("/agents/personal/events?limit="));
  expect(emptyLimit.status).toBe(200);
});

test("an internal error becomes a generic 500 without leaking detail", async () => {
  // A store whose read throws stands in for any kernel-side failure.
  const boom = {
    ...deps(),
    store: {
      ...store,
      runs: {
        list() {
          throw new Error("secret-bearing internal detail");
        },
      },
    } as unknown as ServerDeps["store"],
  };
  const res = await handleRequest(boom, get("/agents/personal/runs"));
  expect(res.status).toBe(500);
  const json = (await res.json()) as { error: string };
  expect(json.error).toBe("Internal server error.");
  expect(json.error).not.toContain("secret-bearing");
});

test("unknown paths 404 and wrong methods 405", async () => {
  expect((await handleRequest(deps(), get("/"))).status).toBe(404);
  expect((await handleRequest(deps(), get("/agents/personal"))).status).toBe(404);
  expect((await handleRequest(deps(), get("/agents/personal/widgets"))).status).toBe(404);

  // events is read-only; runs rejects DELETE.
  const postEvents = await handleRequest(deps(), post("/agents/personal/events", {}));
  expect(postEvents.status).toBe(405);
  const del = await handleRequest(
    deps(),
    new Request(`${BASE}/agents/personal/runs`, { method: "DELETE" }),
  );
  expect(del.status).toBe(405);
});

test("a failed run surfaces its error in the response", async () => {
  const res = await handleRequest(
    deps({ adapter: cannedAdapter({ status: "failed", text: "", error: "model unreachable" }) }),
    post("/agents/personal/runs", { input: "go" }),
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as { status: string; error: string };
  expect(json.status).toBe("failed");
  expect(json.error).toBe("model unreachable");
});

test("host capabilities reach HTTP runs, and the gate still pauses destructive actions", async () => {
  // Surface parity: `capabilities` on ServerDeps mirrors the CLI's CliIO seam, so
  // a host that wires tools sees the same exposure whichever surface starts the
  // run — and over HTTP, with no confirm possible, a destructive action must park
  // the run at awaiting_confirmation without ever executing.
  const executed: string[] = [];
  const destructive: Capability = {
    key: "delete_files",
    effect: "destructive",
    tool: {
      name: "delete_files",
      description: "delete files",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        executed.push("delete_files");
        return { output: "deleted" };
      },
    },
  };
  const toolCallingAdapter: RuntimeAdapter = {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        const tool = request.tools.list().find((t) => t.name === "delete_files");
        if (!tool) return { status: "done", text: "(tool not exposed)" };
        const result = await tool.execute({ args: { command: "rm -rf dist" } }, request.signal);
        return { status: "done", text: result.output };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };

  const res = await handleRequest(
    deps({ adapter: toolCallingAdapter, capabilities: [destructive] }),
    post("/agents/personal/runs", { input: "delete the generated files in dist/" }),
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as { status: string; output: string };
  // The tool WAS exposed (the adapter found it), but the gate paused the run.
  expect(json.output).not.toBe("(tool not exposed)");
  expect(json.status).toBe("awaiting_confirmation");
  expect(executed).toHaveLength(0);
});

test("serve() binds a real socket: a run can be triggered and events read over HTTP", async () => {
  // The real Bun.serve binding (port 0 ⇒ OS-assigned, so no conflict), exercised
  // over a genuine HTTP round-trip rather than handleRequest directly.
  const running = await serve({
    store,
    agent: personal,
    adapter: cannedAdapter({ status: "done", text: "hello over http" }),
    port: 0,
  });
  try {
    const ran = await fetch(`${running.url}/agents/personal/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "ping" }),
    });
    expect(ran.status).toBe(201);
    expect(((await ran.json()) as { output: string }).output).toBe("hello over http");

    const events = await fetch(`${running.url}/agents/personal/events`);
    expect(events.status).toBe(200);
    const ev = (await events.json()) as { events: { type: string }[] };
    expect(ev.events.some((e) => e.type === "run.started")).toBe(true);

    // Still bound to one agent, even over a real socket.
    const other = await fetch(`${running.url}/agents/work/runs`);
    expect(other.status).toBe(404);
  } finally {
    running.stop();
  }
});

// --- SSE streaming (#16) -------------------------------------------------

/** A substrate stand-in that emits one tool lifecycle event, then resolves canned output. */
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

function postStream(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
}

/** Pull the JSON payload of the terminal `result` frame out of an SSE body. */
function parseSseResult(body: string): {
  status: string;
  output: string;
  actions: readonly { capability: string; decision: string }[];
} {
  const lines = body.split("\n");
  const idx = lines.indexOf("event: result");
  expect(idx).toBeGreaterThanOrEqual(0);
  const dataLine = lines[idx + 1] ?? "";
  return JSON.parse(dataLine.replace(/^data: /, ""));
}

test("POST with Accept: text/event-stream streams activity then a terminal result", async () => {
  const res = await handleRequest(
    deps({ adapter: eventEmittingAdapter({ status: "done", text: "hi there" }) }),
    postStream("/agents/personal/runs", { input: "write a note" }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const body = await res.text();
  // An activity frame for the tool execution, then the terminal result frame.
  expect(body).toContain("event: activity");
  expect(body).toContain('"tool":"fs.write"');
  const result = parseSseResult(body);
  expect(result.status).toBe("done");
  expect(result.output).toBe("hi there");

  // The run executed for real and was persisted, exactly like the buffered path.
  expect(store.runs.list(personal.id)).toHaveLength(1);
});

test("a destructive action over SSE ends with an awaiting_confirmation result frame", async () => {
  const destructive: Capability = {
    key: "delete_files",
    effect: "destructive",
    tool: {
      name: "delete_files",
      description: "delete files",
      inputSchema: { type: "object", properties: {} },
      execute: () => ({ output: "deleted" }),
    },
  };
  const toolAdapter: RuntimeAdapter = {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        const tool = request.tools.list().find((t) => t.name === "delete_files");
        if (!tool) return { status: "done", text: "(tool not exposed)" };
        const result = await tool.execute({ args: { command: "rm -rf dist" } }, request.signal);
        return { status: "done", text: result.output };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };

  const res = await handleRequest(
    deps({ adapter: toolAdapter, capabilities: [destructive] }),
    postStream("/agents/personal/runs", { input: "delete the dist files" }),
  );
  expect(res.status).toBe(200);
  const result = parseSseResult(await res.text());
  // No confirm over HTTP, so the gate parks the run — the stream just reports it.
  expect(result.status).toBe("awaiting_confirmation");
  expect(result.actions).toEqual([
    { capability: "delete_files", effect: "destructive", decision: "paused" },
  ]);
});

test("the buffered POST surfaces the action summary", async () => {
  const writeCap: Capability = {
    key: "fs.write",
    effect: "write",
    tool: {
      name: "fs.write",
      description: "write a file",
      inputSchema: { type: "object", properties: {} },
      execute: () => ({ output: "written" }),
    },
  };
  const adapter: RuntimeAdapter = {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        const tool = request.tools.list().find((t) => t.name === "fs.write");
        if (tool) await tool.execute({ args: { path: "n.md" } }, request.signal);
        return { status: "done", text: "ok" };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };

  const res = await handleRequest(
    deps({ adapter, capabilities: [writeCap] }),
    post("/agents/personal/runs", { input: "write a note" }),
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as {
    actions: readonly { capability: string; effect: string; decision: string }[];
  };
  // personal is autonomous, so the write executes and is summarized as such.
  expect(json.actions).toEqual([
    { capability: "fs.write", effect: "write", decision: "executed" },
  ]);
});

// --- confirm endpoint: resume a gate-paused run out of band (#17) ---------

/** A destructive capability whose spy records when it truly runs. */
function destructiveCap(executed: string[]): Capability {
  return {
    key: "delete_files",
    effect: "destructive",
    tool: {
      name: "delete_files",
      description: "delete files",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        executed.push("delete_files");
        return { output: "deleted" };
      },
    },
  };
}

/** A substrate stand-in that drives the destructive tool, like a real loop would. */
function deleteAdapter(): RuntimeAdapter {
  return {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        const tool = request.tools.list().find((t) => t.name === "delete_files");
        if (!tool) return { status: "done", text: "(tool not exposed)" };
        const result = await tool.execute({ args: { command: "rm -rf dist" } }, request.signal);
        return { status: "done", text: result.output };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
}

function confirmReq(runId: string, stream = false): Request {
  return new Request(`${BASE}/agents/personal/runs/${runId}/confirm`, {
    method: "POST",
    headers: stream
      ? { "content-type": "application/json", accept: "text/event-stream" }
      : { "content-type": "application/json" },
    body: "{}",
  });
}

test("a run paused over HTTP can be confirmed out of band and then completes", async () => {
  const executed: string[] = [];
  // ONE deps object, reused for both calls, so the start and the confirm share the
  // same store and adapter — exactly how a server instance handles them.
  const d = deps({ adapter: deleteAdapter(), capabilities: [destructiveCap(executed)] });

  // The initial run parks: no confirm over HTTP, so the destructive action waits.
  const start = await handleRequest(d, post("/agents/personal/runs", { input: "delete dist" }));
  expect(start.status).toBe(201);
  const startJson = (await start.json()) as { status: string; run: { id: string } };
  expect(startJson.status).toBe("awaiting_confirmation");
  expect(executed).toHaveLength(0);

  // The confirm endpoint resumes the SAME run; the destructive action now runs.
  const confirm = await handleRequest(d, confirmReq(startJson.run.id));
  expect(confirm.status).toBe(200);
  const confirmJson = (await confirm.json()) as {
    status: string;
    output: string;
    run: { id: string };
    actions: readonly { capability: string; decision: string }[];
  };
  expect(confirmJson.status).toBe("done");
  expect(confirmJson.output).toBe("deleted");
  expect(confirmJson.run.id).toBe(startJson.run.id);
  expect(executed).toEqual(["delete_files"]);
  expect(confirmJson.actions).toEqual([
    { capability: "delete_files", effect: "destructive", decision: "executed" },
  ]);

  // One run, now done — not a new one — and the resume is on the record.
  expect(store.runs.list(personal.id)).toHaveLength(1);
  expect(store.events.tail(personal.id).map((e) => e.type)).toContain("run.resumed");
});

test("confirming an unknown run is a 404", async () => {
  const res = await handleRequest(deps(), confirmReq("no-such-run"));
  expect(res.status).toBe(404);
});

test("confirming a run that is not awaiting confirmation is a 409", async () => {
  // deps() default adapter finishes the run `done`, so there is nothing to confirm.
  const start = await handleRequest(deps(), post("/agents/personal/runs", { input: "hi" }));
  const id = ((await start.json()) as { run: { id: string } }).run.id;
  const res = await handleRequest(deps(), confirmReq(id));
  expect(res.status).toBe(409);
  const json = (await res.json()) as { status: string; error: string };
  expect(json.status).toBe("done");
  expect(json.error).toContain("not awaiting confirmation");
});

test("confirm with no model configured is a 503", async () => {
  const res = await handleRequest(
    deps({ adapter: undefined, adapterReason: "Set ASTERISM_MODEL_ID and an API key." }),
    confirmReq("anything"),
  );
  expect(res.status).toBe(503);
});

test("the confirm path is POST-only and bound to the served agent", async () => {
  const wrongMethod = await handleRequest(deps(), get("/agents/personal/runs/abc/confirm"));
  expect(wrongMethod.status).toBe(405);
  // One agent per server: another agent's confirm path is not reachable here.
  const otherAgent = await handleRequest(
    deps(),
    new Request(`${BASE}/agents/work/runs/abc/confirm`, { method: "POST", body: "{}" }),
  );
  expect(otherAgent.status).toBe(404);
  expect(store.runs.list(work.id)).toHaveLength(0);
});

test("confirm streams the resume as SSE, ending with a done result frame", async () => {
  const executed: string[] = [];
  const d = deps({ adapter: deleteAdapter(), capabilities: [destructiveCap(executed)] });
  const start = await handleRequest(d, post("/agents/personal/runs", { input: "delete dist" }));
  const id = ((await start.json()) as { run: { id: string } }).run.id;

  const res = await handleRequest(d, confirmReq(id, true));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const result = parseSseResult(await res.text());
  expect(result.status).toBe("done");
  expect(executed).toEqual(["delete_files"]);
});

test("confirm over SSE frames a refusal as an error event, not a result", async () => {
  const res = await handleRequest(deps(), confirmReq("ghost", true));
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("event: error");
  expect(body).toContain("No such run");
  expect(body).not.toContain("event: result");
});
