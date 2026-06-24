// Tests for the optional Lodestar cognition layer. The discipline these prove:
//   1. The wrapper is a transparent decorator — the inner adapter's output is
//      returned unchanged (opting in changes nothing about the run's result).
//   2. The trace is REFERENCES-ONLY — a secret a tool returns NEVER reaches the log,
//      and not even a bare hash of it (which would be dictionary-attackable).
//   3. INTEGRITY — the trace is written to a host-provided root OFF the agent workspace,
//      so the agent's own file tools cannot reach it; cross-agent reads find nothing.
//   4. Observe-only resilience — a tool that throws still propagates; the run is not
//      altered by the trace being a side record.
//   5. The read surface surfaces the recorded references (status + size) and treats a
//      corrupt log as an error, never as an empty/absent trace.

import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolRegistry } from "@qmilab/asterism-core";
import type {
  RunHandle,
  RunOutput,
  RunRequest,
  RuntimeAdapter,
  ScopedTool,
  ToolObservation,
} from "@qmilab/asterism-core";
import { renderTrace, wrapWithLodestar } from "./index.js";

const SECRET = "sk-super-secret-value-DO-NOT-LOG-9f3a";

// A test's temp `dir` holds two SIBLINGS — neither contains the other — mirroring the
// production layout where the trace root (`<home>/traces`) is a sibling of the agent
// workspace (`<home>/agents/<name>`). Using siblings (not `traces/` INSIDE the workspace)
// is what makes the "off-workspace" guarantee actually testable: a trace root nested in
// the workspace would be reachable by the agent's file tools, defeating the integrity property.

/** The agent's tool-writable workspace for a test. */
function workspaceIn(dir: string): string {
  return join(dir, "workspace");
}

/** The host trace root for a test — a sibling of {@link workspaceIn}, OUTSIDE the workspace. */
function traceRootIn(dir: string): string {
  return join(dir, "traces");
}

/** A scoped tool whose output is a secret — to prove the trace never records it. */
function secretEchoTool(): ScopedTool {
  return {
    name: "echo",
    description: "returns a secret",
    inputSchema: {},
    execute: () => ({ output: SECRET }),
  };
}

/** A scoped tool that returns an error RESULT (not a throw) — to prove status is captured. */
function erroringTool(): ScopedTool {
  return {
    name: "flaky",
    description: "errors",
    inputSchema: {},
    execute: () => ({ output: "boom", isError: true }),
  };
}

/** Benign text in {@link mixedOutputTool}'s output — must SHOW in a content-mode trace. */
const BENIGN = "status ok for build 42";

/**
 * A scoped tool whose output mixes benign content with a secret — to prove content mode
 * captures the benign part but the redaction boundary scrubs the secret.
 */
function mixedOutputTool(): ScopedTool {
  return {
    name: "report",
    description: "returns mixed content",
    inputSchema: {},
    execute: () => ({ output: `${BENIGN}\nleaked key: ${SECRET}\ndone` }),
  };
}

/** A scoped tool that emits a clean structured observation (benign facts) alongside its output. */
function factEmittingTool(): ScopedTool {
  return {
    name: "writer",
    description: "writes and reports structured facts",
    inputSchema: {},
    execute: () => ({
      output: "Wrote 42 bytes to 'notes/todo.md'.",
      observation: {
        schema: "asterism.fs.write@1",
        facts: [
          { subject: "file:notes/todo.md", relation: "size_bytes", object: 42 },
          { subject: "file:notes/todo.md", relation: "exists", object: true },
        ],
      },
    }),
  };
}

/** A tool whose observation SUBJECT carries a secret-shaped path — to prove facts are redacted. */
function secretFactTool(): ScopedTool {
  return {
    name: "leaky",
    description: "emits a fact whose subject looks like a secret",
    inputSchema: {},
    execute: () => ({
      output: "ok",
      observation: {
        schema: "asterism.fs.read@1",
        facts: [{ subject: `file:config/${SECRET}`, relation: "size_bytes", object: 7 }],
      },
    }),
  };
}

