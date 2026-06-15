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

test("an empty pre-existing token file yields a fresh token instead of crashing", () => {
  // The lost-race / mid-create case: the token path already exists (here, empty)
  // when generation runs. The old wx-then-throw would have failed startup with
  // EEXIST; the resolver must instead return a usable, non-empty token.
  const path = httpTokenPath(home, "personal");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ""); // empty ⇒ treated as "no saved token", so generation runs

  const resolved = resolveHttpToken(home, "personal", {});
  expect(resolved.token).toMatch(/^[0-9a-f]{64}$/);
});
