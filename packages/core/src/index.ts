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

// Trust enforcement + the destructive-action gate. The kernel resolves an
// agent's trust level + allow-lists into a scoped, gated tool registry; the
// adapter only ever sees the wrapped tools this produces.
export {
  EFFECT_CLASSES,
  GATE_DECISIONS,
  DESTRUCTIVE_COMMAND_RULES,
  classifyEffect,
  isDestructive,
  matchDestructiveCommand,
  decideGate,
  trustProfile,
  resolveToolRegistry,
} from "./trust";
export type {
  EffectClass,
  GateDecision,
  Capability,
  Action,
  TrustProfile,
  TrustProfileInput,
  TrustHooks,
} from "./trust";

// The memory firewall — screens every inbound memory write for injection /
// exfiltration before persistence. The classifier (`screenMemory`) is pure; the
// memory repository enforces it via `assertMemorySafe` on the write path.
export {
  FIREWALL_CATEGORIES,
  MEMORY_INJECTION_RULES,
  MEMORY_EXFILTRATION_RULES,
  MEMORY_FIREWALL_RULES,
  screenMemory,
  assertMemorySafe,
  MemoryFirewallError,
} from "./firewall";
export type {
  FirewallCategory,
  FirewallRule,
  FirewallFinding,
  FirewallVerdict,
} from "./firewall";

// The local secret store — holds credential plaintext behind a scoped `read`;
// the credentials table stores only the `valueRef` into it.
export { SecretStore, secretValueRef } from "./secrets";
export type { SecretRef } from "./secrets";

// Run framing — composes soul / role / scoped skills / accepted memories into the
// RunRequest's system prompt.
export {
  buildSystemPrompt,
  frameRun,
  resolveSoul,
  BUILTIN_SOULS,
} from "./framing";
export type {
  SkillContext,
  FramingContext,
  FrameRunInput,
  ResolveSoulOptions,
} from "./framing";

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
