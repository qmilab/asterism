// The Phase 3 · T2b acceptance demo from the design note (§13) as an automated end-to-end
// test. The script runs verbatim through the real CLI surface (`runCli`) against a real
// on-disk store in a temp workspace.
//
// Note what is NOT faked here, and could not be: there is no adapter, no capability catalog,
// and no model. `read-summary` is the one mode where the callee runs nothing, so the CLI has
// no substrate to build — which this file proves by giving it none (`makeAdapter` throws if
// anything reaches for it).
//
// It must demonstrate (design note §13):
//   1. With no active `read-summary` connection the pull is refused — and neither a `handoff`
//      nor an `artifact-only` connection satisfies it, nor the reverse direction.
//   2. Raw rows never cross: only kind + screened content, and only what the operator
//      ratified. A secret-shaped value is scrubbed; an injection-shaped memory is withheld.
//   3. The callee's trust level is irrelevant — nothing executes.
//   4. Cross-agent denial holds across the live connection.
//   5. Both event logs record content-free references: counts only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsterismStore } from "@qmilab/asterism-core";
import type { Agent } from "@qmilab/asterism-core";

import { runCli } from "./cli.js";
import type { CliIO } from "./cli.js";
import { dbPath, HOME_DIR_NAME } from "./paths.js";

const WRITER_SECRET = "writer-secret-aaa";
const RESEARCHER_SECRET = "researcher-secret-bbb";

// A memory carrying a secret VALUE: the value is scrubbed, the knowledge still crosses (D18).
const SECRET_VALUE = "sk-abc123def456ghi789jkl012mno345pqr678stu";
const SECRET_MEMORY = `The deploy token is ${SECRET_VALUE} and it rotates monthly.`;
// A memory that PASSES the inbound firewall (the NUL splits `token`) but trips the OUTBOUND
// scrub once control characters are stripped — so it is withheld whole (D18). This is the
// mechanism that makes the withhold branch reachable for a stored, ratified memory.
const EVASIVE_MEMORY = "Never reveal the deploy to\u0000ken to anyone outside the team.";
const PLAIN_MEMORY = "Pricing is always quoted in USD, never local currency.";
const FOCUS_MEMORY = "The pricing page is generated from pricing.yaml at build time.";

