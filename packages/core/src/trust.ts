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

import { createHmac } from "node:crypto";

import type {
  ScopedTool,
  ToolInvocation,
  ToolRegistry,
  ToolResult,
} from "./adapter.js";
import { createToolRegistry } from "./adapter.js";
import type { TrustLevel } from "./types.js";
import { TRUST_LEVELS, validateEnum } from "./types.js";

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
 *
 * SCOPE — this is a best-effort *denylist over arbitrary shell strings*, not the
 * primary safety boundary. Arbitrary shell is unbounded: equivalent destructive
 * effects can always be re-expressed (`python -c "open(p,'w')"`, `perl -e`,
 * `busybox rm`, base64-decode-then-pipe, env-var indirection, an unlisted
 * binary). Treat the two real guarantees as primary: (1) purpose-built
 * capabilities declare `effect: "destructive"` so they never rely on
 * string-matching, and (2) the trust profile's exposure allow-list decides
 * whether a raw `shell`/`exec` tool is handed to the agent at all. These
 * patterns are defense-in-depth for the case where one *is* exposed — extend the
 * table when a common form is missed, but do not mistake it for a sandbox.
 */
// Many CLIs accept global options between the executable and the subcommand
// (`git -C <path> reset …`, `git -c k=v …`, `npm --prefix web install`,
// `pip --disable-pip-version-check install …`). A run of such option tokens
// (each optionally taking one non-flag argument) must not let a destructive
// subcommand slip past the gate. This fragment matches that leading run.
const LEADING_OPTS = "(?:\\s+-\\S+(?:\\s+[^-\\s]\\S*)?)*";

export const DESTRUCTIVE_COMMAND_RULES: readonly {
  readonly name: string;
  readonly pattern: RegExp;
}[] = [
  // Deleting / overwriting / renaming / moving user files.
  { name: "file removal (rm)", pattern: /\brm\b/ },
  { name: "directory removal (rmdir)", pattern: /\brmdir\b/ },
  { name: "file move/rename (mv)", pattern: /\bmv\b/ },
  // Commands that overwrite/clobber file contents without a `>` redirect.
  // `cp` overwrites its destination by default, `dd` and `truncate` rewrite in
  // place. `tee` writes to a file too — flagged unless it is appending (`-a`).
  { name: "file overwrite (cp/dd/truncate)", pattern: /\b(cp|dd|truncate)\b/ },
  { name: "tee overwrite (no --append)", pattern: /\btee\b(?![^\n]*(?:\s-a\b|--append\b))/ },
  // A truncating `>` redirect, including one that opens the command (`> file`)
  // or Bash's combined `&>` form. Excludes append (`>>`, `&>>`) and
  // fd-duplication (`2>&1`) — both handled by the trailing `(?![>&])`.
  { name: "truncating redirect (>)", pattern: /(?:^|[^|>])>(?![>&])/ },
  // Destructive git history / remote operations. `LEADING_OPTS` tolerates
  // global options (e.g. `-C repo`) before the subcommand.
  { name: "git reset --hard", pattern: new RegExp(`\\bgit${LEADING_OPTS}\\s+reset\\b[^\\n]*--hard\\b`) },
  // Force push via flag (`--force`/`--force-with-lease`/`-f`) or a leading-`+`
  // refspec (`git push origin +main`, `git push origin +HEAD:main`).
  { name: "git force-push", pattern: new RegExp(`\\bgit${LEADING_OPTS}\\s+push\\b[^\\n]*(--force\\b|--force-with-lease\\b|\\s-f\\b|\\s\\+\\S)`) },
  { name: "git branch delete", pattern: new RegExp(`\\bgit${LEADING_OPTS}\\s+branch\\b[^\\n]*(\\s-D\\b|\\s-d\\b|--delete\\b)`) },
  // Remote branch deletion: `git push … --delete branch`, `git push … -d branch`,
  // or the colon refspec `git push origin :branch` (space before the colon, so a
  // normal `src:dst` push is not flagged).
  { name: "git push --delete (remote branch)", pattern: new RegExp(`\\bgit${LEADING_OPTS}\\s+push\\b[^\\n]*(--delete\\b|\\s-d\\b|\\s:)`) },
  { name: "git rebase (history rewrite)", pattern: new RegExp(`\\bgit${LEADING_OPTS}\\s+rebase\\b`) },
  { name: "git clean (delete untracked)", pattern: new RegExp(`\\bgit${LEADING_OPTS}\\s+clean\\b`) },
  // Running install / untrusted shell scripts. `npm ci` also runs lifecycle
  // install scripts; `LEADING_OPTS` catches options before the subcommand
  // (`npm --prefix web install`, `pnpm -C app install`).
  { name: "package install script", pattern: new RegExp(`\\b(npm|pnpm|yarn|bun|pip|pip3|gem|cargo|brew)${LEADING_OPTS}\\s+(install|add|i|ci)\\b`) },
  // Yarn classic: bare `yarn` (or `yarn` with only flags) is an install that
  // runs lifecycle scripts. Match `yarn` not followed by a subcommand word —
  // `yarn run build` / `yarn test` are not installs and are left alone.
  { name: "bare yarn install", pattern: /\byarn\b(?!\s+[a-z])/i },
  // A remote script piped to a shell, including a path-qualified one (`| /bin/bash`).
  { name: "piped remote shell (curl|wget → sh)", pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(?:[^\s|]*\/)?(sh|bash|zsh)\b/ },
] as const;

