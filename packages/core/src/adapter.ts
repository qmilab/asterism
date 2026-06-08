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

/** What a scoped tool hands back after executing. */
export interface ToolResult {
  /** Text returned to the model. */
  output: string;
  /** True when the tool failed; the model sees this as an error result. */
  isError?: boolean;
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

/** Build a frozen, read-only registry from an explicit set of scoped tools. */
export function createToolRegistry(tools: readonly ScopedTool[]): ToolRegistry {
  const snapshot = Object.freeze([...tools]);
  return { list: () => snapshot };
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
 * A single lifecycle event emitted during a run. JSON-serializable and free of
 * secret values — the kernel may append it to the event log verbatim.
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
