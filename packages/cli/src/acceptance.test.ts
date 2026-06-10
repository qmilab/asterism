// The canonical demo from CLAUDE.md as an automated end-to-end acceptance test —
// the Phase 0 definition of done. The demo script runs verbatim through the real
// CLI surface (`runCli`) against a real on-disk store in a temp workspace; only
// the host seams `CliIO` exists for are faked: the substrate (a scripted adapter
// that drives the kernel-scoped tools the way a model loop would), the reflection
// model, and the interactive reviewer. The kernel — persistence, scoping, trust
// enforcement, the destructive-action gate, the firewall, the event log — is the
// real thing end to end.
//
// The five claims, each its own test below:
//   1. `personal` memory never appears in `work`'s memory.
//   2. `work`'s GITHUB_TOKEN is unreadable from `personal`.
//   3. `work` (propose) returns a plan it never executes; `personal` (autonomous) acts.
//   4. The `personal` run pauses for confirmation before deleting, despite being
//      autonomous — the gate fires independent of trust level.
//   5. `reflect --review` proposes typed memories; nothing persists unapproved.
//
// If a change breaks any of these, it doesn't ship (CLAUDE.md).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsterismStore } from "@qmilab/asterism-core";
import type {
  Agent,
  Capability,
  ReflectionProvider,
  RunOutput,
  RunRequest,
  RuntimeAdapter,
} from "@qmilab/asterism-core";

import { runCli } from "./cli.js";
import type { CliIO, ReviewDecision, ReviewItem } from "./cli.js";
import { dbPath, HOME_DIR_NAME } from "./paths.js";

const SECRET_VALUE = "ghp_demo_secret_value_12345";
const ACCEPTED_MEMORY = "the blog drafts live in ./drafts";
const REJECTED_MEMORY = "regenerate dist/ before publishing";
const SKILL_BODY = "# blog-writer\n\nWrite friendly, concise blog posts.\n";

/** One tool call the scripted substrate will attempt, in order. */
interface ScriptedCall {
  tool: string;
  args: unknown;
}

/**
 * A substrate stand-in that behaves like a real agent loop: it calls the tools
 * the kernel scoped into the request, in order, and folds their results into the
 * run's text. It also records the framed request, so the test can assert what
 * each agent's run was allowed to see. It stops when a tool result reports an
 * error — exactly what the gate's awaiting-confirmation result is — or when the
 * kernel aborts the run. A scripted tool missing from the registry is a harness
 * bug (the kernel scoped less than the script assumes), so it throws loudly
 * instead of letting the failure surface far downstream.
 */
