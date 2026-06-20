// Run framing — how an agent's identity becomes the way a run is posed.
//
// A run is not just a task string handed to the substrate. The kernel frames it:
// it composes the agent's ROLE (its one-line responsibility), its SOUL (the
// persona config in the SOUL.md lineage — tone, values, operating style), the
// markdown SKILLS scoped to it, and the MEMORIES it has accepted, into the system
// prompt of a `RunRequest`. That request, together with the trust-resolved tool
// registry, is the entire surface the adapter sees.
//
// This is the consumption point for two scoped stores. Memory and skills are
// written under one agentId and read back here under the same agentId; because
// the caller passes already-scoped rows (from `store.memories.list(agentId)` /
// `store.skills.list(agentId)`), one agent's framing can only ever contain its
// own data. Cross-agent leakage would require querying the store wrong, which the
// repositories already forbid.
//
// Soul is kept minimal — no DSL. A soul is resolved to a short block of persona
// text (a named built-in, or a file the workspace owns); the framing simply
// places it. `buildSystemPrompt` is pure and deterministic so it is trivially
// testable; `frameRun` assembles the full `RunRequest`.

import type { RunRequest, ToolRegistry } from "./adapter.js";
import type { Agent, Memory, Objective } from "./types.js";

/**
 * A skill made available to a run: its name and, when loaded, the markdown body.
 * The body is optional — framing can list a skill by name without inlining its
 * full text (the agent can open the file in its workspace), or inline it when the
 * caller has read it. Either way the skill is one the agent owns.
 */
export interface SkillContext {
  name: string;
  content?: string;
}

/** Inputs to {@link buildSystemPrompt}. All scoped data must already belong to `agent`. */
export interface FramingContext {
  agent: Agent;
  /** Resolved persona text for `agent.soulRef`; falls back to a reference line if absent. */
  soulText?: string;
  /** The agent's scoped skills. */
  skills?: readonly SkillContext[];
  /** The agent's scoped memories (filtered to active + accepted before use). */
  memories?: readonly Memory[];
  /** The agent's scoped standing objectives (filtered to `active` before use). */
  objectives?: readonly Objective[];
}

/**
 * A memory only frames a run when it is BOTH `active` and `accepted`. Proposed
 * memories (awaiting human review), rejected ones, and archived ones must never
 * shape behaviour — this is what makes reflection's accept/reject meaningful and
 * keeps an unreviewed proposal from acting as a backdoor injection.
 */
function isFramable(memory: Memory): boolean {
  return memory.status === "active" && memory.reviewState === "accepted";
}

// A stable order so the same inputs always produce the same prompt (tests + cache
// friendliness). Memories are grouped by type in this order.
const MEMORY_TYPE_ORDER = [
  "convention",
  "procedural",
  "semantic",
  "negative",
  "episodic",
] as const;

/**
 * Compose the agent's identity, soul, skills, and accepted memories into a single
 * system-prompt string. Pure and deterministic: no clock, no store, no I/O. Only
 * framable memories are included; sections with nothing to say are omitted.
 */
