// Artifact manifest — reduce a run's STATE-CHANGING tool observations to the
// references-only list of workspace artifacts the run produced (Phase 3 · T2a).
//
// This is the payload of the `artifact-only` collaboration mode: when one agent asks
// another to do a task over an `artifact-only` connection, what crosses the agent
// boundary is THIS — a list of `{path, kind, exists, sizeBytes?}` references — and
// never the callee's narration, its memory, or the file BYTES (design note
// `phase-3-collaboration.md` §9, decision D8).
//
// Why references and not contents, restated where it is enforced:
//
//   1. FORWARD-COMPATIBILITY WITH AGENT-INITIATED DELEGATION (T5). The modes are a dial
//      on "how much of the callee does the CALLER get back". Today the initiator is a
//      human (D4), so crossing contents would look harmless — the operator already has
//      access to both agents. Once an agent initiates an exchange mid-run, the payload
//      is no longer read by a person: it is ingested INTO THE CALLER'S CONTEXT. Callee-
//      authored file contents would then be a prompt-injection channel between two
//      agents the whole phase exists to keep apart. The payload contract is designed for
//      that case now, so T5 is an additive capability rather than a retrofit.
//   2. THE SECRET SCRUB IS BEST-EFFORT. `redactForTrace` is pattern-based over secret
//      VALUE shapes and built for bounded snippets; stretching it across arbitrary-length
//      file contents and calling the result screened would overstate it. A manifest needs
//      no such stretch — the observation stream is already bounded and already redacted.
//
// Byte delivery is DEFERRED, not cancelled: materializing a listed artifact into the
// caller's workspace is a WRITE INTO THE CALLER (with overwrite risk), so it belongs
// behind the CALLER's own destructive-action gate, in the caller's context — a follow-up
// slice, and the natural completion of this mode.
//
// Pure: no store, no clock, no I/O — the same deterministic-reducer discipline as
// `world-fact-harvest.ts`, which reduces the SAME observation stream to a different
// projection (proposed working notes). Both read `ObservedEffect[]`; neither owns it.

import type { ObservedEffect } from "./world-fact-harvest.js";
import { DEFAULT_MAX_OBSERVATION_FACTS, redactForTrace } from "./redaction.js";

/**
 * One workspace artifact a run produced — a REFERENCE, never the bytes.
 *
 * `path` is workspace-relative (the agent's own workspace is the only thing its tools can
 * reach), already screened through the kernel's secret-redaction boundary. `exists` is the
 * artifact's state at the end of the run, so a path the run WROTE and then DELETED is
 * reported honestly as absent rather than silently dropped.
 */
export interface ArtifactRef {
  /** Workspace-relative path, e.g. `notes/section.md`. Redacted at construction. */
  path: string;
  /** What the observation established at that path. */
  kind: "file" | "dir";
  /** Whether it exists at the run's end (`false` — the run removed it). */
  exists: boolean;
  /** Size in bytes, when the observation established one. Absent for directories. */
  sizeBytes?: number;
}

// The `asterism.fs.*@1` current-state relations this reducer understands, and the subject
// prefixes it maps to an artifact kind. Hardcoded here (not imported from the `cli` tool
// emitter — `core` must not depend on a surface) as this module's view of the fact
// contract, exactly as `world-fact-harvest.ts` does. A subject carrying an unknown prefix,
// or an observation with no renderable state, contributes NOTHING — never a guess.
const REL_EXISTS = "exists";
const REL_SIZE_BYTES = "size_bytes";
const SUBJECT_KINDS: ReadonlyArray<readonly [string, ArtifactRef["kind"]]> = [
  ["file:", "file"],
  ["dir:", "dir"],
];

/**
 * Split a controlled fact subject (`file:notes/todo.md`) into its kind and path, or
 * `undefined` for a subject this reducer does not model (e.g. a future `repo:` subject).
 *
 * The prefix is fixed kernel vocabulary; only the PATH is agent-chosen, so only the path
 * is redacted — parsing before redaction keeps a secret-shaped path from ever making the
 * kind unparseable, while preserving the identical security property (the attacker-
 * controlled span is the one that gets screened).
 */
function parseSubject(subject: string): { kind: ArtifactRef["kind"]; path: string } | undefined {
  for (const [prefix, kind] of SUBJECT_KINDS) {
    if (subject.startsWith(prefix)) return { kind, path: subject.slice(prefix.length) };
  }
  return undefined;
}

/**
 * Resolve a subject's final relation map to its end-of-run state, or `undefined` to SKIP
 * it (no renderable state — never guess). Priority mirrors the working-note harvest's
 * renderer so the two projections of one run can never disagree about what happened:
 *   - `exists = false` → absent (a deletion dominates a stale earlier `size_bytes`),
 *   - `size_bytes = N` → present with a known size,
 *   - `exists = true`  → present without a size (a directory).
 * Strict comparisons: a malformed object of the wrong type falls through rather than
 * mis-reporting.
 */