/** A tool whose fact subject embeds a newline + a fake audit line — to prove render can't be spoofed. */
function lineInjectingTool(): ScopedTool {
  return {
    name: "sneaky",
    description: "emits a fact whose subject contains a newline",
    inputSchema: {},
    execute: () => ({
      output: "ok",
      observation: {
        schema: "asterism.fs.read@1",
        // A POSIX path can legitimately contain a newline; redactForTrace keeps newlines, so
        // without single-line escaping at render this would forge an extra audit line.
        facts: [{ subject: "file:a\nRecorded tool calls (99):", relation: "size_bytes", object: 1 }],
      },
    }),
  };
}

/** A tool that returns a MALFORMED observation (no facts array) — as an untyped JS tool might. */
function malformedObservationTool(): ScopedTool {
  return {
    name: "malformed",
    description: "returns an observation with no facts array",
    inputSchema: {},
    execute: () => ({
      output: "still useful",
      // Despite the TS contract, a third-party/JS tool can hand back this shape at runtime.
      observation: { schema: "asterism.bad@1" } as unknown as ToolObservation,
    }),
  };
}

/** A tool that emits `n` facts in one call — to prove the per-observation fact cap holds. */
function manyFactsTool(n: number): ScopedTool {
  return {
    name: "lister",
    description: "emits many facts",
    inputSchema: {},
    execute: () => ({
      output: "listed",
      observation: {
        schema: "asterism.fs.list@1",
        facts: Array.from({ length: n }, (_, i) => ({
          subject: `file:f${i}.txt`,
          relation: "exists",
          object: true,
        })),
      },
    }),
  };
}

/** A scoped tool that throws — to prove a throw still propagates through the wrapper. */
function throwingTool(): ScopedTool {
  return {
    name: "boom",
    description: "throws",
    inputSchema: {},
    execute: () => {
      throw new Error("tool failed");
    },
  };
}

/**
 * A fake inner adapter that DRIVES the registry: it invokes the named tool once, then
 * returns a fixed output. Standing in for Pi — it lets us prove the wrapper records the
 * call without running a real model loop.
 */
function toolDrivingAdapter(toolName: string): RuntimeAdapter {
  return {
    run(request: RunRequest): RunHandle {
      const output: Promise<RunOutput> = (async () => {
        const tool = request.tools.list().find((t) => t.name === toolName);
        if (!tool) return { status: "failed", text: "", error: "no such tool" };
        const result = await tool.execute({ args: { note: "call" } });
        return { status: "done", text: `ran:${result.output}` };
      })();
      async function* noEvents() {
        // no lifecycle events in this fake
      }
      return { events: noEvents(), output };
    },
  };
}

function requestFor(workspaceDir: string, tool: ScopedTool): RunRequest {
  return {
    workspaceDir,
    input: "do the thing",
    tools: createToolRegistry([tool]),
  };
}

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "asterism-lodestar-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Recursively read every file under a dir into one string (for "does it contain X" checks). */
async function readTreeText(dir: string): Promise<string> {
  let out = "";
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out += await readTreeText(full);
    else out += await readFile(full, "utf8");
  }
  return out;
}

/** Run `toolName` once for `agentId`, tracing to `traceRootIn(dir)` with workspace separate. */
function runTraced(dir: string, agentId: string, tool: ScopedTool): Promise<RunOutput> {
  const wrapped = wrapWithLodestar(toolDrivingAdapter(tool.name), {
    agentId,
    traceRoot: traceRootIn(dir),
  });
  return wrapped.run(requestFor(workspaceIn(dir), tool)).output;
}

/** Like {@link runTraced}, but with content capture opted in (`captureContent: true`). */
function runTracedContent(dir: string, agentId: string, tool: ScopedTool): Promise<RunOutput> {
  const wrapped = wrapWithLodestar(toolDrivingAdapter(tool.name), {
    agentId,
    traceRoot: traceRootIn(dir),
    captureContent: true,
  });
  return wrapped.run(requestFor(workspaceIn(dir), tool)).output;
}

test("the wrapper returns the inner adapter's output unchanged", async () => {
  await withWorkspace(async (dir) => {
    const output = await runTraced(dir, "agent-a", secretEchoTool());
    expect(output.status).toBe("done");
    expect(output.text).toBe(`ran:${SECRET}`); // the run itself still sees the real value
  });
});

test("the run records a renderable trace under the host trace root", async () => {
  await withWorkspace(async (dir) => {
    await runTraced(dir, "agent-a", secretEchoTool());
    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).toBeDefined();
    expect(report).toContain("echo"); // the tool name is in the references-only trace
  });
});