export function buildSystemPrompt(ctx: FramingContext): string {
  const { agent } = ctx;
  const sections: string[] = [];

  // Identity — name + role, always present.
  sections.push(`You are ${agent.name}.\nYour role: ${agent.role}`);

  // Soul — resolved persona text, or a reference line when it could not be loaded.
  const soul = ctx.soulText?.trim();
  sections.push(
    soul && soul.length > 0
      ? `Your character and operating style:\n${soul}`
      : `Your character is defined by the soul "${agent.soulRef}".`,
  );

  // Objectives — the agent's standing purpose, placed high (right after who it is,
  // before skills/memory) because it is what shapes everything the run is for. Only
  // `active` objectives frame a run — `done`/`dropped` ones must never shape
  // behaviour, the same "only the live subset frames a run" rule memory's
  // active+accepted predicate enforces. Input order is preserved (the caller passes
  // them oldest-first); the section is omitted entirely when none are active.
  const objectives = (ctx.objectives ?? []).filter((o) => o.status === "active");
  if (objectives.length > 0) {
    const lines = objectives.map((o) => `- ${o.content}`);
    sections.push(`Your standing objectives:\n${lines.join("\n")}`);
  }

  // Skills — names always; bodies inlined when provided.
  const skills = ctx.skills ?? [];
  if (skills.length > 0) {
    const lines = skills.map((s) => {
      const body = s.content?.trim();
      return body && body.length > 0
        ? `### ${s.name}\n${body}`
        : `- ${s.name}`;
    });
    sections.push(`Skills available to you:\n${lines.join("\n")}`);
  }

  // Memory — only active + accepted, grouped by type in a stable order.
  const framable = (ctx.memories ?? []).filter(isFramable);
  if (framable.length > 0) {
    const byType = framable.slice().sort((a, b) => {
      const ai = MEMORY_TYPE_ORDER.indexOf(a.memoryType as never);
      const bi = MEMORY_TYPE_ORDER.indexOf(b.memoryType as never);
      return ai - bi;
    });
    const lines = byType.map((m) => `- (${m.memoryType}) ${m.content}`);
    sections.push(`What you remember:\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

/** Inputs to {@link frameRun}: the framing context plus the run's task and tools. */
export interface FrameRunInput extends FramingContext {
  /** The task to perform. */
  input: string;
  /** The trust-resolved, pre-scoped tool registry for this run. */
  tools: ToolRegistry;
  /** Cooperative cancellation for the run (the same controller the gate may abort). */
  signal?: AbortSignal;
}

/**
 * Assemble the {@link RunRequest} the kernel hands the adapter: the agent's
 * confined workspace, the framed system prompt, the task, and the scoped tools.
 * No store, no credential reader, no memory writer cross this seam — the request
 * shape itself denies them. Optional fields are spread conditionally to satisfy
 * `exactOptionalPropertyTypes`.
 */
export function frameRun(input: FrameRunInput): RunRequest {
  const systemPrompt = buildSystemPrompt(input);
  return {
    workspaceDir: input.agent.workspaceDir,
    input: input.input,
    tools: input.tools,
    systemPrompt,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
}

// ---------------------------------------------------------------------------
// Soul resolution — minimal: named built-ins, else a file the caller reads.
// ---------------------------------------------------------------------------

/**
 * A few built-in souls keyed by name (the ones the canonical demo uses). Persona
 * text only — tone and operating style, no architecture or product vocabulary.
 * An agent's `soulRef` that is not a built-in name is treated as a path the
 * caller resolves via the optional reader in {@link resolveSoul}.
 */
export const BUILTIN_SOULS: Readonly<Record<string, string>> = {
  "casual-helper":
    "Warm, direct, and informal. You get to the point, prefer doing over " +
    "discussing, and explain only as much as is useful. You sweat the small " +
    "stuff so the person doesn't have to.",
  "careful-consultant":
    "Measured, precise, and conservative. You think before you act, surface " +
    "risks and trade-offs plainly, and prefer to propose a plan over making an " +
    "irreversible change unasked. You would rather ask than assume.",
};

/** Options for {@link resolveSoul}: a reader for path-based souls. */
export interface ResolveSoulOptions {
  /** Reads a soul file's text given its path. Omit to resolve built-ins only. */
  readFile?: (path: string) => string;
}

/**
 * Resolve an agent's `soulRef` to its persona text. A built-in name wins; failing
 * that, if a `readFile` is provided the ref is treated as a path and read;
 * otherwise resolution yields `undefined` and framing falls back to a reference
 * line. Kept dependency-free (no `node:fs` import) so `core` stays runtime-light
 * and the resolver is trivially testable — the CLI supplies a real reader.
 */
export function resolveSoul(
  soulRef: string,
  options: ResolveSoulOptions = {},
): string | undefined {
  // Own-property check, not bracket access: a `soulRef` that names an inherited
  // property (`toString`, `__proto__`, `constructor`) must NOT resolve to the
  // inherited value — that would hand framing a non-string and crash `.trim()`.
  if (Object.hasOwn(BUILTIN_SOULS, soulRef)) return BUILTIN_SOULS[soulRef];
  if (options.readFile) {
    try {
      return options.readFile(soulRef);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
