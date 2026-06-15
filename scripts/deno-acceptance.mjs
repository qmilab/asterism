// Deno-runtime acceptance check for issue #15: prove `asterism` runs end to end
// under Deno. Run it with DENO, after a build:
//
//   bun run build && deno run -A scripts/deno-acceptance.mjs
//
// Why a separate script from node-acceptance.mjs: Deno cannot load the Node
// floor's SQLite binding at all — `better-sqlite3` is a legacy V8/nan native
// addon whose ABI Deno deliberately does not expose. So the Deno path uses the
// runtime's built-in `node:sqlite` driver instead (see core's db/index.js), and
// this script is what certifies that driver actually opens, writes, and reads a
// store under Deno — the one runtime the bun:test suite and node-acceptance can
// never cover. Like node-acceptance it uses no test runner, just plain assertions
// and a non-zero exit, so it runs under the very runtime it certifies. Two parts:
//   1. the shipped CLI bin under Deno: init / new / secrets (piped stdin) / read
//      views — exercising the node:sqlite driver and the runtime-neutral stdin.
//   2. the HTTP server under Deno: serve() binds via node:http, a canned run is
//      driven over a real socket (buffered + SSE), then a clean shutdown drains.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Import the built dist by path, same as node-acceptance: a module's own bare
// imports resolve relative to it, so server→core resolves via the workspace
// symlinks without this script needing a node_modules/@qmilab of its own. Under
// Deno this import path is also what makes openDatabase pick the node:sqlite
// driver — `better-sqlite3` is never required.
import { AsterismStore } from "../packages/core/dist/index.js";
import { serve } from "../packages/server/dist/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "packages", "cli", "dist", "bin.js");
const RUNTIME = `Deno ${Deno.version.deno}`;

