// `asterism artifact fetch` end-to-end through the real CLI surface — the completion of the
// `artifact-only` mode (issue #110, design note §11).
//
// The script runs verbatim through `runCli` against a real on-disk store AND real
// workspaces: the tool that produces the artifact writes an actual file into the callee's
// directory, and the fetch copies actual bytes into the caller's. Only the substrate (a
// scripted adapter) is faked. The kernel — the connection check, the exchange record, the
// caller's destructive-action gate — and the host's confinement are both real.
//
// It must demonstrate:
//   1. Fetching with no active artifact-only connection is refused.
//   2. Only an artifact the callee actually PRODUCED IN AN EXCHANGE can be fetched — an
//      arbitrary path in the callee's workspace is refused even though it exists on disk.
//   3. The CALLER's gate fires: an autonomous caller still confirms, a declined
//      confirmation writes nothing, and a `propose` caller withholds the fetch entirely.
//   4. Cross-agent memory/credential denial still holds.
//   5. Both event logs record content-free references — never the file's contents.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
const CALLEE_PROSE = "PROSE: the market section is drafted and reads well";
const ARTIFACT_PATH = "drafts/market-section.md";
const ARTIFACT_BODY = "# Market\n\nThe market is large and growing.\n";
// A real file in the callee's workspace that was never part of any exchange. Fetching it
// must fail even though it is right there on disk — the sharp invariant.
const PRIVATE_PATH = "private/helper-notes.md";
const PRIVATE_BODY = "HELPER PRIVATE NOTES — never handed over";

