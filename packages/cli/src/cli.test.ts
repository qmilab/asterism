import { afterEach, expect, test } from "bun:test";

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeAdapter } from "@qmilab/asterism-core";

import { runCli } from "./cli.ts";
import type { CliIO } from "./cli.ts";
import { HOME_DIR_NAME } from "./paths.ts";
import { VERSION } from "./version.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  io: CliIO;
  out: string[];
  err: string[];
  dir: string;
}

function harness(env: Record<string, string | undefined> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "asterism-cli-"));
  tempDirs.push(dir);
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    cwd: dir,
    env,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  return { io, out, err, dir };
}

/** A substrate stand-in: no tools, returns canned text. Keeps `run` off the network. */
const fakeAdapter: RuntimeAdapter = {
  run() {
    async function* noEvents() {
      // No lifecycle events for the canned run.
    }
    return {
      events: noEvents(),
      output: Promise.resolve({ status: "done" as const, text: "hello from the agent" }),
    };
  },
};

test("init creates a workspace and is idempotent", async () => {
  const h = harness();
  expect(await runCli(["init"], h.io)).toBe(0);
  expect(existsSync(join(h.dir, HOME_DIR_NAME, "asterism.db"))).toBe(true);
  expect(h.out.join("\n")).toContain("Initialized Asterism");

  const again = await runCli(["init"], h.io);
  expect(again).toBe(0);
  expect(h.out.join("\n")).toContain("already set up");
});

test("commands fail clearly before init", async () => {
  const h = harness();
  expect(await runCli(["new", "personal"], h.io)).toBe(1);
  expect(h.err.join("\n")).toContain("asterism init");
});

test("new creates an agent and rejects duplicates", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  expect(
    await runCli(["new", "personal", "--soul", "casual-helper", "--trust", "autonomous"], h.io),
  ).toBe(0);
  expect(h.out.join("\n")).toContain('Created agent "personal" (autonomous)');
  expect(existsSync(join(h.dir, HOME_DIR_NAME, "agents", "personal"))).toBe(true);

  const dup = await runCli(["new", "personal"], h.io);
  expect(dup).toBe(1);
  expect(h.err.join("\n")).toContain("already exists");
});

test("a relative custom soul is stored as a stable absolute path", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  writeFileSync(join(h.dir, "soul.md"), "Calm and exacting.\n");
  expect(await runCli(["new", "persona", "--soul", "./soul.md"], h.io)).toBe(0);
  const printed = h.out.join("\n");
  // The stored reference is the absolute path, not the CWD-relative one, so the
  // soul resolves identically from any directory at run time.
  expect(printed).toContain(`soul: ${join(h.dir, "soul.md")}`);
  expect(printed).not.toContain("soul: ./soul.md");
});

test("creating an agent with a missing soul file warns but still succeeds", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  expect(await runCli(["new", "persona", "--soul", "nope.md"], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("no soul file at");
});

test("a built-in soul name is stored verbatim, not as a path", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  await runCli(["new", "personal", "--soul", "careful-consultant"], h.io);
  expect(h.out.join("\n")).toContain("soul: careful-consultant");
});

test("a failure opening the store returns an error code, not a rejection", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  h.io.openStore = () => {
    throw new Error("database is locked");
  };
  const code = await runCli(["memory", "inspect", "whoever"], h.io);
  expect(code).toBe(1);
  expect(h.err.join("\n")).toContain("database is locked");
});

test("new rejects an invalid trust level", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  expect(await runCli(["new", "x", "--trust", "yolo"], h.io)).toBe(1);
  expect(h.err.join("\n")).toContain("trust level");
});

test("new rejects an unsafe agent name", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  expect(await runCli(["new", "../escape"], h.io)).toBe(1);
  expect(h.err.join("\n")).toContain("Invalid agent name");
});

test("trust changes an agent's autonomy level", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  await runCli(["new", "work", "--trust", "propose"], h.io);
  expect(await runCli(["trust", "work", "notify"], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("Set work to notify");
});

test("secrets add stores a value without ever echoing it", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  await runCli(["new", "work"], h.io);
  expect(await runCli(["secrets", "add", "work", "GITHUB_TOKEN", "super-secret-value"], h.io)).toBe(0);
  const printed = [...h.out, ...h.err].join("\n");
  expect(printed).toContain("Stored credential GITHUB_TOKEN");
  expect(printed).not.toContain("super-secret-value");
});

