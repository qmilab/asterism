// The HTTP access-token resolver — its resolution order and its single on-disk side
// effect (generate-and-persist on first serve). What we pin: the env var wins and is
// never written to disk; a saved token is reused silently; first serve mints, saves
// owner-only, and reports `generated`; and per-agent tokens never collide.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { HTTP_TOKEN_ENV, resolveHttpToken } from "./http-token.ts";
import { httpTokenPath } from "./paths.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "asterism-httptok-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("an env token wins, is returned verbatim, and is never written to disk", () => {
  const resolved = resolveHttpToken(home, "personal", { [HTTP_TOKEN_ENV]: "injected-secret" });
  expect(resolved).toEqual({ token: "injected-secret", source: "env" });
  // The injected secret is the container/VPS path — we must not persist it.
  expect(existsSync(httpTokenPath(home, "personal"))).toBe(false);
});

test("an env token is trimmed, and an empty/whitespace one is treated as unset", () => {
  expect(resolveHttpToken(home, "personal", { [HTTP_TOKEN_ENV]: "  padded  " }).token).toBe("padded");

  // Whitespace-only falls through to generation rather than keying on a blank token.
  const blank = resolveHttpToken(home, "work", { [HTTP_TOKEN_ENV]: "   " });
  expect(blank.source).toBe("generated");
  expect(blank.token.length).toBeGreaterThan(0);
});

test("first serve with no env mints a token, saves it owner-only, and reports it generated", () => {
  const resolved = resolveHttpToken(home, "personal", {});
  expect(resolved.source).toBe("generated");
  // 32 random bytes as hex ⇒ 64 chars.
  expect(resolved.token).toMatch(/^[0-9a-f]{64}$/);

  const path = httpTokenPath(home, "personal");
  expect(resolved.path).toBe(path);
  // Persisted, and the file holds exactly the token returned.
  expect(readFileSync(path, "utf8")).toBe(resolved.token);
  // Owner-only (0600) — a per-server secret must not be world/group readable.
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("a saved token is reused silently on the next serve (no re-mint, no re-report)", () => {
  const first = resolveHttpToken(home, "personal", {});
  expect(first.source).toBe("generated");

  const second = resolveHttpToken(home, "personal", {});
  expect(second.source).toBe("file");
  expect(second.token).toBe(first.token);
});

test("an injected env token overrides a saved file without disturbing it", () => {
  const saved = resolveHttpToken(home, "personal", {}); // creates the file
  const overridden = resolveHttpToken(home, "personal", { [HTTP_TOKEN_ENV]: "from-env" });
  expect(overridden).toEqual({ token: "from-env", source: "env" });
  // The saved token is left intact for when the env var is not set.
  expect(readFileSync(httpTokenPath(home, "personal"), "utf8")).toBe(saved.token);
});

test("per-agent tokens are distinct files — separate lives reach the front door", () => {
  const personal = resolveHttpToken(home, "personal", {});
  const work = resolveHttpToken(home, "work", {});
  expect(personal.token).not.toBe(work.token);
  expect(httpTokenPath(home, "personal")).not.toBe(httpTokenPath(home, "work"));
});

test("an empty pre-existing token file is reclaimed, persisted, and then reused", () => {
  // A stale empty leftover from an interrupted serve. The resolver must not crash
  // (the original wx-then-throw failed startup), AND it must WRITE the token back —
  // otherwise the next serve sees an empty file again and generates a different one.
  const path = httpTokenPath(home, "personal");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ""); // empty ⇒ treated as "no saved token", so generation runs

  const first = resolveHttpToken(home, "personal", {});
  expect(first.token).toMatch(/^[0-9a-f]{64}$/);
  // Persisted (not returned in memory only) and still owner-only.
  expect(readFileSync(path, "utf8")).toBe(first.token);
  expect(statSync(path).mode & 0o777).toBe(0o600);

  // The next serve reuses it rather than regenerating — the reuse contract holds.
  const second = resolveHttpToken(home, "personal", {});
  expect(second.source).toBe("file");
  expect(second.token).toBe(first.token);
});

test("a malformed persisted token is rejected, reclaimed, and replaced", () => {
  // A non-empty but corrupt/truncated file (e.g. an interrupted write) must not be
  // accepted as the bearer token — that would leave the server on a short,
  // low-entropy secret. It is repaired with a fresh well-formed token instead.
  const path = httpTokenPath(home, "personal");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "deadbeef"); // valid hex but far too short to be a real token

  const first = resolveHttpToken(home, "personal", {});
  expect(first.token).toMatch(/^[0-9a-f]{64}$/);
  expect(first.token).not.toBe("deadbeef");
  // The corrupt file was overwritten on disk, owner-only — not left in place.
  expect(readFileSync(path, "utf8")).toBe(first.token);
  expect(statSync(path).mode & 0o777).toBe(0o600);

  // And the repaired token is now reused, not regenerated yet again.
  const second = resolveHttpToken(home, "personal", {});
  expect(second.source).toBe("file");
  expect(second.token).toBe(first.token);
});

test("a leftover lock file self-heals so serving still gets a valid token", () => {
  // A lock abandoned by a crashed serve (no token yet). Resolution must not deadlock:
  // after a bounded wait it publishes a token anyway and clears the stuck lock.
  const path = httpTokenPath(home, "personal");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.lock`, "");

  const resolved = resolveHttpToken(home, "personal", {});
  expect(resolved.token).toMatch(/^[0-9a-f]{64}$/);
  expect(readFileSync(path, "utf8")).toBe(resolved.token); // published despite the lock
  expect(existsSync(`${path}.lock`)).toBe(false); // and the stuck lock was cleared
});
