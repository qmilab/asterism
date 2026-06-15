// The channel dispatcher — a thin, runtime-neutral surface over the kernel's
// run flow, the chat-app analog of the HTTP server's `handleRequest`
// (`packages/server/src/index.ts` is the template).
//
// It turns one inbound chat message into the kernel call it implies and returns
// the reply(ies) to send back — nothing more. No trust reasoning, no scoping, no
// run orchestration lives here: `executeRun` / `resumeRun` and the agent-scoped
// repositories own all of that, so a chat channel inherits the CLI's and the HTTP
// surface's exact guarantees. By construction the dispatcher reaches exactly one
// agent (the one it was built with); it can no more address another agent's runs
// than a server bound to `personal` can serve `work`.
//
// Two things a chat surface needs that HTTP does not:
//
//   1. An access boundary. An HTTP server is safe because it binds loopback — the
//      bind IS its access control. A bot handle is globally reachable, so the
//      boundary must be explicit: an allow-list of authorized chat ids. A message
//      from any other chat is refused here, before the kernel is ever touched.
//      This is how "no back door to another agent" holds at the chat edge.
//
//   2. Out-of-band confirmation. A run that trips the destructive-action gate has
//      no human at the keyboard to confirm it inline (same as HTTP), so it parks
//      at `awaiting_confirmation`. Over chat the pause is cleared by a *reply*:
//      the dispatcher remembers the paused run per chat and, on `/confirm`, calls
//      `resumeRun` — which re-enters the loop with only the action it stopped on
//      approved. The gate is never weakened; a new destructive action pauses again.
//
// Replies are buffered: the run executes to a terminal state and the dispatcher
// returns the result as text. Live token streaming to chat is a later concern.

import { executeRun, resumeRun } from "@qmilab/asterism-core";
import type {
  ActionRecord,
  Agent,
  AsterismStore,
  Capability,
  ExecuteRunOptions,
  ExecuteRunResult,
  RuntimeAdapter,
} from "@qmilab/asterism-core";

/** A message received from a chat: which chat it came from, and its text. */
export interface InboundMessage {
  /** The chat's id, as a string (the transport stringifies the platform id). */
  chatId: string;
  /** The message text. */
  text: string;
}

/** A reply to send back to a chat. The transport delivers (and chunks) it. */
export interface OutboundMessage {
  chatId: string;
  text: string;
}

/**
 * Everything the dispatcher needs, injectable so it is testable without a
 * network. Mirrors the HTTP surface's `ServerDeps` (the store + the single served
 * agent + the substrate seams), plus the one thing a chat surface adds: the
 * `allow` set that is its access boundary.
 */
export interface ChannelDeps {
  /** The open kernel store. */
  store: AsterismStore;
  /** The single agent this channel serves (resolved at startup). */
  agent: Agent;
  /**
   * The substrate for executing runs. Absent ⇒ a task message is declined with a
   * clear note rather than crashing — the chat-edge analog of the HTTP 503.
   */
  adapter?: RuntimeAdapter;
  /** When `adapter` is absent, a client-facing explanation of what to configure. */
  adapterReason?: string;
  /** Reads a file's text (soul + skill bodies); forwarded to the run untouched. */
  readFile?: (path: string) => string;
  /**
   * Capabilities to expose to runs; forwarded to the kernel untouched, so the
   * trust profile + gate decide what each run may do with them. Mirrors the CLI
   * and HTTP seam, so tool exposure cannot differ by surface.
   */
  capabilities?: readonly Capability[];
  /**
   * The chat ids authorized to drive this agent — the channel's access boundary.
   * A message from any chat not in this set is refused before the kernel is
   * touched. Never empty in practice: the surface that wires the dispatcher
   * refuses to start without it.
   */
  allow: ReadonlySet<string>;
  /**
   * This bot's `@username`, if known. In a group chat Telegram appends `@bot` to
   * a command (`/confirm@thisbot`); a command addressed to a *different* bot must
   * not act on this agent. With the username set, only an unaddressed command or
   * one addressed to this bot is honored; absent, only unaddressed commands are.
   */
  botUsername?: string;
}