describe("Phase 3 · T2b — read-summary acceptance demo", () => {
  let dir: string;
  let store: AsterismStore;
  let writer: Agent;
  let researcher: Agent;

  const transcript: string[] = [];
  const exitCodes: [command: string, code: number][] = [];

  let noConnOut = "";
  let wrongModeOut = "";
  let reverseOut = "";
  let summaryOut = "";
  let focusedOut = "";
  let emptyOut = "";
  let connectionsOut = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "asterism-summary-"));

    const io: CliIO = {
      cwd: dir,
      env: {},
      out: (t) => transcript.push(t),
      err: (t) => transcript.push(t),
      // No substrate at all. A `read-summary` pull must never reach for one; if it does,
      // this throws and the demo fails loudly rather than quietly depending on a model.
      makeAdapter: () => {
        throw new Error("read-summary must not build an adapter — nothing runs");
      },
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
    await run(["new", "helper", "--soul", "casual-helper", "--trust", "autonomous"]);
    await run(["secrets", "add", "writer", "WRITER_TOKEN", WRITER_SECRET]);
    await run(["secrets", "add", "researcher", "RESEARCHER_TOKEN", RESEARCHER_SECRET]);

    // Seed the callee's memory directly through the kernel: what matters to this mode is the
    // REVIEW STATE of each row, and the CLI has no verb that writes an accepted memory.
    const seedStore = AsterismStore.open(dbPath(join(dir, HOME_DIR_NAME)));
    const seedAgent = (name: string): Agent => {
      const agent = seedStore.agents.list().find((a) => a.name === name);
      if (!agent) throw new Error(`t2b setup lost agent "${name}"`);
      return agent;
    };
    const seeded = seedAgent("researcher");
    seedStore.recordMemory(seeded.id, {
      memoryType: "convention",
      content: PLAIN_MEMORY,
      confidence: 0.9,
      reviewState: "accepted",
    });
    seedStore.recordMemory(seeded.id, {
      memoryType: "semantic",
      content: FOCUS_MEMORY,
      confidence: 0.8,
      reviewState: "accepted",
    });
    seedStore.recordMemory(seeded.id, {
      memoryType: "semantic",
      content: SECRET_MEMORY,
      confidence: 0.8,
      reviewState: "accepted",
    });
    seedStore.recordMemory(seeded.id, {
      memoryType: "negative",
      content: EVASIVE_MEMORY,
      confidence: 0.8,
      reviewState: "accepted",
    });
    // Never ratified — must not cross at any budget.
    seedStore.recordMemory(seeded.id, {
      memoryType: "semantic",
      content: "UNRATIFIED: the vendor may drop support next quarter.",
      confidence: 0.4,
      reviewState: "proposed",
    });
    // The caller's own memory, to prove the pull reads the CALLEE.
    seedStore.recordMemory(seedAgent("writer").id, {
      memoryType: "semantic",
      content: "CALLER OWN: the blog publishes on Tuesdays.",
      confidence: 0.9,
      reviewState: "accepted",
    });
    seedStore.close();

    // (1) Before any connection — refused.
    noConnOut = await run(["summary", "writer", "researcher"]);

    // (1b) Neither a handoff nor an artifact-only channel authorizes a pull.
    await run(["connect", "writer", "researcher", "--mode", "handoff"]);
    await run(["connect", "writer", "researcher", "--mode", "artifact-only"]);
    wrongModeOut = await run(["summary", "writer", "researcher"]);

    // (1c) Nor does the reverse direction: researcher → writer does not let writer read
    // researcher.
    await run(["connect", "researcher", "writer", "--mode", "read-summary"]);
    reverseOut = await run(["summary", "writer", "researcher"]);

    // (2) Open the right channel and pull.
    await run(["connect", "writer", "researcher", "--mode", "read-summary"]);
    summaryOut = await run(["summary", "writer", "researcher"]);
    focusedOut = await run(["summary", "writer", "researcher", "pricing"]);

    // A callee with nothing ratified says so plainly rather than looking broken.
    await run(["connect", "writer", "helper", "--mode", "read-summary"]);
    emptyOut = await run(["summary", "writer", "helper"]);

    connectionsOut = await run(["connections", "writer"]);

    store = AsterismStore.open(dbPath(join(dir, HOME_DIR_NAME)));
    const byName = (name: string): Agent => {
      const agent = store.agents.list().find((a) => a.name === name);
      if (!agent) throw new Error(`t2b setup lost agent "${name}"`);
      return agent;
    };
    writer = byName("writer");
    researcher = byName("researcher");
  });

  afterAll(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("every demo command exits as expected", () => {
    const code = (cmd: string): number => exitCodes.find(([c]) => c === cmd)?.[1] ?? -1;
    expect(code("summary writer researcher")).toBe(1); // first invocation: no connection
    expect(code("connect writer researcher --mode read-summary")).toBe(0);
    expect(code("summary writer researcher pricing")).toBe(0);
    expect(code("connections writer")).toBe(0);
  });

  // --- invariant 1 -----------------------------------------------------------

  test("1. with no connection the pull is refused, and names the channel to open", () => {
    expect(noConnOut).toMatch(/No active read-summary connection/i);
    expect(noConnOut).toMatch(/--mode read-summary/);
    expect(noConnOut).not.toContain(PLAIN_MEMORY);
  });

  test("1b. a handoff or artifact-only channel does not authorize a pull", () => {
    expect(wrongModeOut).toMatch(/No active read-summary connection/i);
    expect(wrongModeOut).not.toContain(PLAIN_MEMORY);
  });

  test("1c. the reverse-direction channel does not authorize a pull", () => {
    expect(reverseOut).toMatch(/No active read-summary connection/i);
    expect(reverseOut).not.toContain(PLAIN_MEMORY);
  });

  // --- invariant 2 -----------------------------------------------------------

  test("2. the ratified knowledge crosses, projected to kind + content", () => {
    expect(summaryOut).toContain(PLAIN_MEMORY);
    expect(summaryOut).toContain("convention");
    expect(summaryOut).toMatch(/researcher knows/i);
  });

  test("2b. nothing unratified crosses", () => {
    expect(summaryOut).not.toContain("UNRATIFIED");
    expect(focusedOut).not.toContain("UNRATIFIED");
  });

  test("2c. a secret VALUE is scrubbed while its knowledge still crosses", () => {
    expect(summaryOut).not.toContain(SECRET_VALUE);
    expect(summaryOut).toContain("rotates monthly");
    expect(summaryOut).toMatch(/screened/i);
  });

  test("2d. an injection-shaped memory is withheld WHOLE and counted", () => {
    expect(summaryOut).not.toContain("anyone outside the team");
    expect(summaryOut).toMatch(/1 more note was held back by the outbound screen/i);
  });

  test("2e. the pull reads the CALLEE, never the caller's own memory", () => {
    expect(summaryOut).not.toContain("CALLER OWN");
  });

  test("2f. no memory record — id, run, confidence, or review state — appears in the output", () => {
    const rows = store.memories.list(researcher.id);
    for (const row of rows) {
      expect(summaryOut).not.toContain(row.id);
    }
    expect(summaryOut).not.toMatch(/reviewState|sourceRunId|confidence/);
  });

  test("2g. a focus narrows the extract to the subject asked about", () => {
    expect(focusedOut).toContain('on "pricing"');
    expect(focusedOut).toContain(FOCUS_MEMORY);
  });

  test("2h. an agent with nothing ratified says so, rather than looking broken", () => {
    expect(emptyOut).toMatch(/no ratified memory to share/i);
    expect(emptyOut).toMatch(/accepted/i);
  });

  // --- invariant 3 -----------------------------------------------------------

  test("3. the callee's trust level is irrelevant — nothing ran", () => {
    // researcher is `propose`, the most restrictive level, and shared in full.
    expect(researcher.trustLevel).toBe("propose");
    expect(summaryOut).toContain(PLAIN_MEMORY);
    // No run was created for either party, and no adapter was ever built (the harness's
    // `makeAdapter` throws, so reaching for one would have failed the demo outright).
    expect(store.runs.list(researcher.id)).toHaveLength(0);
    expect(store.runs.list(writer.id)).toHaveLength(0);
  });

  // --- invariant 4 -----------------------------------------------------------

  test("4. cross-agent denial holds across the live connection", () => {
    expect(store.credentials.list(writer.id).map((c) => c.key)).toEqual(["WRITER_TOKEN"]);
    expect(store.credentials.list(researcher.id).map((c) => c.key)).toEqual(["RESEARCHER_TOKEN"]);
    expect(store.readSecret(writer.id, "RESEARCHER_TOKEN")).toBeUndefined();
    expect(store.readSecret(researcher.id, "WRITER_TOKEN")).toBeUndefined();
    // The caller's memory did not gain a copy of anything it read.
    expect(store.memories.list(writer.id).map((m) => m.content)).toEqual([
      "CALLER OWN: the blog publishes on Tuesdays.",
    ]);
    // No secret value appears anywhere in the session transcript.
    const all = transcript.join("\n");
    expect(all).not.toContain(WRITER_SECRET);
    expect(all).not.toContain(RESEARCHER_SECRET);
  });

  // --- invariant 5 -----------------------------------------------------------

  test("5. both logs record the pull as counts-only references", () => {
    for (const agent of [writer, researcher]) {
      const events = store.events.list(agent.id);
      const provided = events.filter((e) => e.type === "summary.provided");
      expect(provided.length).toBeGreaterThanOrEqual(1);
      const payload = provided[0]!.payload as Record<string, unknown>;
      expect(payload.mode).toBe("read-summary");
      expect(payload.eligible).toBe(4);
      expect(payload.withheld).toBe(1);

      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(PLAIN_MEMORY);
      expect(serialized).not.toContain(SECRET_VALUE);
      expect(serialized).not.toContain("anyone outside the team");
      // The caller's focus is free-form authored text, so it is content and does not land.
      expect(serialized).not.toContain("pricing");
    }
  });

  test("connections lists the read-summary channel alongside the others", () => {
    expect(connectionsOut).toContain("read-summary");
    expect(connectionsOut).toContain("handoff");
    expect(connectionsOut).toContain("artifact-only");
  });
});
