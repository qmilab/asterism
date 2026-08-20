// Node-runtime acceptance check for issue #14: prove `asterism` runs end to end
// under Node (not just Bun). Run it with NODE, after a build:
//
//   bun run build && node scripts/node-acceptance.mjs
//
// It deliberately uses no test runner (the suite is `bun:test`, which only runs
// under Bun) — just plain assertions and a non-zero exit on failure — so it can be
// executed by the very runtime it is meant to certify. Two parts:
//   1. the shipped CLI bin under Node: init / new / secrets (piped stdin) / read
//      views — exercising the better-sqlite3 driver and the runtime-neutral stdin.
//   2. the HTTP server under Node: serve() binds via node:http, a canned run is
//      driven over a real socket (buffered + SSE), then a clean shutdown.
//   4. the install-wide operator CONSOLE under Node: the cross-agent collaboration
//      endpoints over a real socket — the console's first runtime-parity coverage
//      (parts 1-3 exercise `serve`, which is a different surface).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Import the built dist by path: a module's own bare imports resolve relative to
// it, so server→core and core→better-sqlite3 resolve via their package
// node_modules without this script needing a node_modules/@qmilab of its own.
// (A published install exposes the packages by name; that path is #15's matrix.)
import { AsterismStore } from "../packages/core/dist/index.js";
import { concurrencyChecks } from "./concurrency-check.mjs";
import { serve } from "../packages/server/dist/index.js";
import { serveConsole } from "../packages/server/dist/console.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "packages", "cli", "dist", "bin.js");