function scriptedAdapter(
  calls: readonly ScriptedCall[],
  recordRequest: (request: RunRequest) => void,
): RuntimeAdapter {
  return {
    run(request) {
      recordRequest(request);
      const output = (async (): Promise<RunOutput> => {
        const texts: string[] = [];
        for (const call of calls) {
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

describe("canonical demo — Phase 0 acceptance", () => {
  let dir: string;
  let store: AsterismStore;
  let personal: Agent;
  let work: Agent;

  /** Every line the CLI printed across the whole demo, for leak sweeps. */
  const transcript: string[] = [];
  /** Exit code of each demo step, keyed by the command line that produced it. */
  const exitCodes: [command: string, code: number][] = [];
  /** Capability keys whose real `execute` actually ran (the spies). */
  const executed: string[] = [];
  /** The framed request each run handed the substrate, in run order. */
  const requests: RunRequest[] = [];

  let personalRunOut = "";
  let workRunOut = "";
  let memoryWorkAfterReflectOut = "";
  let memoryPersonalAfterReflectOut = "";
  let eventsPersonalOut = "";
  let reflectOut = "";

  /** A spied capability: the gate decides; the spy records if it truly ran. */
  function capability(key: string, effect: "write" | "destructive"): Capability {
    return {
      key,
      effect,
      tool: {
        name: key,
        description: `${key} (acceptance-demo capability)`,
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          executed.push(key);
          return { output: `${key}: done` };
        },
      },
    };
  }

  const fakeReflection: ReflectionProvider = {
    async reflect(input) {
      return [
        {
          memoryType: "semantic",
          content: ACCEPTED_MEMORY,
          confidence: 0.9,
          sourceRunId: input.transcript.runId,
        },
        {
          memoryType: "procedural",
          content: REJECTED_MEMORY,
          confidence: 0.7,
          sourceRunId: input.transcript.runId,
        },
      ];
    },
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "asterism-acceptance-"));
    writeFileSync(join(dir, "blog-writer.md"), SKILL_BODY);

    let script: readonly ScriptedCall[] = [];
    const io: CliIO = {
      cwd: dir,
      env: {},
      out: (t) => transcript.push(t),
      err: (t) => transcript.push(t),
      // The substrate seam: the adapter plays back the current run's script
      // against whatever tools the kernel actually scoped to it.
      makeAdapter: () => ({
        adapter: scriptedAdapter(script, (r) => requests.push(r)),
      }),
      makeReflectionProvider: () => ({ provider: fakeReflection }),
      // The human reviewer: accept or reject by content, not presentation order,
      // so a reordered presentation cannot silently flip the verdicts.
      review: (item: ReviewItem): ReviewDecision =>
        item.content === ACCEPTED_MEMORY ? { kind: "accept" } : { kind: "reject" },
      // Deliberately NO `confirm` — the destructive gate must pause, not resolve.
      // The demo's tools, exposed through the same seam a real embedding uses;
      // the kernel's trust profile + gate decide what each run may do with them.
      capabilities: [
        capability("edit_files", "write"),
        capability("tidy_notes", "write"),
        capability("delete_files", "destructive"),
      ],
    };

    /** Run one demo command, capturing its own output and exit code. */
    async function run(argv: string[]): Promise<string> {
      const start = transcript.length;
      const code = await runCli(argv, io);
      exitCodes.push([argv.join(" "), code]);
      return transcript.slice(start).join("\n");
    }

    // The canonical demo, in order (CLAUDE.md "Canonical demo = the acceptance test").
    await run(["init"]);
    await run(["new", "personal", "--soul", "casual-helper", "--trust", "autonomous"]);
    await run(["new", "work", "--soul", "careful-consultant", "--trust", "propose"]);
    await run(["secrets", "add", "work", "GITHUB_TOKEN", SECRET_VALUE]);
    await run(["skill", "add", "personal", "blog-writer.md"]);

    script = [
      { tool: "edit_files", args: { path: "drafts/blog.md", content: "updated draft" } },
      { tool: "delete_files", args: { command: "rm -rf dist" } },
    ];
    personalRunOut = await run([
      "run",
      "personal",
      "update my blog draft and delete the generated files in dist/",
    ]);

    script = [{ tool: "tidy_notes", args: { plan: "archive notes older than 30 days" } }];
    workRunOut = await run([
      "run",
      "work",
      "summarize the client meeting and propose a cleanup of the notes folder",
    ]);

    await run(["memory", "inspect", "personal"]);
    await run(["memory", "inspect", "work"]);
    eventsPersonalOut = await run(["events", "tail", "personal"]);
    reflectOut = await run(["reflect", "personal", "--review"]);

    // Re-inspect both agents now that `personal` has an accepted memory — the
    // moment claim 1 ("never appears in work's memory") becomes falsifiable.
    memoryPersonalAfterReflectOut = await run(["memory", "inspect", "personal"]);
    memoryWorkAfterReflectOut = await run(["memory", "inspect", "work"]);

    // Open the same on-disk store the CLI wrote, for kernel-level assertions, and
    // resolve both identities once — they are immutable for the rest of the suite.
    store = AsterismStore.open(dbPath(join(dir, HOME_DIR_NAME)));
    const byName = (name: string): Agent => {
      const agent = store.agents.list().find((a) => a.name === name);
      if (!agent) throw new Error(`acceptance setup lost agent "${name}"`);
      return agent;
    };
    personal = byName("personal");
    work = byName("work");
  });

  afterAll(() => {
    // Guarded: if beforeAll threw before creating these, the real failure must
    // not be masked by a second throw from teardown.
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the demo script runs clean end to end", () => {
    // A failing step shows up by name; the count guards against a skipped step
    // (it must equal the number of run() calls in beforeAll).
    expect(exitCodes.filter(([, code]) => code !== 0)).toEqual([]);
    expect(exitCodes).toHaveLength(13);
    // Both runs were framed and handed to the substrate.
    expect(requests).toHaveLength(2);
  });

  test("claim 1 — personal memory never appears in work's memory", () => {
    // The accepted memory exists for personal — so the isolation check is real.
    const personalMemories = store.memories.list(personal.id);
    expect(personalMemories.map((m) => m.content)).toContain(ACCEPTED_MEMORY);

    // Scoped store: work has no memories at all, let alone personal's.
    expect(store.memories.list(work.id)).toHaveLength(0);

    // The CLI surface agrees, inspected after personal's memory was written —
    // the moment the claim is falsifiable.
    expect(memoryWorkAfterReflectOut).toContain("work has no memories yet.");
    expect(memoryWorkAfterReflectOut).not.toContain(ACCEPTED_MEMORY);
  });

  test("claim 2 — work's GITHUB_TOKEN is unreadable from personal", () => {
    // The credential exists for work — by reference only, never the value.
    const workCreds = store.credentials.list(work.id);
    expect(workCreds.map((c) => c.key)).toContain("GITHUB_TOKEN");
    expect(JSON.stringify(workCreds)).not.toContain(SECRET_VALUE);
    const ref = workCreds.find((c) => c.key === "GITHUB_TOKEN")!.valueRef;

    // The kernel resolves the ref for its owner and for no one else.
    expect(store.secrets.read(work.id, ref)).toBe(SECRET_VALUE);
    expect(store.secrets.read(personal.id, ref)).toBeUndefined();
    expect(store.credentials.list(personal.id)).toHaveLength(0);

    // The value leaked into no surface: not the CLI's output, not either event
    // log, not the framed request either agent's run was given. The tool registry
    // is swept via list() — stringifying the request alone would serialize the
    // registry as {} and miss a secret leaked into a tool name/description/schema.
    const stripFunctions = (_k: string, v: unknown) =>
      typeof v === "function" ? undefined : v;
    expect(transcript.join("\n")).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(store.events.tail(personal.id))).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(store.events.tail(work.id))).not.toContain(SECRET_VALUE);
    for (const request of requests) {
      expect(JSON.stringify(request, stripFunctions)).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(request.tools.list(), stripFunctions)).not.toContain(SECRET_VALUE);
    }
  });

  test("claim 3 — work (propose) returns a plan it never executes; personal (autonomous) acts", () => {
    // work: the side effect was withheld as a plan step — and truly never ran.
    expect(workRunOut).toContain("[proposed]");
    expect(workRunOut).toContain("'tidy_notes' was not executed (trust level: propose)");
    expect(executed).not.toContain("tidy_notes");
    expect(store.events.tail(work.id).map((e) => e.type)).toContain("action.withheld");
    const workRuns = store.runs.list(work.id);
    expect(workRuns).toHaveLength(1);
    expect(workRuns[0]!.status).toBe("done");

    // personal: the ordinary write executed without asking.
    expect(executed).toContain("edit_files");
    expect(store.events.tail(personal.id).map((e) => e.type)).toContain("action.executed");
  });

  test("claim 4 — the destructive-action gate pauses the autonomous run before deleting", () => {
    // The gate fired despite the highest trust level.
    expect(personal.trustLevel).toBe("autonomous");
    expect(personalRunOut).toContain(
      "Run paused: a destructive action needs your confirmation before it can proceed.",
    );

    // The deletion never happened; the run is parked non-terminal.
    expect(executed).not.toContain("delete_files");
    const personalRuns = store.runs.list(personal.id);
    expect(personalRuns).toHaveLength(1);
    expect(personalRuns[0]!.status).toBe("awaiting_confirmation");

    // The pause is on the record, and visible through `events tail`.
    expect(store.events.tail(personal.id).map((e) => e.type)).toContain(
      "action.awaiting_confirmation",
    );
    expect(eventsPersonalOut).toContain("action.awaiting_confirmation");
  });

  test("claim 5 — reflection proposes typed memories; only what the human approves persists", () => {
    // Both proposals were presented; the verdict matched the reviewer.
    expect(reflectOut).toContain(ACCEPTED_MEMORY);
    expect(reflectOut).toContain(REJECTED_MEMORY);
    expect(reflectOut).toContain("1 saved, 1 rejected");

    // Exactly the accepted memory persisted — typed, attributed, and accepted;
    // nothing was written silently (no `proposed` rows linger in the store).
    const memories = store.memories.list(personal.id);
    expect(memories).toHaveLength(1);
    const memory = memories[0]!;
    expect(memory.content).toBe(ACCEPTED_MEMORY);
    expect(memory.memoryType).toBe("semantic");
    expect(memory.reviewState).toBe("accepted");
    expect(memory.sourceRunId).toBe(store.runs.list(personal.id)[0]!.id);

    // The accepted memory shows up for its owner through the CLI.
    expect(memoryPersonalAfterReflectOut).toContain(ACCEPTED_MEMORY);
    expect(memoryPersonalAfterReflectOut).toContain("accepted");
  });
});
