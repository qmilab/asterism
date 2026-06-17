// HTTP access-token resolution for `asterism serve`.
//
// The HTTP front door is default-deny: every request must carry a bearer token, on
// loopback as much as on an exposed interface (loopback is not private on a shared
// machine). This module decides WHICH token a server expects — the kernel never sees
// it (it is a per-server operator secret, not an agent credential), and the server
// package only verifies whatever it is handed.
//
// Resolution order, designed around how `serve` is actually run:
//   1. ASTERISM_HTTP_TOKEN (env)  — the stable, injected secret for the unattended /
//      exposed case (a container, a launchd/systemd unit, a VPS). Never written to
//      disk by us, never logged. This mirrors how the chat-channel tokens are sourced.
//   2. a persisted per-agent file — the local convenience: generated once on first
//      serve, reused silently after, so an interactive operator is not made to manage
//      an env var every shell. Owner-only (0600), under the home, never the workspace.
//   3. otherwise generate one now, persist it (2), and return it as `generated` so the
//      caller can print it exactly once.
//
// The env var always overrides the file, so a container injecting the secret never
// bakes one into its image and never depends on what is on disk.

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { consoleTokenPath, httpTokenPath } from "./paths.js";

/** The env var holding the HTTP access token. A secret — env only, never config/flags. */
export const HTTP_TOKEN_ENV = "ASTERISM_HTTP_TOKEN";

/** Where a resolved token came from — drives how `serve` reports it to the operator. */
export type HttpTokenSource = "env" | "file" | "generated";

export interface ResolvedHttpToken {
  /** The token a client must present as `Authorization: Bearer <token>`. */
  token: string;
  source: HttpTokenSource;
  /** The on-disk file backing a `file`/`generated` token (absent for `env`). */
  path?: string;
}

