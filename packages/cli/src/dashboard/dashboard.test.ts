// The dashboard — its three testable halves, none of which bind a socket:
//   1. DashboardClient, driven against `handleConsoleRequest` in-process, so the real
//      routing + auth + kernel calls run end-to-end through HTTP semantics.
//   2. render(state) — the pure frame builder.
//   3. runDashboard — the IO loop, driven by a fake terminal that records frames and
//      replays key presses, proving each key maps to the right client call.
// Plus decodeKeys, the only stdin-byte parsing the real terminal does.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { AsterismStore, executeRun } from "@qmilab/asterism-core";
import type {
  Agent,
  Capability,
  ProposedMemory,
  ReflectionProvider,
  RuntimeAdapter,
  RunOutput,
} from "@qmilab/asterism-core";
import { handleConsoleRequest } from "@qmilab/asterism-server";
import type { ConsoleDeps } from "@qmilab/asterism-server";

import { CLEAR_SCREEN, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, SHOW_CURSOR, stripAnsi } from "./ansi.js";
import { DashboardClient, DashboardError } from "./client.js";
import type { FetchLike } from "./client.js";
import { decodeKeys } from "./terminal-node.js";
import { initialState, render, runDashboard } from "./tui.js";
import type { Key, TerminalIO } from "./tui.js";

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

const TOKEN = "test-token";

function cannedAdapter(output: RunOutput): RuntimeAdapter {
  return {
    run() {
      async function* noEvents() {}
      return { events: noEvents(), output: Promise.resolve(output) };
    },
  };
}

function stubProvider(proposals: ProposedMemory[]): ReflectionProvider {
  return { reflect: async () => proposals };
}

/** Console deps over the test store; the client's fetch routes into this handler. */
function deps(over: Partial<ConsoleDeps> = {}): ConsoleDeps {
  return { store, authToken: TOKEN, ...over };
}

/** A fetch that drives the in-process console handler — no socket. */
function consoleFetch(d: ConsoleDeps): (url: string, init?: RequestInit) => Promise<Response> {
  return (url, init) => handleConsoleRequest(d, new Request(url, init));
}

function client(token = TOKEN, d: ConsoleDeps = deps()): DashboardClient {
  return new DashboardClient("http://console", token, consoleFetch(d));
}

// --- DashboardClient -------------------------------------------------------

test("client.listAgents returns the roster; a bad token throws DashboardError(401)", async () => {
  const agents = await client().listAgents();
  expect(agents.map((a) => a.name).sort()).toEqual(["personal", "work"]);

  await expect(client("wrong-token").listAgents()).rejects.toBeInstanceOf(DashboardError);
});

test("client.setTrust round-trips to the kernel", async () => {
  const updated = await client().setTrust("work", "notify");
  expect(updated.trustLevel).toBe("notify");
  expect(store.agents.get(work.id)?.trustLevel).toBe("notify");
});

test("client.reflect surfaces proposals; client.saveMemory persists an accepted one", async () => {
  store.finishRun(personal.id, store.startRun(personal.id, { input: "tidy" }).id, "tidied", "done");
  const d = deps({ makeReflectionProvider: () => ({ provider: stubProvider([
    { memoryType: "semantic", content: "prefers tabs", confidence: 0.9, sourceRunId: "x" },
  ]) }) });
  const c = client(TOKEN, d);

  const result = await c.reflect("personal");
  expect(result.proposals.map((p) => p.content)).toEqual(["prefers tabs"]);

  await c.saveMemory("personal", { memoryType: "semantic", content: "prefers tabs", confidence: 0.9 });
  expect(store.memories.list(personal.id, { reviewState: "accepted" }).map((m) => m.content)).toEqual([
    "prefers tabs",
  ]);
});