/** The dispatcher: hand it one inbound message, get back the replies to send. */
export interface ChannelDispatcher {
  handle(message: InboundMessage): Promise<OutboundMessage[]>;
}

/**
 * The substrate-side host concerns a run forwards to the kernel — built once so
 * starting a run and resuming one hand the kernel the SAME reader + tool catalog
 * (no drift). Deliberately carries NO `confirm` hook: a chat channel never
 * confirms inline (there is no synchronous human), it pauses and clears the pause
 * out of band via a reply — exactly like the HTTP surface.
 */
function runOptions(deps: ChannelDeps, adapter: RuntimeAdapter): ExecuteRunOptions {
  return {
    adapter,
    ...(deps.readFile ? { readFile: deps.readFile } : {}),
    ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
  };
}

/**
 * Build a dispatcher bound to one agent. It holds the only state a chat surface
 * needs beyond the store: the run each chat is currently waiting to confirm
 * (`chatId → runId`). That map is the conversational equivalent of the run id an
 * HTTP client puts in the confirm URL.
 */
export function createDispatcher(deps: ChannelDeps): ChannelDispatcher {
  // Which run, if any, each chat has parked awaiting confirmation. Set when a run
  // pauses; cleared when it resolves (resumed to completion, or abandoned).
  const pending = new Map<string, string>();

  function reply(chatId: string, text: string): OutboundMessage[] {
    return [{ chatId, text }];
  }

  /** Render a settled run's outcome, updating the pending map as a side effect. */
  function settle(chatId: string, result: ExecuteRunResult): OutboundMessage[] {
    if (result.status === "awaiting_confirmation") {
      // The gate stopped the run on a destructive action. Remember it so a reply
      // can clear the pause, and ask for the OK naming what is waiting.
      pending.set(chatId, result.run.id);
      return reply(chatId, formatConfirmPrompt(result));
    }
    pending.delete(chatId);
    return reply(chatId, formatResult(deps.agent, result));
  }

  /** Clear a chat's pending pause by resuming its run after an explicit `/confirm`. */
  async function resume(chatId: string, runId: string): Promise<OutboundMessage[]> {
    if (!deps.adapter) {
      return reply(chatId, deps.adapterReason ?? NO_MODEL);
    }
    const outcome = await resumeRun(deps.store, deps.agent, runId, runOptions(deps, deps.adapter));
    if (outcome.kind === "not_found") {
      pending.delete(chatId);
      return reply(chatId, "That run is no longer available.");
    }
    if (outcome.kind === "not_paused") {
      pending.delete(chatId);
      return reply(chatId, `That run is ${outcome.run.status} now — nothing to confirm.`);
    }
    // Resumed: it may have finished, or hit a NEW destructive action and re-paused
    // — `settle` re-prompts in that case, so one confirm clears one gate.
    return settle(chatId, outcome.result);
  }

  async function handle(message: InboundMessage): Promise<OutboundMessage[]> {
    const { chatId } = message;

    // The access boundary: an unknown chat gets nothing but its own id (so it can
    // be allow-listed) and never reaches the kernel.
    if (!deps.allow.has(chatId)) {
      return reply(
        chatId,
        `Not authorized. Your chat id is ${chatId} — add it to this bot's allow-list to use the agent.`,
      );
    }

    const parsed = classifyMessage(message.text, deps.botUsername);

    // A slash-command addressed to a different bot (groups append `@bot`) is not
    // ours: ignore it entirely — no run, no reply — even mid-confirmation. This is
    // distinct from ordinary text, which is treated as a task below.
    if (parsed.kind === "foreign") return [];
    const command = parsed.kind === "command" ? parsed.name : undefined;

    // `/help` and `/start` answer the same way whatever the run state.
    if (command === "/help") return reply(chatId, helpText(deps.agent));
    if (command === "/start") return reply(chatId, greeting(deps.agent));

    // A chat waiting on a confirmation is in a focused state: only confirm/cancel
    // act; any other message re-prompts rather than starting a parallel run (which
    // would leave the gated one stranded and confuse which run a later reply means).
    let pendingRunId = pending.get(chatId);
    if (pendingRunId !== undefined) {
      // The pause may have been cleared out of band (e.g. `asterism confirm` or the
      // HTTP confirm endpoint). If the run is no longer awaiting confirmation, drop
      // the stale pointer so this chat isn't blocked on an already-finished run.
      const parked = deps.store.runs.get(deps.agent.id, pendingRunId);
      if (!parked || parked.status !== "awaiting_confirmation") {
        pending.delete(chatId);
        pendingRunId = undefined;
      }
    }
    if (pendingRunId !== undefined) {
      if (isConfirm(command)) return resume(chatId, pendingRunId);
      if (isCancel(command)) {
        pending.delete(chatId);
        return reply(
          chatId,
          "Okay — left it paused. Send a new task whenever you're ready (or confirm it from the CLI).",
        );
      }
      return reply(
        chatId,
        "You have a run waiting for confirmation. Reply /confirm to approve the paused action, or /cancel to leave it.",
      );
    }

    // No pending confirmation: a stray /confirm or /cancel (a double-send after a
    // run finished, or sent before anything paused) is not a task — answer plainly
    // instead of running the agent on the command text.
    if (isConfirm(command) || isCancel(command)) {
      return reply(chatId, "There's nothing waiting for confirmation right now. Send me a task to get started.");
    }

    // An empty message — e.g. a bare @mention in a Discord server, which strips to
    // nothing — is not a task worth a run. Nudge instead of running the agent on "".
    // (This is reached only past the allow-list, so an unknown chat still gets the
    // discovery reply above, not this.)
    if (message.text.trim().length === 0) {
      return reply(chatId, "Send me a task to get started.");
    }

    // Idle: the message is a task. Decline cleanly if no model is configured —
    // the chat-edge analog of the HTTP 503.
    if (!deps.adapter) {
      return reply(chatId, deps.adapterReason ?? NO_MODEL);
    }
    const result = await executeRun(
      deps.store,
      deps.agent,
      message.text,
      runOptions(deps, deps.adapter),
    );
    return settle(chatId, result);
  }

  return { handle };
}

