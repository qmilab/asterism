// Trust enforcement + the destructive-action gate — the kernel's safety core.
//
// The kernel never hands the substrate a raw capability. Instead it resolves an
// agent's trust level and capability allow-list into a *pre-scoped* tool
// registry whose `execute` closures embed the gate. By the time a tool reaches
// the adapter, the policy has already been baked in: the adapter merely calls
// `execute` and gets back a result that may be the action's output, a withheld
// plan, or an "awaiting confirmation" pause. "Pi never sees raw capability."
//
// Two ideas live here, kept deliberately separate:
//
//   1. CLASSIFICATION — what is the effect of an action? `read` (no side
//      effect), `write` (side-effecting but ordinary), or `destructive`
//      (irreversible / dangerous, per the CLAUDE.md taxonomy). This is an
//      explicit, testable function, never a vibe.
//
//   2. DECISION — given a trust profile and a classified action, do we execute,
//      withhold (return a plan), or pause for confirmation? The destructive
//      override fires identically at `notify` and `autonomous`: a destructive
//      action confirms regardless of trust level unless that specific capability
//      is explicitly allow-listed for the agent.
//
// Nothing here imports Pi or any adapter. Core owns the policy; the adapter only
// ever sees the wrapped tools this module produces.

import type {
  ScopedTool,
  ToolInvocation,
  ToolRegistry,
  ToolResult,
} from "./adapter";
import { createToolRegistry } from "./adapter";
import type { TrustLevel } from "./types";
import { TRUST_LEVELS, validateEnum } from "./types";

/**
 * The effect an action has on the world.
 * - `read`        — no side effect; always safe to run.
 * - `write`       — side-effecting but ordinary (create a file, a plain network
 *                   GET). Blocked only by the `propose` level.
 * - `destructive` — irreversible / dangerous (see the taxonomy below). Requires
 *                   explicit confirmation at *every* trust level unless the
 *                   capability is allow-listed for the agent.
 */
export const EFFECT_CLASSES = ["read", "write", "destructive"] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

/**
 * A capability the kernel may expose to an agent: a scoped tool plus the effect
 * metadata the gate reasons about. `key` is the stable identifier used for both
 * exposure allow-listing and the destructive override (it must match the keys in
 * a `TrustProfile`). `effect` is the capability's *declared base* effect; the
 * classifier may escalate a specific invocation to `destructive` based on its
 * arguments (a generic shell tool running `git reset --hard`), but never
 * de-escalates below what is declared.
 */
export interface Capability {
  key: string;
  effect: EffectClass;
  tool: ScopedTool;
}

/**
 * A single action under evaluation: which capability, its declared base effect,
 * and the arguments the model produced (for argument-level classification).
 */
export interface Action {
  capability: string;
  effect: EffectClass;
  args?: unknown;
}

// ---------------------------------------------------------------------------
// 1. Destructive classification — explicit, testable, "never a vibe".
// ---------------------------------------------------------------------------

/**
 * The canonical destructive-command taxonomy from CLAUDE.md, as named patterns.
 * A capability whose specific *arguments* match one of these is escalated to
 * `destructive` even if it was declared `read`/`write` — this is how one generic
 * `shell`/`exec` tool can run safe commands freely yet still trip the gate on
 * `git reset --hard`. Each rule is named so a test can assert it individually.
 *
 * Note: irreversible *external* actions (payment, email send, public post,
 * production deploy) and credential reads are not detected from a command string
 * — they are purpose-built capabilities the kernel registers with
 * `effect: "destructive"` directly. This table covers the in-shell cases a
 * single declared effect cannot capture.
 */
export const DESTRUCTIVE_COMMAND_RULES: readonly {
  readonly name: string;
  readonly pattern: RegExp;
}[] = [
  // Deleting / overwriting / renaming / moving user files.
  { name: "file removal (rm)", pattern: /\brm\b/ },
  { name: "directory removal (rmdir)", pattern: /\brmdir\b/ },
  { name: "file move/rename (mv)", pattern: /\bmv\b/ },
  // A truncating `>` redirect, but not append (`>>`) or fd-duplication (`2>&1`).
  { name: "truncating redirect (>)", pattern: /[^|>&]>(?![>&])/ },
  // Destructive git history / remote operations.
  { name: "git reset --hard", pattern: /\bgit\s+reset\b[^\n]*--hard\b/ },
  { name: "git force-push", pattern: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/ },
  { name: "git branch delete", pattern: /\bgit\s+branch\b[^\n]*(\s-D\b|\s-d\b|--delete\b)/ },
  { name: "git rebase (history rewrite)", pattern: /\bgit\s+rebase\b/ },
  { name: "git clean (delete untracked)", pattern: /\bgit\s+clean\b/ },
  // Running install / untrusted shell scripts.
  { name: "package install script", pattern: /\b(npm|pnpm|yarn|bun|pip|pip3|gem|cargo|brew)\s+(install|add|i)\b/ },
  { name: "piped remote shell (curl|wget → sh)", pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/ },
] as const;

