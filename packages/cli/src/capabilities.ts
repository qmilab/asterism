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
//   - fs.mkdir  → `write`       create a folder; cannot lose data, so an ordinary
//                               side effect like fs.write.
//   - fs.append → `write`       add text to the end of a file (create-if-absent);
//                               preserves existing content, so non-destructive.
//   - fs.move   → `write`       move / rename within the workspace. NO-CLOBBER: it
//                               refuses an existing destination, so it can never
//                               overwrite (irreversible loss) and relocating bytes
//                               is reversible — hence `write`, not `destructive`.
//                               To replace a target, delete it first (that pauses).
//   - fs.delete → `destructive` deleting is irreversible, so it pauses for
//                               confirmation at EVERY trust level, autonomous
//                               included, unless the capability is allow-listed.
//
// CONFINEMENT IS BEST-EFFORT, NOT A SANDBOX. Each tool resolves its `path`
// argument against the agent's workspace and refuses one that climbs out (`..`,
// an absolute path). EVERY file tool ADDITIONALLY realpath-checks that no symlinked
// path component resolves outside the workspace before it reads, enumerates, writes,
// relocates, or deletes — closing the symlinked-directory (and symlinked-leaf) escape
// uniformly across the read explorers (list_dir/stat/find), the writes
// (write_file/append_file/mkdir/move), read_file, and delete_file alike. The split is
// by how each tool treats a FINAL symlink: a tool that FOLLOWS the leaf (read_file
// reads through it, write_file/append_file write through it, mkdir satisfies onto it)
// checks the leaf too; a tool that operates on the leaf AS A LINK (delete_file removes
// it, move relocates it) checks only the ANCESTORS, so deleting or moving an outward
// symlink as a link still works. This is still Phase 0's *logical* scoping — exactly
// what the docs claim and no more: it is NOT an OS-enforced filesystem jail and does
// not defend against a TOCTOU symlink swap between the check and the operation, or a
// deliberately hostile in-process tool. Stronger execution isolation is a later phase;
// this catalog is intentionally limited to bounded file operations and ships no
// arbitrary-shell tool, so it never grants code execution under merely logical
// confinement.

import {
  type Dirent,
  appendFileSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

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
const FS_MKDIR_SCHEMA = "asterism.fs.mkdir@1";
const FS_APPEND_SCHEMA = "asterism.fs.append@1";
const FS_MOVE_SCHEMA = "asterism.fs.move@1";
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

/**
 * Resolve `p` to the absolute location a CREATE / WRITE would land, FOLLOWING symlinks and
 * tolerating not-yet-existing components. `realpathSync` is not enough on its own: it THROWS on a
 * dangling symlink (one whose target does not exist yet), and a guard that treated that throw as
 * "stays inside" would let an in-workspace `link -> /tmp/out/notyet` be written through, CREATING
 * the outside file — the exact dangling-symlink escape. So: fast-path `realpathSync` when the whole
 * chain exists; otherwise, if `p` itself is a symlink, follow its target (even if missing); else
 * `p` is a missing name, so resolve its parent and re-append. Bounded against symlink loops.
 */
function resolveTargetLocation(p: string, depth = 0): string {
  if (depth > 64) return p; // symlink-loop guard (realpathSync also throws ELOOP on the fast path)
  try {
    return realpathSync(p); // whole chain exists — one syscall, fully resolved
  } catch {
    // A component is missing or a symlink dangles; resolve manually.
  }
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(p);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) {
    const link = readlinkSync(p);
    const abs = isAbsolute(link) ? link : resolvePath(dirname(p), link);
    return resolveTargetLocation(abs, depth + 1);
  }
  const parent = dirname(p);
  if (parent === p) return p; // filesystem root
  return resolvePath(resolveTargetLocation(parent, depth + 1), basename(p));
}

/**
 * True when a write/create at `absLocation` would land OUTSIDE the workspace once symlinks (and
 * dangling ones) are followed. The shared core of the write-tool symlink guards — `confine` is
 * lexical and cannot see through a symlink; this resolves where the bytes would actually land.
 */
