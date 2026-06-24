// The default tool catalog the shipped CLI hands the kernel — host wiring, not
// kernel policy. The kernel owns trust and the destructive-action gate; this
// module only declares a few real, workspace-scoped tools and their *effects* so
// the gate has concrete actions to reason about when you run the bare binary.
//
// Why this lives at the surface (CLAUDE.md "adapter boundary is law"): a tool's
// `execute` does real filesystem work, which is a host concern. The kernel never
// constructs a tool — it receives this catalog through the `CliIO.capabilities`
// seam, filters it by the agent's trust level, wraps each tool's `execute` in the
// gate, and only then hands the result to the substrate. So nothing here makes a
// trust decision; it declares capabilities and lets the kernel decide.
//
// Effect declarations are load-bearing and are kept deliberately conservative
// (CLAUDE.md golden rule 4, and the `CliIO.capabilities` contract): the kernel
// escalates a *command-string* argument to `destructive`, but it cannot introspect
// a structured-arg tool, so a mis-declared one would slip the gate. Hence:
//   - fs.read   → `read`        information only; always runs.
//   - fs.list   → `read`        list a folder's entries (one level); info only.
//   - fs.stat   → `read`        a node's metadata (exists / kind / size); info only.
//   - fs.find   → `read`        recursive name search under a folder; info only.
//   - fs.write  → `write`       an ordinary side effect inside the agent's own
//                               workspace; runs at notify/autonomous, is withheld
//                               under propose. (The acceptance demo declares its
//                               editor tool `write` the same way — editing a file
//                               in the agent's scratch space is the agent's job.)
//   - fs.delete → `destructive` deleting is irreversible, so it pauses for
//                               confirmation at EVERY trust level, autonomous
//                               included, unless the capability is allow-listed.
//
// CONFINEMENT IS BEST-EFFORT, NOT A SANDBOX. Each tool resolves its `path`
// argument against the agent's workspace and refuses one that climbs out (`..`,
// an absolute path). That is Phase 0's *logical* scoping — exactly what the docs
// claim and no more: it is not an OS-enforced filesystem jail and does not defend
// against symlink tricks or a deliberately hostile tool. Stronger execution
// isolation is a later phase; this catalog is intentionally limited to bounded
// file operations and ships no arbitrary-shell tool, so it never grants code
// execution under merely logical confinement.

