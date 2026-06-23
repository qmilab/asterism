// @qmilab/asterism-adapter-lodestar — an OPTIONAL cognition layer that wraps a
// RuntimeAdapter to record an auditable epistemic trace of an agent's run via
// Lodestar (github.com/qmilab/lodestar).
//
// This is the ONLY package permitted to import Lodestar (`@qmilab/lodestar-*`),
// mirroring the adapter-pi rule for Pi (golden rule 6: replaceable substrate). The
// rest of the codebase speaks only core's neutral vocabulary; the host (the CLI)
// wires this in lazily, and only for an agent that opted in, so the default install
// never loads Lodestar.
//
// OBSERVE-ONLY. The wrapper RECORDS what a run did; it never gates. Asterism's
// kernel stays the sole trust authority and the sole owner of the destructive-action
// gate (golden rules 2, 4) — this layer adds a trace, never a second gate. It is
// handed no store, no credential reader, and no memory writer: it decorates the
// kernel-scoped tool registry and writes a log, nothing more.
//
// REFERENCES-ONLY (slice 1). The trace records, per tool call, the tool NAME, an
// invocation id, the output's byte length + a KEYED fingerprint, and whether it
// errored — NEVER the raw input arguments or the raw output text. The fingerprint is
// an HMAC under a per-run random key (minted in memory, never persisted), NOT a bare
// hash: a plain digest of a low-entropy output (a short token, a yes/no) could be
// dictionary-attacked offline by anyone who can read the trace, so a bare hash would
// quietly break the no-leak property. This mirrors the kernel's own `actionFingerprint`
// (a keyed HMAC) discipline, keeping the trace consistent with Asterism's event log
// ("references, never values"). Content-bearing capture behind a redaction boundary is
// a deliberate later slice.
//
// ISOLATION + INTEGRITY. The trace is written to a HOST-CONTROLLED root the host passes
// in (`traceRoot`), NEVER under the agent's own `workspaceDir`: the workspace is
// agent-writable (its file tools can create or overwrite files there), so a trace stored
// inside it could be disabled or tampered with by the very agent it audits. The host puts
// the root OUTSIDE every agent workspace (the CLI uses the install home's `traces/`), and
// events are partitioned by `project_id = the agent's id`, so one agent's trace is never
// reachable through another's. The wrapper never sees a store or a credential; the agent
// id and the trace root arrive as explicit options from the host that resolved the agent.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { EventLogReader, EventLogWriter } from "@qmilab/lodestar-event-log";
import type { EventEnvelope, Observation } from "@qmilab/lodestar-core";
import { projectChain, renderReport } from "@qmilab/lodestar-trace";
import { createToolRegistry } from "@qmilab/asterism-core";
import type {
  RunHandle,
  RunRequest,
  RuntimeAdapter,
  ScopedTool,
  ToolResult,
} from "@qmilab/asterism-core";

/** The schema key the trace stamps on each tool-result observation. */
const TOOL_RESULT_SCHEMA = "asterism.tool_result@1";
/** Semver of the `observation.recorded` event shape this writer emits. */
const EVENT_SCHEMA_VERSION = "1.0.0";

export interface LodestarWrapOptions {
  /**
   * The agent's id, used as the Lodestar `project_id` so the trace is partitioned per
   * agent. Supplied by the host (which already resolved the agent) — never read from the
   * `RunRequest`, which carries no `agentId` by contract.
   */
  agentId: string;
  /**
   * The HOST-controlled directory the trace is written under (the event-log root). It
   * MUST be OUTSIDE the agent's tool-writable workspace — otherwise the agent's own file
   * tools could disable or tamper with its audit trail. The CLI passes the install home's
   * `traces/` dir; events land under `${traceRoot}/${agentId}/`.
   */
  traceRoot: string;
}

/**
 * Records a references-only epistemic trace for ONE run: one `observation.recorded`
 * event per tool call, written to the run's confined workspace log. Best-effort by
 * design — a recording failure is swallowed by the caller so it can never break the
 * run (observe-only: the trace is a side record, never on the critical path).
 */
