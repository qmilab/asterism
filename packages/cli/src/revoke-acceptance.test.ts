// `asterism disconnect` end-to-end through the real CLI surface — withdrawing a channel
// that was granted (issue #117, design note §15).
//
// Before this, a granted cross-agent permission was permanent. The script runs verbatim
// through `runCli` against a real on-disk store AND real workspaces: the callee's tool
// writes an actual file, the fetch copies actual bytes, and the revoke is a real kernel
// transition. Only the substrate (a scripted adapter) is faked.
//
// It must demonstrate (design note §15):
//   1. Revoke withdraws ALL FOUR capabilities — handoff, artifact, fetch, summary.
//   2. Revoke is exact: only the named (from, to, mode) triple is touched.
//   3. Revoke is terminal — reconnecting opens a NEW channel that old references do not
//      resolve over, and both rows stay visible in `connections`.
//   4. Work already in flight is not stranded: a paused run still confirms, but nothing it
//      produces afterwards crosses the withdrawn channel.
//   5. Both event logs record `connection.revoked` as content-free references.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AsterismStore } from "@qmilab/asterism-core";
import type { Action, Agent, Capability, RunOutput, RuntimeAdapter } from "@qmilab/asterism-core";

import { artifactFetchHost } from "./capabilities.js";
import { runCli } from "./cli.js";
import type { CliIO } from "./cli.js";
import { dbPath, HOME_DIR_NAME } from "./paths.js";

const WRITER_SECRET = "writer-secret-aaa";
const HELPER_SECRET = "helper-secret-bbb";
const CALLEE_PROSE = "PROSE: the market section is drafted";
const ARTIFACT_PATH = "drafts/market-section.md";
const ARTIFACT_BODY = "# Market\n\nThe market is large and growing.\n";
const LATE_PATH = "drafts/final.md";
const LATE_BODY = "# Final\n\nWritten after the confirmation.\n";
const RATIFIED_MEMORY = "Pricing is always quoted in USD, never local currency.";

