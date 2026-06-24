// The shipped file tools' STRUCTURED OBSERVATIONS (slice T1).
//
// The catalog test (catalog.test.ts) proves the tools' EFFECTS through the full
// CLI surface — what runs, what pauses, what is confined. This test proves the
// FACTS each tool declares at the source: the typed `subject/relation/object`
// records the trace recorder later persists. The tools do real filesystem work
// against a real temp workspace here, so the facts reflect genuine effects (a real
// size, a real existence flag), never stubs. The discipline under test:
//
//   - write_file → the file's size AND that it now exists.
//   - read_file  → the file's SIZE only — never its contents as a fact.
//   - delete_file → that the target no longer exists, with an honest file:/dir: subject.
//   - a failed call emits NO observation (no effect ⇒ nothing to record).
//   - subject references are controlled + normalized (file:<workspace-relative-path>).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ScopedTool, ToolResult } from "@qmilab/asterism-core";

import { workspaceCapabilities } from "./capabilities.js";

describe("file tools emit structured observations", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "asterism-caps-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  /** The shipped catalog's tool by name, bound to this test's workspace. */
  function tool(name: string): ScopedTool {
    const cap = workspaceCapabilities(workspace).find((c) => c.tool.name === name);
    if (!cap) throw new Error(`no such tool in catalog: ${name}`);
    return cap.tool;
  }

  function run(name: string, args: unknown): Promise<ToolResult> | ToolResult {
    return tool(name).execute({ args });
  }

  test("write_file reports the file's size and that it now exists", async () => {
    const result = await run("write_file", { path: "notes/todo.md", content: "hello" });
    expect(result.isError).toBeUndefined();
    expect(result.observation).toEqual({
      schema: "asterism.fs.write@1",
      facts: [
        { subject: "file:notes/todo.md", relation: "size_bytes", object: 5 },
        { subject: "file:notes/todo.md", relation: "exists", object: true },
      ],
    });
  });

  test("read_file reports the file's SIZE only — never its contents as a fact", async () => {
    await run("write_file", { path: "a.txt", content: "twelve bytes" }); // 12 UTF-8 bytes
    const result = await run("read_file", { path: "a.txt" });
    expect(result.output).toBe("twelve bytes"); // contents come back as the model-facing output...
    expect(result.observation).toEqual({
      schema: "asterism.fs.read@1",
      facts: [{ subject: "file:a.txt", relation: "size_bytes", object: 12 }],
    });
    // ...but the contents are never carried as a fact object (only the size is).
    const objects = result.observation!.facts.map((f) => f.object);
    expect(objects).not.toContain("twelve bytes");
  });

  test("delete_file reports that a file no longer exists (file: subject)", async () => {
    await run("write_file", { path: "gone.txt", content: "x" });
    const result = await run("delete_file", { path: "gone.txt" });
    expect(result.observation).toEqual({
      schema: "asterism.fs.delete@1",
      facts: [{ subject: "file:gone.txt", relation: "exists", object: false }],
    });
  });

  test("delete_file uses a dir: subject when the target is a directory", async () => {
    await run("write_file", { path: "build/out.txt", content: "x" }); // creates build/
    const result = await run("delete_file", { path: "build" });
    expect(result.observation).toEqual({
      schema: "asterism.fs.delete@1",
      facts: [{ subject: "dir:build", relation: "exists", object: false }],
    });
  });

  test("a failed call emits NO observation — no effect, nothing to record", async () => {
    const missing = await run("read_file", { path: "nope.txt" });
    expect(missing.isError).toBe(true);
    expect(missing.observation).toBeUndefined();

    const refused = await run("write_file", { path: "../escape.txt", content: "x" });
    expect(refused.isError).toBe(true);
    expect(refused.observation).toBeUndefined();
  });

  test("the subject reference is workspace-relative and normalized", async () => {
    const result = await run("write_file", { path: "a/b/c.txt", content: "x" });
    expect(result.observation!.facts[0]!.subject).toBe("file:a/b/c.txt");
  });
});
