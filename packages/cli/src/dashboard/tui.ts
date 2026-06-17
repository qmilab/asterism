// The dashboard TUI — a hand-rolled, dependency-free terminal UI over the console
// client. It is split into two halves so the hard-to-test IO loop stays thin:
//
//   • render(state, dims) → string[]   A PURE function: dashboard state in, the
//                                       full frame out. All layout lives here and is
//                                       unit-tested with plain data.
//   • runDashboard(client, term)        The IO loop: load data, draw, handle keys,
//                                       poll for live updates, restore the terminal.
//                                       It holds NO behavior of its own beyond UI
//                                       state — every action is one client call.
//
// The terminal is injected (TerminalIO) so the loop is drivable by a fake in tests
// and by real stdin/stdout in bin.ts.

import { TRUST_LEVELS } from "@qmilab/asterism-core";
import type { Event, Run, ReviewableProposal, TrustLevel } from "@qmilab/asterism-core";

import {
  bold,
  CLEAR_SCREEN,
  CURSOR_HOME,
  cyan,
  dim,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  gray,
  HIDE_CURSOR,
  padEnd,
  red,
  reverse,
  SHOW_CURSOR,
  truncate,
  width,
  yellow,
} from "./ansi.js";
import type { DashboardClient, RosterEntry } from "./client.js";
import { DashboardError } from "./client.js";

/** A decoded key press. `name` is normalized; `sequence` is the raw char for input. */
export interface Key {
  /** A single character, or one of: up down left right enter escape backspace tab. */
  name: string;
  ctrl: boolean;
  sequence: string;
}

/** Everything the loop drives the terminal through — injectable for tests. */
export interface TerminalIO {
  readonly columns: number;
  readonly rows: number;
  write(s: string): void;
  /** Enable/disable key-by-key (raw) input. */
  setRawMode(on: boolean): void;
  /** Subscribe to key presses; the handler may be async. Returns an unsubscribe. */
  onKey(handler: (key: Key) => void | Promise<void>): () => void;
  /** Subscribe to terminal-size changes. Returns an unsubscribe. */
  onResize(handler: () => void): () => void;
}

export interface DashboardOptions {
  /** Milliseconds between live polls of the roster + selected agent. Default 1500. */
  refreshMs?: number;
  /** A label for the header (e.g. "local" or the remote URL). */
  connection?: string;
}

type Mode = "roster" | "trust" | "review" | "editing" | "help";

/** The full UI state — the single input to {@link render}. */
export interface DashboardState {
  agents: RosterEntry[];
  selected: number;
  runs: Run[];
  events: Event[];
  mode: Mode;
  /** Trust chooser cursor (index into TRUST_LEVELS). */
  trustChoice: number;
  /** Reflect proposals under review, and the cursor into them. */
  proposals: ReviewableProposal[];
  proposalIndex: number;
  /**
   * The agent the proposals under review belong to — captured when reflection ran,
   * NOT re-derived from the live selection. Reflection is async, and the roster stays
   * navigable while it is in flight, so the selected agent may have changed by the
   * time a proposal is accepted; saving to this name keeps a memory from ever being
   * written under the wrong agent.
   */
  reviewAgent: string;
  /** Edit buffer while editing a proposal's content. */
  editBuffer: string;
  /** A transient status line (last action result or error). */
  status: string;
  /** True while an action is in flight. */
  busy: boolean;
  connection: string;
}

/** A fresh, empty dashboard state. */
export function initialState(connection = "local"): DashboardState {
  return {
    agents: [],
    selected: 0,
    runs: [],
    events: [],
    mode: "roster",
    trustChoice: 0,
    proposals: [],
    proposalIndex: 0,
    reviewAgent: "",
    editBuffer: "",
    status: "",
    busy: false,
    connection,
  };
}

/** The currently selected agent, or undefined when the roster is empty. */
function selectedAgent(state: DashboardState): RosterEntry | undefined {
  return state.agents[state.selected];
}

