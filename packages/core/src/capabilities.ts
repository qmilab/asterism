// Capability ownership — WHICH capabilities an agent holds at all.
//
// Three ideas sit next to each other in this product and are easy to confuse, so
// they are named here once:
//
//   1. OWNERSHIP (this file) — the operator-declared set of capability keys an
//      agent holds. Resolved into `TrustProfile.capabilities`, the exposure
//      allow-list `resolveToolRegistry` filters by. A capability an agent does not
//      own never reaches the registry, so the substrate never sees it.
//   2. TRUST LEVEL (`trust.ts`) — what the agent may DO with a capability it holds:
//      withhold a plan (`propose`), act and surface (`notify`), act and log
//      (`autonomous`). Orthogonal to ownership.
//   3. STANDING (`standing.ts`, `capability_standing`) — which DESTRUCTIVE
//      capabilities the agent has EARNED the right to run without pausing. Standing
//      presumes ownership and never implies it; the two are separate columns and
//      separate verbs, and revoking one does not cascade into the other.
//
// Nothing here touches the store, and nothing here builds a tool. This is policy
// data plus one pure resolver — the same category as `DESTRUCTIVE_COMMAND_RULES`,
// which names shell commands for a tool that has never shipped.

import { WORLD_FACT_FORGET_KEY, WORLD_FACT_RECORD_KEY } from "./world-facts.js";

/**
 * The capability keys an agent holds when the operator has declared nothing — a
 * **named, closed set**, deliberately not "whatever the host handed in".
 *
 * Why closed rather than dynamic: an agent with nothing declared must keep getting
 * the catalog it gets TODAY (back-compat), and that promise must not silently extend
 * to capability classes added later. A credential-bearing tool, when one ships, is
 * never inherited by an agent that never asked for it — it is simply not in this
 * list, so it requires an explicit declaration. If the default tracked the live host
 * catalog, every future addition would widen every existing agent by inheritance.
 *
 * These are the nine filesystem capabilities the CLI's `workspaceCapabilities`
 * builds. The kernel cannot construct them and does not try to: it names the keys
 * that are exposed by default, which is policy, not capability. The coupling is
 * pinned by a test in the CLI (`catalog.test.ts`) asserting the shipped catalog's
 * keys ARE this list — so adding a tool to the catalog fails that test until its
 * author decides, in review, whether it is default-exposed.
 *
 * A host that ships capabilities of its own (an embedder, a test fixture) keeps
 * them: they are simply not default-exposed, so each agent that should have them
 * declares them.
 */
export const DEFAULT_CAPABILITY_KEYS: readonly string[] = Object.freeze([
  "fs.append",
  "fs.delete",
  "fs.find",
  "fs.list",
  "fs.mkdir",
  "fs.move",
  "fs.read",
  "fs.stat",
  "fs.write",
]);

/**
 * The kernel's own capability keys — its tools over the agent's OWN state, not the
 * host's environment. They are exposed on every run whether or not the operator has
 * declared anything, so narrowing an agent's host catalog never takes away its
 * working notes.
 *
 * This is the same reservation `run.ts` already enforces in the other direction (a
 * host capability colliding on one of these keys, or on either tool NAME, is dropped
 * before the kernel's own is appended). Reserved means reserved both ways: a host
 * may not take the key, and a declaration may not drop it.
 */
export const RESERVED_CAPABILITY_KEYS: readonly string[] = Object.freeze([
  WORLD_FACT_RECORD_KEY,
  WORLD_FACT_FORGET_KEY,
]);

/** The longest a single capability key may be. The shipped keys are ~8 characters. */
const MAX_CAPABILITY_KEY_LENGTH = 128;

/** The most keys one declaration may name. The whole shipped catalog is nine. */
const MAX_DECLARED_CAPABILITIES = 256;

/**
 * Assert that `keys` is a usable capability declaration and return it CANONICAL —
 * de-duplicated and sorted, so the stored value has one representation and an
 * unchanged declaration compares equal (which is what lets the setter skip a phantom
 * write and a phantom event).
 *
 * The write-boundary chokepoint for ownership, the sibling of `validateEnum` /
 * `validatePositiveInt`: a bad value from a surface can never reach a stored
 * declaration the kernel later trusts. It lives here rather than in `types.ts`
 * because it needs the reserved-key list, and because ownership is where the rule
 * belongs.
 *
 * What it checks — SHAPE, not membership:
 *   - each key is a non-empty string with no whitespace or control characters, within
 *     a length bound;
 *   - the set is within a size bound;
 *   - no key is RESERVED for the kernel ({@link RESERVED_CAPABILITY_KEYS}) — those
 *     ride every run regardless (see {@link resolveOwnedCapabilityKeys}), so naming
 *     one in a declaration is a mistake worth surfacing, not a no-op to swallow.
 *
 * It deliberately does NOT check that a key names a capability that exists. The
 * kernel cannot know: an embedder's own tools are legitimate keys it has never heard
 * of. The surface that knows its catalog (the CLI) rejects an unknown key with the
 * catalog printed, which is where a typo is actually catchable.
 */
export function validateCapabilityKeys(keys: readonly string[], label: string): string[] {
  if (keys.length > MAX_DECLARED_CAPABILITIES) {
    throw new Error(
      `invalid ${label}: ${keys.length} keys (at most ${MAX_DECLARED_CAPABILITIES})`,
    );
  }
  const reserved = new Set(RESERVED_CAPABILITY_KEYS);
  for (const key of keys) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(`invalid ${label}: ${JSON.stringify(key)} (expected a non-empty key)`);
    }
    if (key.length > MAX_CAPABILITY_KEY_LENGTH) {
      throw new Error(
        `invalid ${label}: a key may be at most ${MAX_CAPABILITY_KEY_LENGTH} characters`,
      );
    }
    // Whitespace, C0 + DEL, and C1 — a key is an identifier, and an invisible character
    // in one is either a paste accident or an attempt to make two declarations look
    // identical while resolving differently.
    if (/[\s\u0000-\u001F\u007F-\u009F]/.test(key)) {
      throw new Error(
        `invalid ${label}: ${JSON.stringify(key)} (a key may not contain whitespace or control characters)`,
      );
    }
    if (reserved.has(key)) {
      throw new Error(
        `invalid ${label}: ${JSON.stringify(key)} is reserved for the kernel and is always available — it cannot be declared`,
      );
    }
  }
  return [...new Set(keys)].sort();
}

/**
 * Resolve an agent's stored declaration into the exposure allow-list for a run.
 *
 *   - `undefined` (nothing declared) ⇒ {@link DEFAULT_CAPABILITY_KEYS}. A legitimate
 *     permanent state, not one to migrate out of — no backfill exists or is wanted.
 *   - a declared array ⇒ exactly those keys. An EMPTY array is a real declaration
 *     ("this agent owns no host tools"), distinct from `undefined`, which is why the
 *     stored column is nullable rather than a row-per-key table: with rows, "no rows"
 *     could not tell the two apart, and revoking an agent's last capability would
 *     silently widen it back to the full catalog.
 *
 * The reserved kernel keys are unioned in either way. Declaring is therefore always
 * a narrowing of the host catalog and never a widening of it.
 *
 * Pure: the caller reads the declaration from the store and passes it in. The
 * returned set is fresh, so a caller may not mutate a shared value through it.
 */
export function resolveOwnedCapabilityKeys(
  declared: readonly string[] | undefined,
): ReadonlySet<string> {
  const owned = new Set<string>(declared ?? DEFAULT_CAPABILITY_KEYS);
  for (const key of RESERVED_CAPABILITY_KEYS) owned.add(key);
  return owned;
}
