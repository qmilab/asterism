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

import type { MemoryType } from "./types.js";

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