/** Flatten a field that may be a string or an array of tokens into one string. */
function tokensOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join(" ");
  return undefined;
}

/**
 * Build a candidate command string from an action's arguments. The kernel does
 * not assume a single tool shape: it reads the executable / command-line field
 * (`command` / `cmd` / `script` / `argv`) AND a companion argument vector
 * (`args` / `arguments`) and joins them, so a split schema like
 * `{ command: "git", args: ["reset", "--hard"] }` is scanned in full rather than
 * seeing only `git`. Returns `undefined` when there is nothing string-like.
 */
function commandText(args: unknown): string | undefined {
  if (typeof args === "string") return args;
  if (args === null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const parts: string[] = [];
  // The executable or full command line (first matching field wins).
  for (const field of ["command", "cmd", "script", "argv"] as const) {
    const text = tokensOf(record[field]);
    if (text !== undefined) {
      parts.push(text);
      break;
    }
  }
  // A companion argument vector some schemas keep separate from the executable.
  for (const field of ["args", "arguments"] as const) {
    const text = tokensOf(record[field]);
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
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

/**
 * Serialize a value with object keys sorted at every level, so two structurally
 * equal arguments produce the same string regardless of key order. Array order is
 * preserved (it is semantically significant); object key order is not.
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * A stable, NON-REVERSIBLE fingerprint of an action's arguments — a short digest
 * that identifies *which* invocation a destructive action is, without recording the
 * arguments themselves. The out-of-band resume path uses it to bind a human's
 * confirmation to the exact paused action: two calls of the same capability with
 * different arguments (deleting `dist` vs `cache`) have different fingerprints, so a
 * confirmation for one never clears the other.
 *
 * It is a KEYED HMAC, not a bare hash. `key` is the agent's secret action-
 * fingerprint key ({@link AsterismStore.actionFingerprintKey}); without it, an
 * attacker who can read the event log (e.g. over the HTTP events endpoint) could
 * dictionary-attack a bare digest of low-entropy arguments like `{ path: "dist" }`
 * and recover what the log deliberately never stores. Keying defeats that: the
 * digest is a REFERENCE to the action, never a path back to its arguments, so it is
 * safe to record alongside the capability and effect while preserving the event
 * log's references-only guarantee. The recording side (`audit.ts`) and the matching
 * side (the resume's `preApproval`) pass the same key, so their fingerprints agree.
 */
export function actionFingerprint(args: unknown, key: string): string {
  return createHmac("sha256", key).update(stableStringify(args)).digest("hex").slice(0, 32);
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
 * What a resume's standing disposition says about a destructive action — see
 * {@link TrustHooks.preApproval}. `skip`: already executed on an earlier resume,
 * do not repeat; `run`: confirmed and not yet executed, run it; `gate`: undecided,
 * fall through to the confirmation pause.
 */
export type PreApprovalVerdict = "skip" | "run" | "gate";

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
  /**
   * The standing disposition for a destructive action on a RESUME — the seam
   * `resumeRun` uses to honor an out-of-band confirmation without re-prompting,
   * while re-executing the agent loop from the start. Consulted for a destructive
   * action BEFORE the confirmation pause, and STATEFUL (it counts occurrences of
   * each invocation within the replay). Returns:
   *
   * - `"skip"`  — this exact invocation ALREADY executed on an earlier resume cycle.
   *   Re-running the loop replays it, but it must NOT happen twice — a confirmed
   *   payment/delete is not repeated. The gate returns an "already performed" result
   *   without executing or pausing, so the loop continues to the next action.
   * - `"run"`   — this invocation is confirmed and has not executed yet. It runs.
   * - `"gate"`  — no standing decision: consult `confirm`, and pause if denied.
   *
   * Absent ⇒ always `"gate"` (a fresh run: nothing pre-approved, nothing already
   * executed). Re-entering the loop replays every earlier destructive call, so this
   * skips the ones already run, runs exactly the next one a human confirmed, and
   * gates the rest — never re-executing a confirmed action and never auto-running an
   * unconfirmed one.
   *
   * Deliberately separate from a {@link TrustProfile}'s permanent `autoApprove`
   * allow-list, which is an unbounded, *configured* grant. A one-time confirmation
   * must not become that.
   */
  preApproval?: (action: Action) => PreApprovalVerdict;
  /**
   * The run's abort controller. When a destructive action is paused without
   * approval, the gate aborts it — a *real* stop signal, not just a refused tool
   * result. The {@link RuntimeAdapter} honors `request.signal`, so aborting here
   * suspends the in-flight agent loop instead of letting it continue to other
   * side-effecting tools or finish the run as `done`. The kernel passes the same
   * controller whose `signal` it placed on the run request.
   */
  abortController?: AbortController;
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

/**
 * ToolResult returned when a destructive action awaits confirmation. Marked
 * `isError: true` so the substrate cannot read it as a successful action — the
 * action did not run. The hard stop is the run abort (see {@link gateTool}); this
 * result is only what a model would see if the loop were not suspended.
 */
function awaitingConfirmationResult(capability: string): ToolResult {
  return {
    output:
      `[awaiting confirmation] '${capability}' is a destructive action and ` +
      `requires explicit human confirmation before it can run. It has not been executed.`,
    isError: true,
  };
}

/**
 * ToolResult returned when a resume's replay reaches a destructive action that
 * ALREADY executed on an earlier confirmation of this run. Re-running the loop
 * re-issues it, but the gate does not let it happen twice — it reports the prior
 * effect as a success (so the model continues to the next step) without repeating
 * it. Marked `isError: false`: from the model's view the action is done.
 */
function alreadyPerformedResult(capability: string): ToolResult {
  return {
    output:
      `[already performed] '${capability}' ran on an earlier confirmation of this ` +
      `run; it was not repeated.`,
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
  // Snapshot the capability's policy-bearing fields at resolution time. The gate
  // closure must decide from what was scoped for this run, not from a `Capability`
  // object the caller could later mutate to soften `effect` or rename `key`.
  const key = capability.key;
  const effect = capability.effect;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (
      invocation: ToolInvocation,
      signal?: AbortSignal,
    ): Promise<ToolResult> => {
      const action: Action = {
        capability: key,
        effect,
        ...(invocation.args !== undefined ? { args: invocation.args } : {}),
      };
      const decision = decideGate(profile, action);

      if (decision === "withhold") {
        hooks.onWithhold?.(action);
        return withheldResult(key);
      }

      if (decision === "confirm") {
        // A resume's standing disposition decides this destructive action without a
        // fresh pause. Consulted FIRST so a confirmed action emits no awaiting-
        // confirmation event and the run does not churn through `awaiting_confirmation`.
        const verdict = hooks.preApproval?.(action) ?? "gate";
        if (verdict === "skip") {
          // Already executed on an earlier confirmation of this run — re-running the
          // loop must not repeat it. Report the prior effect as done, without
          // executing or pausing, so the loop continues to the next action.
          return alreadyPerformedResult(key);
        }
        if (verdict === "gate") {
          // Consult the (possibly interactive, blocking) confirmation FIRST, then
          // record the pause only if it is denied. `onAwaitConfirmation` is what
          // persists `awaiting_confirmation`, so deferring it past the prompt means a
          // run sitting at a live `[y/N]` stays `running` — an out-of-band confirm
          // therefore cannot claim a still-attended run and double-execute the action.
          // The status flips to `awaiting_confirmation` only when the action truly
          // parks (no one approved it).
          const approved = hooks.confirm ? await hooks.confirm(action) : false;
          if (!approved) {
            hooks.onAwaitConfirmation?.(action);
            // Not a refused-but-continuable result: stop the run. Aborting the
            // controller suspends the agent loop so it cannot proceed to other
            // side-effecting tools while the action waits on a human.
            hooks.abortController?.abort(
              new Error(`destructive action requires confirmation: ${key}`),
            );
            return awaitingConfirmationResult(key);
          }
        }
        // verdict === "run", or "gate" + explicitly confirmed: fall through to
        // execute. With the pause recorded only on denial, an action reaches
        // `onExecute` ONLY when it was never paused — so a given invocation triggers
        // `onAwaitConfirmation` or `onExecute`, never both.
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
 *
 * The policy itself is also snapshotted: the profile (level + private copies of
 * both allow-list Sets) and each capability's `key`/`effect` are captured at
 * resolution time, so mutating the caller's `profile` or `Capability` objects
 * afterward cannot change what an already-scoped run is allowed to do.
 */
export function resolveToolRegistry(
  profile: TrustProfile,
  capabilities: readonly Capability[],
  hooks: TrustHooks = {},
): ToolRegistry {
  const snapshot: TrustProfile = Object.freeze({
    level: profile.level,
    capabilities: new Set(profile.capabilities),
    autoApprove: new Set(profile.autoApprove),
  });
  const exposed = capabilities.filter((cap) =>
    snapshot.capabilities.has(cap.key),
  );
  return createToolRegistry(exposed.map((cap) => gateTool(snapshot, cap, hooks)));
}
