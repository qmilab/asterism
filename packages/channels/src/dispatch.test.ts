// The channel dispatcher — tested against the real kernel (an in-memory store +
// `executeRun`/`resumeRun`), so what we pin is real behavior, not a mock's:
//   • the allow-list is the access boundary — an unknown chat reaches nothing;
//   • the dispatcher only ever runs the one agent it is bound to;
//   • a destructive action pauses and asks, and a `/confirm` reply resumes it
//     through the kernel's out-of-band gate — the gate is never weakened here;
//   • a `propose` agent surfaces its plan without ever pausing to ask;
//   • a chat with a pending confirmation can't accidentally start a parallel run.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { AsterismStore } from "@qmilab/asterism-core";
import type { Agent, Capability, RunOutput, RuntimeAdapter } from "@qmilab/asterism-core";

import { createDispatcher } from "./dispatch.ts";
import type { ChannelDeps } from "./dispatch.ts";

let store: AsterismStore;
let personal: Agent; // autonomous
let work: Agent; // propose

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

/** A substrate stand-in that ignores tools and resolves canned output. */
function cannedAdapter(output: RunOutput): RuntimeAdapter {
  return {
    run() {
      async function* noEvents() {}
      return { events: noEvents(), output: Promise.resolve(output) };
    },
  };
}

/** A substrate stand-in that drives the named scoped tool through the gate. */
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

/** A destructive capability — invoking it trips the gate and pauses the run. */
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

/** Deps bound to `personal` with a clean substrate and a one-chat allow-list. */
function deps(over: Partial<ChannelDeps> = {}): ChannelDeps {
  return {
    store,
    agent: personal,
    adapter: cannedAdapter({ status: "done", text: "hi from the agent" }),
    allow: new Set(["100"]),
    ...over,
  };
}

test("an unauthorized chat is refused with its own id and never reaches the kernel", async () => {
  let ran = false;
  const watching: RuntimeAdapter = {
    run() {
      ran = true;
      async function* noEvents() {}
      return { events: noEvents(), output: Promise.resolve({ status: "done" as const, text: "" }) };
    },
  };
  const d = createDispatcher(deps({ adapter: watching, allow: new Set(["100"]) }));

  const out = await d.handle({ chatId: "999", text: "do something" });

  expect(out).toHaveLength(1);
  expect(out[0]!.chatId).toBe("999");
  expect(out[0]!.text).toContain("999");
  expect(out[0]!.text.toLowerCase()).toContain("not authorized");
  // The kernel was never touched: no run started, no substrate invoked.
  expect(ran).toBe(false);
  expect(store.runs.list(personal.id)).toHaveLength(0);
});

test("an authorized chat runs the bound agent — and only that agent", async () => {
  const d = createDispatcher(deps());

  const out = await d.handle({ chatId: "100", text: "write the draft" });

  expect(out[0]!.text).toContain("hi from the agent");
  // The run landed on the bound agent, and never on the other one in the store.
  expect(store.runs.list(personal.id)).toHaveLength(1);
  expect(store.runs.list(work.id)).toHaveLength(0);
});

test("a destructive action pauses and asks; /confirm resumes it through the gate", async () => {
  const d = createDispatcher(
    deps({
      adapter: toolCallingAdapter("delete_files", { command: "rm -rf dist" }),
      capabilities: [deleteFilesCapability()],
    }),
  );

  const paused = await d.handle({ chatId: "100", text: "clean up dist" });
  expect(paused[0]!.text).toContain("/confirm");
  expect(paused[0]!.text).toContain("delete_files");
  expect(store.runs.list(personal.id)[0]!.status).toBe("awaiting_confirmation");

  const resumed = await d.handle({ chatId: "100", text: "/confirm" });
  // The confirmed action ran and the run finished — the reply is no longer a prompt.
  expect(resumed[0]!.text).not.toContain("/confirm");
  expect(resumed[0]!.text).toContain("delete_files");
  expect(store.runs.list(personal.id)[0]!.status).toBe("done");
});

test("a pending confirmation blocks a parallel run until it is resolved", async () => {
  const d = createDispatcher(
    deps({
      adapter: toolCallingAdapter("delete_files", { command: "rm -rf dist" }),
      capabilities: [deleteFilesCapability()],
    }),
  );

  await d.handle({ chatId: "100", text: "clean up dist" }); // pauses
  const reply = await d.handle({ chatId: "100", text: "do something unrelated" });

  expect(reply[0]!.text.toLowerCase()).toContain("waiting for confirmation");
  // Still exactly one run, still parked — the second message did not start a run.
  const runs = store.runs.list(personal.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status).toBe("awaiting_confirmation");
});

