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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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

// The read-only richer tools (slice T2): list_dir / stat / find. All are `effect: "read"`
// (they always run, withheld at no trust level), confined to the workspace, and emit
// structured facts — a COUNT fact first (authoritative total) plus per-entry existence
// facts. The discipline under test:
//
//   - list_dir → entry_count + one file:/dir: exists fact per entry; deterministic order.
//   - stat     → exists (+ size_bytes for a file); a missing path fails with NO observation.
//   - find     → recursive name match → match_count + per-match exists facts; never follows
//                a symlink (so it cannot loop or escape) and stays inside the workspace.
//   - all three permit reading the workspace ROOT, but refuse a climb-OUT.
describe("read-only tools emit structured observations", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "asterism-read-caps-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function tool(name: string): ScopedTool {
    const cap = workspaceCapabilities(workspace).find((c) => c.tool.name === name);
    if (!cap) throw new Error(`no such tool in catalog: ${name}`);
    return cap.tool;
  }
  function run(name: string, args: unknown): Promise<ToolResult> | ToolResult {
    return tool(name).execute({ args });
  }

  test("the read tools are all effect:read (they run at every trust level)", () => {
    const caps = workspaceCapabilities(workspace);
    for (const key of ["fs.list", "fs.stat", "fs.find"]) {
      expect(caps.find((c) => c.key === key)?.effect).toBe("read");
    }
  });

  // ---- list_dir ----

  test("list_dir reports an entry count and one exists fact per entry, sorted", async () => {
    await run("write_file", { path: "b.md", content: "x" });
    await run("write_file", { path: "a.txt", content: "x" });
    await run("write_file", { path: "sub/inner.txt", content: "x" }); // creates dir sub/

    const result = await run("list_dir", { path: "." });
    expect(result.isError).toBeUndefined();
    expect(result.observation).toEqual({
      schema: "asterism.fs.list@1",
      facts: [
        { subject: "dir:.", relation: "entry_count", object: 3 },
        { subject: "file:a.txt", relation: "exists", object: true },
        { subject: "file:b.md", relation: "exists", object: true },
        { subject: "dir:sub", relation: "exists", object: true },
      ],
    });
    expect(result.output).toContain("contains 3 entries");
    expect(result.output).toContain("sub/"); // a directory is rendered with a trailing slash
  });

  test("list_dir defaults to the workspace root and uses a dir:. subject", async () => {
    await run("write_file", { path: "only.txt", content: "x" });
    const result = await run("list_dir", {}); // no path → workspace root
    expect(result.observation!.facts[0]).toEqual({
      subject: "dir:.",
      relation: "entry_count",
      object: 1,
    });
    expect(result.observation!.facts[1]!.subject).toBe("file:only.txt");
  });

  test("list_dir on an empty folder reports a zero count and no entry facts", async () => {
    mkdirSync(join(workspace, "empty"));
    const result = await run("list_dir", { path: "empty" });
    expect(result.observation!.facts).toEqual([
      { subject: "dir:empty", relation: "entry_count", object: 0 },
    ]);
    expect(result.output).toContain("is empty");
  });

  test("list_dir bounds the per-entry facts but the count fact stays the true total", async () => {
    for (let i = 0; i < 70; i++) {
      await run("write_file", { path: `f${String(i).padStart(2, "0")}.txt`, content: "x" });
    }
    const result = await run("list_dir", { path: "." });
    const facts = result.observation!.facts;
    // Count fact (1) + at most 63 entry facts = the recorder's 64-fact cap, never more…
    expect(facts.length).toBe(64);
    // …yet the count fact reports the real total, so bounding never hides the true size.
    expect(facts[0]).toEqual({ subject: "dir:.", relation: "entry_count", object: 70 });
  });

  test("list_dir refuses a path that climbs out of the workspace", async () => {
    const result = await run("list_dir", { path: "../.." });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("must be a path inside this agent's workspace");
    expect(result.observation).toBeUndefined();
  });

  test("list_dir on a missing folder fails with no observation", async () => {
    const result = await run("list_dir", { path: "nope" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
  });

  // ---- stat ----

  test("stat reports a file's existence and size", async () => {
    await run("write_file", { path: "doc.txt", content: "twelve bytes" }); // 12 UTF-8 bytes
    const result = await run("stat", { path: "doc.txt" });
    expect(result.observation).toEqual({
      schema: "asterism.fs.stat@1",
      facts: [
        { subject: "file:doc.txt", relation: "exists", object: true },
        { subject: "file:doc.txt", relation: "size_bytes", object: 12 },
      ],
    });
    expect(result.output).toContain("12 bytes");
  });

  test("stat reports a folder's existence with no size fact", async () => {
    await run("write_file", { path: "d/inner.txt", content: "x" });
    const result = await run("stat", { path: "d" });
    expect(result.observation).toEqual({
      schema: "asterism.fs.stat@1",
      facts: [{ subject: "dir:d", relation: "exists", object: true }],
    });
    expect(result.output).toContain("is a folder");
  });

  test("stat on a missing path fails with no observation — nothing to record", async () => {
    const result = await run("stat", { path: "ghost.txt" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
  });

  test("stat refuses a path that climbs out of the workspace", async () => {
    const result = await run("stat", { path: "../secret" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
  });

  // ---- find ----

  test("find matches names recursively and reports a match count plus per-match facts", async () => {
    await run("write_file", { path: "notes.md", content: "x" });
    await run("write_file", { path: "docs/readme.md", content: "x" });
    await run("write_file", { path: "src/auth.ts", content: "x" });
    await run("write_file", { path: "src/util.ts", content: "x" });

    const result = await run("find", { pattern: "*.md" });
    expect(result.observation).toEqual({
      schema: "asterism.fs.find@1",
      facts: [
        { subject: "dir:.", relation: "match_count", object: 2 },
        { subject: "file:docs/readme.md", relation: "exists", object: true },
        { subject: "file:notes.md", relation: "exists", object: true },
      ],
    });
    expect(result.output).toContain("docs/readme.md");
    expect(result.output).toContain("notes.md");
    expect(result.output).not.toContain("auth.ts");
  });

  test("find can be scoped to a subfolder and matches an exact name", async () => {
    await run("write_file", { path: "src/auth.ts", content: "x" });
    await run("write_file", { path: "other/auth.ts", content: "x" });
    const result = await run("find", { pattern: "auth.ts", path: "src" });
    expect(result.observation!.facts).toEqual([
      { subject: "dir:src", relation: "match_count", object: 1 },
      { subject: "file:src/auth.ts", relation: "exists", object: true },
    ]);
    expect(result.output).not.toContain("other/auth.ts"); // the search was scoped to src/
  });

  test("find reports a zero count when nothing matches", async () => {
    await run("write_file", { path: "a.txt", content: "x" });
    const result = await run("find", { pattern: "*.xyz" });
    expect(result.observation!.facts).toEqual([
      { subject: "dir:.", relation: "match_count", object: 0 },
    ]);
    expect(result.output).toContain("No entries");
  });

  test("find never follows a symlink — so it cannot loop or escape the workspace", async () => {
    await run("write_file", { path: "real/inside.txt", content: "x" });
    // A self-referential symlink: descending into it would loop forever. find must treat it
    // as a leaf file: node (lstat semantics), never recurse, and terminate.
    symlinkSync(workspace, join(workspace, "loop"));
    const result = await run("find", { pattern: "*" });
    expect(result.isError).toBeUndefined();
    const bySubject = new Map(result.observation!.facts.map((f) => [f.subject, f]));
    // The symlink is recorded as a file: leaf, never a dir: descended into.
    expect(bySubject.get("file:loop")).toBeDefined();
    expect(bySubject.has("dir:loop")).toBe(false);
    // And the real subtree below it is still found exactly once (no loop multiplied it).
    expect(bySubject.get("file:real/inside.txt")).toBeDefined();
  });

  test("find refuses a search root that climbs out of the workspace", async () => {
    const result = await run("find", { pattern: "*", path: ".." });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
  });
});
