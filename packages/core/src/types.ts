// Phase 0 data model — entity types and enums.
//
// The agent is the first-class identity and the isolation boundary. Every
// scoped entity carries an `agentId`; there is no global store any agent can
// reach. The reserved fields `teamId` / `ownerPrincipalId` exist in the schema
// (nullable) but are intentionally absent from these public types — they must
// not be exposed anywhere in Phase 0.

// Each enum has a single source of truth: a `readonly` array of its allowed
// values, with the union type derived from it. The arrays let the persistence
// layer validate untrusted input at the write boundary (a string from the CLI
// or HTTP surface cast to one of these types must still be a real member) so an
// invalid value can never reach a safety-critical path like trust resolution.

export const TRUST_LEVELS = ["propose", "notify", "autonomous"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const RUN_STATUSES = [
  "pending",
  "running",
  "awaiting_confirmation",
  "done",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const MEMORY_TYPES = [
  "semantic",
  "procedural",
  "convention",
  "negative",
  "episodic",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_STATUSES = ["active", "archived"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const REVIEW_STATES = ["proposed", "accepted", "rejected"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/**
 * Assert that `value` is one of `allowed`, returning it narrowed. Throws a clear
 * error otherwise. The single chokepoint for enum validation on the write path —
 * the storage layer never trusts the TypeScript type alone, mirroring how it
 * never trusts application code to remember the `agentId` filter.
 */
export function validateEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `invalid ${label}: ${JSON.stringify(value)} (expected one of: ${allowed.join(", ")})`,
    );
  }
  return value as T;
}

/** The agent identity. `teamId` / `ownerPrincipalId` are reserved and hidden. */
export interface Agent {
  id: string;
  name: string;
  /** One-line responsibility. */
  role: string;
  /** Name or path of the persona config in the SOUL.md lineage. */
  soulRef: string;
  workspaceDir: string;
  trustLevel: TrustLevel;
  createdAt: string;
}

export interface Run {
  id: string;
  agentId: string;
  input: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
}

export interface Memory {
  id: string;
  agentId: string;
  memoryType: MemoryType;
  content: string;
  confidence: number;
  sourceRunId?: string;
  status: MemoryStatus;
  reviewState: ReviewState;
  createdAt: string;
}

export interface Skill {
  id: string;
  agentId: string;
  name: string;
  /** Path to the markdown skill file in the agent's workspace. */
  path: string;
  createdAt: string;
}

export interface Credential {
  id: string;
  agentId: string;
  key: string;
  /** Reference into the local secret store — never the plaintext value. */
  valueRef: string;
  createdAt: string;
}

export interface Event {
  id: string;
  agentId: string;
  runId?: string;
  type: string;
  payload: unknown;
  createdAt: string;
}
