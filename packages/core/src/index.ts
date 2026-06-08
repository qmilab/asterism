// @qmilab/asterism-core — the kernel.
// Phase 0: entity types and agent-scoped SQLite persistence. The agent is the
// isolation boundary; every scoped repository asserts an agentId.

export * from "./types";

// The RuntimeAdapter contract — the kernel/substrate seam. Core defines it and
// depends on no adapter and no Pi; adapters depend on core and implement it.
export type {
  RuntimeAdapter,
  RunRequest,
  RunHandle,
  RunEvent,
  RunOutput,
  RunResultStatus,
  ToolRegistry,
  ScopedTool,
  ToolInvocation,
  ToolResult,
  ToolInputSchema,
} from "./adapter";
export { createToolRegistry } from "./adapter";

export { AsterismStore } from "./store";
export { openDatabase } from "./db/index";
export type { SqlDriver, SqlStatement, SqlRow, SqlValue } from "./db/driver";

export { AgentRepository } from "./repositories/agents";
export type { CreateAgentInput } from "./repositories/agents";
export { RunRepository } from "./repositories/runs";
export type { CreateRunInput } from "./repositories/runs";
export { MemoryRepository } from "./repositories/memories";
export type { CreateMemoryInput } from "./repositories/memories";
export { SkillRepository } from "./repositories/skills";
export type { CreateSkillInput } from "./repositories/skills";
export { CredentialRepository } from "./repositories/credentials";
export type { CreateCredentialInput } from "./repositories/credentials";
export { EventRepository } from "./repositories/events";
export type { AppendEventInput } from "./repositories/events";
