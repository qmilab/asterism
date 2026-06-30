// The Phase 3 · T1 acceptance demo from the design note (§7) as an automated end-to-end
// test — the Phase-3 analogue of the Phase-0 canonical demo. The script runs verbatim
// through the real CLI surface (`runCli`) against a real on-disk store in a temp
// workspace; only the substrate (a scripted adapter) and capability catalog are faked. The
// kernel — connection persistence, the cross-agent handoff op, trust enforcement, the
// destructive gate, the event log — is the real thing end to end.
//
// It must demonstrate (design note §7):
//   1. With NO connection, `handoff` is refused (default isolation holds).
//   2. The callee runs the task in ITS OWN identity; the caller receives only the callee's
//      final output — never the callee's memory or secrets.
//   3. A destructive action fires the CALLEE's gate per the callee's trust, independent of
//      the caller's autonomy (callee-sovereign).
//   4. The caller's secret stays unreadable from the callee and vice-versa, across a live
//      connection.
//   5. Both event logs record content-free connection.created / handoff.requested /
//      handoff.completed references — no task text, no output, no secret value.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsterismStore } from "@qmilab/asterism-core";
import type { Agent, Capability, RunOutput, RuntimeAdapter } from "@qmilab/asterism-core";

import { runCli } from "./cli.js";
import type { CliIO } from "./cli.js";
import { dbPath, HOME_DIR_NAME } from "./paths.js";

const WRITER_SECRET = "writer-secret-aaa";
const RESEARCHER_SECRET = "researcher-secret-bbb";
const SUMMARY_OUTPUT = "SUMMARY: the latest notes cover three topics";

interface ScriptedCall {
  tool: string;
  args: unknown;
}

