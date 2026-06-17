// Reflection — the kernel's contract for turning a finished run into PROPOSED,
// human-reviewable memory.
//
// Core defines the interface and the data shapes; it depends on NO model client.
// The default provider (a hosted model) lives in `@qmilab/asterism-reflect`, the
// only package permitted to import a reflection model client — exactly the seam
// the RuntimeAdapter/adapter-pi split uses to keep the substrate replaceable.
//
// Two invariants live here, in the contract, not in any provider:
//
//   1. Reflection only ever PROPOSES. Nothing in this interface persists memory.
//      A `ReflectionProvider` returns proposals; whether any of them becomes a
//      real memory is the reviewer's decision, gated by the human AND the memory
//      firewall on the write path (see the CLI's `reflect --review`). A provider
//      that wrote memory directly would be a bug, not an implementation choice —
//      the return type gives it nowhere to write.
//
//   2. Proposals are limited to the four DURABLE memory types. `episodic` is a
//      record of what happened, not a learned lesson, so reflection never proposes
//      it (a Phase 0 constraint). The subset is checked against `MemoryType` at
//      compile time so the two can never drift.

import type { Agent, MemoryType } from "./types.js";
import type { AsterismStore } from "./store.js";
import { screenMemory } from "./firewall.js";
import type { FirewallFinding } from "./firewall.js";

/**
 * The memory types reflection may propose — the durable, behaviour-shaping kinds.
 * Deliberately excludes `episodic`. `satisfies readonly MemoryType[]` makes this a
 * compile-time-checked subset of the canonical {@link MemoryType} set.
 */
export const REFLECTION_MEMORY_TYPES = [
  "semantic",
  "procedural",
  "convention",
  "negative",
] as const satisfies readonly MemoryType[];

export type ReflectionMemoryType = (typeof REFLECTION_MEMORY_TYPES)[number];

/** Whether `value` is one of the four memory types reflection is allowed to propose. */
export function isReflectionMemoryType(
  value: string,
): value is ReflectionMemoryType {
  return (REFLECTION_MEMORY_TYPES as readonly string[]).includes(value);
}

/**
 * A finished run reduced to what reflection reads: the task it was given and the
 * agent's final output. Phase 0 deliberately does NOT carry the full tool-call
 * trajectory — that is trajectory export, out of scope — so reflection learns from
 * the task and the result, not from a replay of every step.
 */
export interface RunTranscript {
  /** The run this transcript belongs to; every proposal is attributed back to it. */
  runId: string;
  /** The task the run was given. */
  input: string;
  /** The agent's final output text for the run. */
  output: string;
}

/** What the kernel hands a {@link ReflectionProvider} to reflect on. */
export interface ReflectionInput {
  /** The agent whose run this was — every resulting proposal is scoped to it. */
  agentId: string;
  /** The run to learn from. */
  transcript: RunTranscript;
  /**
   * Contents of memories the agent already holds, so a provider can avoid
   * re-proposing what is already known. Advisory only — the human review step is
   * the real gate, not this hint. Optional.
   */
  knownMemories?: readonly string[];
}

/**
 * A single proposed memory write. A provider produces these; it never persists
 * them. `confidence` is the provider's own estimate in [0, 1]; `sourceRunId` ties
 * the proposal back to the run it was learned from (it becomes the memory's
 * `sourceRunId` if a human accepts it).
 */
export interface ProposedMemory {
  memoryType: ReflectionMemoryType;
  content: string;
  confidence: number;
  sourceRunId: string;
}

/**
 * Turns a run transcript into PROPOSED typed memory writes. The default
 * implementation drives a hosted model and lives in `@qmilab/asterism-reflect`;
 * core depends on no model client, mirroring the RuntimeAdapter seam. Returns a
 * read-only list so a caller can never mistake the result for a writable store.
 */
export interface ReflectionProvider {
  reflect(input: ReflectionInput): Promise<readonly ProposedMemory[]>;
}

/**
 * A proposed memory readied for human review: the provider's proposal plus the
 * memory firewall's findings on its content (empty when it screens clean). The
 * findings are advisory — for the reviewer to see WHAT tripped a rule — the hard
 * gate is the firewall re-screen at persistence (`store.recordMemory`).
 */
export interface ReviewableProposal extends ProposedMemory {
  findings: readonly FirewallFinding[];
}

/**
 * The outcome of {@link proposeReviewableMemories}:
 * - `proposed` — a reflectable run was found and the provider returned proposals
 *   (possibly an empty list); `ignored` counts proposals dropped for a
 *   non-reviewable memory type.
 * - `no_run`   — the agent has no completed run with output to reflect on (or the
 *   requested run has none), so nothing was sent to the provider.
 */
export type ProposeResult =
  | { kind: "proposed"; runId: string; proposals: ReviewableProposal[]; ignored: number }
  | { kind: "no_run" };

/**
 * The reflect-proposal pipeline, shared by every surface that reviews memory (the
 * CLI's `reflect --review` and the dashboard's console endpoint) so they can never
 * drift on WHAT is reviewable. It selects the run to learn from (a given `runId`, or
 * the agent's latest run with output), hands the transcript and the agent's already-
 * known memories to the provider, then applies the two kernel policies: the
 * reflection-only type filter ({@link isReflectionMemoryType}) and a memory-firewall
 * screen of each proposal for display.
 *
 * It only ever PROPOSES — nothing is persisted here (that is the reviewer's accept,
 * through `store.recordMemory`, where the firewall re-screens as the real gate). The
 * provider's own errors propagate to the caller, which owns how to report them.
 */
export async function proposeReviewableMemories(
  store: AsterismStore,
  agent: Agent,
  provider: ReflectionProvider,
  options: { runId?: string } = {},
): Promise<ProposeResult> {
  const target =
    options.runId !== undefined
      ? store.runs.get(agent.id, options.runId)
      : store.runs.latestWithOutput(agent.id);
  // Both paths require NON-BLANK output: `latestWithOutput` already filters on it, and
  // an explicit `runId` must meet the same bar — a run that finished with empty or
  // whitespace-only output has nothing to learn from, so the provider is never run on
  // an empty transcript.
  if (!target || target.output === undefined || target.output.trim().length === 0) {
    return { kind: "no_run" };
  }

  const transcript = { runId: target.id, input: target.input, output: target.output };
  const knownMemories = store.memories.listActiveAccepted(agent.id).map((m) => m.content);
  const raw = await provider.reflect({ agentId: agent.id, transcript, knownMemories });

  // Reflection-only types are a kernel constraint, enforced at the consumption point:
  // a non-conforming custom provider must never slip a disallowed type (e.g.
  // `episodic`) into review, since `recordMemory` would otherwise accept it.
  const usable = raw.filter((p) => isReflectionMemoryType(p.memoryType));
  const proposals = usable.map((p) => ({ ...p, findings: screenMemory(p.content).findings }));
  return { kind: "proposed", runId: target.id, proposals, ignored: raw.length - usable.length };
}