describe("Phase 3 · artifact fetch — acceptance", () => {
  let dir: string;
  let store: AsterismStore;
  let writer: Agent;
  let helper: Agent;
  let editor: Agent;

  const transcript: string[] = [];
  const exitCodes: [command: string, code: number][] = [];
  const confirmations: Action[] = [];

  let noConnOut = "";
  let notExchangedOut = "";
  let declinedOut = "";
  let fetchedOut = "";
  let overwriteOut = "";
  let proposeOut = "";
  let staleOut = "";
  let landedAfterStale = true;
  let contentAfterStale = "";

  /** Answers the destructive-action prompt; flipped per command by the script below. */
  let approve = true;
  // Filesystem state captured DURING the script — a later step legitimately creates the
  // file, so "nothing landed" has to be observed at the moment of the refusal, not after.
  let landedAfterNoConnection = true;
  let landedAfterDecline = true;

  /** A write tool that writes a REAL file and declares the artifact it produced. */
  function writeCapability(workspaceDir: string): Capability {
    return {
      key: "fs.write",
      effect: "write",
      tool: {
        name: "write_file",
        description: "write the drafted section",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          const abs = join(workspaceDir, ARTIFACT_PATH);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, ARTIFACT_BODY);
          const bytes = Buffer.byteLength(ARTIFACT_BODY, "utf8");
          return {
            output: `wrote ${bytes} bytes`,
            observation: {
              schema: "asterism.fs.write@1",
              facts: [
                { subject: `file:${ARTIFACT_PATH}`, relation: "size_bytes", object: bytes },
                { subject: `file:${ARTIFACT_PATH}`, relation: "exists", object: true },
              ],
            },
          };
        },
      },
    };
  }

  /** A substrate stand-in: calls the kernel-scoped tools in order, then returns fixed text. */
  function scriptedAdapter(tools: readonly string[], text: string): RuntimeAdapter {
    return {
      run(request) {
        const output = (async (): Promise<RunOutput> => {
          for (const name of tools) {
            if (request.signal?.aborted) break;
            const tool = request.tools.list().find((t) => t.name === name);
            if (!tool) continue;
            const result = await tool.execute({ args: {} }, request.signal);
            if (result.isError) break;
          }
          return { status: "done", text };
        })();
        async function* noEvents() {}
        return { events: noEvents(), output };
      },
    };
  }

  const workspaceOf = (name: string): string => join(dir, HOME_DIR_NAME, "agents", name);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "asterism-fetch-acc-"));

    const io: CliIO = {
      cwd: dir,
      env: {},
      out: (t) => transcript.push(t),
      err: (t) => transcript.push(t),
      makeAdapter: () => ({ adapter: scriptedAdapter(["write_file"], CALLEE_PROSE) }),
      capabilities: (workspaceDir) => [writeCapability(workspaceDir)],
      // The REAL host: real confinement, real bytes.
      fetchHost: artifactFetchHost(),
      confirm: (action: Action) => {
        confirmations.push(action);
        return approve;
      },
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
    await run(["new", "editor", "--soul", "careful-consultant", "--trust", "propose"]);
    await run(["secrets", "add", "writer", "WRITER_TOKEN", WRITER_SECRET]);
    await run(["secrets", "add", "helper", "HELPER_TOKEN", HELPER_SECRET]);

    // A real private file in the callee's workspace, never exchanged.
    const priv = join(workspaceOf("helper"), PRIVATE_PATH);
    mkdirSync(dirname(priv), { recursive: true });
    writeFileSync(priv, PRIVATE_BODY);

    // (1) Fetch before any connection exists — refused.
    noConnOut = await run(["artifact", "fetch", "writer", "helper", ARTIFACT_PATH]);
    landedAfterNoConnection = existsSync(join(workspaceOf("writer"), ARTIFACT_PATH));

    // Open the channel and do the exchange, so there is a recorded manifest.
    await run(["connect", "writer", "helper", "--mode", "artifact-only"]);
    await run(["artifact", "writer", "helper", "draft the market section"]);

    // (2) A real file the callee never handed over — refused despite existing on disk.
    notExchangedOut = await run(["artifact", "fetch", "writer", "helper", PRIVATE_PATH]);

    // (3a) The caller is autonomous — it STILL asks, and a decline writes nothing.
    approve = false;
    declinedOut = await run(["artifact", "fetch", "writer", "helper", ARTIFACT_PATH]);
    landedAfterDecline = existsSync(join(workspaceOf("writer"), ARTIFACT_PATH));

    // (3b) Confirmed — the bytes land.
    approve = true;
    fetchedOut = await run(["artifact", "fetch", "writer", "helper", ARTIFACT_PATH]);

    // (3c) Fetching again OVERWRITES — allowed, but only after saying so.
    overwriteOut = await run(["artifact", "fetch", "writer", "helper", ARTIFACT_PATH]);

    // (3e) The callee REWRITES the exchanged path outside any exchange — a later run, or the
    // operator's own editor. The path is still in the manifest writer holds, but what sits
    // there was never handed over, so the fetch must refuse rather than deliver it.
    const exchangedPath = join(workspaceOf("helper"), ARTIFACT_PATH);
    writeFileSync(exchangedPath, PRIVATE_BODY);
    const later = Date.now() / 1000 + 120;
    utimesSync(exchangedPath, later, later);
    staleOut = await run(["artifact", "fetch", "writer", "helper", ARTIFACT_PATH]);
    contentAfterStale = readFileSync(join(workspaceOf("writer"), ARTIFACT_PATH), "utf8");
    landedAfterStale = contentAfterStale.includes(PRIVATE_BODY);
    // Put the artifact back so the remaining steps see the state they expect.
    writeFileSync(exchangedPath, ARTIFACT_BODY);
    const before = Date.now() / 1000 - 120;
    utimesSync(exchangedPath, before, before);

    // (3d) A `propose` caller writes nothing at all, even with a confirmation available.
    await run(["connect", "editor", "helper", "--mode", "artifact-only"]);
    await run(["artifact", "editor", "helper", "draft the market section"]);
    proposeOut = await run(["artifact", "fetch", "editor", "helper", ARTIFACT_PATH]);

    store = AsterismStore.open(dbPath(join(dir, HOME_DIR_NAME)));
    const byName = (name: string): Agent => {
      const agent = store.agents.list().find((a) => a.name === name);
      if (!agent) throw new Error(`fetch acceptance lost agent "${name}"`);
      return agent;
    };
    writer = byName("writer");
    helper = byName("helper");
    editor = byName("editor");
  });

  afterAll(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // --- 1. No connection → no fetch ------------------------------------------

  test("with no active artifact-only connection the fetch is refused", () => {
    expect(noConnOut).toMatch(/No active artifact-only connection/i);
    expect(exitCodes.find(([c]) => c === `artifact fetch writer helper ${ARTIFACT_PATH}`)?.[1]).toBe(1);
    // Nothing landed (observed at the time of the refusal).
    expect(landedAfterNoConnection).toBe(false);
  });

  // --- 2. Only what was exchanged -------------------------------------------

  test("a real file the callee never handed over cannot be fetched", () => {
    // It genuinely exists in the callee's workspace...
    expect(readFileSync(join(workspaceOf("helper"), PRIVATE_PATH), "utf8")).toBe(PRIVATE_BODY);
    // ...and the fetch still refuses it, saying only that it was not handed over.
    expect(notExchangedOut).toMatch(/has not handed writer an artifact/i);
    // The refusal never reveals whether the file exists, and never leaks its contents.
    expect(notExchangedOut).not.toContain(PRIVATE_BODY);
    expect(notExchangedOut).not.toMatch(/exists|found|bytes/i);
    // Nothing was copied into the caller's workspace.
    expect(existsSync(join(workspaceOf("writer"), PRIVATE_PATH))).toBe(false);
  });

  test("a traversal path is refused the same way — the argument selects a record", async () => {
    const out = transcript.length;
    const code = await runCli(
      ["artifact", "fetch", "writer", "helper", "../helper/private/helper-notes.md"],
      {
        cwd: dir,
        env: {},
        out: (t) => transcript.push(t),
        err: (t) => transcript.push(t),
        fetchHost: artifactFetchHost(),
        confirm: () => true,
      },
    );
    expect(code).toBe(1);
    expect(transcript.slice(out).join("\n")).toMatch(/has not handed writer an artifact/i);
  });

  // --- 3. The CALLER's gate governs -----------------------------------------

  test("an autonomous caller is STILL asked, and told the direction of the copy", () => {
    // The very first confirmation for the fetch capability, i.e. not the callee's own gate.
    const fetchAsks = confirmations.filter((a) => a.capability === "exchange.fetch");
    expect(fetchAsks.length).toBeGreaterThan(0);
    expect(fetchAsks[0]?.effect).toBe("destructive");
    expect(declinedOut).toMatch(/Fetching '.*market-section\.md' from helper into writer's workspace/);
  });

  test("a declined confirmation writes nothing", () => {
    expect(declinedOut).toMatch(/Not fetched/i);
    expect(landedAfterDecline).toBe(false);
    expect(exitCodes.filter(([c]) => c.startsWith("artifact fetch writer helper drafts")).map(([, x]) => x))
      .toContain(1);
  });

  test("a confirmed fetch copies the real bytes into the caller's workspace", () => {
    expect(fetchedOut).toMatch(/Fetched 'drafts\/market-section\.md' from helper into writer's workspace/);
    const landed = join(workspaceOf("writer"), ARTIFACT_PATH);
    expect(readFileSync(landed, "utf8")).toBe(ARTIFACT_BODY);
    // The callee still has its own copy — a fetch copies, it does not move.
    expect(readFileSync(join(workspaceOf("helper"), ARTIFACT_PATH), "utf8")).toBe(ARTIFACT_BODY);
  });

  test("re-fetching over an existing file warns that it replaces, then does", () => {
    expect(overwriteOut).toMatch(/REPLACES a file that is already there/i);
    expect(overwriteOut).toMatch(/replaced an existing file/i);
    const replaced = confirmations.filter(
      (a) =>
        a.capability === "exchange.fetch" &&
        typeof a.args === "object" &&
        a.args !== null &&
        (a.args as { overwrites?: unknown }).overwrites === true,
    );
    expect(replaced).toHaveLength(1);
  });

  test("a `propose` caller withholds the fetch — it writes nothing and says what it would do", () => {
    expect(proposeOut).toMatch(/\[proposed\] would copy/i);
    expect(proposeOut).toMatch(/Nothing was written/i);
    expect(existsSync(join(workspaceOf("editor"), ARTIFACT_PATH))).toBe(false);
  });

  test("a path REWRITTEN after the exchange is refused — a reference is not a read grant", () => {
    // The heart of it: `drafts/market-section.md` is still in the manifest writer was handed,
    // and it still exists on disk — but what is there now was never handed over.
    expect(staleOut).toMatch(/has changed since helper handed it over/i);
    expect(staleOut).toMatch(/Ask for the work again/i);
    // The private content did not reach the caller, and the previously fetched copy is intact.
    expect(landedAfterStale).toBe(false);
    expect(contentAfterStale).toBe(ARTIFACT_BODY);
    expect(staleOut).not.toContain(PRIVATE_BODY);
  });

  // --- 4. Cross-agent denial -------------------------------------------------

  test("each agent's secret stays unreadable from the others, across the live channel", () => {
    expect(store.readSecret(writer.id, "WRITER_TOKEN")).toBe(WRITER_SECRET);
    expect(store.readSecret(helper.id, "WRITER_TOKEN")).toBeUndefined();
    expect(store.readSecret(writer.id, "HELPER_TOKEN")).toBeUndefined();
    expect(store.readSecret(editor.id, "HELPER_TOKEN")).toBeUndefined();
  });

  test("the fetch started no run — it is a gated kernel op, not an agent turn", () => {
    // Every run on this install belongs to a CALLEE that was asked to do work.
    expect(store.runs.list(writer.id)).toHaveLength(0);
    expect(store.runs.list(editor.id)).toHaveLength(0);
    expect(store.runs.list(helper.id).length).toBeGreaterThan(0);
  });

  // --- 5. Content-free logs --------------------------------------------------

  test("artifact.fetched appears on BOTH logs, with references only", () => {
    for (const agent of [writer, helper]) {
      const fetched = store.events.tail(agent.id).filter((e) => e.type === "artifact.fetched");
      // Two successful fetches: the create and the overwrite. (The declined one is absent.)
      expect(fetched).toHaveLength(2);
      for (const e of fetched) {
        expect(e.payload).toMatchObject({
          fromAgentId: writer.id,
          toAgentId: helper.id,
          mode: "artifact-only",
          ref: `file:${ARTIFACT_PATH}`,
          bytes: Buffer.byteLength(ARTIFACT_BODY, "utf8"),
        });
      }
    }
  });

  test("no event payload carries the artifact's CONTENTS, the callee's prose, or a secret", () => {
    const serialized = [
      ...store.events.tail(writer.id),
      ...store.events.tail(helper.id),
      ...store.events.tail(editor.id),
    ]
      .map((e) => JSON.stringify(e.payload))
      .join(" ");
    expect(serialized).not.toContain("The market is large");
    expect(serialized).not.toContain(CALLEE_PROSE);
    expect(serialized).not.toContain(PRIVATE_BODY);
    expect(serialized).not.toContain(WRITER_SECRET);
    expect(serialized).not.toContain(HELPER_SECRET);
  });

  test("no secret value or private file content appears anywhere in the demo output", () => {
    const all = transcript.join("\n");
    expect(all).not.toContain(WRITER_SECRET);
    expect(all).not.toContain(HELPER_SECRET);
    expect(all).not.toContain(PRIVATE_BODY);
    expect(all).not.toContain(CALLEE_PROSE);
  });
});