/** The selected agent's runs that are awaiting confirmation, oldest-first. */
function pendingRuns(state: DashboardState): Run[] {
  return state.runs.filter((r) => r.status === "awaiting_confirmation");
}

// --- rendering (pure) ------------------------------------------------------

interface Dims {
  cols: number;
  rows: number;
}

/** A human badge for a trust level, fixed width for alignment. */
function trustBadge(level: TrustLevel): string {
  return level;
}

/** A compact one-line view of an event for the activity timeline. */
function eventLine(e: Event): string {
  const time = e.createdAt.slice(11, 19); // HH:MM:SS from the ISO timestamp
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof p.capability === "string") bits.push(p.capability);
  if (typeof p.effect === "string") bits.push(p.effect);
  if (typeof p.to === "string") bits.push(typeof p.from === "string" ? `${p.from}→${p.to}` : p.to);
  if (typeof p.memoryType === "string") bits.push(p.memoryType);
  const detail = bits.length > 0 ? `  ${bits.join(" ")}` : "";
  return `${time}  ${e.type}${detail}`;
}

/** The left pane: the agent roster. */
function rosterPane(state: DashboardState, height: number, w: number): string[] {
  const lines: string[] = [bold(padEnd("AGENTS", w)), ""];
  state.agents.forEach((a, i) => {
    const marker = i === state.selected ? "> " : "  ";
    const pending = a.pendingConfirmations > 0 ? ` !${a.pendingConfirmations}` : "";
    // Right-align the trust (+ pending) badge; the name takes the rest and truncates.
    const badge = `${trustBadge(a.trustLevel)}${pending}`;
    const label = padEnd(`${marker}${a.name}`, Math.max(0, w - badge.length - 1));
    const plain = truncate(`${label} ${badge}`, w);
    lines.push(i === state.selected ? reverse(plain) : a.pendingConfirmations > 0 ? yellow(plain) : plain);
  });
  if (state.agents.length === 0) lines.push(dim("  (no agents yet)"));
  return fit(lines, height, w);
}

/** The right pane: detail for the selected agent (roster mode). */
function detailPane(state: DashboardState, height: number, w: number): string[] {
  const agent = selectedAgent(state);
  if (!agent) return fit([dim("Create an agent first: asterism new <name>")], height, w);

  const lines: string[] = [];
  lines.push(bold(truncate(`${agent.name}  ·  ${agent.trustLevel}`, w)));
  if (agent.role) lines.push(dim(truncate(`role: ${agent.role}`, w)));
  lines.push(dim(truncate(`soul: ${agent.soulRef}`, w)));
  lines.push("");

  const pending = pendingRuns(state);
  if (pending.length > 0) {
    const first = pending[0]!;
    lines.push(yellow(bold(truncate(`Pending confirmation (${pending.length})`, w))));
    lines.push(yellow(truncate(`  run ${first.id.slice(0, 8)}  "${first.input}"`, w)));
    lines.push(truncate("  [c] approve   [x] decline", w));
    lines.push("");
  }

  lines.push(bold(truncate("Activity", w)));
  if (state.events.length === 0) {
    lines.push(dim("  (no activity yet)"));
  } else {
    // Newest at the bottom; show as many recent events as fit the remaining height.
    const room = Math.max(1, height - lines.length);
    for (const e of state.events.slice(-room)) lines.push(gray(truncate(eventLine(e), w)));
  }
  return fit(lines, height, w);
}

/** The trust chooser (replaces the body in trust mode). */
function trustBody(state: DashboardState, height: number, w: number): string[] {
  const agent = selectedAgent(state);
  const lines: string[] = [bold(`Set autonomy for ${agent?.name ?? ""}`), ""];
  TRUST_LEVELS.forEach((level, i) => {
    const marker = i === state.trustChoice ? "> " : "  ";
    const row = `${marker}${level}`;
    lines.push(i === state.trustChoice ? reverse(padEnd(row, Math.min(w, 24))) : row);
  });
  lines.push("");
  lines.push(dim("↑/↓ choose · enter apply · esc cancel"));
  lines.push(dim("A destructive action still pauses for confirmation at every level."));
  return fit(lines, height, w);
}

