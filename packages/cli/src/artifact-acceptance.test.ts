// The Phase 3 · T2a acceptance demo from the design note (§9) as an automated end-to-end
// test. The script runs verbatim through the real CLI surface (`runCli`) against a real
// on-disk store in a temp workspace; only the substrate (a scripted adapter) and capability
// catalog are faked. The kernel — connection persistence, the cross-agent exchange op, the
// artifact projection, trust enforcement, the destructive gate, the event log — is real.
//
// It must demonstrate (design note §9):
//   1. With no active `artifact-only` connection the exchange is refused — and a `handoff`
//      connection does NOT satisfy it (modes are distinct permissions).
//   2. Only the manifest crosses: paths and sizes, never the callee's words, never its
//      memory, never the file contents.
//   3. The callee's gate stays sovereign, and a withheld action contributes no artifact.
//   4. Cross-agent denial holds across the live connection.
//   5. Both event logs record content-free references only.

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
// The callee's prose — the thing this mode exists to withhold. It must never reach the
// caller's side of the exchange, nor the transcript of the `artifact` command.
const CALLEE_PROSE = "PROSE: I dug through the Q3 deck and the market looks strong";
const ARTIFACT_PATH = "drafts/market-section.md";
const ARTIFACT_BYTES = 4300;

interface ScriptedCall {
  tool: string;
  args: unknown;
}

/** A substrate stand-in: calls the kernel-scoped tools in order, then returns fixed text. */
/**
 * Scripted tool names the kernel did NOT scope into a run. The throw below fails the run,
 * but the KERNEL catches an adapter failure and finishes the run `failed`, so the message
 * never reaches the test output — the demo fails on some downstream assertion instead, and
 * the reader goes hunting the wrong thing. Recording the name here makes the diagnosis an
 * assertion rather than a hope that an exception escapes.
 */
const missingTools: string[] = [];