test("the trace lives OFF the agent workspace, so the agent's file tools cannot reach it", async () => {
  await withWorkspace(async (dir) => {
    await runTraced(dir, "agent-a", secretEchoTool());
    // The trace root is a SIBLING of the workspace, not nested inside it — so it is not on
    // any path the agent's workspace-confined file tools can write.
    const workspace = workspaceIn(dir);
    const sep = workspace.endsWith("/") ? "" : "/";
    expect(traceRootIn(dir).startsWith(workspace + sep)).toBe(false); // not under the workspace
    // Nothing was written into the workspace by the trace; the trace is in the host root.
    expect(await readTreeText(workspace)).toBe("");
    expect(await readTreeText(traceRootIn(dir))).not.toBe("");
  });
});

test("the trace is references-only — a secret (or a bare hash of it) never reaches the log", async () => {
  await withWorkspace(async (dir) => {
    await runTraced(dir, "agent-a", secretEchoTool());

    const onDisk = await readTreeText(traceRootIn(dir));
    expect(onDisk.length).toBeGreaterThan(0); // something WAS written
    expect(onDisk).not.toContain(SECRET); // ...but never the secret value
    // Nor a BARE digest of it: a plain sha-256 of a low-entropy output is offline
    // dictionary-attackable, so the fingerprint must be KEYED, not a precomputable hash.
    const bareSha = createHash("sha256").update(SECRET).digest("hex");
    expect(onDisk).not.toContain(bareSha);
    expect(onDisk).not.toContain(bareSha.slice(0, 32));
    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).not.toContain(SECRET); // nor does the rendered report
  });
});

test("the output fingerprint is keyed per run — the same output digests differently across runs", async () => {
  await withWorkspace(async (rootA) => {
    await withWorkspace(async (rootB) => {
      // Two runs of the same agent (separate roots here only so we can read them apart)
      // return the SAME secret output. A keyed, per-run fingerprint must differ between
      // them (different in-memory keys), so the digest cannot be precomputed or correlated.
      await runTraced(rootA, "agent-a", secretEchoTool());
      await runTraced(rootB, "agent-a", secretEchoTool());

      const fpA = (await readTreeText(traceRootIn(rootA))).match(/[0-9a-f]{32}/g) ?? [];
      const fpB = (await readTreeText(traceRootIn(rootB))).match(/[0-9a-f]{32}/g) ?? [];
      expect(fpA.length).toBeGreaterThan(0);
      expect(fpB.length).toBeGreaterThan(0);
      expect(fpA.some((h) => fpB.includes(h))).toBe(false);
    });
  });
});

test("cross-agent isolation: a trace never surfaces under another agent's id", async () => {
  await withWorkspace(async (dir) => {
    // agent-a records a trace under this root.
    await runTraced(dir, "agent-a", secretEchoTool());
    // Reading the SAME root for a different agent yields nothing — the trace is partitioned
    // by agent id, so agent-b cannot read agent-a's trace even pointed at the same root.
    expect(await renderTrace(traceRootIn(dir), "agent-b")).toBeUndefined();
  });
});

test("references mode (the default) records NO content — output text is absent from the trace", async () => {
  await withWorkspace(async (dir) => {
    await runTraced(dir, "agent-a", mixedOutputTool());
    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).toContain("report"); // the tool name (a reference) is recorded...
    expect(report).not.toContain(BENIGN); // ...but no output content, even benign content
  });
});

test("content mode captures REDACTED content — benign text shows, the secret is scrubbed", async () => {
  await withWorkspace(async (dir) => {
    await runTracedContent(dir, "agent-a", mixedOutputTool());

    // Even with content ON, the secret never lands on disk — the redaction boundary scrubs
    // it BEFORE the write (this is the whole point of slice 2a).
    const onDisk = await readTreeText(traceRootIn(dir));
    expect(onDisk).not.toContain(SECRET);

    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).toContain(BENIGN); // benign content IS captured (the new capability)
    expect(report).not.toContain(SECRET); // the secret is redacted out
    expect(report).toContain("[redacted:value]"); // and marked
    expect(report).toContain("redactions: secrets="); // the redaction summary shows
  });
});