/** The memory-review card (replaces the body in review/editing mode). */
function reviewBody(state: DashboardState, height: number, w: number): string[] {
  const p = state.proposals[state.proposalIndex];
  if (!p) return fit([dim("No more proposals.")], height, w);
  const lines: string[] = [];
  const forAgent = state.reviewAgent ? ` for ${state.reviewAgent}` : "";
  lines.push(bold(truncate(`Review memory ${state.proposalIndex + 1}/${state.proposals.length}${forAgent}`, w)));
  lines.push(dim(`${p.memoryType} · confidence ${p.confidence}`));
  lines.push("");
  for (const line of wrap(p.content, w)) lines.push(line);
  if (p.findings.length > 0) {
    lines.push("");
    lines.push(yellow(truncate(`⚠ firewall flagged: ${p.findings.map((f) => f.rule).join(", ")}`, w)));
  }
  lines.push("");
  if (state.mode === "editing") {
    lines.push(bold(truncate("Edit content (enter to save · esc to cancel):", w)));
    lines.push(cyan(truncate(`${state.editBuffer}_`, w)));
  } else {
    lines.push(truncate("[a] accept   [e] edit   [r] reject   [esc] done", w));
  }
  return fit(lines, height, w);
}

/** The help overlay (replaces the body in help mode). */
function helpBody(height: number, w: number): string[] {
  const rows = [
    bold("Keys"),
    "",
    "  ↑/↓, j/k   select agent",
    "  t          set autonomy (trust) level",
    "  c          approve the agent's pending destructive action",
    "  x          decline the agent's pending destructive action",
    "  m          reflect — review proposed memories (accept/edit/reject)",
    "  r          refresh now",
    "  ?          toggle this help",
    "  q          quit",
    "",
    dim("The dashboard is a thin client over the local console endpoint."),
  ];
  return fit(rows.map((r) => truncate(r, w)), height, w);
}

/**
 * Render the whole frame as an array of exactly `rows` lines, each at most `cols`
 * columns. Pure: same state + dims always yields the same frame.
 */
export function render(state: DashboardState, dims: Dims): string[] {
  const { cols, rows } = dims;
  if (rows < 8 || cols < 40) {
    return fit([truncate("Terminal too small — enlarge the window.", cols)], rows, cols);
  }

  // Title line: "asterism dashboard" on the left, the connection on the right. Both
  // segments are laid out in PLAIN text (so the spacing is exact) and colored after.
  const leftPlain = "asterism dashboard";
  const rightPlain = `console: ${state.connection}`;
  const titleLine =
    leftPlain.length + rightPlain.length + 1 <= cols
      ? bold("asterism") +
        dim(" dashboard") +
        " ".repeat(cols - leftPlain.length - rightPlain.length) +
        dim(rightPlain)
      : bold("asterism") + dim(" dashboard");
  const sep = "─".repeat(cols);

  const bodyHeight = rows - 4;
  let body: string[];
  if (state.mode === "trust") body = trustBody(state, bodyHeight, cols);
  else if (state.mode === "review" || state.mode === "editing") body = reviewBody(state, bodyHeight, cols);
  else if (state.mode === "help") body = helpBody(bodyHeight, cols);
  else body = rosterBody(state, bodyHeight, cols);

  return [titleLine, sep, ...body, sep, footerLine(state, cols)];
}