function locationEscapesWorkspace(workspaceDir: string, absLocation: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(resolvePath(workspaceDir));
  } catch {
    return false; // workspace itself unresolvable — leave to the operation's own error
  }
  const resolved = resolveTargetLocation(absLocation);
  const rel = relative(realRoot, resolved);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * True when a target would land OUTSIDE the workspace once symlinks are followed THROUGH THE FINAL
 * COMPONENT. For tools that follow a symlink leaf: `read_file` (`readFileSync` reads through
 * `link.txt -> /etc/passwd`, returning external CONTENTS), `write_file`/`append_file`
 * (`writeFileSync`/`appendFileSync` write through `link.txt -> /tmp/out/secret`), AND `mkdir`
 * (`mkdirSync(..., {recursive:true})` treats an existing `escape -> /tmp/out` leaf as a satisfied
 * directory and would emit a false `dir:escape exists`). So the leaf is included — an external leaf
 * (existing OR dangling) is an escape, not just a symlinked ancestor.
 */
function targetEscapesWorkspace(workspaceDir: string, absTarget: string): boolean {
  return locationEscapesWorkspace(workspaceDir, absTarget);
}

/**
 * True when a `move` or `delete_file` target would land OUTSIDE the workspace through a symlinked
 * ANCESTOR directory (e.g. `escape -> /tmp/out`, target `escape/a.txt`). Resolves the target's
 * PARENT only — the final component is deliberately NOT followed, because `renameSync` moves and
 * `rmSync` removes a symlink leaf AS A LINK (relocating/unlinking the link itself, never reaching
 * its target), matching the `lstat` discipline both use to classify the node. (`move` checks both
 * its source and destination this way; `delete_file` checks the single target.)
 */
function parentEscapesWorkspace(workspaceDir: string, absTarget: string): boolean {
  return locationEscapesWorkspace(workspaceDir, dirname(absTarget));
}

/** realpath the NEAREST EXISTING node at or above `start`, or null if none resolves. Used by the
 *  move descendant guard to compare REAL paths (so a symlink alias `alias -> src` in the
 *  destination chain cannot disguise an into-the-source move as a sibling). */
function realpathNearestExisting(start: string): string | null {
  let node = start;
  for (;;) {
    try {
      lstatSync(node);
      try {
        return realpathSync(node);
      } catch {
        return null;
      }
    } catch {
      const parent = dirname(node);
      if (parent === node) return null;
      node = parent;
    }
  }
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
 * Read a directory's entries with a hard upper bound. `readdirSync` materializes (and then we
 * sort) the WHOLE directory before any per-entry budget check could apply — so a single folder
 * with far more entries than the scan budget would blow `find`'s advertised bound on memory and
 * time. This streams with `opendirSync`/`readSync` instead, keeping at most `limit` entries and
 * stopping the moment one more exists, so memory is O(limit), not O(directory size). Returns the
 * kept entries sorted by name (deterministic, replay-stable) and `more = true` when the directory
 * held more than `limit` — the caller marks the walk truncated, exactly as for the depth/scan
 * caps. When the directory fits within `limit`, every entry is read and sorted, so a COMPLETE
 * result stays fully ordered; only an already-incomplete (truncated) one sees an FS-order subset.
 */
