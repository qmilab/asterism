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
/**
 * The CLI's configuration file inside the home (model/provider defaults and
 * per-agent overrides). Surface-owned and substrate-free: the kernel never reads
 * it. Holds only model coordinates — never an API key.
 */
export const CONFIG_FILE_NAME = "config.json";
/**
 * Subdirectory holding per-agent HTTP access tokens. These gate `asterism serve`'s
 * front door and are a per-server operator secret, NOT an agent credential — they
 * live here, owner-only, never in the kernel's scoped secret store and never in the
 * workspace (which an agent can write and a future target could expose).
 */
export const HTTP_TOKENS_DIR_NAME = "http-tokens";

/** Absolute path to the database file given an install's home directory. */
export function dbPath(home: string): string {
  return join(home, DB_FILE_NAME);
}

/** Absolute path to the config file given an install's home directory. */
export function configPath(home: string): string {
  return join(home, CONFIG_FILE_NAME);
}

/** A given agent's confined workspace directory inside the home. */
export function agentWorkspace(home: string, agentName: string): string {
  return join(home, AGENTS_DIR_NAME, agentName);
}

/**
 * A given agent's persisted HTTP access token file. Per-agent (so a server for
 * `personal` and one for `work` hold different door keys — "separate lives" reaches
 * the network edge too). The name is a validated single path segment, so it is safe
 * to interpolate here.
 */
export function httpTokenPath(home: string, agentName: string): string {
  return join(home, HTTP_TOKENS_DIR_NAME, `${agentName}.token`);
}

/**
 * The install's HTTP access token for the operator CONSOLE (`asterism dashboard`).
 * Unlike a per-agent serve token, this gates one install-wide door, so it is a
 * single file at the home root — never inside `http-tokens/<name>.token`, where it
 * could collide with an agent literally named `console`. Owner-only, like the
 * per-agent tokens, and never the workspace.
 */
export function consoleTokenPath(home: string): string {
  return join(home, "console.token");
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