/** Two-column roster body: roster on the left, selected-agent detail on the right. */
function rosterBody(state: DashboardState, height: number, cols: number): string[] {
  const leftWidth = Math.min(30, Math.floor(cols * 0.4));
  const rightWidth = cols - leftWidth - 3; // " │ " gutter
  const left = rosterPane(state, height, leftWidth);
  const right = detailPane(state, height, rightWidth);
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    // Pad the left cell to its exact VISIBLE width (cells may carry color) so the
    // gutter stays aligned even on the blank rows below the roster.
    const l = left[i] ?? "";
    const cell = l + " ".repeat(Math.max(0, leftWidth - width(l)));
    out.push(`${cell} ${dim("│")} ${right[i] ?? ""}`);
  }
  return out;
}

/** The footer: context-appropriate key hints, then the status message. */
function footerLine(state: DashboardState, cols: number): string {
  let keys: string;
  if (state.mode === "trust") keys = "↑/↓ choose · enter apply · esc cancel";
  else if (state.mode === "editing") keys = "type to edit · enter save · esc cancel";
  else if (state.mode === "review") keys = "a accept · e edit · r reject · esc done";
  else if (state.mode === "help") keys = "? or esc to close";
  else keys = "↑/↓ select · t trust · c approve · x decline · m reflect · r refresh · ? help · q quit";
  const status = state.busy ? yellow("working…") : state.status;
  const plain = truncate(keys, cols);
  // Right-align the status if there's room; otherwise just the keys. Measure the
  // status by its VISIBLE width (it may carry color) so the spacing stays exact.
  const statusWidth = width(status);
  const room = cols - plain.length - 1;
  if (status && room > statusWidth + 1) {
    return `${dim(plain)}${" ".repeat(room - statusWidth)}${status}`;
  }
  return dim(plain);
}

// --- small layout helpers --------------------------------------------------

/** Force `lines` to exactly `height` rows (pad with blanks, drop overflow). */
function fit(lines: string[], height: number, _w: number): string[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push("");
  return out;
}

/** Word-wrap plain text to `w` columns. */
function wrap(text: string, w: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= w) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.map((l) => truncate(l, w));
}

// --- the IO loop -----------------------------------------------------------

/**
 * Run the dashboard against `client`, drawing to `term`, until the user quits. Sets
 * up the alternate screen + raw input, draws on every change, polls for live updates,
 * and ALWAYS restores the terminal on exit (normal screen, cursor shown, raw off) —
 * even if an action throws — so a crash never leaves the user's terminal wedged.
 */