const NO_MODEL = "No model is configured, so I can't run tasks yet.";

/**
 * How an inbound message reads:
 *   - `command` — a slash-command for us (`/confirm`, `/help`, …), lowercased.
 *   - `foreign` — a slash-command addressed to a *different* bot; not ours to act
 *     on and not a task either, so the dispatcher ignores it.
 *   - `text`    — ordinary text, handled as a task.
 */
type ClassifiedMessage =
  | { kind: "command"; name: string }
  | { kind: "foreign" }
  | { kind: "text" };

/**
 * Classify a message by its leading token. Only the first token matters —
 * `/confirm now` is still `/confirm`.
 *
 * Telegram appends `@botname` to a command in a group. An unaddressed command is
 * ours; one addressed to `botUsername` is ours; one addressed to any other bot
 * (or any addressed command when we don't know our own username) is `foreign` —
 * which is what stops `/confirm@other_bot` from resuming this agent's gated run
 * AND stops `/status@other_bot` from being run as a task.
 */
function classifyMessage(text: string, botUsername?: string): ClassifiedMessage {
  const first = text.trim().split(/\s+/, 1)[0] ?? "";
  if (!first.startsWith("/")) return { kind: "text" };
  const at = first.indexOf("@");
  if (at === -1) return { kind: "command", name: first.toLowerCase() };
  const addressedTo = first.slice(at + 1).toLowerCase();
  if (botUsername !== undefined && addressedTo === botUsername.toLowerCase()) {
    return { kind: "command", name: first.slice(0, at).toLowerCase() };
  }
  return { kind: "foreign" };
}

