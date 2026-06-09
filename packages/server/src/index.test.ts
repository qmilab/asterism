// The HTTP surface — tested against `handleRequest` directly, so no socket binds.
// What we pin: the three endpoints work and stay agent-scoped; the server is bound
// to one agent and refuses any other name; malformed requests fail cleanly; and a
// run with no model configured is declined rather than crashing.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { AsterismStore } from "@qmilab/asterism-core";
import type { Agent, RuntimeAdapter, RunOutput } from "@qmilab/asterism-core";

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

test("serve() binds a real socket: a run can be triggered and events read over HTTP", async () => {
  // The real Bun.serve binding (port 0 ⇒ OS-assigned, so no conflict), exercised
  // over a genuine HTTP round-trip rather than handleRequest directly.
  const running = serve({
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