import {
  type Dirent,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

import { DEFAULT_MAX_OBSERVATION_FACTS } from "@qmilab/asterism-core";
import type { Capability } from "@qmilab/asterism-core";
import type { ObservedFact, ToolInvocation, ToolResult } from "@qmilab/asterism-core";

// Structured-observation schemas and their CLOSED relation vocabulary. Each tool declares
// the facts it KNOWS it established — at the source, never reverse-engineered from output —
// so the trace can record what a call changed, not just its byte count. The relation set is
// per-schema and fixed here (no free-text drift). Facts are references about the call's own
// effect (a size, an existence flag), never the file's contents and never a secret value;
// the kernel screens them through `redactObservation` before any of it is persisted.
const FS_WRITE_SCHEMA = "asterism.fs.write@1";
const FS_DELETE_SCHEMA = "asterism.fs.delete@1";
const FS_READ_SCHEMA = "asterism.fs.read@1";
const FS_LIST_SCHEMA = "asterism.fs.list@1";
const FS_STAT_SCHEMA = "asterism.fs.stat@1";
const FS_FIND_SCHEMA = "asterism.fs.find@1";
const REL_SIZE_BYTES = "size_bytes";
const REL_EXISTS = "exists";
const REL_ENTRY_COUNT = "entry_count";
const REL_MATCH_COUNT = "match_count";

// Bounds for the read-only directory tools (list_dir / find). The fact arrays they emit are
// capped at the recorder's own limit so a huge tree can't flood the trace — the authoritative
// COUNT fact (entry_count / match_count) is always emitted first and carries the true total, so
// bounding the per-entry facts never hides the real size. `find` additionally caps the WALK
// itself (nodes visited, depth) so a deep or hostile tree cannot make a read run unbounded.
const MAX_LISTED_ENTRIES = 200; // entries rendered into the human-readable output
const MAX_FIND_NODES = 20_000; // entries scanned before `find` stops and says so
const MAX_FIND_DEPTH = 32; // directory depth `find` descends before stopping

/**
 * A controlled `file:`/`dir:` subject reference for a confined, workspace-relative path,
 * separators normalized to `/` so the reference is stable across platforms. The closed
 * prefix set (`file:`, `dir:`) pins each fact to an identifiable node inside the workspace.
 */
function nodeSubject(kind: "file" | "dir", rel: string): string {
  return `${kind}:${rel.split(sep).join("/")}`;
}

/** A tool failure the model can see and react to (never throws across the seam). */
function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

/**
 * A short, host-path-free reason for a filesystem failure. Node's `Error.message`
 * embeds the absolute path it failed on (e.g. `ENOENT: ... open '/Users/me/...'`),
 * which would leak the host home directory and username to the model across a
 * tool contract that is supposed to be workspace-relative. So surface only the
 * errno code (`ENOENT`, `EISDIR`, `EACCES`, …); the relative path the model asked
 * for is added by the caller.
 */
function failureReason(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "operation failed";
}

/** Read a string field from a tool's (untrusted, `unknown`) arguments. */
function stringArg(args: unknown, name: string): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Resolve a requested path to a target *inside* the workspace, or refuse it.
 * Returns the absolute in-workspace path, or a message explaining the refusal.
 * Best-effort logical confinement (see the module header) — a path that climbs
 * out (`..`, an absolute path) and the workspace root itself are rejected; this
 * is not OS-level containment.
 */
function confine(
  workspaceDir: string,
  requested: string,
): { ok: true; path: string; rel: string } | { ok: false; message: string } {
  const root = resolvePath(workspaceDir);
  const target = resolvePath(root, requested);
  const rel = relative(root, target);
  // Refuse a climb-out (`..`, absolute) AND the workspace root itself
  // (`rel === ""`, which `.` / `""` / `notes/..` resolve to). A tool must target a
  // path *inside* the workspace, never the directory itself — otherwise
  // `delete_file` with "." would `rmSync` the whole workspace (a recursive delete
  // does NOT "fail naturally" on a directory the way a read/write would).
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return {
      ok: false,
      message: `Refused: '${requested}' must be a path inside this agent's workspace.`,
    };
  }
  // `rel` is the canonical workspace-relative path (`.`/`./x`/`a/../b` collapsed) — the
  // stable identity a structured fact's subject reference is built from.
  return { ok: true, path: target, rel };
}

/**
 * Confinement for a READ-only tool. Identical to {@link confine} except the workspace
 * ROOT is permitted — listing or searching `.` is the natural default for `list_dir` /
 * `find`, and reading the root directory is harmless (the reason `confine` refuses the
 * root is write/delete-specific: a `delete_file` of "." would `rmSync` the whole
 * workspace; a read cannot do comparable damage). Only a climb-OUT (`..`, an absolute
 * path) is refused. The root normalizes to a stable `.` so its subject is `dir:.`.
 */
function confineForRead(
  workspaceDir: string,
  requested: string,
): { ok: true; path: string; rel: string } | { ok: false; message: string } {
  const root = resolvePath(workspaceDir);
  const target = resolvePath(root, requested);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return {
      ok: false,
      message: `Refused: '${requested}' must be a path inside this agent's workspace.`,
    };
  }
  return { ok: true, path: target, rel: rel === "" ? "." : rel };
}

/**
 * True when an in-workspace path RESOLVES (through symlinks) to a location outside the
 * workspace. `confineForRead` is lexical — it accepts a path that stays inside textually,
 * but a symlinked component (the root itself, or an intermediate directory) can still point
 * out, and a tool that enumerates a directory with `readdirSync` FOLLOWS that symlink and
 * would leak an external tree. The directory-listing reads (`list_dir`, `find`) call this to
 * refuse such a root, making good on their "does not follow symlinks" contract (it goes one
 * step beyond `confine`'s lexical-only baseline precisely because enumerating leaks a whole
 * tree, not one file). Both sides are realpath'd, so a workspace that itself sits under a
 * symlink (e.g. macOS `/tmp` → `/private/tmp`) is fine. A path that cannot be resolved
 * (missing) is NOT an escape — the caller's `readdirSync` reports it — so this returns false
 * and lets that failure surface normally.
 */