/** A reply that approves a pending pause: `/confirm`, or a plain yes. */
function isConfirm(command: string | undefined): boolean {
  return command === "/confirm" || command === "/yes";
}

/** A reply that abandons a pending pause: `/cancel`, or a plain no. */
function isCancel(command: string | undefined): boolean {
  return command === "/cancel" || command === "/no";
}

/**
 * Whether a raw message is a confirmation control reply (`/confirm`/`/cancel` and
 * their aliases) — the replies that clear a pending pause. Exposed for a transport
 * that gates *unaddressed* messages: Discord requires an @mention before running a
 * task in a server, but the pause prompt tells users to "reply /confirm", so these
 * control replies must still pass the gate or a paused run would be stranded.
 */
export function isControlReply(text: string): boolean {
  const parsed = classifyMessage(text, undefined);
  return parsed.kind === "command" && (isConfirm(parsed.name) || isCancel(parsed.name));
}

/** Glyph per gate decision, matching the CLI's action summary. */
const ACTION_GLYPH: Readonly<Record<ActionRecord["decision"], string>> = {
  executed: "✓",
  withheld: "⊘",
  paused: "⏸",
};

/**
 * Render a settled run as the chat reply: the agent's text, then — for a
 * `notify`/`autonomous` agent — the after-the-fact summary of what it did.
 * References only (capability + classified effect), never an argument value. A
 * `propose` agent's plan already lives in the output text, so its withheld
 * actions are not repeated.
 */
function formatResult(agent: Agent, result: ExecuteRunResult): string {
  const parts: string[] = [];
  if (result.status === "failed") {
    parts.push(`⚠️ The run failed${result.error ? `: ${result.error}` : "."}`);
  }
  const body = result.output.trim();
  if (body.length > 0) parts.push(body);
  else if (result.status !== "failed") parts.push("(the agent finished with no text to report.)");

  if (agent.trustLevel !== "propose" && result.actions.length > 0) {
    parts.push(formatActions(result.actions));
  }
  return parts.join("\n\n");
}

/** A compact, references-only tally of the gate decisions a run took. */
function formatActions(actions: readonly ActionRecord[]): string {
  const counts: Record<ActionRecord["decision"], number> = { executed: 0, withheld: 0, paused: 0 };
  for (const a of actions) counts[a.decision]++;
  const tally = (["executed", "withheld", "paused"] as const)
    .filter((d) => counts[d] > 0)
    .map((d) => `${counts[d]} ${d}`)
    .join(", ");
  const lines = [`Actions (${tally}):`];
  for (const a of actions) lines.push(`  ${ACTION_GLYPH[a.decision]} ${a.capability} (${a.effect})`);
  return lines.join("\n");
}

/**
 * Ask for confirmation of the action(s) a run paused on. Names the capability and
 * its classified effect — references only, the same the HTTP surface exposes,
 * never the argument values (which can carry a secret).
 */
function formatConfirmPrompt(result: ExecuteRunResult): string {
  const paused = result.actions.filter((a) => a.decision === "paused");
  const lines = ["⏸ This needs your OK before I can continue:"];
  if (paused.length > 0) {
    for (const a of paused) lines.push(`  • ${a.capability} (${a.effect})`);
  } else {
    lines.push("  • a destructive action");
  }
  lines.push("");
  lines.push("Reply /confirm to approve it, or /cancel to leave the run paused.");
  return lines.join("\n");
}

/** The `/start` greeting — what this agent is and how the gate behaves. */
function greeting(agent: Agent): string {
  return [
    `I'm the "${agent.name}" agent. Send me a task and I'll work on it.`,
    "If a task needs a destructive action, I'll pause and ask you to /confirm before doing it.",
  ].join("\n");
}

/** The `/help` text — the same, plus the commands. */
function helpText(agent: Agent): string {
  return [
    greeting(agent),
    "",
    "Commands:",
    "  /confirm — approve a paused action",
    "  /cancel  — leave a paused run alone",
    "  /help    — show this message",
  ].join("\n");
}