describe("Phase 3 · connection revoke — acceptance", () => {
  let dir: string;
  let store: AsterismStore;
  let writer: Agent;
  let helper: Agent;

  const transcript: string[] = [];
  const exitCodes: [command: string, code: number][] = [];

  let fetchedOut = "";
  let disconnectOut = "";
  let fetchAfterOut = "";
  let handoffAfterOut = "";
  let artifactAfterOut = "";
  let summaryAfterOut = "";
  let connectionsOut = "";
  let fetchAfterReconnectOut = "";
  let ambiguousOut = "";
  let notOpenOut = "";
  let alreadyRevokedOut = "";
  let badModeOut = "";
  let valuelessModeOut = "";
  let pausedOut = "";
  let confirmOut = "";
  let fetchLateOut = "";
  let landedAfterRevoke = true;

  /** Switches the callee's script between the first artifact and the post-confirm one. */
  let stage: "artifact" | "paused" | "resumed" = "artifact";

  /** A write tool that writes a REAL file and declares the artifact it produced. */
  function writeCapability(workspaceDir: string, path: string, body: string): Capability {
    return {
      key: `fs.write.${path}`,
      effect: "write",
      tool: {
        name: `write_${path === ARTIFACT_PATH ? "artifact" : "late"}`,
        description: "write a drafted file",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          const abs = join(workspaceDir, path);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, body);
          // Backdate it: a real confirmation is human-length, and the fetch staleness check
          // compares against the exchange record's timestamp. Without this the fixture's
          // sub-millisecond timings decide the outcome instead of the behaviour under test.
          const past = Date.now() / 1000 - 120;
          utimesSync(abs, past, past);
          const bytes = Buffer.byteLength(body, "utf8");
          return {
            output: `wrote ${bytes} bytes`,
            observation: {
              schema: "asterism.fs.write@1",
              facts: [
                { subject: `file:${path}`, relation: "size_bytes", object: bytes },
                { subject: `file:${path}`, relation: "exists", object: true },
              ],
            },
          };
        },
      },
    };
  }

  /** The destructive step the callee's own gate parks on. */
  function deleteCapability(): Capability {
    return {
      key: "fs.delete",
      effect: "destructive",
      tool: {
        name: "delete_generated",
        description: "delete the generated files",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({
          output: "deleted",
          observation: {
            schema: "asterism.fs.delete@1",
            facts: [{ subject: "file:dist/generated.js", relation: "exists", object: false }],
          },
        }),
      },
    };
  }

  function scriptedAdapter(tools: readonly string[]): RuntimeAdapter {
    return {
      run(request) {
        const output = (async (): Promise<RunOutput> => {
          for (const name of tools) {
            if (request.signal?.aborted) break;
            const tool = request.tools.list().find((t) => t.name === name);
            // Loud, not `continue`: an absent tool and a withheld one are observationally
            // identical, so a silent skip lets a demo stop exercising its own claim.
            if (!tool) {
              throw new Error(`scripted tool not in the scoped registry: ${call.tool}`);
            }
            const result = await tool.execute({ args: {} }, request.signal);
            if (result.isError) break;
          }
          return { status: "done", text: CALLEE_PROSE };
        })();
        async function* noEvents() {}
        return { events: noEvents(), output };
      },
    };
  }

  const workspaceOf = (name: string): string => join(dir, HOME_DIR_NAME, "agents", name);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "asterism-revoke-acc-"));

    const io: CliIO = {
      cwd: dir,
      env: {},
      out: (t) => transcript.push(t),
      err: (t) => transcript.push(t),
      makeAdapter: () => ({
        adapter: scriptedAdapter(
          stage === "artifact"
            ? ["write_artifact"]
            : stage === "paused"
              ? ["write_artifact", "delete_generated"]
              : ["write_artifact", "delete_generated", "write_late"],
        ),
      }),
      capabilities: (workspaceDir) => [
        writeCapability(workspaceDir, ARTIFACT_PATH, ARTIFACT_BODY),
        writeCapability(workspaceDir, LATE_PATH, LATE_BODY),
        deleteCapability(),
      ],
      // The REAL host: real confinement, real bytes.
      fetchHost: artifactFetchHost(),
      // Declining during the `paused` stage is how the callee's run parks at its own
      // destructive gate — the state a revoke must not be able to strand.
      confirm: (_action: Action) => stage !== "paused",
    };

    async function run(argv: string[]): Promise<string> {
      const start = transcript.length;
      const code = await runCli(argv, io);
      exitCodes.push([argv.join(" "), code]);
      return transcript.slice(start).join("\n");
    }

    await run(["init"]);
    await run(["new", "writer", "--soul", "casual-helper", "--trust", "autonomous"]);
    await run(["new", "helper", "--soul", "casual-helper", "--trust", "autonomous"]);

    // Harness wiring: these tools are this file's own spies, not the shipped catalog,
    // so each agent is declared to hold them — what an install with its own tools does.
    for (const name of ["writer", "helper"]) {
      await run([
        "capabilities",
        "set",
        name,
        `fs.write.${ARTIFACT_PATH}`,
        `fs.write.${LATE_PATH}`,
        "fs.delete",
      ]);
    }
    await run(["secrets", "add", "writer", "WRITER_TOKEN", WRITER_SECRET]);
    await run(["secrets", "add", "helper", "HELPER_TOKEN", HELPER_SECRET]);

    // Ratified memory on the callee, so the read-summary capability has something to carry.
    const seedStore = AsterismStore.open(dbPath(join(dir, HOME_DIR_NAME)));
    const seedHelper = seedStore.agents.list().find((a) => a.name === "helper")!;
    seedStore.recordMemory(seedHelper.id, {
      memoryType: "semantic",
      content: RATIFIED_MEMORY,
      confidence: 0.9,
      reviewState: "accepted",
    });
    seedStore.close();

    // --- The §15 script -----------------------------------------------------

    await run(["connect", "writer", "helper", "--mode", "artifact-only"]);
    await run(["artifact", "writer", "helper", "draft the market section"]);
    fetchedOut = await run(["fetch", "writer", "helper", ARTIFACT_PATH]);

    // Two more channels, to prove the revoke is exact and that inference refuses to guess.
    await run(["connect", "writer", "helper", "--mode", "handoff"]);
    await run(["connect", "writer", "helper", "--mode", "read-summary"]);
    ambiguousOut = await run(["disconnect", "writer", "helper"]);

    // Malformed invocations, before anything is withdrawn.
    badModeOut = await run(["disconnect", "writer", "helper", "--mode", "delegated-tool"]);
    valuelessModeOut = await run(["disconnect", "writer", "helper", "--mode"]);

    // (1) Withdraw the artifact-only channel by name.
    disconnectOut = await run(["disconnect", "writer", "helper", "--mode", "artifact-only"]);
    fetchAfterOut = await run(["fetch", "writer", "helper", ARTIFACT_PATH]);
    landedAfterRevoke = existsSync(join(workspaceOf("writer"), LATE_PATH));
    artifactAfterOut = await run(["artifact", "writer", "helper", "draft it again"]);
    // ...while the pair's OTHER channels still work.
    summaryAfterOut = await run(["summary", "writer", "helper"]);

    // Withdraw the rest, and prove each capability goes with its own channel.
    await run(["disconnect", "writer", "helper", "--mode", "read-summary"]);
    const summaryGoneOut = await run(["summary", "writer", "helper"]);
    expect(summaryGoneOut).toMatch(/no .*read-summary|not connected|no channel|no open/i);
    // The last remaining channel — so `--mode` can be inferred again.
    disconnectOut += `\n${await run(["disconnect", "writer", "helper"])}`;
    handoffAfterOut = await run(["handoff", "writer", "helper", "do it"]);

    // Withdrawing what is not open, and re-withdrawing what already was.
    notOpenOut = await run(["disconnect", "writer", "helper"]);
    alreadyRevokedOut = await run(["disconnect", "writer", "helper", "--mode", "artifact-only"]);

    // (3) Reconnect: a NEW channel. Old references do not travel to it.
    await run(["connect", "writer", "helper", "--mode", "artifact-only"]);
    fetchAfterReconnectOut = await run(["fetch", "writer", "helper", ARTIFACT_PATH]);
    connectionsOut = await run(["connections", "writer"]);

    // (4) Work in flight: an exchange that PAUSES on the callee's own gate, revoked before
    //     the callee's operator confirms it.
    stage = "paused";
    pausedOut = await run(["artifact", "writer", "helper", "draft it and clean up dist/"]);
    const paused = AsterismStore.open(dbPath(join(dir, HOME_DIR_NAME)));
    const pausedHelper = paused.agents.list().find((a) => a.name === "helper")!;
    const pausedRun = paused.runs
      .list(pausedHelper.id)
      .filter((r) => r.status === "awaiting_confirmation")
      .at(-1)!;
    paused.close();

    await run(["disconnect", "writer", "helper", "--mode", "artifact-only"]);
    stage = "resumed";
    confirmOut = await run(["confirm", "helper", pausedRun.id]);
    fetchLateOut = await run(["fetch", "writer", "helper", LATE_PATH]);

    store = AsterismStore.open(dbPath(join(dir, HOME_DIR_NAME)));
    writer = store.agents.list().find((a) => a.name === "writer")!;
    helper = store.agents.list().find((a) => a.name === "helper")!;
  });

  afterAll(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Invariant 1: all four capabilities are withdrawn ---------------------

  test("the artifact landed while the channel was open", () => {
    expect(fetchedOut).toContain(ARTIFACT_PATH);
    expect(existsSync(join(workspaceOf("writer"), ARTIFACT_PATH))).toBe(true);
  });

  test("disconnect reports what was taken away, in behavioural terms", () => {
    expect(disconnectOut).toContain("Disconnected writer → helper (artifact-only)");
    // The consequence an operator most needs to know, and the one most easily missed.
    expect(disconnectOut).toContain("can no longer be fetched");
    expect(disconnectOut).toContain("does not bring the old one back");
    // Public copy: no internal vocabulary in what an operator reads.
    for (const forbidden of [/\bkernel\b/i, /\brevoked\b/, /\bconnection row\b/i]) {
      expect(disconnectOut).not.toMatch(forbidden);
    }
  });

  test("FETCH is refused once the channel is withdrawn — for an artifact already exchanged", () => {
    expect(fetchAfterOut).not.toContain("bytes");
    expect(fetchAfterOut).toMatch(/connect|channel/i);
    expect(exitCodes.find(([c]) => c === `fetch writer helper ${ARTIFACT_PATH}`)).toBeDefined();
  });

  test("ARTIFACT exchange, HANDOFF and SUMMARY are each refused over their withdrawn channel", () => {
    expect(artifactAfterOut).toMatch(/connect|channel/i);
    expect(handoffAfterOut).toMatch(/connect|channel/i);
  });

  // --- Invariant 2: revoke is exact ----------------------------------------

  test("withdrawing one mode leaves the pair's other channels working", () => {
    // read-summary was still open at this point in the script, and still carried memory.
    expect(summaryAfterOut).toContain("USD");
  });

  test("disconnect refuses to GUESS when several channels are open", () => {
    // Copying `connect`'s default of handoff here would be a safety bug: the operator would
    // be told there was nothing to disconnect while the real channel stayed open.
    expect(ambiguousOut).toContain("3 open channels");
    expect(ambiguousOut).toContain("--mode artifact-only");
    expect(ambiguousOut).toContain("--mode handoff");
    expect(ambiguousOut).toContain("--mode read-summary");
    expect(exitCodes.find(([c]) => c === "disconnect writer helper")?.[1]).toBe(1);
  });

  test("a malformed --mode is refused loudly rather than falling through to inference", () => {
    expect(badModeOut).toContain('Unknown connection mode "delegated-tool"');
    expect(valuelessModeOut).toContain("--mode needs a value");
  });

  test("withdrawing a channel that is not open says so, and re-withdrawing is not an error twice over", () => {
    expect(notOpenOut).toMatch(/no open channel/i);
    expect(alreadyRevokedOut).toMatch(/no open artifact-only channel/i);
  });

  // --- Invariant 3: terminal; a reconnect is a new channel -------------------

  test("reconnecting opens a NEW channel that old references do not resolve over", () => {
    // The connection read now SUCCEEDS — and the reference still misses, because the
    // exchange row is keyed on the channel that was withdrawn.
    expect(fetchAfterReconnectOut).toMatch(/has not handed|never|not.*hand/i);
    expect(fetchAfterReconnectOut).not.toContain("bytes");
  });

  test("connections lists withdrawn channels after the open ones, marked", () => {
    expect(connectionsOut).toContain("(withdrawn — nothing crosses it)");
    // The open channel comes first; the withdrawn ones follow.
    const lines = connectionsOut.split("\n").filter((l) => l.startsWith("•"));
    const firstWithdrawn = lines.findIndex((l) => l.includes("withdrawn"));
    const lastOpen = lines.map((l) => l.includes("withdrawn")).lastIndexOf(false);
    expect(firstWithdrawn).toBeGreaterThan(lastOpen);
  });

  // --- Invariant 4: work in flight is not stranded ---------------------------

  test("the exchange paused on the callee's own destructive gate", () => {
    expect(pausedOut).toMatch(/paused/i);
  });

  test("a revoke does not strand the paused run — the callee's operator can still confirm", () => {
    // Golden rule 4 puts that confirmation with the CALLEE's operator: a revoke on the
    // caller's side must never be able to take it away.
    expect(confirmOut).toContain(CALLEE_PROSE);
    // The callee really did finish its work in its own workspace.
    expect(existsSync(join(workspaceOf("helper"), LATE_PATH))).toBe(true);
  });

  test("...but nothing it produced afterwards crosses the withdrawn channel", () => {
    expect(fetchLateOut).toMatch(/connect|channel/i);
    expect(fetchLateOut).not.toContain("bytes");
    expect(existsSync(join(workspaceOf("writer"), LATE_PATH))).toBe(false);
    expect(landedAfterRevoke).toBe(false);
  });

  // --- Invariant 5: the audit ------------------------------------------------

  test("connection.revoked is on BOTH agents' logs, references only", () => {
    for (const agent of [writer, helper]) {
      const revoked = store.events.tail(agent.id).filter((e) => e.type === "connection.revoked");
      // artifact-only (twice — before and after the reconnect), handoff, read-summary.
      expect(revoked.length).toBe(4);
      for (const event of revoked) {
        expect(Object.keys(event.payload as object).sort()).toEqual([
          "connectionId",
          "fromAgentId",
          "mode",
          "toAgentId",
        ]);
      }
    }
  });

  test("no event log carries file contents, prose, or a secret", () => {
    for (const agent of [writer, helper]) {
      const serialized = JSON.stringify(store.events.tail(agent.id));
      for (const forbidden of [ARTIFACT_BODY.trim(), LATE_BODY.trim(), CALLEE_PROSE, WRITER_SECRET, HELPER_SECRET, RATIFIED_MEMORY]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  test("cross-agent isolation held throughout: neither agent can read the other's secret", () => {
    // Operator-visible keys only — a paused run also stores a kernel-internal fingerprint key
    // in the callee's own store, which is not a credential the operator added.
    const keys = (agent: Agent) =>
      store.secrets
        .list(agent.id)
        .map((c) => c.key)
        .filter((k) => !k.startsWith("__asterism."));
    expect(keys(writer)).toEqual(["WRITER_TOKEN"]);
    expect(keys(helper)).toEqual(["HELPER_TOKEN"]);
    // The ratified memory stayed the callee's throughout, including while read-summary was
    // open: what crossed was an extract, never a row.
    expect(store.memories.list(writer.id)).toHaveLength(0);
    expect(store.memories.list(helper.id)).toHaveLength(1);
  });
});