test("/cancel clears the pending confirmation so a new task can start", async () => {
  const d = createDispatcher(
    deps({
      adapter: toolCallingAdapter("delete_files", { command: "rm -rf dist" }),
      capabilities: [deleteFilesCapability()],
    }),
  );

  await d.handle({ chatId: "100", text: "clean up dist" }); // pauses
  const cancel = await d.handle({ chatId: "100", text: "/cancel" });
  expect(cancel[0]!.text.toLowerCase()).toContain("paused");

  // A following message is treated as a fresh task (it pauses on its own gate),
  // not answered with "waiting for confirmation" — proving the pending was cleared.
  const next = await d.handle({ chatId: "100", text: "clean up dist again" });
  expect(next[0]!.text).toContain("/confirm");
  expect(store.runs.list(personal.id)).toHaveLength(2);
});

test("in a group, /confirm addressed to another bot does not resume our run", async () => {
  // Group chat ids are negative; Telegram appends @botname to commands there. A
  // /confirm meant for a different bot must not approve this agent's gated action.
  const d = createDispatcher(
    deps({
      adapter: toolCallingAdapter("delete_files", { command: "rm -rf dist" }),
      capabilities: [deleteFilesCapability()],
      allow: new Set(["-100"]),
      botUsername: "ourbot",
    }),
  );

  await d.handle({ chatId: "-100", text: "clean up dist" }); // pauses

  const other = await d.handle({ chatId: "-100", text: "/confirm@other_bot" });
  expect(other[0]!.text.toLowerCase()).toContain("waiting for confirmation");
  expect(store.runs.list(personal.id)[0]!.status).toBe("awaiting_confirmation");

  // The same command addressed to us does resume it.
  const ours = await d.handle({ chatId: "-100", text: "/confirm@ourbot" });
  expect(ours[0]!.text).not.toContain("/confirm");
  expect(store.runs.list(personal.id)[0]!.status).toBe("done");
});

test("a propose agent surfaces its plan without ever pausing to confirm", async () => {
  const d = createDispatcher(
    deps({
      agent: work,
      adapter: toolCallingAdapter("delete_files", { command: "rm -rf notes" }),
      capabilities: [deleteFilesCapability()],
    }),
  );

  const out = await d.handle({ chatId: "100", text: "tidy the notes folder" });

  // Propose never executes a side effect, so a destructive step is withheld into the
  // plan rather than pausing — no confirmation prompt is shown.
  expect(out[0]!.text).not.toContain("/confirm");
  expect(store.runs.list(work.id)[0]!.status).toBe("done");
});

test("with no model configured, a task is declined rather than crashing", async () => {
  // Build deps without an adapter — the chat-edge analog of the HTTP 503.
  const d = createDispatcher({
    store,
    agent: personal,
    adapterReason: "No model is configured.",
    allow: new Set(["100"]),
  });

  const out = await d.handle({ chatId: "100", text: "do a thing" });

  expect(out[0]!.text).toContain("No model is configured.");
  expect(store.runs.list(personal.id)).toHaveLength(0);
});

test("an idle /confirm or /cancel is answered, not run as a task", async () => {
  const d = createDispatcher(deps()); // clean adapter, nothing pending

  const confirm = await d.handle({ chatId: "100", text: "/confirm" });
  expect(confirm[0]!.text.toLowerCase()).toContain("nothing waiting");

  const cancel = await d.handle({ chatId: "100", text: "/cancel" });
  expect(cancel[0]!.text.toLowerCase()).toContain("nothing waiting");

  // Neither started an agent run.
  expect(store.runs.list(personal.id)).toHaveLength(0);
});

test("/help lists the commands for an authorized chat", async () => {
  const d = createDispatcher(deps());
  const out = await d.handle({ chatId: "100", text: "/help" });
  expect(out[0]!.text).toContain("/confirm");
  expect(out[0]!.text).toContain("/cancel");
  // It answered help, not a task — no run was started.
  expect(store.runs.list(personal.id)).toHaveLength(0);
});