function resolvesOutsideWorkspace(workspaceDir: string, absPath: string): boolean {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(resolvePath(workspaceDir));
    realTarget = realpathSync(absPath);
  } catch {
    return false;
  }
  const rel = relative(realRoot, realTarget);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Classify a directory entry as a `dir:` or `file:` node. A symlink is NOT followed
 *  (`withFileTypes` / `lstat` semantics): it reports `isDirectory() === false`, so it is
 *  labelled `file:` — a leaf the tools never descend into, keeping the walk confined. */
function direntKind(entry: Pick<Dirent, "isDirectory">): "file" | "dir" {
  return entry.isDirectory() ? "dir" : "file";
}

/** The workspace-relative path of an entry inside `parentRel` (root `"."` has no prefix). */
function childRel(parentRel: string, name: string): string {
  return parentRel === "." ? name : `${parentRel}${sep}${name}`;
}

/**
 * Compile a simple filename glob into a matcher over an entry's NAME. Only `*` is a
 * wildcard (matching any run of non-separator characters); every other character is
 * matched literally. Building the regex from a fully-escaped pattern means there is no
 * nested-quantifier ReDoS surface, and it only ever runs against short entry names.
 * Case-insensitive, for friendliness (`*.MD` finds `notes.md`).
 */
function nameMatcher(pattern: string): (name: string) => boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[^/]*");
  const re = new RegExp(`^${escaped}$`, "i");
  return (name) => re.test(name);
}

/**
 * Override for the read-only `find` walk bounds — the number of entries scanned and
 * the directory depth descended before it stops and reports results incomplete.
 * Defaults to the production limits; the CLI seam calls `workspaceCapabilities`
 * with no overrides, so this is for tests (and a future operator-tunable budget).
 */
interface FindWalkLimits {
  maxFindNodes?: number;
  maxFindDepth?: number;
}

/**
 * Build the default capability catalog bound to one agent's workspace. The set of
 * tools (and their effects) is install-wide — every agent's runs receive the same
 * catalog; only the workspace each tool is confined to differs, and only the
 * agent's trust level and the gate decide what may actually run. The kernel does
 * the rest: exposure filtering, gating, and (for fs.delete) the confirmation pause.
 */