class TraceRecorder {
  private readonly writer: EventLogWriter;
  /**
   * A per-run random key for the output fingerprint — minted in memory, NEVER persisted.
   * It salts the HMAC so the fingerprint cannot be dictionary-attacked offline (an
   * attacker who can read the trace does not have the key) and cannot be correlated
   * across runs (each run mints its own). Mirrors the kernel's `actionFingerprint` key.
   */
  private readonly outputKey: Buffer = randomBytes(32);

  constructor(
    private readonly agentId: string,
    private readonly sessionId: string,
    logRoot: string,
  ) {
    this.writer = new EventLogWriter(logRoot);
  }

  /** Record a completed tool call — references only (name, output size, keyed fingerprint, error flag). */
  async recordResult(tool: string, result: ToolResult): Promise<void> {
    const output = result.output ?? "";
    await this.append(tool, {
      tool,
      output_bytes: Buffer.byteLength(output, "utf8"),
      // A KEYED fingerprint under the per-run key — never a bare hash (see `outputKey`).
      // Reveals only whether an output recurred WITHIN this run; it is non-reversible.
      output_fingerprint: createHmac("sha256", this.outputKey)
        .update(output)
        .digest("hex")
        .slice(0, 32),
      is_error: result.isError === true,
    });
  }

  /** Record a tool call that threw — the invocation happened; the outcome was an error. */
  async recordThrow(tool: string): Promise<void> {
    await this.append(tool, { tool, threw: true, is_error: true });
  }

  /**
   * Append one `observation.recorded` event. `payload` is a references-only summary —
   * NEVER raw arguments or output text. The observation is stamped `internal` and
   * `raw`; it is a record of "tool X ran and returned N bytes", not the content.
   */
  private async append(tool: string, summary: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    const observation: Observation = {
      id: randomUUID(),
      schema: TOOL_RESULT_SCHEMA,
      payload: summary,
      source: { tool, invocation_id: randomUUID(), captured_at: now },
      context: { session_id: this.sessionId, project_id: this.agentId, actor_id: this.agentId },
      trust: "raw",
      sensitivity: "internal",
    };
    await this.writer.append({
      id: randomUUID(),
      type: "observation.recorded",
      schema_version: EVENT_SCHEMA_VERSION,
      project_id: this.agentId,
      session_id: this.sessionId,
      actor_id: this.agentId,
      timestamp: now,
      causal_parent_ids: [],
      payload: observation,
      versions: {},
    });
  }
}

/**
 * Wrap a single {@link ScopedTool} so its result is recorded after it runs. The REAL
 * (kernel-scoped) `execute` runs unchanged — the wrapper only observes it — so the
 * decorator can never widen capability or reach what the closure holds (a credential,
 * the network): golden rule 2 holds. Recording is awaited (so the trace is durable and
 * ordered) but its failures are swallowed: an observe-only side record must never break
 * the run.
 */
function wrapTool(tool: ScopedTool, recorder: TraceRecorder): ScopedTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (invocation, signal) => {
      let result: ToolResult;
      try {
        result = await tool.execute(invocation, signal);
      } catch (err) {
        await recorder.recordThrow(tool.name).catch(() => {});
        throw err;
      }
      await recorder.recordResult(tool.name, result).catch(() => {});
      return result;
    },
  };
}

/**
 * Wrap a {@link RuntimeAdapter} so each run records a references-only Lodestar trace
 * to its confined workspace. The inner adapter (e.g. Pi) drives the loop UNCHANGED —
 * this decorator only swaps the tool registry for one whose tools record themselves.
 * Returns a `RuntimeAdapter`; nothing about the run's behaviour changes except that a
 * trace is written. A fresh `session_id` is minted per run, so each run is its own
 * Lodestar session within the agent's project.
 */
export function wrapWithLodestar(
  inner: RuntimeAdapter,
  options: LodestarWrapOptions,
): RuntimeAdapter {
  return {
    run(request: RunRequest): RunHandle {
      // The trace root is the HOST-provided dir (off the agent-writable workspace), not
      // anything derived from `request.workspaceDir`.
      const recorder = new TraceRecorder(options.agentId, randomUUID(), options.traceRoot);
      const wrappedTools = request.tools.list().map((tool) => wrapTool(tool, recorder));
      return inner.run({ ...request, tools: createToolRegistry(wrappedTools) });
    },
  };
}