test("client.declineRun ends a paused run failed; confirm of an unknown run throws 404", async () => {
  const parked = await executeRun(store, personal, "delete dist", {
    adapter: deleteAdapter(),
    capabilities: [deleteFilesCapability()],
  });
  expect(parked.status).toBe("awaiting_confirmation");

  const out = await client().declineRun("personal", parked.run.id);
  expect(out.status).toBe("failed");

  // Confirm needs a model present to reach the run lookup (no model is a 503, like
  // `serve`); with one wired, an unknown run is a 404.
  const withModel = client(TOKEN, deps({ makeAdapter: () => ({ adapter: deleteAdapter() }) }));
  await expect(withModel.confirmRun("personal", "no-such-run")).rejects.toMatchObject({ status: 404 });
});

/** A replaying destructive adapter + capability for parking a run in client tests. */
function deleteAdapter(): RuntimeAdapter {
  return {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        if (request.signal?.aborted) return { status: "done", text: "" };
        const tool = request.tools.list().find((t) => t.name === "delete_files");
        if (!tool) return { status: "done", text: "" };
        const r = await tool.execute({ args: { command: "rm -rf dist" } }, request.signal);
        return { status: "done", text: r.output };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
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

// --- render (pure) ---------------------------------------------------------

test("render produces exactly `rows` lines and shows the roster + trust", () => {
  const state = initialState();
  state.agents = [
    { name: "personal", role: "helper", soulRef: "casual-helper", trustLevel: "autonomous", pendingConfirmations: 1 },
    { name: "work", role: "consultant", soulRef: "careful-consultant", trustLevel: "propose", pendingConfirmations: 0 },
  ];
  const frame = render(state, { cols: 80, rows: 24 });
  expect(frame).toHaveLength(24);
  const text = stripAnsi(frame.join("\n"));
  expect(text).toContain("AGENTS");
  expect(text).toContain("personal");
  expect(text).toContain("autonomous");
  // The pending badge shows on the agent with a parked action.
  expect(text).toContain("!1");
});

test("render shows a review card in review mode", () => {
  const state = initialState();
  state.agents = [
    { name: "personal", role: "", soulRef: "casual-helper", trustLevel: "autonomous", pendingConfirmations: 0 },
  ];
  state.mode = "review";
  state.reviewAgent = "personal";
  state.proposals = [{ memoryType: "semantic", content: "remember the tabs", confidence: 0.8, sourceRunId: "r", findings: [] }];
  const text = stripAnsi(render(state, { cols: 80, rows: 24 }).join("\n"));
  expect(text).toContain("Review memory 1/1 for personal");
  expect(text).toContain("remember the tabs");
});

// --- decodeKeys ------------------------------------------------------------

test("decodeKeys parses arrows, enter, backspace, escape, ctrl-c, and printables", () => {
  expect(decodeKeys("\x1b[A")[0]).toMatchObject({ name: "up" });
  expect(decodeKeys("\x1b[B")[0]).toMatchObject({ name: "down" });
  expect(decodeKeys("\r")[0]).toMatchObject({ name: "enter" });
  expect(decodeKeys("\x7f")[0]).toMatchObject({ name: "backspace" });
  expect(decodeKeys("\x1b")[0]).toMatchObject({ name: "escape" });
  expect(decodeKeys("\x03")[0]).toMatchObject({ name: "c", ctrl: true });
  expect(decodeKeys("Q")[0]).toMatchObject({ name: "q", sequence: "Q" });
});

// --- runDashboard (the IO loop, via a fake terminal) -----------------------

interface FakeTerminal extends TerminalIO {
  frames: string[];
  press(key: Partial<Key> & { name: string }): Promise<void>;
  lastText(): string;
}

function fakeTerminal(cols = 100, rows = 30): FakeTerminal {
  let handler: ((k: Key) => void | Promise<void>) | undefined;
  const frames: string[] = [];
  return {
    columns: cols,
    rows,
    frames,
    write(s: string): void {
      frames.push(s);
    },
    setRawMode(): void {},
    onKey(h): () => void {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    onResize(): () => void {
      return () => {};
    },
    async press(key): Promise<void> {
      await handler?.({ ctrl: false, sequence: "", ...key });
      await flush();
    },
    lastText(): string {
      return stripAnsi(frames[frames.length - 1] ?? "");
    },
  };
}

/** Let pending fire-and-forget actions (the loop's `void act(...)`) settle. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

test("runDashboard renders the roster, changes trust via keys, and quits cleanly", async () => {
  const term = fakeTerminal();
  // A huge refresh interval so the poll never fires during the test.
  const done = runDashboard(client(), term, { refreshMs: 1_000_000 });
  await flush();
  expect(term.lastText()).toContain("personal");

  // t → trust chooser; ↑ to 'propose' (from autonomous); enter applies.
  await term.press({ name: "t" });
  await term.press({ name: "up" });
  await term.press({ name: "up" });
  await term.press({ name: "enter" });
  expect(store.agents.get(personal.id)?.trustLevel).toBe("propose");

  await term.press({ name: "q" });
  await done; // resolves only when the loop quits and restores the terminal
});

test("runDashboard reflects and accepts a proposed memory through the console", async () => {
  store.finishRun(personal.id, store.startRun(personal.id, { input: "tidy" }).id, "tidied", "done");
  const d = deps({ makeReflectionProvider: () => ({ provider: stubProvider([
    { memoryType: "semantic", content: "user prefers tabs", confidence: 0.9, sourceRunId: "x" },
  ]) }) });
  const term = fakeTerminal();
  const done = runDashboard(client(TOKEN, d), term, { refreshMs: 1_000_000 });
  await flush();

  await term.press({ name: "m" }); // reflect → review mode
  expect(term.lastText()).toContain("user prefers tabs");
  await term.press({ name: "a" }); // accept → persists
  expect(store.memories.list(personal.id, { reviewState: "accepted" }).map((m) => m.content)).toEqual([
    "user prefers tabs",
  ]);

  await term.press({ name: "q" });
  await done;
});

test("runDashboard drains the persisted proposed queue — accept transitions it in place, no model needed", async () => {
  // Seed a queued proposal, as a scheduled `reflect --propose` would.
  const proposed = store.recordMemory(personal.id, {
    memoryType: "semantic",
    content: "a queued lesson",
    confidence: 0.8,
    reviewState: "proposed",
    status: "active",
  });
  // A provider builder that THROWS if invoked — draining the queue must never build a model.
  const d = deps({
    makeReflectionProvider: () => {
      throw new Error("a model was built while draining the queue");
    },
  });
  const term = fakeTerminal();
  const done = runDashboard(client(TOKEN, d), term, { refreshMs: 1_000_000 });
  await flush();

  await term.press({ name: "m" }); // drains the queue (not a live reflect) → shows the queued item
  expect(term.lastText()).toContain("a queued lesson");
  await term.press({ name: "a" }); // accept → transitions the SAME row to active+accepted
  expect(store.memories.listActiveAccepted(personal.id).map((m) => m.id)).toEqual([proposed.id]);
  expect(store.memories.list(personal.id, { reviewState: "proposed" })).toEqual([]);

  await term.press({ name: "q" });
  await done;
});

test("runDashboard rejects a queued proposal through the console", async () => {
  const proposed = store.recordMemory(personal.id, {
    memoryType: "semantic",
    content: "a doomed lesson",
    confidence: 0.8,
    reviewState: "proposed",
    status: "active",
  });
  const term = fakeTerminal();
  const done = runDashboard(client(), term, { refreshMs: 1_000_000 });
  await flush();

  await term.press({ name: "m" });
  expect(term.lastText()).toContain("a doomed lesson");
  await term.press({ name: "r" }); // reject → server transitions it out of the queue
  await flush();
  expect(store.memories.get(personal.id, proposed.id)?.reviewState).toBe("rejected");
  expect(store.memories.listActiveAccepted(personal.id)).toEqual([]);

  await term.press({ name: "q" });
  await done;
});

test("runDashboard never draws after quit while an action is still in flight", async () => {
  store.finishRun(personal.id, store.startRun(personal.id, { input: "tidy" }).id, "tidied", "done");
  const d = deps({ makeReflectionProvider: () => ({ provider: stubProvider([
    { memoryType: "semantic", content: "x", confidence: 0.9, sourceRunId: "x" },
  ]) }) });
  // Gate the reflect response so the action stays in flight across the quit.
  let releaseReflect!: () => void;
  const reflectGate = new Promise<void>((r) => {
    releaseReflect = r;
  });
  const gatedFetch: FetchLike = async (url, init) => {
    if (url.includes("/reflect")) await reflectGate;
    return handleConsoleRequest(d, new Request(url, init));
  };
  const term = fakeTerminal();
  const done = runDashboard(new DashboardClient("http://console", TOKEN, gatedFetch), term, {
    refreshMs: 1_000_000,
  });
  await flush();

  // Start the reflect WITHOUT awaiting it (the real stdin path is fire-and-forget, so
  // a later keypress is handled concurrently) — it blocks on the gate, in flight.
  const mPress = term.press({ name: "m" });
  await flush();
  await term.press({ name: "q" }); // quit while the reflect is still pending
  await done; // the terminal is restored and the loop returned

  const framesAtQuit = term.frames.length;
  const lastWrite = term.frames[framesAtQuit - 1] ?? "";
  expect(lastWrite).toContain(EXIT_ALT_SCREEN); // the restore was the last write
  expect(lastWrite).not.toContain(CLEAR_SCREEN); // …not a dashboard frame

  releaseReflect(); // the in-flight action now completes
  await mPress;
  await flush();
  // No frame was painted after teardown — the write count is unchanged.
  expect(term.frames.length).toBe(framesAtQuit);
});

test("runDashboard restores the terminal even if entering raw mode throws", async () => {
  const term = fakeTerminal();
  // An unusual TTY where raw-mode entry fails — but only AFTER the alternate screen
  // has already been written, the exact case the finally must recover from.
  term.setRawMode = (on: boolean): void => {
    if (on) throw new Error("no raw mode");
  };
  await expect(runDashboard(client(), term, { refreshMs: 1_000_000 })).rejects.toThrow("no raw mode");
  const all = term.frames.join("");
  expect(all).toContain(ENTER_ALT_SCREEN); // it did switch screens…
  expect(all).toContain(EXIT_ALT_SCREEN); // …and the finally switched back
  expect(all).toContain(SHOW_CURSOR);
});

test("runDashboard saves a reflected memory to its source agent, not one selected mid-flight", async () => {
  // personal has a reflectable run; the proposal belongs to personal.
  store.finishRun(personal.id, store.startRun(personal.id, { input: "tidy" }).id, "tidied", "done");
  const d = deps({ makeReflectionProvider: () => ({ provider: stubProvider([
    { memoryType: "semantic", content: "belongs to personal", confidence: 0.9, sourceRunId: "x" },
  ]) }) });
  // Gate the reflect so the user can navigate to another agent while it's in flight.
  let releaseReflect!: () => void;
  const gate = new Promise<void>((r) => {
    releaseReflect = r;
  });
  const gatedFetch: FetchLike = async (url, init) => {
    if (url.includes("/reflect")) await gate;
    return handleConsoleRequest(d, new Request(url, init));
  };
  const term = fakeTerminal();
  const done = runDashboard(new DashboardClient("http://console", TOKEN, gatedFetch), term, {
    refreshMs: 1_000_000,
  });
  await flush();

  // personal is selected (index 0). Start reflect WITHOUT awaiting (it blocks on the gate).
  const mPress = term.press({ name: "m" });
  await flush();
  await term.press({ name: "down" }); // navigate to `work` while the reflect is in flight
  releaseReflect();
  await mPress;
  await flush();
  expect(term.lastText()).toContain("belongs to personal"); // review opened for personal

  await term.press({ name: "a" }); // accept — must save under personal, not work
  await flush();
  expect(store.memories.list(personal.id, { reviewState: "accepted" }).map((m) => m.content)).toEqual([
    "belongs to personal",
  ]);
  expect(store.memories.list(work.id, { reviewState: "accepted" })).toEqual([]); // never misattributed

  await term.press({ name: "q" });
  await done;
});
