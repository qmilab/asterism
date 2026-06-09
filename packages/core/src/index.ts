// @qmilab/asterism-core — the kernel.
// Phase 0: entity types and agent-scoped SQLite persistence. The agent is the
// isolation boundary; every scoped repository asserts an agentId.

export * from "./types.js";

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
} from "./adapter.js";
export { createToolRegistry } from "./adapter.js";

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
} from "./trust.js";
export type {
  EffectClass,
  GateDecision,
  Capability,
  Action,
  TrustProfile,
  TrustProfileInput,
  TrustHooks,
} from "./trust.js";

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
} from "./firewall.js";
export type {
  FirewallCategory,
  FirewallRule,
  FirewallFinding,
  FirewallVerdict,
} from "./firewall.js";

// The local secret store — holds credential plaintext behind a scoped `read`;
// the credentials table stores only the `valueRef` into it.
export { SecretStore, secretValueRef } from "./secrets.js";
export type { SecretRef } from "./secrets.js";

// The ReflectionProvider contract — the kernel/reflection seam. Core defines it
// (transcript in → proposed typed memory writes out) and depends on no model
// client; the default hosted-model provider lives in `@qmilab/asterism-reflect`.
export {
  REFLECTION_MEMORY_TYPES,
  isReflectionMemoryType,
} from "./reflection.js";
export type {
  ReflectionMemoryType,
  RunTranscript,
  ReflectionInput,
  ProposedMemory,
  ReflectionProvider,
} from "./reflection.js";

// Run framing — composes soul / role / scoped skills / accepted memories into the
// RunRequest's system prompt.
export {
  buildSystemPrompt,
  frameRun,
  resolveSoul,
  BUILTIN_SOULS,
} from "./framing.js";
export type {
  SkillContext,
  FramingContext,
  FrameRunInput,
  ResolveSoulOptions,
} from "./framing.js";

// Run orchestration — the kernel's execute-a-run flow (start → trust-resolve +
// gate → frame → substrate → persist outcome), shared by every surface so the
// trust/gate path can never drift between the CLI and the HTTP endpoint.
export { executeRun } from "./run.js";
export type { ExecuteRunOptions, ExecuteRunResult } from "./run.js";

// The audit bridge — turns trust-gate decisions into append-only events. The
// kernel's run-orchestration surfaces compose this around their own hooks.
export { auditTrustHooks } from "./audit.js";
export type { AuditContext } from "./audit.js";

export { AsterismStore } from "./store.js";
export { openDatabase } from "./db/index.js";
export type { SqlDriver, SqlStatement, SqlRow, SqlValue } from "./db/driver.js";

export { AgentRepository } from "./repositories/agents.js";
export type { CreateAgentInput } from "./repositories/agents.js";
export { RunRepository } from "./repositories/runs.js";
export type { CreateRunInput } from "./repositories/runs.js";
export { MemoryRepository } from "./repositories/memories.js";
export type { CreateMemoryInput } from "./repositories/memories.js";
export { SkillRepository } from "./repositories/skills.js";
export type { CreateSkillInput } from "./repositories/skills.js";
export { CredentialRepository } from "./repositories/credentials.js";
export type { CreateCredentialInput } from "./repositories/credentials.js";
export { EventRepository } from "./repositories/events.js";
export type { AppendEventInput, TailOptions } from "./repositories/events.js";