test("cross-agent isolation holds in content mode: A's captured content never surfaces under B", async () => {
  await withWorkspace(async (dir) => {
    await runTracedContent(dir, "agent-a", mixedOutputTool());
    // Agent B reading the same root sees nothing — content is partitioned per agent id, so
    // B can never read A's captured content (the golden-rule cross-agent test, content path).
    expect(await renderTrace(traceRootIn(dir), "agent-b")).toBeUndefined();
  });
});

test("a tool that throws still propagates through the wrapper (observe-only side record)", async () => {
  await withWorkspace(async (dir) => {
    const wrapped = wrapWithLodestar(toolDrivingAdapter("boom"), {
      agentId: "agent-a",
      traceRoot: traceRootIn(dir),
    });
    // The wrapper records the throw, then RE-RAISES it — it must not swallow a tool
    // failure to write its side record. The fake adapter surfaces that as a rejected
    // output promise.
    const handle = wrapped.run(requestFor(workspaceIn(dir), throwingTool()));
    await expect(handle.output).rejects.toThrow("tool failed");
  });
});

test("the trace summary surfaces each call's status and output size", async () => {
  await withWorkspace(async (dir) => {
    // A successful call and a failed one, recorded for the same agent.
    await runTraced(dir, "agent-a", secretEchoTool());
    await runTraced(dir, "agent-a", erroringTool());

    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).toContain("Recorded tool calls");
    expect(report).toContain("echo  [ok]"); // success is distinguishable...
    expect(report).toContain("flaky  [error]"); // ...from failure
    expect(report).toMatch(/\d+ bytes/); // and the (references-only) output size shows
  });
});

test("renderTrace handles an agent with multiple runs (sessions) without interleaving", async () => {
  await withWorkspace(async (dir) => {
    // Two runs for the same agent under one root → two Lodestar sessions. Each must be
    // projected on its own (Lodestar orders by per-session logical_clock and labels by a
    // single session id), so rendering must not pass both sessions into one projection.
    await runTraced(dir, "agent-a", secretEchoTool());
    await runTraced(dir, "agent-a", secretEchoTool());

    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).toBeDefined();
    expect(report).toContain("echo"); // both runs rendered; multi-session does not throw
  });
});

test("renderTrace returns undefined for an agent that never recorded a trace", async () => {
  await withWorkspace(async (dir) => {
    // A missing log directory is "no trace", not an error (readAll returns []).
    expect(await renderTrace(traceRootIn(dir), "never-ran")).toBeUndefined();
  });
});

test("renderTrace surfaces a corrupt log as an error, not as 'no trace'", async () => {
  await withWorkspace(async (dir) => {
    // A malformed NDJSON line is a REAL read failure — it must propagate so `asterism
    // trace` can report the corruption, never be masked as an empty/absent trace.
    const projectDir = join(traceRootIn(dir), "agent-a");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "2026-06-23.ndjson"), "{not valid json\n");
    await expect(renderTrace(traceRootIn(dir), "agent-a")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Structured facts (slice T1) — a tool's `observation` is recorded under @3,
// redacted at the same boundary as content, partitioned per agent like the rest.
// ---------------------------------------------------------------------------

test("a tool's structured facts are recorded under @3 and rendered in the report", async () => {
  await withWorkspace(async (dir) => {
    await runTraced(dir, "agent-a", factEmittingTool());

    const onDisk = await readTreeText(traceRootIn(dir));
    expect(onDisk).toContain("asterism.tool_result@3"); // the trace-record superset schema
    expect(onDisk).toContain("asterism.fs.write@1"); // the observation's own fact schema

    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).toContain("facts (asterism.fs.write@1):");
    expect(report).toContain("file:notes/todo.md size_bytes = 42");
    expect(report).toContain("file:notes/todo.md exists = true");
  });
});

test("facts ride the redaction boundary — a secret-shaped fact subject never reaches the log", async () => {
  await withWorkspace(async (dir) => {
    await runTraced(dir, "agent-a", secretFactTool());

    const onDisk = await readTreeText(traceRootIn(dir));
    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk).not.toContain(SECRET); // the secret-shaped path is scrubbed IN the fact
    expect(onDisk).toContain("[redacted:value]");

    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).not.toContain(SECRET);
    expect(report).toContain("fact redactions: secrets="); // the fact-redaction summary shows
  });
});