test("secrets add falls back to the environment variable", async () => {
  const h = harness({ GITHUB_TOKEN: "from-env" });
  await runCli(["init"], h.io);
  await runCli(["new", "work"], h.io);
  expect(await runCli(["secrets", "add", "work", "GITHUB_TOKEN"], h.io)).toBe(0);
  expect([...h.out, ...h.err].join("\n")).not.toContain("from-env");
});

test("secrets add reports when no value is available", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  await runCli(["new", "work"], h.io);
  expect(await runCli(["secrets", "add", "work", "GITHUB_TOKEN"], h.io)).toBe(1);
  expect(h.err.join("\n")).toContain("No value for GITHUB_TOKEN");
});

test("skill add copies a markdown skill into the agent's workspace", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  await runCli(["new", "personal"], h.io);
  const skillFile = join(h.dir, "blog-writer.md");
  writeFileSync(skillFile, "# Blog writer\nWrite in a warm, direct voice.\n");
  expect(await runCli(["skill", "add", "personal", "blog-writer.md"], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain('Attached skill "blog-writer"');
  expect(existsSync(join(h.dir, HOME_DIR_NAME, "agents", "personal", "skills", "blog-writer.md"))).toBe(true);
});

test("memory inspect reports an empty store", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  await runCli(["new", "personal"], h.io);
  expect(await runCli(["memory", "inspect", "personal"], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("no memories yet");
});

test("events tail shows the kernel's own lifecycle log", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  await runCli(["new", "personal"], h.io);
  expect(await runCli(["events", "tail", "personal"], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("agent.created");
});

test("run drives the adapter, records the run, and prints output", async () => {
  const h = harness();
  h.io.makeAdapter = () => ({ adapter: fakeAdapter });
  await runCli(["init"], h.io);
  await runCli(["new", "personal", "--trust", "autonomous"], h.io);
  expect(await runCli(["run", "personal", "say hello"], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("hello from the agent");

  // The run and its status transitions are on the agent's record.
  const events: string[] = [];
  await runCli(["events", "tail", "personal"], { ...h.io, out: (t) => events.push(t) });
  const log = events.join("\n");
  expect(log).toContain("run.started");
  expect(log).toContain("run.status_changed");
});

test("run without a configured model explains what to set", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  await runCli(["new", "personal"], h.io);
  expect(await runCli(["run", "personal", "do a thing"], h.io)).toBe(1);
  expect(h.err.join("\n")).toContain("ASTERISM_MODEL_ID");
});

test("secrets and activity never cross between agents", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  await runCli(["new", "personal", "--trust", "autonomous"], h.io);
  await runCli(["new", "work", "--trust", "propose"], h.io);
  await runCli(["secrets", "add", "work", "GITHUB_TOKEN", "abc"], h.io);

  const workEvents: string[] = [];
  await runCli(["events", "tail", "work"], { ...h.io, out: (t) => workEvents.push(t) });
  expect(workEvents.join("\n")).toContain("credential.added");

  const personalEvents: string[] = [];
  await runCli(["events", "tail", "personal"], { ...h.io, out: (t) => personalEvents.push(t) });
  expect(personalEvents.join("\n")).not.toContain("credential.added");
});

test("reflect and serve are recognized but not yet wired", async () => {
  const h = harness();
  await runCli(["init"], h.io);
  await runCli(["new", "personal"], h.io);
  expect(await runCli(["reflect", "personal", "--review"], h.io)).toBe(1);
  expect(await runCli(["serve", "personal"], h.io)).toBe(1);
  expect(h.err.join("\n")).toContain("coming soon");
});

test("--version prints the version", async () => {
  const h = harness();
  expect(await runCli(["--version"], h.io)).toBe(0);
  expect(h.out).toEqual([VERSION]);
});

test("no command prints usage", async () => {
  const h = harness();
  expect(await runCli([], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("Usage:");
});

test("an unknown command is an error", async () => {
  const h = harness();
  expect(await runCli(["frobnicate"], h.io)).toBe(1);
  expect(h.err.join("\n")).toContain("Unknown command");
});
