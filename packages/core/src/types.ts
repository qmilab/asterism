// Phase 0 data model — entity types and enums.
//
// The agent is the first-class identity and the isolation boundary. Every
// scoped entity carries an `agentId`; there is no global store any agent can
// reach. The reserved fields `teamId` / `ownerPrincipalId` exist in the schema
// (nullable) but are intentionally absent from these public types — they must
// not be exposed anywhere in Phase 0.

export type TrustLevel = "propose" | "notify" | "autonomous";

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_confirmation"
  | "done"
  | "failed";

export type MemoryType =
  | "semantic"
  | "procedural"
  | "convention"
  | "negative"
  | "episodic";

export type MemoryStatus = "active" | "archived";

export type ReviewState = "proposed" | "accepted" | "rejected";

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