test("facts are recorded in REFERENCES mode too (no content), proving they are reference-grade", async () => {
  await withWorkspace(async (dir) => {
    // A references-only run (the default) with a fact-emitting tool: the facts ARE recorded,
    // but the human-readable output content is NOT — facts are references, not content.
    await runTraced(dir, "agent-a", factEmittingTool());
    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).toContain("file:notes/todo.md size_bytes = 42"); // facts present...
    expect(report).not.toContain("Wrote 42 bytes"); // ...but the output content is absent
  });
});

test("content mode with facts records BOTH the redacted content and the facts (@3 superset)", async () => {
  await withWorkspace(async (dir) => {
    await runTracedContent(dir, "agent-a", factEmittingTool());
    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).toContain("Wrote 42 bytes"); // the benign content is captured...
    expect(report).toContain("file:notes/todo.md size_bytes = 42"); // ...alongside the facts
  });
});

test("cross-agent isolation holds for facts: A's recorded facts never surface under B", async () => {
  await withWorkspace(async (dir) => {
    await runTraced(dir, "agent-a", factEmittingTool());
    // The facts ride the same agent-id partition as the rest of the trace.
    expect(await renderTrace(traceRootIn(dir), "agent-b")).toBeUndefined();
  });
});

test("the call count reports CALLS, not rendered lines, even when facts add extra lines", async () => {
  await withWorkspace(async (dir) => {
    // factEmittingTool emits TWO facts in ONE call. The header counts CALLS, so it must read
    // "(1)" — not "(3)" for the call line plus its two fact lines.
    await runTraced(dir, "agent-a", factEmittingTool());
    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).toContain("Recorded tool calls (1):");
  });
});

test("a newline in a fact field cannot forge extra audit lines — it is single-line escaped", async () => {
  await withWorkspace(async (dir) => {
    await runTraced(dir, "agent-a", lineInjectingTool());
    const report = await renderTrace(traceRootIn(dir), "agent-a");
    // The real call count is 1; the forged "(99)" line must NOT appear as its own audit line.
    expect(report).toContain("Recorded tool calls (1):");
    expect(report).not.toMatch(/\n\s*Recorded tool calls \(99\):/);
    // The newline is rendered as a visible escape, keeping the fact on one line.
    expect(report).toContain("file:a\\nRecorded tool calls (99):");
  });
});

test("a malformed observation degrades to references — the call is recorded, never dropped", async () => {
  await withWorkspace(async (dir) => {
    // The observation has no valid `facts` array. Reading `.facts.length` would throw, and the
    // wrapper's `.catch` would swallow it — dropping the WHOLE call from the trace. The guard
    // must instead fall back to the @1 references record so the call still appears in the audit.
    await runTraced(dir, "agent-a", malformedObservationTool());
    const onDisk = await readTreeText(traceRootIn(dir));
    expect(onDisk).toContain("asterism.tool_result@1"); // references recorded...
    expect(onDisk).not.toContain("asterism.tool_result@3"); // ...not the @3 facts record
    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).toContain("malformed  [ok]"); // the call is present in the audit
  });
});

test("a flood of facts is capped on disk and the drop is surfaced in the audit", async () => {
  await withWorkspace(async (dir) => {
    await runTraced(dir, "agent-a", manyFactsTool(70)); // 70 > the default cap of 64
    const report = await renderTrace(traceRootIn(dir), "agent-a");
    expect(report).toContain("fact redactions: facts dropped=6"); // 70 - 64
    // Only the capped facts were stored, so only that many render.
    const factLines = (report ?? "").split("\n").filter((l) => l.includes("exists = true"));
    expect(factLines).toHaveLength(64);
  });
});

test("a no-facts call in references mode is unchanged — still @1, no observation field", async () => {
  await withWorkspace(async (dir) => {
    // The byte-for-byte property: a tool that emits no observation records the slice-1
    // record exactly — @1, and nothing fact-shaped on disk.
    await runTraced(dir, "agent-a", secretEchoTool());
    const onDisk = await readTreeText(traceRootIn(dir));
    expect(onDisk).toContain("asterism.tool_result@1");
    expect(onDisk).not.toContain("asterism.tool_result@3");
    expect(onDisk).not.toContain("fact_redaction");
  });
});