let passed = 0;
function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ok  ${label}`);
}

// The HTTP endpoint is default-deny: every request needs this bearer token, which
// the server is given via `serve({ authToken })` and each fetch presents.
const HTTP_TOKEN = "deno-acceptance-token";
function authed(extra = {}) {
  return { ...extra, authorization: `Bearer ${HTTP_TOKEN}` };
}

// Run the built CLI under THIS Deno, in `cwd`, optionally feeding piped stdin.
// `Deno.execPath()` is the deno binary; `run -A` runs the bin with full perms (a
// local-first CLI reads/writes the cwd and env). The bin's `node` shebang is
// ignored when invoked as a `deno run` argument.
function asterism(cwd, args, input) {
  return execFileSync(Deno.execPath(), ["run", "-A", BIN, ...args], {
    cwd,
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
}

async function part1CliUnderDeno() {
  console.log(`\n[1] CLI bin under ${RUNTIME} — node:sqlite + piped stdin`);
  const work = mkdtempSync(join(tmpdir(), "asterism-deno-"));
  try {
    asterism(work, ["init"]);
    asterism(work, ["new", "personal", "--role", "personal helper", "--trust", "autonomous"]);
    asterism(work, ["new", "work", "--trust", "propose"]);

    // Piped stdin is the runtime-neutral path that replaced `Bun.stdin.text()`.
    asterism(work, ["secrets", "add", "work", "GITHUB_TOKEN"], "ghp_deno_token");

    const list = asterism(work, ["list"]);
    check("list shows both agents", list.includes("personal") && list.includes("work"));

    // Store-backed read views resolve (the DB opened and queried under Deno).
    const mem = asterism(work, ["memory", "inspect", "personal"]);
    check("memory inspect runs", typeof mem === "string");
    const events = asterism(work, ["events", "tail", "personal"]);
    check("events tail records agent.created", events.includes("agent.created"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A substrate stand-in: emits one activity event, then resolves canned output. */
function eventEmittingAdapter(output) {
  return {
    run() {
      async function* events() {
        yield { type: "tool_execution_start", payload: { tool: "fs.write" } };
        yield { type: "tool_execution_end", payload: { tool: "fs.write", isError: false } };
      }
      return { events: events(), output: Promise.resolve(output) };
    },
  };
}

async function part2ServerUnderDeno() {
  console.log(`\n[2] HTTP server under ${RUNTIME} — node:http bind + SSE`);
  const dir = mkdtempSync(join(tmpdir(), "asterism-deno-db-"));
  const store = AsterismStore.open(join(dir, "asterism.db")); // file-backed ⇒ real node:sqlite I/O
  const agent = store.createAgent({
    name: "personal",
    role: "personal helper",
    soulRef: "casual-helper",
    workspaceDir: join(dir, "personal"),
    trustLevel: "autonomous",
  });

  const running = await serve({
    store,
    agent,
    adapter: eventEmittingAdapter({ status: "done", text: "hello over deno http" }),
    authToken: HTTP_TOKEN,
    port: 0,
  });
  try {
    check("serve() resolved an OS-assigned port", running.port > 0);

    // Default-deny: an unauthenticated request is a 401 over the real socket.
    const noToken = await fetch(`${running.url}/agents/personal/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "ping" }),
    });
    check("unauthenticated POST → 401", noToken.status === 401);

    // Buffered run.
    const ran = await fetch(`${running.url}/agents/personal/runs`, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ input: "ping" }),
    });
    const ranBody = await ran.json();
    check("POST run → 201", ran.status === 201);
    check("run output round-tripped", ranBody.output === "hello over deno http");

    // Streamed run (SSE) — frames must arrive over the node:http bridge.
    const streamed = await fetch(`${running.url}/agents/personal/runs`, {
      method: "POST",
      headers: authed({ "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify({ input: "ping again" }),
    });
    check("SSE response content-type", (streamed.headers.get("content-type") ?? "").includes("text/event-stream"));
    const frames = await streamed.text();
    check("SSE carried an activity frame", frames.includes("event: activity"));
    check("SSE carried a result frame", frames.includes("event: result"));

    // Read view over the socket.
    const events = await fetch(`${running.url}/agents/personal/events`, { headers: authed() });
    const evBody = await events.json();
    check("GET events → 200", events.status === 200);
    check("event log recorded run.started", evBody.events.some((e) => e.type === "run.started"));

    // Still one-agent-per-server at the network edge.
    const other = await fetch(`${running.url}/agents/work/runs`, { headers: authed() });
    check("wrong agent → 404", other.status === 404);
  } finally {
    await running.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function part3DrainUnderDeno() {
  console.log(`\n[3] Graceful shutdown under ${RUNTIME} — an in-flight SSE run drains, not torn down`);
  const dir = mkdtempSync(join(tmpdir(), "asterism-deno-drain-"));
  const store = AsterismStore.open(join(dir, "asterism.db"));
  const agent = store.createAgent({
    name: "personal",
    role: "personal helper",
    soulRef: "casual-helper",
    workspaceDir: join(dir, "personal"),
    trustLevel: "autonomous",
  });

  // A run that reaches the substrate, then blocks until released — so it is
  // provably mid-flight when shutdown begins.
  let runReached;
  const reached = new Promise((r) => {
    runReached = r;
  });
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const adapter = {
    run() {
      runReached();
      async function* events() {
        yield { type: "tool_execution_start", payload: { tool: "fs.write" } };
      }
      return { events: events(), output: gate.then(() => ({ status: "done", text: "drained on deno" })) };
    },
  };

  const running = await serve({ store, agent, adapter, authToken: HTTP_TOKEN, port: 0 });
  try {
    const inflight = fetch(`${running.url}/agents/personal/runs`, {
      method: "POST",
      headers: authed({ "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify({ input: "slow stream" }),
    });
    await reached; // the SSE producer is mid-run

    // Begin shutdown while the run is still executing, then let it finish.
    const stopped = running.stop();
    release();

    const body = await (await inflight).text();
    check("SSE run drained to its result frame on shutdown", body.includes("event: result") && body.includes("drained on deno"));
    await stopped; // resolves only after the in-flight run drained

    // The run reached the store before it was torn down (no write-after-close).
    const events = store.events.tail(agent.id, {});
    check("drained run persisted run.started before store close", events.some((e) => e.type === "run.started"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await part1CliUnderDeno();
await part2ServerUnderDeno();
await part3DrainUnderDeno();
console.log(`\nPASS — ${passed} checks green on ${RUNTIME}.`);
