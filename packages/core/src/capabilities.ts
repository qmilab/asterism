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

/**
 * The reserved namespace for CREDENTIAL-BEARING capabilities — a bound outbound
 * endpoint (`endpoints.ts`), whose `execute` closure carries one of the agent's own
 * secrets.
 *
 * A namespace rather than a fixed list, because unlike the two world-fact keys these
 * are named by the operator at bind time (`api.<name>`), one per binding. It is
 * reserved in both directions, for the same reason the world-fact keys are:
 *
 *   - a HOST capability may not take a key in it — the kernel's tool over state only
 *     the kernel can reach is authoritative for its own namespace, and a host tool
 *     answering to a credential-bearing key is precisely the confusion to prevent;
 *   - an operator may not hand-type one into a `capabilities` declaration — the
 *     BINDING is the grant (design note E3), so a declaration naming a key no binding
 *     backs would be an exposure with nothing behind it, and one that a binding DOES
 *     back would be a second writer of the same fact.
 */
export const CREDENTIAL_CAPABILITY_PREFIX = "api.";

/**
 * Whether `key` names a credential-bearing capability.
 *
 * ONE predicate, deliberately, because three unrelated places must agree about it and
 * a drift between any two of them is a security defect rather than an inconsistency:
 * the exposure filter (`run.ts` drops a colliding host capability), the destructive
 * gate's `autoApprove` (a credential-bearing capability is never auto-approved), and
 * the standing evidence reader (`standing.ts` collects no evidence for one, so
 * `trust --review` can never propose a grant). Those last two are the two independent
 * locks of design note E9 — they must be independent in MECHANISM, not in the
 * question they ask.
 */
export function isCredentialBearingKey(key: string): boolean {
  return key.startsWith(CREDENTIAL_CAPABILITY_PREFIX);
}

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
    if (isCredentialBearingKey(key)) {
      throw new Error(
        `invalid ${label}: ${JSON.stringify(key)} names a credential-bearing capability — those are granted by binding an endpoint (asterism api add), not by declaring a key`,
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
 * `bound` carries the keys of this agent's CREDENTIAL-BEARING bindings — one per
 * bound outbound endpoint — and is unioned in the same way, because **the binding is
 * the grant** (design note E3). Binding is already the explicit, per-agent, audited
 * operator act that a declaration would otherwise be; requiring a second one would
 * mean that declaring `api.x` for an agent which had declared nothing SHRANK it from
 * nine capabilities to one, which is D8's "an add that removes eight" arriving in the
 * most likely case rather than a corner.
 *
 * What keeps that from being a second exposure mechanism is that it resolves THROUGH
 * here: `TrustProfile.capabilities` remains the one exposure truth, so every view
 * that reads the resolution reports bindings without being told to — which is the
 * structural form of the fix for the single most repeated defect of PR 1 (a surface
 * stating a completeness it has not checked).
 *
 * {@link DEFAULT_CAPABILITY_KEYS} is untouched by any of this and stays closed: with
 * no binding there is no credential-bearing capability, so the class cannot be
 * inherited, because there is nothing to inherit it from.
 *
 * Pure: the caller reads the declaration and the bindings from the store and passes
 * them in. The returned set is fresh, so a caller may not mutate a shared value
 * through it.
 */
export function resolveOwnedCapabilityKeys(
  declared: readonly string[] | undefined,
  bound: readonly string[] = [],
): ReadonlySet<string> {
  const owned = new Set<string>(declared ?? DEFAULT_CAPABILITY_KEYS);
  for (const key of RESERVED_CAPABILITY_KEYS) owned.add(key);
  for (const key of bound) owned.add(key);
  return owned;
}
