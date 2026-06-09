// Local on-disk layout for an Asterism install. Everything lives under a single
// `.asterism/` home in the directory where `asterism init` was run:
//
//   .asterism/
//     asterism.db        the local SQLite store (every row scoped by agentId)
//     agents/<name>/      one confined workspace directory per agent
//
// This module is pure path/filesystem plumbing — it knows nothing about the
// kernel. Commands locate the home by walking up from the current directory the
// way `git` finds its repo root, so they work from any subdirectory of a project.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The single directory that holds an install's state. */
export const HOME_DIR_NAME = ".asterism";
/** The SQLite database file inside the home. */
export const DB_FILE_NAME = "asterism.db";
/** Subdirectory holding per-agent workspace directories. */
export const AGENTS_DIR_NAME = "agents";

/** Absolute path to the database file given an install's home directory. */
export function dbPath(home: string): string {
  return join(home, DB_FILE_NAME);
}

/** A given agent's confined workspace directory inside the home. */
export function agentWorkspace(home: string, agentName: string): string {
  return join(home, AGENTS_DIR_NAME, agentName);
}

/**
 * Walk up from `startDir` looking for an existing `.asterism/` directory and
 * return its absolute path, or `undefined` if none is found before the
 * filesystem root. Mirrors how `git` discovers its repository from a nested cwd.
 */
export function findHome(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, HOME_DIR_NAME);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Create the `.asterism/` home (and its `agents/` subdirectory) under `cwd`,
 * returning its path and whether it was newly created. Idempotent: re-running
 * over an existing home leaves it untouched and reports `created: false`.
 */
export function createHome(cwd: string): { home: string; created: boolean } {
  const home = join(resolve(cwd), HOME_DIR_NAME);
  const existed = existsSync(home);
  mkdirSync(join(home, AGENTS_DIR_NAME), { recursive: true });
  return { home, created: !existed };
}

/**
 * Agent names double as workspace directory names and as the handle every
 * command resolves them by, so they must be a single safe path segment: no
 * separators, no `.`/`..`, a reasonable length. Validated at creation time.
 */
export function isValidAgentName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false;
  if (name === "." || name === "..") return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}