function scriptedAdapter(calls: readonly ScriptedCall[], text: string): RuntimeAdapter {
  return {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        for (const call of calls) {
          if (request.signal?.aborted) break;
          const tool = request.tools.list().find((t) => t.name === call.tool);
          // Loud, not `continue`: an absent tool and a withheld one are observationally
          // identical, so a silent skip lets a demo stop exercising its own claim.
          if (!tool) {
            missingTools.push(call.tool);
            throw new Error(`scripted tool not in the scoped registry: ${call.tool}`);
          }
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

describe("Phase 3 · T2a — artifact-only acceptance demo", () => {
  let dir: string;
  let store: AsterismStore;
  let writer: Agent;
  let researcher: Agent;
  let helper: Agent;

  const transcript: string[] = [];
  const exitCodes: [command: string, code: number][] = [];
  const executed: string[] = [];

  let noConnOut = "";
  let wrongModeOut = "";
  let artifactOut = "";
  let withheldOut = "";
  let connectionsOut = "";

  /** A write tool that declares the artifact it produced (the T1 observation seam). */
  function writeCapability(): Capability {
    return {
      key: "edit_files",
      effect: "write",
      tool: {
        name: "edit_files",
        description: "edit_files (t2a-demo capability)",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          executed.push("edit_files");
          return {
            output: "edit_files: done",
            observation: {
              schema: "asterism.fs.write@1",
              facts: [
                { subject: `file:${ARTIFACT_PATH}`, relation: "exists", object: true },
                { subject: `file:${ARTIFACT_PATH}`, relation: "size_bytes", object: ARTIFACT_BYTES },
              ],
            },
          };
        },
      },
    };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "asterism-artifact-"));

    let script: readonly ScriptedCall[] = [];
    let outputText = CALLEE_PROSE;
    const io: CliIO = {
      cwd: dir,
      env: {},
      out: (t) => transcript.push(t),
      err: (t) => transcript.push(t),
      makeAdapter: () => ({ adapter: scriptedAdapter(script, outputText) }),
      capabilities: () => [writeCapability()],
    };

    async function run(argv: string[]): Promise<string> {
      const start = transcript.length;
      const code = await runCli(argv, io);
      exitCodes.push([argv.join(" "), code]);
      // Checked HERE, on the command that hit it. The kernel catches an adapter
      // failure and finishes the run `failed`, so the throw never surfaces; the demo
      // then crashes several steps downstream (`pausedRun.id` of a run that never
      // paused) and names the symptom instead of the cause.
      if (missingTools.length > 0) {
        throw new Error(
          `scripted tool not in the scoped registry: ${missingTools.join(", ")} (during: ${argv.join(" ")})`,
        );
      }
      return transcript.slice(start).join("\n");
    }

    await run(["init"]);
    await run(["new", "researcher", "--soul", "careful-consultant", "--trust", "propose"]);
    await run(["new", "writer", "--soul", "casual-helper", "--trust", "autonomous"]);
    await run(["new", "helper", "--soul", "casual-helper", "--trust", "autonomous"]);
    await run(["secrets", "add", "writer", "WRITER_TOKEN", WRITER_SECRET]);
    await run(["secrets", "add", "researcher", "RESEARCHER_TOKEN", RESEARCHER_SECRET]);

    // Harness wiring: the tool above is this file's own spy, not the shipped catalog,
    // so each agent is declared to hold it — what an install with its own tools does.
    for (const name of ["researcher", "writer", "helper"]) {
      await run(["capabilities", "set", name, "edit_files"]);
    }

    // (1) Before any connection — refused.
    noConnOut = await run(["artifact", "writer", "helper", "draft the market section"]);

    // (1b) A HANDOFF channel does not authorize an artifact exchange.
    await run(["connect", "writer", "researcher", "--mode", "handoff"]);
    wrongModeOut = await run(["artifact", "writer", "researcher", "draft the market section"]);

    // (2) Open the right channel to an autonomous callee and exchange.
    await run(["connect", "writer", "helper", "--mode", "artifact-only"]);
    script = [{ tool: "edit_files", args: {} }];
    outputText = CALLEE_PROSE;
    artifactOut = await run(["artifact", "writer", "helper", "draft the market section"]);

    // (3) A `propose` callee withholds the write — so it contributes no artifact.
    await run(["connect", "writer", "researcher", "--mode", "artifact-only"]);
    script = [{ tool: "edit_files", args: {} }];
    outputText = "PLAN: I would write the section (proposed, not executed)";
    withheldOut = await run(["artifact", "writer", "researcher", "draft the market section"]);

    connectionsOut = await run(["connections", "writer"]);

    store = AsterismStore.open(dbPath(join(dir, HOME_DIR_NAME)));
    const byName = (name: string): Agent => {
      const agent = store.agents.list().find((a) => a.name === name);
      if (!agent) throw new Error(`t2a setup lost agent "${name}"`);
      return agent;
    };
    writer = byName("writer");
    researcher = byName("researcher");
    helper = byName("helper");
  });

  afterAll(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("every scripted tool reached the scoped registry", () => {
    // Without this the demo can only fail on a downstream assertion, which names the
    // symptom and not the cause: the kernel catches an adapter failure and finishes the
    // run `failed`, so the missing tool never appears in the output.
    expect(missingTools).toEqual([]);
  });

  test("every demo command exits as expected", () => {
    const code = (cmd: string): number => exitCodes.find(([c]) => c === cmd)?.[1] ?? -1;
    expect(code("artifact writer helper draft the market section")).toBe(1); // first: no connection
    expect(code("connect writer helper --mode artifact-only")).toBe(0);
    expect(code("connections writer")).toBe(0);
  });

  // (1) No connection → refused; wrong mode → refused.
  test("with no connection the exchange is refused, naming the mode to open", () => {
    expect(noConnOut).toMatch(/No active artifact-only connection/i);
    expect(noConnOut).toMatch(/--mode artifact-only/);
  });

  test("a handoff connection does NOT authorize an artifact exchange", () => {
    expect(wrongModeOut).toMatch(/No active artifact-only connection/i);
  });

  // (2) Only the manifest crosses.
  test("the caller receives the artifact manifest — path and size", () => {
    expect(artifactOut).toContain(ARTIFACT_PATH);
    expect(artifactOut).toMatch(/4\.2 KB/);
    expect(artifactOut).toMatch(/produced 1 artifact/i);
  });

  test("the callee's PROSE never crosses — not in the manifest, not anywhere in the output", () => {
    expect(artifactOut).not.toContain(CALLEE_PROSE);
    expect(artifactOut).not.toContain("market looks strong");
    // The callee really did produce that text on its own run — so this is proving absence,
    // not passing because nothing was generated.
    const calleeRun = store.runs.list(helper.id).at(0);
    expect(calleeRun?.output).toContain("market looks strong");
  });

  test("the output says plainly what did not cross", () => {
    expect(artifactOut).toMatch(/not helper's words, memory, or the file contents/i);
  });

  // (3) The callee's gate is sovereign; a withheld action yields no artifact.
  test("a propose callee withholds the write, and reports no artifacts", () => {
    expect(withheldOut).toMatch(/produced no artifacts/i);
    // `edit_files` ran exactly once across the whole demo — for the autonomous callee only.
    expect(executed).toEqual(["edit_files"]);
  });

  // (4) Cross-agent denial across the live connection.
  test("each agent's secret stays unreadable from the others", () => {
    expect(store.readSecret(writer.id, "WRITER_TOKEN")).toBe(WRITER_SECRET);
    expect(store.readSecret(researcher.id, "WRITER_TOKEN")).toBeUndefined();
    expect(store.readSecret(helper.id, "WRITER_TOKEN")).toBeUndefined();
    expect(store.readSecret(writer.id, "RESEARCHER_TOKEN")).toBeUndefined();
  });

  test("the run executed as the callee — the caller started none of its own", () => {
    expect(store.runs.list(helper.id).length).toBeGreaterThan(0);
    expect(store.runs.list(writer.id)).toHaveLength(0);
  });

  // (5) Content-free logs.
  test("both event logs record content-free references only", () => {
    const collab = new Set(["connection.created", "handoff.requested", "handoff.completed"]);
    for (const id of [writer.id, helper.id]) {
      const events = store.events.tail(id).filter((e) => collab.has(e.type));
      expect(events.some((e) => e.type === "handoff.requested")).toBe(true);
      expect(events.some((e) => e.type === "handoff.completed")).toBe(true);
      for (const e of events) {
        const p = JSON.stringify(e.payload);
        expect(p).not.toContain("draft the market section");
        expect(p).not.toContain(CALLEE_PROSE);
        expect(p).not.toContain(ARTIFACT_PATH);
        expect(p).not.toContain(WRITER_SECRET);
        expect(p).not.toContain(RESEARCHER_SECRET);
      }
    }
  });

  test("`connections writer` lists both channels with their modes", () => {
    expect(connectionsOut).toContain("artifact-only");
    expect(connectionsOut).toMatch(/→ helper/);
  });

  test("no secret value appears anywhere in the demo output", () => {
    const all = transcript.join("\n");
    expect(all).not.toContain(WRITER_SECRET);
    expect(all).not.toContain(RESEARCHER_SECRET);
  });
});