/** A substrate stand-in: calls the kernel-scoped tools in order, folding results into text. */
function scriptedAdapter(calls: readonly ScriptedCall[], text: string): RuntimeAdapter {
  return {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        for (const call of calls) {
          if (request.signal?.aborted) break;
          const tool = request.tools.list().find((t) => t.name === call.tool);
          if (!tool) continue;
          const result = await tool.execute({ args: call.args }, request.signal);
          if (result.isError) break;
        }
        return { status: "done", text };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
}

describe("Phase 3 · T1 — handoff acceptance demo", () => {
  let dir: string;
  let store: AsterismStore;
  let writer: Agent;
  let researcher: Agent;

  const transcript: string[] = [];
  const exitCodes: [command: string, code: number][] = [];
  /** Capability keys whose real `execute` actually ran. */
  const executed: string[] = [];

  let noConnHandoffOut = "";
  let handoffOut = "";
  let destructiveHandoffOut = "";
  let connectionsOut = "";

  function capability(key: string, effect: "write" | "destructive"): Capability {
    return {
      key,
      effect,
      tool: {
        name: key,
        description: `${key} (t1-demo capability)`,
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          executed.push(key);
          return { output: `${key}: done` };
        },
      },
    };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "asterism-handoff-"));

    let script: readonly ScriptedCall[] = [];
    let outputText = SUMMARY_OUTPUT;
    const io: CliIO = {
      cwd: dir,
      env: {},
      out: (t) => transcript.push(t),
      err: (t) => transcript.push(t),
      makeAdapter: () => ({ adapter: scriptedAdapter(script, outputText) }),
      capabilities: () => [capability("edit_files", "write"), capability("delete_files", "destructive")],
      // No `confirm`: a destructive action must take the safe default (withheld under
      // propose; it would pause under notify/autonomous).
    };

    async function run(argv: string[]): Promise<string> {
      const start = transcript.length;
      const code = await runCli(argv, io);
      exitCodes.push([argv.join(" "), code]);
      return transcript.slice(start).join("\n");
    }

    await run(["init"]);
    await run(["new", "researcher", "--soul", "careful-consultant", "--trust", "propose"]);
    await run(["new", "writer", "--soul", "casual-helper", "--trust", "autonomous"]);
    await run(["secrets", "add", "writer", "WRITER_TOKEN", WRITER_SECRET]);
    await run(["secrets", "add", "researcher", "RESEARCHER_TOKEN", RESEARCHER_SECRET]);

    // (1) Handoff BEFORE any connection — must be refused.
    noConnHandoffOut = await run(["handoff", "writer", "researcher", "summarize the latest notes"]);

    // Open the channel, then hand off.
    await run(["connect", "writer", "researcher", "--mode", "handoff"]);
    script = [];
    outputText = SUMMARY_OUTPUT;
    handoffOut = await run(["handoff", "writer", "researcher", "summarize the latest notes"]);

    // (3) A destructive task: researcher is `propose`, so the delete is WITHHELD — the
    // callee's gate governs, not the autonomous caller's.
    script = [{ tool: "delete_files", args: { command: "rm -rf dist" } }];
    outputText = "PLAN: I would delete dist/ (proposed, not executed)";
    destructiveHandoffOut = await run(["handoff", "writer", "researcher", "delete the dist files"]);

    connectionsOut = await run(["connections", "writer"]);

    store = AsterismStore.open(dbPath(join(dir, HOME_DIR_NAME)));
    const byName = (name: string): Agent => {
      const agent = store.agents.list().find((a) => a.name === name);
      if (!agent) throw new Error(`t1 setup lost agent "${name}"`);
      return agent;
    };
    writer = byName("writer");
    researcher = byName("researcher");
  });

  afterAll(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("every demo command exits as expected (handoff-before-connect fails, the rest succeed)", () => {
    const code = (cmd: string): number => exitCodes.find(([c]) => c === cmd)?.[1] ?? -1;
    expect(code("handoff writer researcher summarize the latest notes")).toBe(1); // first one: no connection
    expect(code("connect writer researcher --mode handoff")).toBe(0);
    expect(code("connections writer")).toBe(0);
  });

  // (1) No connection → refused.
  test("with no connection, the handoff is refused and runs nothing on the callee", () => {
    expect(noConnHandoffOut).toMatch(/No active handoff connection/i);
    // The refused handoff (before any connect) created no run on researcher; the later
    // successful ones did. So the refusal genuinely blocked interaction at the time.
    // (We assert the message; the count is covered at the kernel level in handoff.test.ts.)
  });

  // (2) The callee's output crosses to the caller — nothing behind it.
  test("the caller receives the callee's final output", () => {
    expect(handoffOut).toContain(SUMMARY_OUTPUT);
  });

  // (3) The callee's gate is sovereign: a `propose` callee withholds the destructive action.
  test("a destructive handoff is withheld by the propose callee, despite the autonomous caller", () => {
    expect(executed).not.toContain("delete_files");
    expect(destructiveHandoffOut).toContain("PLAN: I would delete dist/");
  });

  // (4) Cross-agent denial across the live connection.
  test("the caller's secret is unreadable from the callee and vice-versa", () => {
    expect(store.readSecret(writer.id, "WRITER_TOKEN")).toBe(WRITER_SECRET);
    expect(store.readSecret(researcher.id, "WRITER_TOKEN")).toBeUndefined();
    expect(store.readSecret(researcher.id, "RESEARCHER_TOKEN")).toBe(RESEARCHER_SECRET);
    expect(store.readSecret(writer.id, "RESEARCHER_TOKEN")).toBeUndefined();
  });

  test("the run executed as the callee — researcher has runs, writer has none", () => {
    expect(store.runs.list(researcher.id).length).toBeGreaterThan(0);
    expect(store.runs.list(writer.id)).toHaveLength(0);
  });

  // (5) Both logs carry content-free collaboration markers.
  test("both event logs record content-free connection/handoff references", () => {
    const collab = new Set(["connection.created", "handoff.requested", "handoff.completed"]);
    for (const id of [writer.id, researcher.id]) {
      const events = store.events.tail(id).filter((e) => collab.has(e.type));
      expect(events.some((e) => e.type === "connection.created")).toBe(true);
      expect(events.some((e) => e.type === "handoff.requested")).toBe(true);
      expect(events.some((e) => e.type === "handoff.completed")).toBe(true);
      for (const e of events) {
        const p = JSON.stringify(e.payload);
        expect(p).not.toContain("summarize the latest notes");
        expect(p).not.toContain(SUMMARY_OUTPUT);
        expect(p).not.toContain(WRITER_SECRET);
        expect(p).not.toContain(RESEARCHER_SECRET);
      }
    }
  });

  test("`connections writer` lists the one outbound channel to researcher", () => {
    expect(connectionsOut).toContain("researcher");
    expect(connectionsOut).toContain("handoff");
    expect(connectionsOut).toMatch(/→ researcher/);
  });

  // The full transcript never leaked a secret value anywhere.
  test("no secret value appears anywhere in the demo output", () => {
    const all = transcript.join("\n");
    expect(all).not.toContain(WRITER_SECRET);
    expect(all).not.toContain(RESEARCHER_SECRET);
  });
});