function readDirBounded(absDir: string, limit: number): { entries: Dirent[]; more: boolean } {
  const dir = opendirSync(absDir);
  try {
    const entries: Dirent[] = [];
    let more = false;
    for (;;) {
      const entry = dir.readSync();
      if (entry === null) break;
      if (entries.length >= limit) {
        more = true;
        break;
      }
      entries.push(entry);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { entries, more };
  } finally {
    dir.closeSync();
  }
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
        // Refuse READING through a symlink that resolves outside — `readFileSync` follows both a
        // symlinked intermediate directory and a final symlink LEAF, so an in-workspace
        // `link -> /etc/passwd` (or `escape/secret`, escape -> outside) would return an EXTERNAL
        // file's CONTENTS to the model — an exfiltration, not the "one in-workspace file" the
        // lexical `confine` assumes. The leaf is followed, so it is checked too (a symlink that
        // resolves INSIDE the workspace still reads fine); same guard write_file/append_file/mkdir use.
        if (targetEscapesWorkspace(workspaceDir, c.path)) {
          return failure(`Refused: '${path}' resolves outside this agent's workspace.`);
        }
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
        // Refuse WRITING through a symlinked directory OR a final symlink leaf that resolves
        // outside — `writeFileSync` follows a symlink leaf (`link.txt -> /tmp/out` would write
        // there, overwriting an external file) and `mkdirSync(dirname)` below follows symlinked
        // intermediates. The leaf is followed, so it is checked too; same guard
        // append_file/mkdir use (confine is lexical only).
        if (targetEscapesWorkspace(workspaceDir, c.path)) {
          return failure(`Refused: '${path}' resolves outside this agent's workspace.`);
        }
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
        // Refuse DELETING through a symlinked directory — `rmSync('escape/file', {recursive})`
        // with `escape -> /tmp/out` would remove an EXTERNAL file. Use the PARENT-only guard
        // (not the leaf-following one): `rmSync` removes a final symlink AS A LINK — it unlinks the
        // link, never follows it to delete the target — exactly `move`'s source discipline, so only
        // a symlinked ANCESTOR escapes. Checked BEFORE the `lstatSync` below, so a symlinked-parent
        // target is never stat'd into the observation (the same ordering `move` uses for its source).
        if (parentEscapesWorkspace(workspaceDir, c.path)) {
          return failure(`Refused: '${path}' resolves outside this agent's workspace.`);
        }
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

  const mkdirNode: Capability = {
    key: "fs.mkdir",
    effect: "write",
    tool: {
      name: "mkdir",
      description:
        "Create a folder in your workspace, making parent folders as needed. " +
        "Argument: { path } relative to your workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative folder path to create." },
        },
        required: ["path"],
      },
      execute: (invocation: ToolInvocation): ToolResult => {
        const path = stringArg(invocation.args, "path");
        if (path === undefined) return failure("mkdir needs a 'path'.");
        const c = confine(workspaceDir, path);
        if (!c.ok) return failure(c.message);
        // Refuse creating THROUGH a symlinked directory OR onto a symlink LEAF that resolves
        // outside — mkdirSync follows an existing symlink-to-dir leaf and would otherwise report
        // an out-of-workspace target as a satisfied `dir:` (confine is lexical only).
        if (targetEscapesWorkspace(workspaceDir, c.path)) {
          return failure(`Refused: '${path}' resolves outside this agent's workspace.`);
        }
        try {
          // recursive:true makes parents as needed and is idempotent on an existing
          // FOLDER (no-op success → an honest `exists:true`); it still THROWS when the
          // path is an existing file (EEXIST/ENOTDIR), so that fails with no observation.
          mkdirSync(c.path, { recursive: true });
          return {
            output: `Created folder '${path}'.`,
            observation: {
              schema: FS_MKDIR_SCHEMA,
              facts: [{ subject: nodeSubject("dir", c.rel), relation: REL_EXISTS, object: true }],
            },
          };
        } catch (err) {
          return failure(`Could not create '${path}': ${failureReason(err)}`);
        }
      },
    },
  };

  const appendFile: Capability = {
    key: "fs.append",
    effect: "write",
    tool: {
      name: "append_file",
      description:
        "Append text to the end of a file in your workspace, creating it (and parent folders) " +
        "if needed. Existing content is preserved. Arguments: { path, content } with path " +
        "relative to your workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path to append to." },
          content: { type: "string", description: "Text to add to the end of the file." },
        },
        required: ["path", "content"],
      },
      execute: (invocation: ToolInvocation): ToolResult => {
        const path = stringArg(invocation.args, "path");
        if (path === undefined) return failure("append_file needs a 'path'.");
        // Require `content` explicitly (write_file's discipline): a missing/non-string value
        // must fail, not silently append nothing and report a misleading success.
        const content = stringArg(invocation.args, "content");
        if (content === undefined) return failure("append_file needs string 'content'.");
        const c = confine(workspaceDir, path);
        if (!c.ok) return failure(c.message);
        // Refuse writing THROUGH a symlinked directory OR a final symlink that resolves outside
        // (appendFileSync follows the leaf, so it is checked too — confine is lexical only).
        if (targetEscapesWorkspace(workspaceDir, c.path)) {
          return failure(`Refused: '${path}' resolves outside this agent's workspace.`);
        }
        try {
          mkdirSync(dirname(c.path), { recursive: true });
          appendFileSync(c.path, content);
          // The size fact is the file's RESULTING total size (its current world-state),
          // read back after the append — not the appended byte count — so it matches the
          // size_bytes fact read_file / stat emit about the same file.
          const bytes = statSync(c.path).size;
          const added = Buffer.byteLength(content, "utf8");
          return {
            output: `Appended ${added} ${added === 1 ? "byte" : "bytes"} to '${path}' (now ${bytes} bytes).`,
            observation: {
              schema: FS_APPEND_SCHEMA,
              facts: [
                { subject: nodeSubject("file", c.rel), relation: REL_SIZE_BYTES, object: bytes },
                { subject: nodeSubject("file", c.rel), relation: REL_EXISTS, object: true },
              ],
            },
          };
        } catch (err) {
          return failure(`Could not append to '${path}': ${failureReason(err)}`);
        }
      },
    },
  };

  const moveNode: Capability = {
    key: "fs.move",
    effect: "write",
    tool: {
      name: "move",
      description:
        "Move or rename a file or folder within your workspace. Refuses if the destination " +
        "already exists — delete it first if you mean to replace it. Arguments: { from, to } " +
        "both relative to your workspace.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Workspace-relative path to move or rename." },
          to: { type: "string", description: "Workspace-relative destination path." },
        },
        required: ["from", "to"],
      },
      execute: (invocation: ToolInvocation): ToolResult => {
        const from = stringArg(invocation.args, "from");
        if (from === undefined) return failure("move needs a 'from'.");
        const to = stringArg(invocation.args, "to");
        if (to === undefined) return failure("move needs a 'to'.");
        const src = confine(workspaceDir, from);
        if (!src.ok) return failure(src.message);
        const dst = confine(workspaceDir, to);
        if (!dst.ok) return failure(dst.message);
        // Refuse reaching the SOURCE through a symlinked directory, or writing the DESTINATION
        // through one — either relocates a file across the workspace boundary even though both
        // paths are lexically inside (confine is lexical). Checked BEFORE the source `lstat`
        // below, so a symlinked-parent source is never even stat'd (which would leak the outside
        // file's size into the observation). The source's OWN final component may be a symlink —
        // it is moved AS A LINK; only a symlinked ANCESTOR escapes.
        if (parentEscapesWorkspace(workspaceDir, src.path)) {
          return failure(`Refused: '${from}' resolves outside this agent's workspace.`);
        }
        if (parentEscapesWorkspace(workspaceDir, dst.path)) {
          return failure(`Refused: '${to}' resolves outside this agent's workspace.`);
        }
        // Classify the SOURCE before the move (it is gone afterward), with lstat so a symlink
        // moves as a link (labelled file:) and is never followed out of the workspace —
        // delete_file's discipline. A missing source throws here and fails with no observation.
        let srcKind: "file" | "dir";
        let srcSize: number;
        try {
          const info = lstatSync(src.path);
          srcKind = info.isDirectory() ? "dir" : "file";
          srcSize = info.size;
        } catch (err) {
          return failure(`Could not move '${from}': ${failureReason(err)}`);
        }
        // NO-CLOBBER (the whole reason this is `write`, not `destructive`): renameSync silently
        // OVERWRITES an existing destination — irreversible data loss, the case only the
        // destructive delete gate may reach. So refuse a taken destination outright; replacing
        // means deleting it first (which pauses). lstat, not an exists-follow, so a dangling or
        // symlinked destination still counts as taken (and a same-path self-move is refused).
        try {
          lstatSync(dst.path);
          return failure(
            `Refused: destination '${to}' already exists. Delete it first if you mean to replace it.`,
          );
        } catch {
          // ENOENT → the destination is free; proceed.
        }
        // Refuse moving a path INTO ITSELF or its own descendant (e.g. `src` → `src/sub/dst`):
        // renameSync would fail (the destination is inside the source), but only AFTER the
        // mkdirSync below had already created the destination's parent folders — a filesystem
        // side effect on a FAILED move. So detect it FIRST, before creating any parents. The
        // destination is a descendant when its path resolves UNDER the source with no climb-out
        // (component-aware via `relative`, so a mere name prefix like `src` → `srcfoo` is fine).
        // `within === ""` is the source itself — already refused by the no-clobber check above
        // (the source exists), kept here as defense.
        const isInsideOrEqual = (rel: string): boolean =>
          rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
        if (isInsideOrEqual(relative(src.path, dst.path))) {
          return failure(`Refused: cannot move '${from}' into itself or its own subfolder ('${to}').`);
        }
        // The lexical check above is fooled by an in-workspace symlink ALIAS in the destination's
        // ancestor chain that points back into the source (e.g. `alias -> src`, dst
        // `alias/sub/dst` reads as a sibling). mkdir would then follow the alias and create inside
        // the source before `renameSync` fails — a filesystem side effect on a REFUSED move. So
        // also compare REAL paths: refuse when the destination's nearest existing ancestor
        // resolves to the source itself or a path inside it.
        const realSrc = realpathNearestExisting(src.path);
        const realDstAnchor = realpathNearestExisting(dst.path);
        if (
          realSrc !== null &&
          realDstAnchor !== null &&
          isInsideOrEqual(relative(realSrc, realDstAnchor))
        ) {
          return failure(`Refused: cannot move '${from}' into itself or its own subfolder ('${to}').`);
        }
        try {
          mkdirSync(dirname(dst.path), { recursive: true });
          renameSync(src.path, dst.path);
        } catch (err) {
          return failure(`Could not move '${from}' to '${to}': ${failureReason(err)}`);
        }
        // Two subjects change: the destination now exists (same kind, and for a file the same
        // size — a move relocates bytes, it does not change them) and the source no longer does.
        const facts: ObservedFact[] = [];
        if (srcKind === "file") {
          facts.push({
            subject: nodeSubject("file", dst.rel),
            relation: REL_SIZE_BYTES,
            object: srcSize,
          });
        }
        facts.push({ subject: nodeSubject(srcKind, dst.rel), relation: REL_EXISTS, object: true });
        facts.push({ subject: nodeSubject(srcKind, src.rel), relation: REL_EXISTS, object: false });
        return {
          output: `Moved '${from}' to '${to}'.`,
          observation: { schema: FS_MOVE_SCHEMA, facts },
        };
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
        // `lstatSync` below does not follow a FINAL-component symlink, but it DOES follow a
        // symlinked INTERMEDIATE directory (e.g. `escape/secret.txt` where `escape` → outside),
        // which would leak the existence and size of a file outside the workspace. Refuse a path
        // that resolves out — the same realpath guard list_dir / find apply before they enumerate.
        if (resolvesOutsideWorkspace(workspaceDir, c.path)) {
          return failure(`Refused: '${path}' resolves outside this agent's workspace.`);
        }
        try {
          // `lstatSync`, not `statSync`: report the node AS IT SITS in the workspace and never
          // follow a FINAL symlink out of it to stat its target (the confinement choice delete_file
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
        // below (a single unreadable subdirectory should not abort the whole search). The bounded
        // read also caps how much of a huge root we materialize (see `readDirBounded`).
        let root: { entries: Dirent[]; more: boolean };
        try {
          root = readDirBounded(c.path, maxFindNodes);
        } catch (err) {
          return failure(`Could not search '${base}': ${failureReason(err)}`);
        }
        const matches = nameMatcher(pattern);

        const found: { rel: string; kind: "file" | "dir" }[] = [];
        let visited = 0;
        let truncated = root.more; // the root held more entries than the scan budget could read
        const walk = (absDir: string, entries: Dirent[], relDir: string, depth: number): void => {
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
            // A subtree we DON'T descend leaves matches below it unexamined, so mark the walk
            // truncated — otherwise the count fact below would be recorded as an authoritative
            // total / absence it cannot actually back.
            if (entry.isDirectory()) {
              // Check the budget BEFORE descending: once `visited` has reached the cap, even the
              // bounded read+sort of a subtree we have no budget left to examine is wasted. The
              // depth limit is the same kind of stop. Either way the walk is now incomplete.
              if (depth >= maxFindDepth || visited >= maxFindNodes) {
                truncated = true;
              } else {
                const childAbs = resolvePath(absDir, entry.name);
                // Read at most the remaining budget — a child folder bigger than that can't be
                // fully scanned anyway, and `readDirBounded` keeps memory O(remaining), never
                // O(child size). `more` means it held more than we could scan ⇒ incomplete.
                let child: { entries: Dirent[]; more: boolean };
                try {
                  child = readDirBounded(childAbs, maxFindNodes - visited);
                } catch {
                  truncated = true; // unreadable subtree → results incomplete
                  continue;
                }
                if (child.more) truncated = true;
                walk(childAbs, child.entries, rel, depth + 1);
              }
            }
          }
        };
        walk(c.path, root.entries, c.rel, 0);

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

  return [
    readFile,
    writeFile,
    appendFile,
    mkdirNode,
    moveNode,
    deleteFile,
    listDir,
    statNode,
    findNodes,
  ];
}