function resolveState(
  relations: ReadonlyMap<string, unknown>,
): { exists: boolean; sizeBytes?: number } | undefined {
  if (relations.get(REL_EXISTS) === false) return { exists: false };
  const size = relations.get(REL_SIZE_BYTES);
  if (typeof size === "number") return { exists: true, sizeBytes: size };
  if (relations.get(REL_EXISTS) === true) return { exists: true };
  return undefined;
}

/**
 * Reduce a run's collected {@link ObservedEffect}s to its artifact manifest.
 *
 * 1. SELECT state-changing observations (`effect !== "read"`) — a pure read produced no
 *    artifact, and including reads would turn the manifest into a record of everything the
 *    callee LOOKED AT, which is exactly the kind of leak this mode exists to prevent.
 * 2. ACCUMULATE per subject a `relation → object` map in execution order, so the LAST
 *    value wins — a write-then-delete of one path resolves to absent, a re-write to its
 *    latest size.
 * 3. PARSE each subject into kind + path, dropping subjects this reducer does not model.
 * 4. REDACT the path through the kernel's secret-redaction boundary before it becomes a
 *    reference, and
 * 5. SORT by path so the manifest is deterministic (and so a downstream cap would be too).
 *
 * Step 4 is the security boundary, for the same reason the working-note harvest redacts:
 * the agent CHOSE the path, so a secret-shaped one (`file:keys/AKIA…`) would otherwise
 * cross the agent boundary verbatim. A clean path passes through unchanged.
 *
 * Invariant 3 (the callee's gate stays sovereign) falls out by construction rather than by
 * a check here: `onObservation` fires only AFTER a tool actually succeeded, so an action
 * the callee's gate withheld under `propose` — or paused for confirmation and never
 * resolved — contributes no observation, and therefore no artifact. The manifest can only
 * ever describe what genuinely executed under the callee's own trust profile.
 *
 * Pure and total: an empty or all-read input yields `[]`.
 */
export function collectArtifactManifest(effects: readonly ObservedEffect[]): ArtifactRef[] {
  // subject → (relation → latest object). Insertion order does not leak: the result sorts.
  const bySubject = new Map<string, Map<string, unknown>>();
  for (const { observation, effect } of effects) {
    if (effect === "read") continue;
    // `observation` arrives from a tool result — an UNTRUSTED extra channel. The TS type
    // guarantees `facts: ObservedFact[]`, but a host/JS tool implemented outside strict TS
    // can return a truthy-but-malformed observation. This reducer runs at a run's exit, so
    // a throw here would reject the run rather than ignore one bad observation: validate
    // the shape and skip what does not match, never throw. (Same defensiveness as the
    // working-note harvest, applied to the second consumer of the same stream.)
    const facts: unknown = observation?.facts;
    if (!Array.isArray(facts)) continue;
    // Bound the facts PROCESSED per observation, at the same per-call bound the trace
    // recorder and the working-note harvest use: a buggy or JS-hosted tool could return a
    // huge `facts` array, and this runs at the run's exit. `slice` is O(cap), not O(len).
    const bounded =
      facts.length > DEFAULT_MAX_OBSERVATION_FACTS
        ? facts.slice(0, DEFAULT_MAX_OBSERVATION_FACTS)
        : facts;
    for (const fact of bounded) {
      if (fact === null || typeof fact !== "object") continue;
      const { subject, relation, object } = fact as {
        subject?: unknown;
        relation?: unknown;
        object?: unknown;
      };
      if (typeof subject !== "string" || typeof relation !== "string") continue;
      let relations = bySubject.get(subject);
      if (relations === undefined) {
        relations = new Map<string, unknown>();
        bySubject.set(subject, relations);
      }
      relations.set(relation, object);
    }
  }

  // Keyed by the REDACTED reference, so the manifest has one entry per safe artifact. Two
  // raw paths that redact identically collapse (last-wins) — the safe outcome, since they
  // cannot be told apart without the secret they contain.
  const byRef = new Map<string, ArtifactRef>();
  for (const [subject, relations] of bySubject) {
    const parsed = parseSubject(subject);
    if (parsed === undefined) continue;
    const state = resolveState(relations);
    if (state === undefined) continue;
    const path = redactForTrace(parsed.path).content;
    // Skip an artifact whose path redacts to nothing: a malformed or custom observation can
    // carry a whitespace path, or one stripped entirely by control-char/redaction removal.
    // Observations are untrusted tool output, so guard it here rather than emit a reference
    // that points at nothing.
    if (path.trim() === "") continue;
    byRef.set(`${parsed.kind}:${path}`, {
      path,
      kind: parsed.kind,
      exists: state.exists,
      ...(state.sizeBytes !== undefined ? { sizeBytes: state.sizeBytes } : {}),
    });
  }

  const manifest = [...byRef.values()];
  manifest.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );
  return manifest;
}