/**
 * Extract a candidate command string from an action's arguments. The kernel does
 * not assume a single tool shape: it inspects the common `command` / `cmd` /
 * `script` fields and falls back to a string argument. Returns `undefined` when
 * there is nothing string-like to scan.
 */
function commandText(args: unknown): string | undefined {
  if (typeof args === "string") return args;
  if (args !== null && typeof args === "object") {
    const record = args as Record<string, unknown>;
    for (const field of ["command", "cmd", "script", "argv"] as const) {
      const value = record[field];
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(String).join(" ");
    }
  }
  return undefined;
}

/**
 * Does this action's command string match a destructive pattern? Exposed for
 * direct testing of the taxonomy. Anything that cannot be parsed into a command
 * string is *not* escalated here (the declared effect still governs).
 */
export function matchDestructiveCommand(args: unknown): string | undefined {
  const command = commandText(args);
  if (command === undefined) return undefined;
  for (const rule of DESTRUCTIVE_COMMAND_RULES) {
    if (rule.pattern.test(command)) return rule.name;
  }
  return undefined;
}

/**
 * The kernel's single classification chokepoint. Returns the *effective* effect
 * class of an action: the declared base effect, escalated to `destructive` when
 * the arguments match the destructive-command taxonomy. Escalation only — a
 * declared `destructive` capability is never softened. When in doubt the
 * taxonomy errs toward `destructive` (CLAUDE.md golden rule 4).
 */
export function classifyEffect(action: Action): EffectClass {
  if (action.effect === "destructive") return "destructive";
  if (matchDestructiveCommand(action.args) !== undefined) return "destructive";
  return action.effect;
}

/** Convenience predicate over {@link classifyEffect}. */
export function isDestructive(action: Action): boolean {
  return classifyEffect(action) === "destructive";
}

// ---------------------------------------------------------------------------
// 2. Trust profile + decision.
// ---------------------------------------------------------------------------

/**
 * The resolved policy for one agent's run. Built from the agent's `trustLevel`
 * plus two allow-lists, each defaulting to empty for a confined-by-default
 * posture:
 *
 * - `capabilities` — EXPOSURE: which capability keys appear in the registry at
 *   all. A capability absent from this set is never handed to the substrate.
 *   Empty ⇒ the agent gets no tools.
 * - `autoApprove`  — DESTRUCTIVE OVERRIDE: which destructive capabilities this
 *   specific agent may run *without* per-action confirmation. This is the "unless
 *   that specific capability is explicitly allow-listed" escape hatch. Empty ⇒
 *   every destructive action pauses for confirmation, even at `autonomous`.
 */
export interface TrustProfile {
  level: TrustLevel;
  capabilities: ReadonlySet<string>;
  autoApprove: ReadonlySet<string>;
}

/** Inputs for {@link trustProfile}; allow-lists accept any iterable for ergonomics. */
export interface TrustProfileInput {
  level: TrustLevel;
  capabilities?: Iterable<string>;
  autoApprove?: Iterable<string>;
}

/**
 * Build a validated {@link TrustProfile}. The trust level is run through the same
 * enum chokepoint the persistence layer uses, so a bad string from a surface can
 * never reach a policy decision. Both allow-lists default to empty (confined by
 * default).
 */
export function trustProfile(input: TrustProfileInput): TrustProfile {
  validateEnum(input.level, TRUST_LEVELS, "trustLevel");
  return {
    level: input.level,
    capabilities: new Set(input.capabilities ?? []),
    autoApprove: new Set(input.autoApprove ?? []),
  };
}

/**
 * The gate's verdict for one action:
 * - `execute` — perform it now.
 * - `withhold` — do not perform; return a plan/diff instead (the `propose`
 *   level's whole contract: it never executes a side effect).
 * - `confirm` — do not perform; a destructive action requires explicit human
 *   confirmation first. Surfaces as a `Run` status of `awaiting_confirmation`.
 */
export const GATE_DECISIONS = ["execute", "withhold", "confirm"] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

/**
 * Resolve a trust profile + a (pre-classified) action into a gate decision. This
 * is the policy, in one place:
 *
 *   - A destructive action (not allow-listed) NEVER silently executes. At
 *     `propose` it is withheld like any side effect; at `notify`/`autonomous` it
 *     pauses for confirmation. The override is independent of trust level — an
 *     `autonomous` agent still stops here. (Golden rule 4.)
 *   - A destructive action whose capability IS allow-listed for this agent is
 *     treated as an ordinary side effect: withheld under `propose`, executed
 *     otherwise.
 *   - A `read` always executes.
 *   - A `write` executes unless the level is `propose`, which withholds every
 *     side effect.
 */
