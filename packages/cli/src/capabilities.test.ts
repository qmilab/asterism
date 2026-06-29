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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  test("find fails loudly when the search root is missing — not a silent empty result", async () => {
    await run("write_file", { path: "real.txt", content: "x" });
    const result = await run("find", { pattern: "*", path: "no-such-dir" });
    // A typoed root must fail (like list_dir/stat), never look like a valid empty search.
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Could not search");
    expect(result.observation).toBeUndefined();
  });

  test("find fails when the search root is a file, not a folder", async () => {
    await run("write_file", { path: "a.txt", content: "x" });
    const result = await run("find", { pattern: "*", path: "a.txt" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
  });

  test("find omits the count fact when the walk is truncated — no authoritative partial count", async () => {
    for (const name of ["m1.md", "m2.md", "m3.md", "m4.md", "m5.md"]) {
      await run("write_file", { path: name, content: "x" });
    }
    // A node cap below the entry count forces truncation mid-walk. `found.length` is then only
    // a partial total, so the structured observation must NOT record it as match_count.
    const cappedFind = workspaceCapabilities(workspace, { maxFindNodes: 3 }).find(
      (c) => c.tool.name === "find",
    )!.tool;
    const result = await cappedFind.execute({ args: { pattern: "*.md" } });
    expect(result.isError).toBeUndefined();
    // No match_count at all — a partial count would persist a false total / false absence…
    expect(result.observation!.facts.some((f) => f.relation === "match_count")).toBe(false);
    // …but the matches actually seen are still recorded, as true `exists` facts.
    expect(result.observation!.facts.length).toBeGreaterThan(0);
    expect(result.observation!.facts.every((f) => f.relation === "exists")).toBe(true);
    expect(result.output).toContain("may be incomplete");
  });

  test("find omits the count fact when the depth limit leaves a subtree unexplored", async () => {
    await run("write_file", { path: "top.md", content: "x" });
    await run("write_file", { path: "deep/inner.md", content: "x" }); // a match below the root
    // maxFindDepth 0 ⇒ the root's `deep/` subtree is never descended, so a real match below it
    // is unexamined: the walk must report incomplete and NOT assert an authoritative count.
    const shallowFind = workspaceCapabilities(workspace, { maxFindDepth: 0 }).find(
      (c) => c.tool.name === "find",
    )!.tool;
    const result = await shallowFind.execute({ args: { pattern: "*.md" } });
    expect(result.isError).toBeUndefined();
    expect(result.observation!.facts.some((f) => f.relation === "match_count")).toBe(false);
    // top.md, seen at the root, is still a true exists fact.
    expect(
      result.observation!.facts.some(
        (f) => f.subject === "file:top.md" && f.relation === "exists",
      ),
    ).toBe(true);
    expect(result.output).toContain("incomplete");
  });

  // ---- symlinked-root escape (read tools must not follow a symlink out of the workspace) ----

  test("list_dir refuses a symlinked root that resolves outside the workspace", () => {
    // A symlink INSIDE the workspace pointing at an external directory. The lexical confinement
    // check accepts it (the path text stays inside), but readdirSync would follow it and leak an
    // outside tree — so the realpath guard must refuse it.
    const outside = mkdtempSync(join(tmpdir(), "asterism-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "x");
      symlinkSync(outside, join(workspace, "escape"));
      const result = run("list_dir", { path: "escape" }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.output).toContain("resolves outside this agent's workspace");
      expect(result.observation).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("find refuses a symlinked root that resolves outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "asterism-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "x");
      symlinkSync(outside, join(workspace, "escape"));
      const result = run("find", { pattern: "*", path: "escape" }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.observation).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("stat refuses a path through a symlinked directory that points outside the workspace", () => {
    // lstat does not follow a FINAL-component symlink, but it DOES follow an intermediate one:
    // `escape/secret.txt` (escape -> /outside) would otherwise leak the outside file's size.
    const outside = mkdtempSync(join(tmpdir(), "asterism-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "twelve bytes");
      symlinkSync(outside, join(workspace, "escape"));
      const result = run("stat", { path: "escape/secret.txt" }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.output).toContain("resolves outside this agent's workspace");
      expect(result.observation).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("find honors the scan budget before descending into a directory", async () => {
    await run("write_file", { path: "a.md", content: "x" });
    await run("write_file", { path: "bigdir/inside.md", content: "x" });
    // Budget = 2: the root's two entries (a.md, then bigdir) exactly spend it, so bigdir must
    // not be descended — its contents must not surface, and the walk reports incomplete.
    const cappedFind = workspaceCapabilities(workspace, { maxFindNodes: 2 }).find(
      (c) => c.tool.name === "find",
    )!.tool;
    const result = await cappedFind.execute({ args: { pattern: "*.md" } });
    expect(result.observation!.facts.some((f) => f.relation === "match_count")).toBe(false);
    // inside.md lives under the un-descended bigdir, so it must not appear as a fact.
    expect(result.observation!.facts.some((f) => f.subject === "file:bigdir/inside.md")).toBe(false);
    expect(result.output).toContain("may be incomplete");
  });

  test("find scans at most the budget from a single large directory (bounded read)", async () => {
    // Eight sibling files, budget 3: the bounded read stops after 3, so only 3 are ever scanned
    // — the directory is never fully materialized before the cap applies. The walk is truncated.
    for (let i = 0; i < 8; i++) {
      await run("write_file", { path: `f${i}.txt`, content: "x" });
    }
    const cappedFind = workspaceCapabilities(workspace, { maxFindNodes: 3 }).find(
      (c) => c.tool.name === "find",
    )!.tool;
    const result = await cappedFind.execute({ args: { pattern: "*.txt" } });
    expect(result.observation!.facts.filter((f) => f.relation === "exists")).toHaveLength(3);
    expect(result.observation!.facts.some((f) => f.relation === "match_count")).toBe(false);
    expect(result.output).toContain("may be incomplete");
  });
});

// The workspace-bounded write tools (slice T4): mkdir / append_file / move. All are `effect:
// "write"` — they run at notify/autonomous, are withheld under propose, and NONE pauses (none is
// destructive). Each emits structured current-state facts exactly like write_file/delete_file.
// The discipline under test:
//
//   - mkdir       → dir: exists=true; recursive parents; idempotent on a folder; fails over a file.
//   - append_file → preserves existing content; size_bytes is the RESULTING total + exists=true.
//   - move        → NO-CLOBBER (refuses a taken destination, so it can never overwrite/lose data);
//                   two facts — the destination now exists, the source no longer does.
//   - all three confine to the workspace and refuse a climb-OUT and the workspace root.
describe("workspace-bounded write tools emit structured observations", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "asterism-write-caps-"));
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

  test("the new write tools are all effect:write (gated like write_file, never pausing)", () => {
    const caps = workspaceCapabilities(workspace);
    for (const key of ["fs.mkdir", "fs.append", "fs.move"]) {
      expect(caps.find((c) => c.key === key)?.effect).toBe("write");
    }
  });

  // --- mkdir ---

  test("mkdir creates a folder and reports it now exists", async () => {
    const result = await run("mkdir", { path: "logs" });
    expect(result.isError).toBeUndefined();
    expect(result.observation).toEqual({
      schema: "asterism.fs.mkdir@1",
      facts: [{ subject: "dir:logs", relation: "exists", object: true }],
    });
    expect(lstatSync(join(workspace, "logs")).isDirectory()).toBe(true);
  });

  test("mkdir makes parent folders as needed", async () => {
    const result = await run("mkdir", { path: "a/b/c" });
    expect(result.observation!.facts[0]!.subject).toBe("dir:a/b/c");
    expect(lstatSync(join(workspace, "a/b/c")).isDirectory()).toBe(true);
  });

  test("mkdir on an existing folder is an idempotent success", async () => {
    await run("mkdir", { path: "dir" });
    const again = await run("mkdir", { path: "dir" });
    expect(again.isError).toBeUndefined();
    expect(again.observation!.facts).toEqual([{ subject: "dir:dir", relation: "exists", object: true }]);
  });

  test("mkdir over an existing FILE fails with no observation", async () => {
    await run("write_file", { path: "taken", content: "x" });
    const result = await run("mkdir", { path: "taken" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
  });

  test("mkdir refuses a climb-out and the workspace root", async () => {
    const out = await run("mkdir", { path: "../escape" });
    expect(out.isError).toBe(true);
    expect(out.observation).toBeUndefined();
    const root = await run("mkdir", { path: "." });
    expect(root.isError).toBe(true);
    expect(root.observation).toBeUndefined();
  });

  // --- append_file ---

  test("append_file preserves existing content and reports the RESULTING total size", async () => {
    await run("write_file", { path: "log.txt", content: "ab" }); // 2 bytes
    const result = await run("append_file", { path: "log.txt", content: "cde" }); // +3 → 5
    expect(result.observation).toEqual({
      schema: "asterism.fs.append@1",
      facts: [
        { subject: "file:log.txt", relation: "size_bytes", object: 5 },
        { subject: "file:log.txt", relation: "exists", object: true },
      ],
    });
    expect(readFileSync(join(workspace, "log.txt"), "utf8")).toBe("abcde");
  });

  test("append_file creates the file (and parents) when absent", async () => {
    const result = await run("append_file", { path: "nested/new.txt", content: "hi" });
    expect(result.isError).toBeUndefined();
    expect(result.observation!.facts).toEqual([
      { subject: "file:nested/new.txt", relation: "size_bytes", object: 2 },
      { subject: "file:nested/new.txt", relation: "exists", object: true },
    ]);
    expect(readFileSync(join(workspace, "nested/new.txt"), "utf8")).toBe("hi");
  });

  test("append_file requires string content and a path", async () => {
    expect((await run("append_file", { path: "x.txt" })).isError).toBe(true);
    expect((await run("append_file", { content: "x" })).isError).toBe(true);
    // A failed append never created the file.
    expect(existsSync(join(workspace, "x.txt"))).toBe(false);
  });

  test("append_file to a directory fails with no observation", async () => {
    await run("mkdir", { path: "folder" });
    const result = await run("append_file", { path: "folder", content: "x" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
  });

  test("append_file refuses a climb-out", async () => {
    const result = await run("append_file", { path: "../escape.txt", content: "x" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
  });

  // --- move ---

  test("move relocates a file: destination exists (same size), source is gone", async () => {
    await run("write_file", { path: "old.txt", content: "hello" }); // 5 bytes
    const result = await run("move", { from: "old.txt", to: "new.txt" });
    expect(result.observation).toEqual({
      schema: "asterism.fs.move@1",
      facts: [
        { subject: "file:new.txt", relation: "size_bytes", object: 5 },
        { subject: "file:new.txt", relation: "exists", object: true },
        { subject: "file:old.txt", relation: "exists", object: false },
      ],
    });
    expect(existsSync(join(workspace, "old.txt"))).toBe(false);
    expect(readFileSync(join(workspace, "new.txt"), "utf8")).toBe("hello");
  });

  test("move renames a folder with a dir: subject and no size fact", async () => {
    await run("write_file", { path: "src/a.txt", content: "x" }); // creates src/
    const result = await run("move", { from: "src", to: "dst" });
    expect(result.observation).toEqual({
      schema: "asterism.fs.move@1",
      facts: [
        { subject: "dir:dst", relation: "exists", object: true },
        { subject: "dir:src", relation: "exists", object: false },
      ],
    });
    expect(existsSync(join(workspace, "src"))).toBe(false);
    expect(readFileSync(join(workspace, "dst/a.txt"), "utf8")).toBe("x");
  });

  test("move is NO-CLOBBER: refuses a taken destination, leaving both paths untouched", async () => {
    await run("write_file", { path: "from.txt", content: "from" });
    await run("write_file", { path: "to.txt", content: "to" });
    const result = await run("move", { from: "from.txt", to: "to.txt" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
    // Neither path changed — the destination was NOT overwritten.
    expect(readFileSync(join(workspace, "from.txt"), "utf8")).toBe("from");
    expect(readFileSync(join(workspace, "to.txt"), "utf8")).toBe("to");
  });

  test("move refuses a destination that exists as a directory", async () => {
    await run("write_file", { path: "f.txt", content: "x" });
    await run("mkdir", { path: "occupied" });
    const result = await run("move", { from: "f.txt", to: "occupied" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
    expect(existsSync(join(workspace, "f.txt"))).toBe(true);
  });

  test("move into the source's own descendant is refused WITHOUT creating parents (no side effect)", async () => {
    await run("write_file", { path: "src/a.txt", content: "x" }); // creates src/
    const result = await run("move", { from: "src", to: "src/sub/dst" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
    // The failed move must NOT have mutated the workspace — `src/sub` was never created...
    expect(existsSync(join(workspace, "src/sub"))).toBe(false);
    // ...and the source is untouched.
    expect(readFileSync(join(workspace, "src/a.txt"), "utf8")).toBe("x");
  });

  test("a name-prefixed sibling is NOT mistaken for a descendant (src → srcfoo is allowed)", async () => {
    await run("mkdir", { path: "src" });
    const result = await run("move", { from: "src", to: "srcfoo" });
    expect(result.isError).toBeUndefined();
    expect(result.observation!.facts).toContainEqual({
      subject: "dir:srcfoo",
      relation: "exists",
      object: true,
    });
    expect(existsSync(join(workspace, "src"))).toBe(false);
    expect(lstatSync(join(workspace, "srcfoo")).isDirectory()).toBe(true);
  });

  test("move of a missing source fails with no observation", async () => {
    const result = await run("move", { from: "ghost.txt", to: "wherever.txt" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
  });

  test("move refuses a climb-out on either side, and the workspace root", async () => {
    await run("write_file", { path: "real.txt", content: "x" });
    expect((await run("move", { from: "../escape.txt", to: "in.txt" })).observation).toBeUndefined();
    expect((await run("move", { from: "real.txt", to: "../escape.txt" })).observation).toBeUndefined();
    expect((await run("move", { from: ".", to: "in.txt" })).isError).toBe(true);
    expect((await run("move", { from: "real.txt", to: "." })).isError).toBe(true);
    // The real file is still where it started after every refusal.
    expect(existsSync(join(workspace, "real.txt"))).toBe(true);
  });

  // ---- symlinked-component escape (T4 writes must not create / relocate THROUGH a symlink out) ----

  test("mkdir refuses creating through a symlinked directory (nothing created outside)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "asterism-mkdir-out-"));
    try {
      symlinkSync(outside, join(workspace, "escape")); // escape -> outside dir
      const result = await run("mkdir", { path: "escape/sub" });
      expect(result.isError).toBe(true);
      expect(result.observation).toBeUndefined();
      expect(existsSync(join(outside, "sub"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("append_file refuses writing through a symlinked directory (nothing written outside)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "asterism-append-out-"));
    try {
      symlinkSync(outside, join(workspace, "escape"));
      const result = await run("append_file", { path: "escape/leak.txt", content: "secret" });
      expect(result.isError).toBe(true);
      expect(result.observation).toBeUndefined();
      expect(existsSync(join(outside, "leak.txt"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("append_file refuses appending through a symlink LEAF whose target is outside (no escape)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "asterism-append-leaf-out-"));
    try {
      const target = join(outside, "secret.txt");
      writeFileSync(target, "orig");
      symlinkSync(target, join(workspace, "link.txt")); // in-workspace symlink → outside FILE
      const result = await run("append_file", { path: "link.txt", content: "MORE" });
      expect(result.isError).toBe(true);
      expect(result.observation).toBeUndefined();
      expect(readFileSync(target, "utf8")).toBe("orig"); // the outside file was not appended to
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("append_file refuses a DANGLING symlink leaf pointing outside (no outside file created)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "asterism-append-dangle-"));
    try {
      const target = join(outside, "notyet.txt"); // does NOT exist yet
      symlinkSync(target, join(workspace, "dangling.txt")); // in-workspace symlink → missing outside path
      const result = await run("append_file", { path: "dangling.txt", content: "X" });
      expect(result.isError).toBe(true);
      expect(result.observation).toBeUndefined();
      expect(existsSync(target)).toBe(false); // the dangling target was NOT created outside
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("mkdir refuses creating through a DANGLING symlinked directory (no escape)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "asterism-mkdir-dangle-"));
    try {
      const missing = join(outside, "nope"); // does NOT exist yet
      symlinkSync(missing, join(workspace, "escape")); // escape → missing outside dir
      const result = await run("mkdir", { path: "escape/sub" });
      expect(result.isError).toBe(true);
      expect(result.observation).toBeUndefined();
      expect(existsSync(missing)).toBe(false); // nothing created outside
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("move refuses a destination that ALIASES back into the source (no parents created)", async () => {
    await run("write_file", { path: "src/a.txt", content: "x" }); // creates src/
    symlinkSync(join(workspace, "src"), join(workspace, "alias")); // alias -> src (in-workspace)
    const result = await run("move", { from: "src", to: "alias/sub/dst" });
    expect(result.isError).toBe(true);
    expect(result.observation).toBeUndefined();
    // mkdir must NOT have followed the alias to create `src/sub` before renameSync failed.
    expect(existsSync(join(workspace, "src/sub"))).toBe(false);
    expect(readFileSync(join(workspace, "src/a.txt"), "utf8")).toBe("x");
  });

  test("move refuses a DESTINATION through a symlinked directory (file not relocated outside)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "asterism-move-dst-out-"));
    try {
      symlinkSync(outside, join(workspace, "escape"));
      await run("write_file", { path: "a.txt", content: "data" });
      const result = await run("move", { from: "a.txt", to: "escape/a.txt" });
      expect(result.isError).toBe(true);
      expect(result.observation).toBeUndefined();
      // The file stayed inside; nothing landed outside.
      expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("data");
      expect(existsSync(join(outside, "a.txt"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("move refuses a SOURCE reached through a symlinked directory (no pull from outside)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "asterism-move-src-out-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "outside-secret");
      symlinkSync(outside, join(workspace, "escape"));
      const result = await run("move", { from: "escape/secret.txt", to: "pulled.txt" });
      expect(result.isError).toBe(true);
      expect(result.observation).toBeUndefined();
      expect(existsSync(join(workspace, "pulled.txt"))).toBe(false);
      // The outside file is untouched.
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside-secret");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("move relocates a symlink as a link (file: subject), never following it out", async () => {
    const outside = mkdtempSync(join(tmpdir(), "asterism-move-out-"));
    try {
      symlinkSync(outside, join(workspace, "link")); // in-workspace symlink → outside dir
      const result = await run("move", { from: "link", to: "moved-link" });
      // Classified by lstat: the link is a file: leaf, not the dir it points at.
      expect(result.observation).toEqual({
        schema: "asterism.fs.move@1",
        facts: [
          { subject: "file:moved-link", relation: "size_bytes", object: lstatSync(join(workspace, "moved-link")).size },
          { subject: "file:moved-link", relation: "exists", object: true },
          { subject: "file:link", relation: "exists", object: false },
        ],
      });
      // The link moved; the OUTSIDE directory it pointed at was never touched.
      expect(lstatSync(join(workspace, "moved-link")).isSymbolicLink()).toBe(true);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