/** Token entropy: 32 random bytes, rendered as lowercase hex (header/copy-paste-safe). */
const TOKEN_BYTES = 32;
/** The exact shape every generated token has, so a corrupt file can be told apart. */
const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`);

/** 32 bytes ⇒ 64 hex chars: 256 bits of entropy, header- and copy-paste-safe. */
function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * Read a persisted token, or `undefined` if the file is absent, empty, OR malformed.
 * A persisted token is one we generated, so it must match {@link TOKEN_PATTERN}
 * exactly; a truncated or corrupt value (e.g. an interrupted write) is rejected as
 * "no token" rather than accepted as a short, low-entropy secret. The caller then
 * regenerates and the reclaim path replaces the bad file — it is never left in place.
 */
function readPersisted(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return TOKEN_PATTERN.test(value) ? value : undefined;
  } catch {
    // Missing (ENOENT) or unreadable ⇒ treat as "no persisted token", and a fresh
    // one is generated below. We never surface the raw fs error: it would only ever
    // mean "generate instead".
    return undefined;
  }
}

/**
 * Atomically publish `token` at `path`, owner-only. Staged in a private temp file
 * written in full, then `rename`d into place — so a reader never observes a partial
 * file, and a stale empty/malformed file at `path` is replaced in one step. The dir
 * is created 0700 and the file 0600 explicitly, so a permissive umask cannot widen
 * them. Callers serialize this behind the lock below, so it is never two writers.
 */
function writeTokenAtomic(path: string, token: string): void {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Block this thread for `ms` — used to back off while another process holds the lock. */
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

/** Lock wait budget: at most LOCK_SPINS × LOCK_BACKOFF_MS (~200ms) before self-healing. */
const LOCK_SPINS = 100;
const LOCK_BACKOFF_MS = 2;

/**
 * Persist a freshly generated token owner-only and return the token in effect.
 * Three correctness hazards drive the shape here: a reader must NEVER observe a
 * half-written token; two `serve` processes racing on first run (or both reclaiming a
 * stale empty/malformed file) must converge on a SINGLE token (else one server 401s
 * the other's clients); and a corrupt file must be replaced, not left in place.
 *
 * Convergence is enforced with an exclusive lock file (`<path>.lock`, created with the
 * `wx` flag — an atomic "fail if it exists"). Exactly one process holds the lock and
 * writes the token via {@link writeTokenAtomic}; everyone else waits and adopts what it
 * published. If the lock is never released (a holder crashed mid-write), the bounded
 * wait gives up and self-heals: it publishes a token and clears the stuck lock, so a
 * server still starts — convergence is best-effort only in that rare case.
 */
function persistGenerated(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // Best effort: an unusual home (e.g. a mount that rejects chmod) must not block
    // serving — the 0600 file is what actually protects the value.
  }

  // Fast path: a valid token is already saved (the common "reuse" case).
  const saved = readPersisted(path);
  if (saved) return saved;

  const lockPath = `${path}.lock`;
  for (let spin = 0; spin < LOCK_SPINS; spin++) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600); // atomic exclusive create ⇒ we hold the lock
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Another process holds the lock and is writing the token (it lands fast). Adopt
      // it once published; otherwise back off briefly and retry — never write our own.
      const published = readPersisted(path);
      if (published) return published;
      sleepSync(LOCK_BACKOFF_MS);
      continue;
    }
    try {
      // Under the lock we are the sole writer. Re-check (a prior holder may have just
      // published), else generate and publish atomically.
      const existing = readPersisted(path);
      if (existing) return existing;
      const token = generateToken();
      writeTokenAtomic(path, token);
      return token;
    } finally {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    }
  }

  // The lock never freed within the budget — almost certainly a holder that died
  // mid-write. Self-heal so the server still starts: publish a token and clear the
  // stuck lock. (Sustained genuine contention here would be pathological.)
  const token = generateToken();
  writeTokenAtomic(path, token);
  rmSync(lockPath, { force: true });
  return token;
}

/**
 * Resolve the HTTP access token a server for `agentName` must expect. Pure over its
 * inputs (home, agent name, environment) bar the single on-disk side effect of
 * generating-and-persisting a token when neither the env var nor a saved file
 * supplies one — which is exactly the first-serve case the caller reports.
 */
export function resolveHttpToken(
  home: string,
  agentName: string,
  env: Record<string, string | undefined>,
): ResolvedHttpToken {
  // 1. Injected env secret wins — the stable path for unattended / exposed runs.
  //    An empty / whitespace-only value is treated as unset (a likely misconfig),
  //    falling through rather than standing up a server keyed on a blank token.
  const fromEnv = env[HTTP_TOKEN_ENV]?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };

  const path = httpTokenPath(home, agentName);

  // 2. A previously generated token — reused silently so repeated local serves do
  //    not churn the secret out from under existing clients.
  const persisted = readPersisted(path);
  if (persisted) return { token: persisted, source: "file", path };

  // 3. First serve with no env and no file: mint one and save it for next time.
  return { token: persistGenerated(path), source: "generated", path };
}

/**
 * Resolve the HTTP access token the install-wide operator CONSOLE expects
 * (`asterism dashboard`). The same resolution as {@link resolveHttpToken} — env
 * override, else a persisted file, else generate-and-save — but install-wide rather
 * than per-agent, so it reads/writes the single {@link consoleTokenPath}. The
 * self-hosted dashboard mints this once and reuses it; `--headless` prints it so a
 * remote `dashboard <url>` can attach. `ASTERISM_HTTP_TOKEN` overrides it, the right
 * choice for an exposed/unattended console.
 */
export function resolveConsoleToken(
  home: string,
  env: Record<string, string | undefined>,
): ResolvedHttpToken {
  const fromEnv = env[HTTP_TOKEN_ENV]?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };

  const path = consoleTokenPath(home);
  const persisted = readPersisted(path);
  if (persisted) return { token: persisted, source: "file", path };

  return { token: persistGenerated(path), source: "generated", path };
}