export function decideGate(profile: TrustProfile, action: Action): GateDecision {
  const effect = classifyEffect(action);
  const sideEffecting = effect !== "read";

  if (effect === "destructive" && !profile.autoApprove.has(action.capability)) {
    // propose withholds everything anyway; the destructive flag would only
    // matter once a human ran the plan, so withhold dominates here.
    return profile.level === "propose" ? "withhold" : "confirm";
  }

  if (sideEffecting && profile.level === "propose") return "withhold";
  return "execute";
}

// ---------------------------------------------------------------------------
// 3. Resolution — wrap capabilities into a scoped, gated tool registry.
// ---------------------------------------------------------------------------

/**
 * Side channels the kernel wires around the gate. All are optional; their absence
 * yields the safe default (a destructive action pauses and is never auto-run).
 * Handlers receive the {@link Action}, which carries `args` — a handler that
 * persists to the event log MUST record references only, never `args` verbatim
 * (the event log stores references, never values).
 */
export interface TrustHooks {
  /** An action is about to execute. The `notify`/`autonomous` surfacing + audit point. */
  onExecute?: (action: Action) => void;
  /** A side-effecting action was withheld under `propose` (recorded as a plan step). */
  onWithhold?: (action: Action) => void;
  /**
   * A destructive action requires confirmation. The kernel transitions the run
   * to `awaiting_confirmation` here.
   */
  onAwaitConfirmation?: (action: Action) => void;
  /**
   * Optional confirmation resolver for destructive actions. When provided and it
   * resolves truthy, the withheld destructive action proceeds to execute; when
   * absent or falsy, the action stays paused (the default — Asterism never
   * auto-approves a destructive action on the agent's behalf). This is the seam
   * a CLI/HTTP surface uses to ask the human and resume.
   */
  confirm?: (action: Action) => boolean | Promise<boolean>;
}

/** ToolResult shown to the model when a side effect is withheld under `propose`. */
function withheldResult(capability: string): ToolResult {
  return {
    output:
      `[proposed] '${capability}' was not executed (trust level: propose). ` +
      `The intended action has been recorded as a plan step for human review.`,
    isError: false,
  };
}

/** ToolResult shown to the model when a destructive action awaits confirmation. */
function awaitingConfirmationResult(capability: string): ToolResult {
  return {
    output:
      `[awaiting confirmation] '${capability}' is a destructive action and ` +
      `requires explicit human confirmation before it can run. It has not been executed.`,
    isError: false,
  };
}

/**
 * Wrap one capability's `execute` so the gate runs on every invocation. The
 * returned tool is structurally a {@link ScopedTool}; the adapter cannot tell it
 * from an ungated one, which is the point — the policy is invisible and
 * unavoidable on the far side of the boundary.
 */
function gateTool(
  profile: TrustProfile,
  capability: Capability,
  hooks: TrustHooks,
): ScopedTool {
  const { tool } = capability;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (
      invocation: ToolInvocation,
      signal?: AbortSignal,
    ): Promise<ToolResult> => {
      const action: Action = {
        capability: capability.key,
        effect: capability.effect,
        ...(invocation.args !== undefined ? { args: invocation.args } : {}),
      };
      const decision = decideGate(profile, action);

      if (decision === "withhold") {
        hooks.onWithhold?.(action);
        return withheldResult(capability.key);
      }

      if (decision === "confirm") {
        hooks.onAwaitConfirmation?.(action);
        const approved = hooks.confirm ? await hooks.confirm(action) : false;
        if (!approved) return awaitingConfirmationResult(capability.key);
        // Explicitly confirmed: fall through to execute. The audit hook still
        // fires so the now-permitted destructive action is recorded.
      }

      hooks.onExecute?.(action);
      return tool.execute(invocation, signal);
    },
  };
}

/**
 * Resolve a trust profile + the run's candidate capabilities into the scoped
 * tool registry the kernel hands the adapter. Two things happen:
 *
 *   1. EXPOSURE FILTER — only capabilities whose `key` is in
 *      `profile.capabilities` survive. Confined by default: an empty allow-list
 *      yields an empty registry.
 *   2. GATING — each surviving capability's `execute` is wrapped with the
 *      destructive-action gate keyed off the profile.
 *
 * The result is a frozen, independent {@link ToolRegistry} (via
 * `createToolRegistry`): the substrate can neither grow the set nor widen a
 * schema, and the gate cannot be unwrapped from outside the closure.
 */
export function resolveToolRegistry(
  profile: TrustProfile,
  capabilities: readonly Capability[],
  hooks: TrustHooks = {},
): ToolRegistry {
  const exposed = capabilities.filter((cap) =>
    profile.capabilities.has(cap.key),
  );
  return createToolRegistry(exposed.map((cap) => gateTool(profile, cap, hooks)));
}
