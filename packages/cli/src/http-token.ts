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

import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { httpTokenPath } from "./paths.js";

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

/** 32 bytes ⇒ 64 hex chars: 256 bits of entropy, header- and copy-paste-safe. */
function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Read a persisted token, or `undefined` if the file is absent or effectively empty. */
function readPersisted(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    // Missing (ENOENT) or unreadable ⇒ treat as "no persisted token", and a fresh
    // one is generated below. We never surface the raw fs error: it would only ever
    // mean "generate instead".
    return undefined;
  }
}

/**
 * Exclusively create `path` holding `token`, owner-only — the portable fallback used
 * when the filesystem has no hard links. If we lose the create race (`EEXIST`) the
 * winner has already written its token, so we adopt it rather than 401 its clients.
 */
function claimByExclusiveWrite(path: string, token: string): string {
  try {
    writeFileSync(path, token, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return readPersisted(path) ?? token;
    throw err;
  }
}

/**
 * Persist a freshly generated token owner-only and return the value actually in
 * effect. Two correctness hazards drive the shape here: a reader must NEVER observe a
 * half-written token, and two `serve` processes racing on first run must converge on a
 * SINGLE token (else one server 401s the other's clients).
 *
 * Both are handled by staging the full token in a private temp file and then
 * publishing it with an atomic exclusive hard link: `path` appears complete in one
 * step (it is a link to an already-written file — no empty/partial window), and only
 * one racer can create it, so the losers read back the winner's token. A filesystem
 * without hard links (e.g. FAT) falls back to an exclusive create + write. The dir is
 * 0700 and the file 0600, set explicitly so a permissive umask cannot widen them.
 */
function persistGenerated(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // Best effort: an unusual home (e.g. a mount that rejects chmod) must not block
    // serving — the 0600 file is what actually protects the value.
  }

  const token = generateToken();
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  try {
    linkSync(tmp, path);
    return token; // won the race; `path` now holds our fully written token
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Lost the race; the winner published a COMPLETE file (it linked a fully
      // written temp), so adopt its token. The `?? token` is pure defense.
      return readPersisted(path) ?? token;
    }
    // No hard-link support here — publish without one.
    return claimByExclusiveWrite(path, token);
  } finally {
    // Drop the temp name. On the link path this leaves `path` (the other name for the
    // same inode); on the fallback path the temp is just discarded.
    rmSync(tmp, { force: true });
  }
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