export function workspaceCapabilities(
  workspaceDir: string,
  limits: FindWalkLimits = {},
): Capability[] {
  const maxFindNodes = limits.maxFindNodes ?? MAX_FIND_NODES;
  const maxFindDepth = limits.maxFindDepth ?? MAX_FIND_DEPTH;
  const readFile: Capability = {
    key: "fs.read",
    effect: "read",
    tool: {
      name: "read_file",
      description:
        "Read a UTF-8 text file from your workspace. Argument: { path } relative to your workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path to read." },
        },
        required: ["path"],
      },
      execute: (invocation: ToolInvocation): ToolResult => {
        const path = stringArg(invocation.args, "path");
        if (path === undefined) return failure("read_file needs a 'path'.");
        const c = confine(workspaceDir, path);
        if (!c.ok) return failure(c.message);
        try {
          const content = readFileSync(c.path, "utf8");
          // The structured fact is the file's SIZE only — never its contents as a fact
          // (the contents are the model-facing `output`; a fact is a reference about the
          // effect, not the data the tool read).
          return {
            output: content,
            observation: {
              schema: FS_READ_SCHEMA,
              facts: [
                {
                  subject: nodeSubject("file", c.rel),
                  relation: REL_SIZE_BYTES,
                  object: Buffer.byteLength(content, "utf8"),
                },
              ],
            },
          };
        } catch (err) {
          return failure(`Could not read '${path}': ${failureReason(err)}`);
        }
      },
    },
  };

  const writeFile: Capability = {
    key: "fs.write",
    effect: "write",
    tool: {
      name: "write_file",
      description:
        "Create or replace a text file in your workspace, making parent folders as needed. " +
        "Arguments: { path, content } with path relative to your workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path to write." },
          content: { type: "string", description: "The full text to write to the file." },
        },
        required: ["path", "content"],
      },
      execute: (invocation: ToolInvocation): ToolResult => {
        const path = stringArg(invocation.args, "path");
        if (path === undefined) return failure("write_file needs a 'path'.");
        // Require `content` explicitly — defaulting a missing/non-string value to
        // "" would silently truncate the target file to empty and report success,
        // which is exactly the kind of unasked-for data loss the gate exists to
        // prevent. A malformed call should fail, not quietly destroy a file.
        const content = stringArg(invocation.args, "content");
        if (content === undefined) return failure("write_file needs string 'content'.");
        const c = confine(workspaceDir, path);
        if (!c.ok) return failure(c.message);
        try {
          mkdirSync(dirname(c.path), { recursive: true });
          writeFileSync(c.path, content);
          const bytes = Buffer.byteLength(content, "utf8");
          return {
            output: `Wrote ${bytes} bytes to '${path}'.`,
            observation: {
              schema: FS_WRITE_SCHEMA,
              facts: [
                { subject: nodeSubject("file", c.rel), relation: REL_SIZE_BYTES, object: bytes },
                { subject: nodeSubject("file", c.rel), relation: REL_EXISTS, object: true },
              ],
            },
          };
        } catch (err) {
          return failure(`Could not write '${path}': ${failureReason(err)}`);
        }
      },
    },
  };

  const deleteFile: Capability = {
    key: "fs.delete",
    effect: "destructive",
    tool: {
      name: "delete_file",
      description:
        "Delete a file or folder (recursively) from your workspace. Argument: { path } " +
        "relative to your workspace. This is destructive and pauses for confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to delete." },
        },
        required: ["path"],
      },
      execute: (invocation: ToolInvocation): ToolResult => {
        const path = stringArg(invocation.args, "path");
        if (path === undefined) return failure("delete_file needs a 'path'.");
        const c = confine(workspaceDir, path);
        if (!c.ok) return failure(c.message);
        try {
          // Classify the node BEFORE removal so the subject reference is honest (it is gone
          // after `rmSync`). `lstatSync`, not `statSync`: classify the node `rmSync` actually
          // removes — a symlink is removed as a link (labelled `file:`), never followed out of
          // the workspace to classify its target. A stat failure means the target is missing;
          // the `force:false` rm below then throws too, so the fact is only ever emitted for a
          // delete that actually happened.
          const kind = lstatSync(c.path).isDirectory() ? "dir" : "file";
          // force:false ⇒ a missing target is an error the model sees, not a
          // silent success; recursive:true allows removing a populated folder.
          rmSync(c.path, { recursive: true, force: false });
          return {
            output: `Deleted '${path}'.`,
            observation: {
              schema: FS_DELETE_SCHEMA,
              facts: [{ subject: nodeSubject(kind, c.rel), relation: REL_EXISTS, object: false }],
            },
          };
        } catch (err) {
          return failure(`Could not delete '${path}': ${failureReason(err)}`);
        }
      },
    },
  };

  const listDir: Capability = {
    key: "fs.list",
    effect: "read",
    tool: {
      name: "list_dir",
      description:
        "List the entries of a folder in your workspace (one level, not recursive). " +
        "Argument: { path } relative to your workspace; omit it or pass '.' for the workspace root.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative folder to list. Defaults to the workspace root.",
          },
        },
      },
      execute: (invocation: ToolInvocation): ToolResult => {
        const path = stringArg(invocation.args, "path") ?? ".";
        const c = confineForRead(workspaceDir, path);
        if (!c.ok) return failure(c.message);
        // `readdirSync` follows a symlinked root out of the workspace — refuse one that
        // resolves outside (the lexical check above cannot see through a symlink).
        if (resolvesOutsideWorkspace(workspaceDir, c.path)) {
          return failure(`Refused: '${path}' resolves outside this agent's workspace.`);
        }
        let entries: Dirent[];
        try {
          entries = readdirSync(c.path, { withFileTypes: true });
        } catch (err) {
          return failure(`Could not list '${path}': ${failureReason(err)}`);
        }
        // Sort by name so the listing AND the facts are deterministic across platforms
        // (readdir order is filesystem-dependent; a replay-stable observation must not be).
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        // The count fact is FIRST and authoritative (the true total, regardless of how many
        // per-entry facts the recorder keeps); per-entry existence facts are bounded so a huge
        // folder cannot flood the observation. The human output is bounded separately, wider.
        const facts: ObservedFact[] = [
          { subject: nodeSubject("dir", c.rel), relation: REL_ENTRY_COUNT, object: entries.length },
        ];
        const factBudget = DEFAULT_MAX_OBSERVATION_FACTS - facts.length;
        const lines: string[] = [];
        entries.forEach((entry, i) => {
          const kind = direntKind(entry);
          if (i < factBudget) {
            facts.push({
              subject: nodeSubject(kind, childRel(c.rel, entry.name)),
              relation: REL_EXISTS,
              object: true,
            });
          }
          if (i < MAX_LISTED_ENTRIES) lines.push(kind === "dir" ? `${entry.name}/` : entry.name);
        });

        let output: string;
        if (entries.length === 0) {
          output = `'${path}' is empty.`;
        } else {
          const noun = entries.length === 1 ? "entry" : "entries";
          output = `'${path}' contains ${entries.length} ${noun}:\n${lines.join("\n")}`;
          if (entries.length > lines.length) {
            output += `\n… and ${entries.length - lines.length} more.`;
          }
        }
        return { output, observation: { schema: FS_LIST_SCHEMA, facts } };
      },
    },
  };

  const statNode: Capability = {
    key: "fs.stat",
    effect: "read",
    tool: {
      name: "stat",
      description:
        "Report metadata about a file or folder in your workspace: whether it is a file or " +
        "a folder, and a file's size in bytes. Argument: { path } relative to your workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to inspect." },
        },
        required: ["path"],
      },
      execute: (invocation: ToolInvocation): ToolResult => {
        const path = stringArg(invocation.args, "path");
        if (path === undefined) return failure("stat needs a 'path'.");
        const c = confineForRead(workspaceDir, path);
        if (!c.ok) return failure(c.message);
        try {
          // `lstatSync`, not `statSync`: report the node AS IT SITS in the workspace and never
          // follow a symlink out of it to stat its target (the confinement choice delete_file
          // makes too). A missing path is a failure with no observation — there is no effect to
          // record, matching read_file's discipline (an `exists:false` fact would also need an
          // ambiguous file:/dir: subject for a node whose kind is unknown).
          const info = lstatSync(c.path);
          const kind = info.isDirectory() ? "dir" : "file";
          const subject = nodeSubject(kind, c.rel);
          const facts: ObservedFact[] = [{ subject, relation: REL_EXISTS, object: true }];
          let output: string;
          if (kind === "dir") {
            output = `'${path}' is a folder.`;
          } else {
            facts.push({ subject, relation: REL_SIZE_BYTES, object: info.size });
            output = `'${path}' is a file of ${info.size} ${info.size === 1 ? "byte" : "bytes"}.`;
          }
          return { output, observation: { schema: FS_STAT_SCHEMA, facts } };
        } catch (err) {
          return failure(`Could not stat '${path}': ${failureReason(err)}`);
        }
      },
    },
  };

  const findNodes: Capability = {
    key: "fs.find",
    effect: "read",
    tool: {
      name: "find",
      description:
        "Find files and folders by name anywhere under a folder in your workspace (recursive). " +
        "The pattern matches an entry's name; '*' is a wildcard (e.g. '*.md'). Arguments: " +
        "{ pattern, path } with path relative to your workspace (defaults to the workspace root).",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Name to match; '*' is a wildcard (e.g. '*.md').",
          },
          path: {
            type: "string",
            description: "Workspace-relative folder to search under. Defaults to the workspace root.",
          },
        },
        required: ["pattern"],
      },
      execute: (invocation: ToolInvocation): ToolResult => {
        const pattern = stringArg(invocation.args, "pattern");
        if (pattern === undefined) return failure("find needs a 'pattern'.");
        const base = stringArg(invocation.args, "path") ?? ".";
        const c = confineForRead(workspaceDir, base);
        if (!c.ok) return failure(c.message);
        // `readdirSync` follows a symlinked root out of the workspace — refuse one that
        // resolves outside (the lexical check above cannot see through a symlink).
        if (resolvesOutsideWorkspace(workspaceDir, c.path)) {
          return failure(`Refused: '${base}' resolves outside this agent's workspace.`);
        }
        // Validate the search ROOT loudly: a missing, non-directory, or unreadable root is a
        // failure with no observation — exactly like list_dir / stat. A typoed root must NOT
        // look like a valid empty search. Only DEEPER subtrees are skipped-on-error in `walk`
        // below (a single unreadable subdirectory should not abort the whole search).
        let rootEntries: Dirent[];
        try {
          rootEntries = readdirSync(c.path, { withFileTypes: true });
        } catch (err) {
          return failure(`Could not search '${base}': ${failureReason(err)}`);
        }
        const matches = nameMatcher(pattern);

        const found: { rel: string; kind: "file" | "dir" }[] = [];
        let visited = 0;
        let truncated = false;
        const walk = (absDir: string, entries: Dirent[], relDir: string, depth: number): void => {
          entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          for (const entry of entries) {
            if (visited >= maxFindNodes) {
              truncated = true;
              return;
            }
            visited++;
            const rel = childRel(relDir, entry.name);
            const kind = direntKind(entry);
            if (matches(entry.name)) found.push({ rel, kind });
            // Recurse only into REAL directories — never follow a symlink (it could be a
            // cycle, or a link pointing out of the workspace; confinement is best-effort).
            // A subtree we DON'T descend (depth limit, or unreadable) leaves matches below it
            // unexamined, so mark the walk truncated — otherwise the count fact below would be
            // recorded as an authoritative total / absence it cannot actually back.
            if (entry.isDirectory()) {
              if (depth < maxFindDepth) {
                const childAbs = resolvePath(absDir, entry.name);
                let sub: Dirent[];
                try {
                  sub = readdirSync(childAbs, { withFileTypes: true });
                } catch {
                  truncated = true; // unreadable subtree → results incomplete
                  continue;
                }
                walk(childAbs, sub, rel, depth + 1);
              } else {
                truncated = true; // a real subdirectory left unexplored at the depth limit
              }
            }
          }
        };
        walk(c.path, rootEntries, c.rel, 0);

        // A TRUNCATED walk has only a partial view, so it must not assert a count: `found.length`
        // is "matches seen before the walk stopped short" (a scan cap, the depth limit, or an
        // unreadable subtree), not the true total. A consumer of the structured observation sees
        // only an exact-looking number and would persist a FALSE count / false absence — so OMIT
        // the count fact when truncated. The per-match `exists` facts stay valid (each found node
        // really does exist; existence is a fact, not a completeness claim).
        const facts: ObservedFact[] = [];
        if (!truncated) {
          facts.push({
            subject: nodeSubject("dir", c.rel),
            relation: REL_MATCH_COUNT,
            object: found.length,
          });
        }
        const factBudget = DEFAULT_MAX_OBSERVATION_FACTS - facts.length;
        found.slice(0, factBudget).forEach((m) => {
          facts.push({ subject: nodeSubject(m.kind, m.rel), relation: REL_EXISTS, object: true });
        });

        let output: string;
        if (found.length === 0) {
          output = `No entries under '${base}' match '${pattern}'.`;
        } else {
          const noun = found.length === 1 ? "match" : "matches";
          const shown = found.slice(0, MAX_LISTED_ENTRIES);
          const lines = shown.map((m) => (m.kind === "dir" ? `${m.rel}/` : m.rel));
          output = `Found ${found.length} ${noun} for '${pattern}' under '${base}':\n${lines.join("\n")}`;
          if (found.length > shown.length) output += `\n… and ${found.length - shown.length} more.`;
        }
        if (truncated) {
          output += `\n(Results may be incomplete: some folders were not fully searched.)`;
        }
        return { output, observation: { schema: FS_FIND_SCHEMA, facts } };
      },
    },
  };

  return [readFile, writeFile, deleteFile, listDir, statNode, findNodes];
}
