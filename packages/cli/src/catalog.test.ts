// The shipped tool catalog, proven end to end through the real CLI surface.
//
// The acceptance test (acceptance.test.ts) wires its own no-op spy tools through
// the capability seam. This test instead exercises the EXACT catalog the shipped
// binary registers — `workspaceCapabilities`, the same factory `bin.ts` hands
// `CliIO` — so canonical-demo claims 3 and 4 are demonstrable from `asterism run`
// itself, not only from an injected harness (issue #12). Only the model loop is
// faked (a scripted adapter standing in for Pi, exactly as the acceptance test
// does); everything else is real: the command surface, an on-disk store, the
// trust gate, and real files written to and deleted from the agent's workspace.
//
//   Claim 3 — an ordinary write EXECUTES under `autonomous`, and is WITHHELD as a
//             plan under `propose`.
//   Claim 4 — a delete PAUSES at `awaiting_confirmation` even under `autonomous`,
//             the destructive-action gate firing regardless of trust level.
//
// Plus the new surface a real catalog raises: file tools are confined to the
// agent's workspace (best-effort, Phase 0 logical scoping).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsterismStore } from "@qmilab/asterism-core";
import type { RunOutput, RunRequest, RuntimeAdapter } from "@qmilab/asterism-core";

import { workspaceCapabilities } from "./capabilities.js";
import { runCli } from "./cli.js";
import type { CliIO } from "./cli.js";
import { agentWorkspace, dbPath, HOME_DIR_NAME } from "./paths.js";

/** One tool call the scripted substrate will attempt, in order. */
interface ScriptedCall {
  tool: string;
  args: unknown;
}

/**
 * A substrate stand-in that behaves like a real agent loop: it calls the tools the
 * kernel scoped into the request, in order, folding their output into the run's
 * text and stopping on an error result (which is what the gate's
 * awaiting-confirmation result is) or when the run is aborted. Unlike the
 * acceptance test's spies, the tools it drives here are the real catalog's — so a
 * `write_file` call actually writes a file and a `delete_file` call would actually
 * delete one if the gate let it through.
 */
function scriptedAdapter(getScript: () => readonly ScriptedCall[]): RuntimeAdapter {
  return {
    run(request: RunRequest) {
      const output = (async (): Promise<RunOutput> => {
        const texts: string[] = [];
        for (const call of getScript()) {
          if (request.signal?.aborted) break;
          const tool = request.tools.list().find((t) => t.name === call.tool);
          if (!tool) {
            throw new Error(`scripted tool not in the scoped registry: ${call.tool}`);
          }
          const result = await tool.execute({ args: call.args }, request.signal);
          texts.push(result.output);
          if (result.isError) break;
        }
        return { status: "done", text: texts.join("\n") };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
}

describe("shipped tool catalog — claims 3 and 4 from the bare CLI", () => {
  let dir: string;
  let store: AsterismStore;
  let autoWorkspace: string;
  let agentsDir: string;

  /** The current run's script; reassigned before each `run` call. */
  let script: readonly ScriptedCall[] = [];

  let writeOut = "";
  let readOut = "";
  let deleteOut = "";
  let proposeOut = "";
  let escapeOut = "";

  function agentId(name: string): string {
    const agent = store.agents.list().find((a) => a.name === name);
    if (!agent) throw new Error(`catalog test lost agent "${name}"`);
    return agent.id;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "asterism-catalog-"));
    const home = join(dir, HOME_DIR_NAME);
    autoWorkspace = agentWorkspace(home, "auto");
    agentsDir = join(home, "agents");

    const io: CliIO = {
      cwd: dir,
      env: {},
      out: () => {},
      err: () => {},
      // The shipped wiring, verbatim: the real catalog factory and a scripted
      // model loop. No `confirm` — a destructive action must pause, not resolve.
      capabilities: workspaceCapabilities,
      makeAdapter: () => ({ adapter: scriptedAdapter(() => script) }),
    };

    async function run(argv: string[]): Promise<string> {
      const lines: string[] = [];
      const capturing: CliIO = { ...io, out: (t) => lines.push(t), err: (t) => lines.push(t) };
      await runCli(argv, capturing);
      return lines.join("\n");
    }

    await run(["init"]);
    await run(["new", "auto", "--trust", "autonomous"]);
    await run(["new", "careful", "--trust", "propose"]);

    // Claim 3a — an ordinary write executes under autonomous (real file appears).
    script = [{ tool: "write_file", args: { path: "notes/draft.md", content: "hello from the agent" } }];
    writeOut = await run(["run", "auto", "write my notes"]);

    // A read of what was just written comes straight back (read always runs).
    script = [{ tool: "read_file", args: { path: "notes/draft.md" } }];
    readOut = await run(["run", "auto", "read my notes"]);

    // Claim 4 — a delete pauses even under autonomous, and never runs.
    script = [{ tool: "delete_file", args: { path: "notes/draft.md" } }];
    deleteOut = await run(["run", "auto", "delete my notes"]);

    // Claim 3b — a propose agent withholds the same write as a plan; nothing is
    // written to disk.
    script = [{ tool: "write_file", args: { path: "plan.md", content: "should not be written" } }];
    proposeOut = await run(["run", "careful", "draft a plan file"]);

    // Confinement — a path that climbs out of the workspace is refused, even
    // though the write itself is permitted at autonomous; no file lands outside.
    script = [{ tool: "write_file", args: { path: "../escape.txt", content: "nope" } }];
    escapeOut = await run(["run", "auto", "write outside the workspace"]);

    store = AsterismStore.open(dbPath(home));
  });

  afterAll(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("claim 3a — an autonomous write executes and lands on disk", () => {
    expect(writeOut).toContain("Wrote");
    const written = join(autoWorkspace, "notes", "draft.md");
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toBe("hello from the agent");

    const run = store.runs.list(agentId("auto"))[0]!;
    expect(run.status).toBe("done");
    expect(store.events.tail(agentId("auto")).map((e) => e.type)).toContain("action.executed");
  });

  test("a read returns the file's contents", () => {
    expect(readOut).toContain("hello from the agent");
  });

  test("claim 4 — a delete pauses an autonomous run and never removes the file", () => {
    expect(deleteOut).toContain(
      "Run paused: a destructive action needs your confirmation before it can proceed.",
    );
    // The gate intercepted before the tool's real `rmSync` could run.
    expect(existsSync(join(autoWorkspace, "notes", "draft.md"))).toBe(true);

    // Exactly the delete run is parked non-terminal; the other auto runs finished.
    const paused = store.runs.list(agentId("auto")).filter((r) => r.status === "awaiting_confirmation");
    expect(paused).toHaveLength(1);
    expect(paused[0]!.input).toBe("delete my notes");
    expect(store.events.tail(agentId("auto")).map((e) => e.type)).toContain(
      "action.awaiting_confirmation",
    );
  });

  test("claim 3b — a propose agent withholds the write as a plan; nothing is written", () => {
    expect(proposeOut).toContain("[proposed]");
    expect(existsSync(join(agentWorkspace(join(dir, HOME_DIR_NAME), "careful"), "plan.md"))).toBe(false);
    expect(store.events.tail(agentId("careful")).map((e) => e.type)).toContain("action.withheld");
  });

  test("file tools are confined to the agent's workspace", () => {
    expect(escapeOut).toContain("outside this agent's workspace");
    // Nothing was written to the sibling path the `..` traversal pointed at.
    expect(existsSync(join(agentsDir, "escape.txt"))).toBe(false);
  });
});