/**
 * Render an agent's recorded trace as a Lodestar markdown trust report, or `undefined`
 * when the agent has no trace yet (never opted in, or no tool calls recorded). Reads only
 * the agent's own `project_id` partition under the host trace root — it cannot reach
 * another agent's trace. `traceRoot` is the same host-controlled root the wrapper wrote to
 * (the install home's `traces/`), NOT the agent workspace. Used by `asterism trace`.
 */
export async function renderTrace(
  traceRoot: string,
  agentId: string,
): Promise<string | undefined> {
  const reader = new EventLogReader(traceRoot);
  // `readAll` returns [] for a missing log directory (an agent that never recorded a
  // trace) — that is the empty-events case below, NOT an error. A THROW here is a real
  // failure (a corrupt NDJSON line, a schema mismatch, an unreadable file) and is left
  // to propagate, so the caller can surface the corruption rather than masking it as
  // "no trace recorded". The caller (`asterism trace`) reports a read failure distinctly.
  const events = await reader.readAll(agentId);
  if (events.length === 0) return undefined;

  // Each run is its own Lodestar SESSION (a fresh session_id per run). Render one report
  // PER session and concatenate — never pass several sessions' events into one
  // `projectChain` call: Lodestar orders by the per-session `logical_clock` and labels the
  // projection with a single session id, so a mixed projection would interleave separate
  // runs and stamp them with the wrong session header. Group by session, order the groups
  // by their earliest project-global `seq` (the monotonic per-project counter), so runs
  // read oldest-first.
  const bySession = new Map<string, EventEnvelope[]>();
  for (const event of events) {
    const group = bySession.get(event.session_id);
    if (group) group.push(event);
    else bySession.set(event.session_id, [event]);
  }
  const ordered = [...bySession.entries()].sort(
    (a, b) => earliestSeq(a[1]) - earliestSeq(b[1]),
  );
  return ordered
    .map(([sessionId, sessionEvents]) => {
      const report = renderReport(
        projectChain(sessionEvents, { project_id: agentId, session_id: sessionId }),
      );
      // Lodestar's generic renderer prints each observation's source/schema/trust but NOT
      // our custom payload (the references we actually recorded). Append a compact per-call
      // summary so the audit shows what it captured — which tool ran, whether it succeeded,
      // and how much it returned — instead of dropping it at the read layer.
      const calls = toolCallLines(sessionEvents);
      return calls.length > 0 ? `${report}\n\nRecorded tool calls (${calls.length}):\n${calls.join("\n")}` : report;
    })
    .join("\n\n");
}

/** The earliest project-global sequence number in a session's events (its run's start order). */
function earliestSeq(events: readonly EventEnvelope[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const event of events) if (event.seq < min) min = event.seq;
  return min;
}

/** The references-only summary this layer stores in each observation's payload. */
interface ToolCallRef {
  tool?: unknown;
  output_bytes?: unknown;
  is_error?: unknown;
  threw?: unknown;
}

/**
 * Render the references we recorded for each tool call in a session — the audit detail
 * Lodestar's report omits. One numbered line per `observation.recorded`: the tool, its
 * status (`ok` / `error` for a non-throwing error result / `threw` for an exception), and
 * the output's byte length (a reference, never its contents). The fingerprint is kept in
 * the log for recurrence checks but not printed (it carries no human-readable signal).
 */
function toolCallLines(sessionEvents: readonly EventEnvelope[]): string[] {
  const lines: string[] = [];
  for (const event of sessionEvents) {
    if (event.type !== "observation.recorded") continue;
    const observation = event.payload as { payload?: ToolCallRef } | undefined;
    const ref = observation?.payload;
    if (!ref) continue;
    const tool = typeof ref.tool === "string" ? ref.tool : "(unknown)";
    const status = ref.threw === true ? "threw" : ref.is_error === true ? "error" : "ok";
    const bytes = typeof ref.output_bytes === "number" ? `${ref.output_bytes} bytes` : "—";
    lines.push(`  ${lines.length + 1}. ${tool}  [${status}]  ${bytes}`);
  }
  return lines;
}
