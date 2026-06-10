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
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

import type { Capability } from "@qmilab/asterism-core";
import type { ToolInvocation, ToolResult } from "@qmilab/asterism-core";

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
): { ok: true; path: string } | { ok: false; message: string } {
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
  return { ok: true, path: target };
}

/**
 * Build the default capability catalog bound to one agent's workspace. The set of
 * tools (and their effects) is install-wide — every agent's runs receive the same
 * catalog; only the workspace each tool is confined to differs, and only the
 * agent's trust level and the gate decide what may actually run. The kernel does
 * the rest: exposure filtering, gating, and (for fs.delete) the confirmation pause.
 */
export function workspaceCapabilities(workspaceDir: string): Capability[] {
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
          return { output: readFileSync(c.path, "utf8") };
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
          return { output: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to '${path}'.` };
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
          // force:false ⇒ a missing target is an error the model sees, not a
          // silent success; recursive:true allows removing a populated folder.
          rmSync(c.path, { recursive: true, force: false });
          return { output: `Deleted '${path}'.` };
        } catch (err) {
          return failure(`Could not delete '${path}': ${failureReason(err)}`);
        }
      },
    },
  };

  return [readFile, writeFile, deleteFile];
}