let passed = 0;
function check(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ok  ${label}`);
}

// The HTTP endpoint is default-deny: every request needs this bearer token, which
// the server is given via `serve({ authToken })` and each fetch presents.
const HTTP_TOKEN = "node-acceptance-token";
function authed(extra = {}) {
  return { ...extra, authorization: `Bearer ${HTTP_TOKEN}` };
}

// Run the built CLI under THIS Node, in `cwd`, optionally feeding piped stdin.
function asterism(cwd, args, input, timeout) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  });
}

async function part1CliUnderNode() {
  console.log(`\n[1] CLI bin under Node (${process.version}) — better-sqlite3 + piped stdin`);
  const work = mkdtempSync(join(tmpdir(), "asterism-node-"));
  try {
    asterism(work, ["init"]);
    asterism(work, ["new", "personal", "--role", "personal helper", "--trust", "autonomous"]);
    asterism(work, ["new", "work", "--trust", "propose"]);

    // Piped stdin is the runtime-neutral path that replaced `Bun.stdin.text()`.
    asterism(work, ["secrets", "add", "work", "GITHUB_TOKEN"], "ghp_node_floor_token");

    // `secrets add` asks for a missing value at a terminal. This session has none — its
    // stdin is a pipe — so an unattended install has to be REFUSED, and refused with the
    // message that names the three scripted ways rather than the one that reports a human
    // declining. That distinction is the whole check: it is what fails if the prompt is
    // ever wired into a session with no terminal. The timeout is a backstop for the worse
    // shape of the same regression, one that blocks instead of answering.
    let refusedUnattended = "";
    try {
      asterism(work, ["secrets", "add", "work", "NO_VALUE_ANYWHERE"], "", 20_000);
    } catch (err) {
      refusedUnattended = err.stderr?.toString() ?? "";
      if (err.code === "ETIMEDOUT") refusedUnattended = "BLOCKED waiting for input";
    }
    check(
      "a value-less `secrets add` with no terminal refuses instead of waiting",
      // The whole first clause, not just the key: BOTH refusals open with "No value for
      // <KEY>", and the one that names the three scripted ways is the only one that says
      // no terminal was ever consulted. Matching the shorter prefix passed even with the
      // prompt wired into this session.
      refusedUnattended.includes("No value for NO_VALUE_ANYWHERE. Pass it inline"),
    );

    const list = asterism(work, ["list"]);
    check("list shows both agents", list.includes("personal") && list.includes("work"));

    // Store-backed read views resolve (the DB opened and queried under Node).
    const mem = asterism(work, ["memory", "inspect", "personal"]);
    check("memory inspect runs", typeof mem === "string");
    const events = asterism(work, ["events", "tail", "personal"]);
    check("events tail runs", typeof events === "string");

    // Capability ownership (#123) on the real runtime: an agent nobody narrowed holds
    // the whole shipped catalog — the migration claim, checked where the store is a
    // real file opened by this runtime's driver, not an in-memory fixture.
    const held = asterism(work, ["capabilities", "show", "personal"]);
    check(
      "an un-narrowed agent holds the whole catalog",
      held.includes("holds all 9 in the catalog  [not narrowed]"),
    );
    asterism(work, ["capabilities", "set", "personal", "fs.read", "fs.list"]);
    const narrowed = asterism(work, ["capabilities", "show", "personal"]);
    check(
      "narrowing persists and withholds the rest",
      narrowed.includes("[narrowed to 2]") && narrowed.includes("· fs.delete  (withheld)"),
    );
    asterism(work, ["capabilities", "unset", "personal"]);
    check(
      "unset restores the catalog",
      asterism(work, ["capabilities", "show", "personal"]).includes("[not narrowed]"),
    );

    // The first CREDENTIAL-BEARING capability class (#123 PR 2) on the real runtime.
    // Three claims that only a real install can carry: the binding grants exposure with
    // no separate declaration, the closed default set is unmoved by it, and the one verb
    // that could quietly undo it refuses to.
    asterism(work, ["secrets", "add", "personal", "API_TOKEN"], "tok_node_endpoint");
    asterism(work, ["api", "add", "personal", "issues", "https://api.example.test/i?state=open", "--credential", "API_TOKEN"]);
    const bound = asterism(work, ["capabilities", "show", "personal"]);
    check(
      "binding an endpoint grants it, with no separate declaration",
      bound.includes("api.issues") && bound.includes("(sends API_TOKEN)"),
    );
    check(
      "binding does not move the host-catalog count",
      bound.includes("holds all 9 in the catalog  [not narrowed]"),
    );
    // The exposure has exactly one writer: the `capabilities` verbs cannot reach it, and
    // `remove` in particular must not report a revoke it did not perform.
    let refusedHandTyping = false;
    try {
      asterism(work, ["capabilities", "remove", "personal", "api.issues"]);
    } catch {
      refusedHandTyping = true;
    }
    check("a hand-typed api.* key is refused by `capabilities remove`", refusedHandTyping);
    check(
      "…and the binding survived that refusal",
      asterism(work, ["api", "list", "personal"]).includes("api.issues"),
    );

    // The FIFTH connection mode (#137) — the one Track-A mode that runs no model, so a
    // real runtime can exercise it end to end. Two locks, and the second is the point:
    // an open channel reaches nothing until a specific tool is named on it.
    asterism(work, ["api", "add", "personal", "issues", "https://api.example.test/i?state=open", "--credential", "API_TOKEN"]);
    asterism(work, ["connect", "work", "personal", "--mode", "delegated-tool"]);
    check(
      "an open delegated-tool channel reaches nothing until a tool is handed over",
      asterism(work, ["connections", "work"]).includes("nothing handed over yet"),
    );
    let refusedUngranted = false;
    try {
      asterism(work, ["call", "work", "personal", "issues"]);
    } catch {
      refusedUngranted = true;
    }
    check("a call over an empty channel is refused", refusedUngranted);
    let refusedUnbound = false;
    try {
      asterism(work, ["delegate", "work", "personal", "payroll"]);
    } catch {
      refusedUnbound = true;
    }
    check("a tool the callee does not hold cannot be handed over", refusedUnbound);
    asterism(work, ["delegate", "work", "personal", "issues"]);
    check(
      "the grant shows on the channel it was made on",
      asterism(work, ["connections", "work"]).includes("may call api.issues"),
    );
    // Re-pointing the binding withdraws the grant — the operator on the other side is told,
    // and the call stops being possible rather than going somewhere else.
    const rebound = asterism(work, ["api", "add", "personal", "issues", "https://api.example.test/other", "--credential", "API_TOKEN"]);
    check(
      "re-pointing a handed-over tool withdraws the grant, and says so",
      rebound.includes("can no longer ask"),
    );
    check(
      "…and the channel no longer reaches it",
      asterism(work, ["connections", "work"]).includes("nothing handed over yet"),
    );
    asterism(work, ["disconnect", "work", "personal", "--mode", "delegated-tool"]);

    asterism(work, ["api", "remove", "personal", "issues"]);
    check(
      "api remove withdraws it",
      asterism(work, ["api", "list", "personal"]).includes("no bound endpoints"),
    );
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

async function part2ServerUnderNode() {
  console.log(`\n[2] HTTP server under Node — node:http bind + SSE`);
  const dir = mkdtempSync(join(tmpdir(), "asterism-node-db-"));
  const store = AsterismStore.open(join(dir, "asterism.db")); // file-backed ⇒ real better-sqlite3 I/O
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
    adapter: eventEmittingAdapter({ status: "done", text: "hello over node http" }),
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
    check("run output round-tripped", ranBody.output === "hello over node http");

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

async function part3DrainUnderNode() {
  console.log(`\n[3] Graceful shutdown under Node — an in-flight SSE run drains, not torn down`);
  const dir = mkdtempSync(join(tmpdir(), "asterism-node-drain-"));
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
      return { events: events(), output: gate.then(() => ({ status: "done", text: "drained on node" })) };
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
    check("SSE run drained to its result frame on shutdown", body.includes("event: result") && body.includes("drained on node"));
    await stopped; // resolves only after the in-flight run drained

    // The run reached the store before it was torn down (no write-after-close).
    const events = store.events.tail(agent.id, {});
    check("drained run persisted run.started before store close", events.some((e) => e.type === "run.started"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function part4ConsoleCollaborationUnderNode() {
  console.log(`\n[4] Collaboration over the operator console under Node — cross-agent, over a socket`);
  const dir = mkdtempSync(join(tmpdir(), "asterism-node-collab-"));
  const store = AsterismStore.open(join(dir, "asterism.db")); // file-backed ⇒ real driver I/O
  const writer = store.createAgent({
    name: "writer",
    role: "drafts posts",
    soulRef: "casual-helper",
    workspaceDir: join(dir, "writer"),
    trustLevel: "autonomous",
  });
  store.createAgent({
    name: "helper",
    role: "researches sections",
    soulRef: "careful-consultant",
    workspaceDir: join(dir, "helper"),
    trustLevel: "autonomous",
  });
  store.recordMemory(store.agents.list().find((a) => a.name === "helper").id, {
    memoryType: "convention",
    content: "Sections live in drafts/, one file per topic.",
    reviewState: "accepted",
    status: "active",
  });

  const running = await serveConsole({
    store,
    authToken: HTTP_TOKEN,
    port: 0,
    makeAdapter: () => ({
      adapter: {
        run() {
          async function* noEvents() {}
          return { events: noEvents(), output: Promise.resolve({ status: "done", text: "helper's answer" }) };
        },
      },
    }),
  });
  const call = async (method, path, body) =>
    fetch(`${running.url}${path}`, {
      method,
      headers: authed(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  try {
    // Default-deny reaches the collaboration routes too, before any routing.
    const anon = await fetch(`${running.url}/agents/writer/connections`, { method: "GET" });
    check("unauthenticated cross-agent GET → 401", anon.status === 401);

    // No channel ⇒ no interaction, over the wire as in the kernel.
    const unarmed = await call("POST", "/agents/writer/connections/helper/handoff", { task: "summarize" });
    check("handoff with no channel → 409", unarmed.status === 409);

    const granted = await call("POST", "/agents/writer/connections", { to: "helper", mode: "handoff" });
    check("connect over the console → 201", granted.status === 201);
    check("connect body names agents, not ids", (await granted.json()).connection.from === "writer");

    const handed = await call("POST", "/agents/writer/connections/helper/handoff", { task: "summarize" });
    const handoffBody = await handed.json();
    check("handoff over the console → 200 with the callee's output", handed.status === 200 && handoffBody.output === "helper's answer");
    check("handoff body carries a runId and no Run row", typeof handoffBody.runId === "string" && handoffBody.run === undefined);

    // A different mode is a different grant — the handoff channel authorizes no pull.
    const unauthorizedPull = await call("POST", "/agents/writer/connections/helper/summary", {});
    check("a handoff channel does not authorize a read-summary pull → 409", unauthorizedPull.status === 409);

    await call("POST", "/agents/writer/connections", { to: "helper", mode: "read-summary" });
    const pulled = await call("POST", "/agents/writer/connections/helper/summary", {});
    const summaryBody = await pulled.json();
    check("read-summary pull → 200 with counts and screened items", pulled.status === 200 && summaryBody.eligible === 1 && summaryBody.items.length === 1);
    check("no memory id crosses in a summary", !JSON.stringify(summaryBody).includes('"id"'));

    const withdrawn = await call("DELETE", "/agents/writer/connections/helper?mode=handoff");
    check("disconnect over the console → 200 revoked", withdrawn.status === 200 && (await withdrawn.json()).connection.status === "revoked");
    const afterRevoke = await call("POST", "/agents/writer/connections/helper/handoff", { task: "again" });
    check("a withdrawn channel refuses the next handoff → 409", afterRevoke.status === 409);

    // Both participants' logs recorded the exchange, each row agent-scoped.
    const types = store.events.tail(writer.id, {}).map((e) => e.type);
    check("the caller's log records connection.created + handoff.completed", types.includes("connection.created") && types.includes("handoff.completed"));
  } finally {
    await running.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// The cross-process store concurrency contract (#119) on the better-sqlite3
// driver — the runtime that actually ships it, and the only place a blocked
// writer can be shown to wait rather than fail.
async function part5ConcurrencyUnderNode() {
  console.log(`\n[5] store concurrency under Node (${process.version}) — two processes, one database`);
  await concurrencyChecks({
    check,
    spawnArgv: (worker, args) => [process.execPath, [worker, ...args]],
    coreDist: join(ROOT, "packages", "core", "dist", "index.js"),
  });
}

await part1CliUnderNode();
await part2ServerUnderNode();
await part3DrainUnderNode();
await part4ConsoleCollaborationUnderNode();
await part5ConcurrencyUnderNode();
console.log(`\nPASS — ${passed} checks green on Node ${process.version}.`);