export async function runDashboard(
  client: DashboardClient,
  term: TerminalIO,
  options: DashboardOptions = {},
): Promise<void> {
  const refreshMs = options.refreshMs ?? 1500;
  const state = initialState(options.connection ?? "local");

  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });

  // Set the moment a quit is requested, BEFORE the terminal is restored. An action a
  // previous keypress kicked off is fire-and-forget, so it can still be in flight when
  // we tear down; this flag makes every later draw and reload a no-op, so a pending
  // `act` can never paint a frame onto the user's normal screen after the alternate
  // screen is gone, nor fetch against a self-hosted server that is shutting down.
  let stopped = false;

  const draw = (): void => {
    if (stopped) return;
    term.write(CLEAR_SCREEN + CURSOR_HOME + render(state, { cols: term.columns, rows: term.rows }).join("\r\n"));
  };

  /** Reload the roster, keeping the selection in range. */
  const loadRoster = async (): Promise<void> => {
    if (stopped) return;
    state.agents = await client.listAgents();
    if (state.selected >= state.agents.length) state.selected = Math.max(0, state.agents.length - 1);
  };

  /** Reload the selected agent's runs + recent events. */
  const loadDetail = async (): Promise<void> => {
    if (stopped) return;
    const agent = selectedAgent(state);
    if (!agent) {
      state.runs = [];
      state.events = [];
      return;
    }
    state.runs = await client.getRuns(agent.name);
    state.events = await client.getEvents(agent.name, { limit: 200 });
  };

  /** Run an action, showing a status and never letting a failure escape the loop. */
  const act = async (fn: () => Promise<string | void>): Promise<void> => {
    if (stopped) return;
    state.busy = true;
    draw();
    try {
      const msg = await fn();
      state.status = msg ?? "";
    } catch (err) {
      state.status = red(err instanceof DashboardError ? err.message : String(err));
    } finally {
      state.busy = false;
      draw();
    }
  };

  async function handleKey(key: Key): Promise<void> {
    if (stopped) return;
    // Global quit (q outside editing, or Ctrl+C anywhere). Flag stopped FIRST so any
    // action still in flight from an earlier key can no longer draw or fetch.
    if ((key.ctrl && key.name === "c") || (key.name === "q" && state.mode !== "editing")) {
      stopped = true;
      resolveQuit();
      return;
    }
    if (state.mode === "trust") return handleTrustKey(key);
    if (state.mode === "editing") return handleEditKey(key);
    if (state.mode === "review") return handleReviewKey(key);
    if (state.mode === "help") {
      if (key.name === "?" || key.name === "escape") {
        state.mode = "roster";
        draw();
      }
      return;
    }
    return handleRosterKey(key);
  }

  async function handleRosterKey(key: Key): Promise<void> {
    const moveTo = (i: number): Promise<void> =>
      act(async () => {
        state.selected = Math.max(0, Math.min(state.agents.length - 1, i));
        await loadDetail();
      });
    if (key.name === "up" || key.name === "k") return moveTo(state.selected - 1);
    if (key.name === "down" || key.name === "j") return moveTo(state.selected + 1);
    if (key.name === "?") {
      state.mode = "help";
      return void draw();
    }
    const agent = selectedAgent(state);
    if (!agent) return;
    if (key.name === "t") {
      state.trustChoice = Math.max(0, TRUST_LEVELS.indexOf(agent.trustLevel));
      state.mode = "trust";
      return void draw();
    }
    if (key.name === "r") {
      return act(async () => {
        await loadRoster();
        await loadDetail();
        return "Refreshed.";
      });
    }
    if (key.name === "c" || key.name === "x") {
      const pending = pendingRuns(state)[0];
      if (!pending) return act(async () => "No pending action for this agent.");
      const approve = key.name === "c";
      return act(async () => {
        if (approve) {
          const result = await client.confirmRun(agent.name, pending.id);
          await loadRoster();
          await loadDetail();
          return `Approved — run ${result.status}.`;
        }
        await client.declineRun(agent.name, pending.id);
        await loadRoster();
        await loadDetail();
        return "Declined — the action did not run.";
      });
    }
    if (key.name === "m") {
      return act(async () => {
        const result = await client.reflect(agent.name);
        if (result.proposals.length === 0) return `Nothing to reflect on yet for ${agent.name}.`;
        // Bind the batch to THIS agent (captured at 'm'), not the live selection,
        // which may have moved while the async reflect was in flight.
        state.proposals = result.proposals;
        state.proposalIndex = 0;
        state.reviewAgent = agent.name;
        state.mode = "review";
        return `Reviewing ${result.proposals.length} proposed ${result.proposals.length === 1 ? "memory" : "memories"} for ${agent.name}.`;
      });
    }
  }

  function handleTrustKey(key: Key): void {
    if (key.name === "escape") {
      state.mode = "roster";
      return draw();
    }
    if (key.name === "up" || key.name === "k") {
      state.trustChoice = Math.max(0, state.trustChoice - 1);
      return draw();
    }
    if (key.name === "down" || key.name === "j") {
      state.trustChoice = Math.min(TRUST_LEVELS.length - 1, state.trustChoice + 1);
      return draw();
    }
    if (key.name === "enter") {
      const agent = selectedAgent(state);
      const level = TRUST_LEVELS[state.trustChoice]!;
      state.mode = "roster";
      if (agent) {
        void act(async () => {
          await client.setTrust(agent.name, level);
          await loadRoster();
          return `${agent.name} → ${level}.`;
        });
      } else {
        draw();
      }
    }
  }

  /** Advance past the current proposal; leave review when the batch is exhausted. */
  function advanceReview(note: string): void {
    if (state.proposalIndex + 1 >= state.proposals.length) {
      state.mode = "roster";
      state.proposals = [];
      state.proposalIndex = 0;
      state.status = `${note} Review complete.`;
    } else {
      state.proposalIndex += 1;
      state.status = note;
    }
  }

  function handleReviewKey(key: Key): void {
    if (key.name === "escape") {
      state.mode = "roster";
      state.proposals = [];
      return draw();
    }
    const p = state.proposals[state.proposalIndex];
    // Save to the agent the batch belongs to (captured at reflect time), NEVER the
    // live selection — accepting must not write one agent's memory under another.
    const agentName = state.reviewAgent;
    if (!p || !agentName) {
      state.mode = "roster";
      return draw();
    }
    if (key.name === "r") {
      advanceReview("Rejected.");
      return draw();
    }
    if (key.name === "e") {
      state.editBuffer = p.content;
      state.mode = "editing";
      return draw();
    }
    if (key.name === "a") {
      void act(async () => {
        await client.saveMemory(agentName, {
          memoryType: p.memoryType,
          content: p.content,
          confidence: p.confidence,
          sourceRunId: p.sourceRunId,
        });
        advanceReview("Saved.");
      });
    }
  }

  function handleEditKey(key: Key): void {
    if (key.name === "escape") {
      state.mode = "review";
      return draw();
    }
    if (key.name === "backspace") {
      state.editBuffer = state.editBuffer.slice(0, -1);
      return draw();
    }
    if (key.name === "enter") {
      const p = state.proposals[state.proposalIndex];
      const agentName = state.reviewAgent; // the batch's agent, not the live selection
      const content = state.editBuffer.trim();
      state.mode = "review";
      if (!p || !agentName || content.length === 0) {
        state.status = "Empty edit — not saved.";
        return draw();
      }
      void act(async () => {
        await client.saveMemory(agentName, {
          memoryType: p.memoryType,
          content,
          confidence: p.confidence,
          sourceRunId: p.sourceRunId,
        });
        advanceReview("Saved (edited).");
      });
      return;
    }
    // A printable character (no ctrl, single char) extends the buffer.
    if (!key.ctrl && key.sequence.length === 1 && key.sequence >= " ") {
      state.editBuffer += key.sequence;
      draw();
    }
  }

  let offKey: (() => void) | undefined;
  let offResize: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    // Enter the alternate screen and raw mode INSIDE the try, so the finally always
    // restores the terminal — even if setRawMode throws on an unusual TTY or a custom
    // embedding, AFTER the alternate screen was already entered. Nothing is drawn to
    // the normal screen before the switch.
    term.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
    term.setRawMode(true);
    offKey = term.onKey((key) => handleKey(key));
    offResize = term.onResize(draw);
    // Live polling — refresh the roster + detail on a fixed cadence so activity, trust
    // changes, and new pending actions appear without a keystroke. Skipped while a
    // modal/edit is open, or an action is in flight, so a poll never clobbers input.
    timer = setInterval(() => {
      if (!stopped && state.mode === "roster" && !state.busy) {
        void act(async () => {
          await loadRoster();
          await loadDetail();
        });
      }
    }, refreshMs);
    // Initial load (its `act` draws the first frame onto the alternate screen).
    await act(async () => {
      await loadRoster();
      await loadDetail();
    });
    await quit;
  } finally {
    // Belt and suspenders: suppress any further draws no matter how the loop exited
    // (a quit key, or a throw), so the restore writes below are the last thing the
    // terminal receives and no late `act` paints over the normal screen.
    stopped = true;
    if (timer) clearInterval(timer);
    offKey?.();
    offResize?.();
    // Best-effort raw-mode restore: on a TTY where setRawMode throws, don't let it
    // skip the screen/cursor restore below — getting back to the normal screen with a
    // visible cursor is the more important recovery.
    try {
      term.setRawMode(false);
    } catch {
      // ignore — the screen restore still runs
    }
    term.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  }
}
