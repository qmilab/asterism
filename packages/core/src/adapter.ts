// The RuntimeAdapter contract — the seam between the kernel and the agent
// execution substrate (Pi today, replaceable tomorrow).
//
// The kernel resolves an agent's identity, trust level, and session into a
// *pre-scoped* tool registry and a confined workspace path, then hands ONLY
// those to the adapter. By construction this contract carries no store, no
// credential reader, and no memory writer: an adapter implementing it has no
// surface through which to read a secret or persist a memory. That denial is
// the whole point of the boundary — "Pi never sees raw capability."
//
// Nothing here references Pi. Core depends on neither the adapter nor Pi; the
// adapter package depends on core and implements this interface.

/** JSON Schema describing a tool's input. Opaque data to the adapter. */
export type ToolInputSchema = Record<string, unknown>;

/** A single invocation the adapter forwards to a scoped tool. */
export interface ToolInvocation {
  /** Arguments the model produced for the call. */
  args: unknown;
}

/**
 * A single thing a tool established for certain about the world by running —
 * a reference about its OWN effect, never the raw content it touched. The shape
 * is a `subject / relation / object` triple so the kernel can record and reason
 * over it without parsing prose:
 *
 *   - `subject` — a controlled entity reference, NOT free text: `file:<workspace
 *     -relative-path>`, `dir:<path>`, `repo:<path>`. The closed prefix set keeps
 *     a fact pinned to an identifiable thing inside the agent's workspace.
 *   - `relation` — a controlled verb from a per-schema closed set (`size_bytes`,
 *     `exists`, …). The emitting tool owns the set; no free-text drift.
 *   - `object` — the value the relation asserts (`412`, `true`, `false`,
 *     `"main"`). A reference about an effect (a size, an existence flag), never a
 *     secret value and never the file's contents.
 *
 * Facts are screened by the redaction boundary (`redactObservation`) before they
 * are persisted, exactly like captured content: a path or value that trips a
 * secret rule is scrubbed in the fact too.
 */
export interface ObservedFact {
  subject: string;
  relation: string;
  object: unknown;
}

/**
 * A typed, structured observation of one tool call's effect — the facts the tool
 * KNOWS it established, declared at the source. Structure comes from the tool (the
 * one component that knows its effect with certainty), never reverse-engineered
 * from the human-readable `output`. `schema` names the fact shape (e.g.
 * `asterism.fs.write@1`) so a reader can tell which closed relation set applies.
 */
export interface ToolObservation {
  schema: string;
  facts: readonly ObservedFact[];
}

/** What a scoped tool hands back after executing. */
export interface ToolResult {
  /** Text returned to the model. */
  output: string;
  /** True when the tool failed; the model sees this as an error result. */
  isError?: boolean;
  /**
   * An OPTIONAL structured record of what this call established about the world,
   * alongside the human-readable `output`. A tool with no structured effect (or a
   * failed call) omits it — fully back-compatible: a result without an
   * `observation` behaves byte-for-byte as before. The kernel screens it through
   * the redaction boundary before it reaches any persisted trace; it is an extra
   * OUTPUT channel and grants the substrate nothing.
   */
  observation?: ToolObservation;
}

/**
 * A tool the kernel has already approved for this run. The adapter can read its
 * descriptor and call `execute` — nothing more. It cannot widen the schema,
 * discover other tools, or reach whatever the closure uses internally (a
 * credential, the network): those live on the kernel's side of `execute`.
 */
export interface ScopedTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute: (
    invocation: ToolInvocation,
    signal?: AbortSignal,
  ) => Promise<ToolResult> | ToolResult;
}

/**
 * The pre-scoped tool registry handed to a run. Read-only: the adapter can
 * enumerate and call exactly the tools the kernel placed here, and no others.
 * There is deliberately no `add`/`remove` — the adapter cannot grow its own
 * capability.
 */
export interface ToolRegistry {
  list(): readonly ScopedTool[];
}

/** Recursively freeze a plain-data value (objects/arrays). Functions are left as-is. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Build a deeply-frozen, read-only registry from an explicit set of scoped
 * tools. The snapshot is independent of the caller's objects and immutable: the
 * substrate can neither grow the set nor mutate a tool's descriptor or
 * `inputSchema` to widen what the model is offered, and reused `ScopedTool`
 * instances cannot bleed state across runs. Only `execute` is kept by reference
 * — it is the kernel's closure, opaque to the adapter.
 */
export function createToolRegistry(tools: readonly ScopedTool[]): ToolRegistry {
  const snapshot: readonly ScopedTool[] = Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        name: tool.name,
        description: tool.description,
        inputSchema: deepFreeze(structuredClone(tool.inputSchema)),
        execute: tool.execute,
      }),
    ),
  );
  return Object.freeze({ list: () => snapshot });
}

/**
 * Everything an adapter needs to run one task — and nothing more.
 *
 * Note what is absent: no `AsterismStore`, no credential repository, no memory
 * repository, no `agentId` to query them with. The adapter receives a confined
 * workspace, the task, and the kernel-scoped tools. That is the contract that
 * keeps the substrate from touching secrets or writing memory.
 */
export interface RunRequest {
  /** The agent's confined working directory. */
  workspaceDir: string;
  /** The task to perform. */
  input: string;
  /** Exactly the tools the kernel approved for this run. */
  tools: ToolRegistry;
  /** How the run is framed (soul/role → system prompt). Optional in Phase 0. */
  systemPrompt?: string;
  /** Cooperative cancellation for the run. */
  signal?: AbortSignal;
}

/**
 * A single lifecycle event emitted during a run. Payloads are content-free,
 * JSON-serializable references — event type, counts, tool names/ids — never
 * transcript text or secret values. The agent's actual output is delivered
 * through `RunOutput`, not the event stream, so the kernel may append these to
 * the event log verbatim without leaking what a run read or produced.
 */
export interface RunEvent {
  type: string;
  payload: unknown;
}

export type RunResultStatus = "done" | "failed";

/** The structured result of a finished run. */
export interface RunOutput {
  status: RunResultStatus;
  /** The agent's final text output. */
  text: string;
  /** Present when `status === "failed"`. */
  error?: string;
}

/**
 * Handle to an in-flight run: a live event stream plus the structured final
 * output. Consume `events` for progress; await `output` for the result. The two
 * settle independently — awaiting `output` never requires draining `events`.
 */
export interface RunHandle {
  events: AsyncIterable<RunEvent>;
  output: Promise<RunOutput>;
}

/**
 * The agent execution substrate, behind an interface. It receives a confined
 * workspace path and a pre-scoped tool registry; it returns a run's events and
 * structured output. It is handed no credential reader and no memory writer —
 * the contract itself denies that capability.
 */
export interface RuntimeAdapter {
  run(request: RunRequest): RunHandle;
}
