// @qmilab/asterism-adapter-pi — the RuntimeAdapter implemented over Pi.
//
// This is the ONLY package permitted to import Pi (`@earendil-works/pi-*`). It
// receives a confined workspace path and a kernel-scoped tool registry, runs
// Pi's agent loop, and returns a neutral event stream plus structured output.
// It is handed no credential reader and no memory writer — the RuntimeAdapter
// contract from core does not carry them, so this implementation cannot reach
// them. Everything Pi-specific stays inside this file; the rest of the codebase
// speaks only core's neutral vocabulary.

import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import type {
  RunEvent,
  RunHandle,
  RunOutput,
  RunRequest,
  RuntimeAdapter,
  ScopedTool,
} from "@qmilab/asterism-core";

/** Minimal framing for a Phase 0 run; soul/role wiring arrives in a later step. */
const DEFAULT_SYSTEM_PROMPT = "You are an Asterism agent. Complete the task.";

/**
 * Plain-data description of the model Pi should drive. Kept Pi-free so the host
 * wiring (e.g. the CLI) can configure the adapter without importing Pi.
 */
export interface PiModelConfig {
  /** Provider id, e.g. "openai", "anthropic". */
  provider: string;
  /** Model id, e.g. "gpt-4o-mini". */
  id: string;
  /** Base URL for the provider endpoint. */
  baseUrl: string;
  /** Provider API kind. Default "openai-completions". */
  api?: string;
  /** Context window in tokens. Default 128_000. */
  contextWindow?: number;
  /** Max output tokens. Default 4_096. */
  maxTokens?: number;
}

export interface PiAdapterOptions {
  /** Which model the agent loop drives. */
  model: PiModelConfig;
  /**
   * LLM stream function. Defaults to Pi's real provider call (`streamSimple`).
   * Inject a canned stream to run offline or in tests. This is the only
   * Pi-typed option; the live host-wiring path never sets it.
   */
  streamFn?: StreamFn;
  /**
   * Resolves the LLM provider's API key. This is *runtime infrastructure*
   * supplied by the host wiring — never an agent-scoped credential.
   */
  getApiKey?: (
    provider: string,
  ) => string | undefined | Promise<string | undefined>;
}

/** Build the Pi `Model` Pi's loop expects from plain config. */
function toPiModel(cfg: PiModelConfig): Model<Api> {
  return {
    id: cfg.id,
    name: cfg.id,
    api: cfg.api ?? "openai-completions",
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow ?? 128_000,
    maxTokens: cfg.maxTokens ?? 4_096,
  };
}

/** Map one kernel-scoped tool onto a Pi `AgentTool`. */
function toPiTool(tool: ScopedTool): AgentTool {
  const hasSchema = Object.keys(tool.inputSchema).length > 0;
  // `Type.Unsafe` wraps the kernel's JSON Schema as a passthrough TypeBox schema
  // (it is forwarded verbatim to the provider); empty schema → an empty object.
  const parameters = hasSchema ? Type.Unsafe(tool.inputSchema) : Type.Object({});
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters,
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> => {
      const result = await tool.execute({ args: params }, signal);
      // Pi's contract: throw on failure rather than encoding it in content.
      if (result.isError) throw new Error(result.output);
      const content: TextContent[] = [{ type: "text", text: result.output }];
      return { content, details: undefined };
    },
  };
}

/** Concatenate the text content of a Pi message. */
function messageText(message: AgentMessage): string {
  if (!("role" in message)) return "";
  if (message.role === "assistant") {
    return message.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  if (message.role === "user") {
    const { content } = message;
    if (typeof content === "string") return content;
    return content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

/** The text of the last assistant message in a transcript, if any. */
function lastAssistantText(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && "role" in message && message.role === "assistant") {
      return messageText(message);
    }
  }
  return "";
}

/** A failure reason if the last assistant turn errored or aborted, else undefined. */
function lastAssistantFailure(
  messages: readonly AgentMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && "role" in message && message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return message.errorMessage ?? `assistant stopped: ${message.stopReason}`;
      }
      return undefined;
    }
  }
  return undefined;
}

/** Translate a Pi lifecycle event into a neutral, log-safe RunEvent. */
function toRunEvent(event: AgentEvent): RunEvent {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
      return { type: event.type, payload: {} };
    case "message_start":
    case "message_end":
      return { type: event.type, payload: { text: messageText(event.message) } };
    case "message_update":
      return {
        type: event.type,
        payload: { event: event.assistantMessageEvent.type },
      };
    case "turn_end":
      return { type: event.type, payload: { text: messageText(event.message) } };
    case "agent_end":
      return { type: event.type, payload: { messages: event.messages.length } };
    case "tool_execution_start":
    case "tool_execution_update":
      return {
        type: event.type,
        payload: { tool: event.toolName, toolCallId: event.toolCallId },
      };
    case "tool_execution_end":
      return {
        type: event.type,
        payload: {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
        },
      };
    default: {
      const unknownEvent = event as { type: string };
      return { type: unknownEvent.type, payload: {} };
    }
  }
}

/**
 * A single-producer, single-consumer async queue bridging Pi's callback-based
 * `subscribe` into an `AsyncIterable<RunEvent>`. Pushed events that arrive
 * before a consumer attaches are buffered; `close` ends iteration once drained.
 */
class RunEventQueue implements AsyncIterable<RunEvent> {
  private readonly buffer: RunEvent[] = [];
  private readonly waiters: ((r: IteratorResult<RunEvent>) => void)[] = [];
  private closed = false;

  push(event: RunEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.buffer.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      } else if (this.closed) {
        return;
      } else {
        const next = await new Promise<IteratorResult<RunEvent>>((resolve) =>
          this.waiters.push(resolve),
        );
        if (next.done) return;
        yield next.value;
      }
    }
  }
}

/**
 * RuntimeAdapter over Pi. Constructed once with model + (optional) stream
 * wiring; each `run` spins a fresh Pi `Agent` confined to the request's scope.
 */
export class PiAdapter implements RuntimeAdapter {
  private readonly model: Model<Api>;
  private readonly streamFn?: StreamFn;
  private readonly getApiKey?: (
    provider: string,
  ) => string | undefined | Promise<string | undefined>;

  constructor(options: PiAdapterOptions) {
    this.model = toPiModel(options.model);
    if (options.streamFn) this.streamFn = options.streamFn;
    if (options.getApiKey) this.getApiKey = options.getApiKey;
  }

  run(request: RunRequest): RunHandle {
    // `request.workspaceDir` is part of the contract but not yet consumed here:
    // Phase 0 confinement is logical, enforced by the kernel-scoped tools whose
    // closures bind the workspace. It will anchor Pi's filesystem tools / cwd as
    // those land — and OS-level containment is a later phase, not this one.
    const events = new RunEventQueue();
    let resolveOutput!: (output: RunOutput) => void;
    const output = new Promise<RunOutput>((resolve) => {
      resolveOutput = resolve;
    });
    let settled = false;
    const settle = (result: RunOutput): void => {
      if (settled) return;
      settled = true;
      resolveOutput(result);
    };

    const tools = request.tools.list().map(toPiTool);
    const agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        model: this.model,
        tools,
      },
      ...(this.streamFn ? { streamFn: this.streamFn } : {}),
      ...(this.getApiKey ? { getApiKey: this.getApiKey } : {}),
    });

    agent.subscribe((event) => {
      events.push(toRunEvent(event));
      if (event.type === "agent_end") {
        const text = lastAssistantText(event.messages);
        const failure = lastAssistantFailure(event.messages);
        if (failure) settle({ status: "failed", text, error: failure });
        else settle({ status: "done", text });
      }
    });

    if (request.signal) {
      if (request.signal.aborted) agent.abort();
      else
        request.signal.addEventListener("abort", () => agent.abort(), {
          once: true,
        });
    }

    // Pi's `prompt` resolves once the run is idle (after agent_end listeners
    // settle). It does not throw for model failures — those arrive as an errored
    // assistant message — so a thrown error here is an unexpected runtime fault.
    void agent
      .prompt(request.input)
      .then(() => {
        if (!settled) {
          settle({ status: "done", text: lastAssistantText(agent.state.messages) });
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        events.push({ type: "run_error", payload: { error: message } });
        settle({ status: "failed", text: "", error: message });
      })
      .finally(() => {
        events.close();
      });

    return { events, output };
  }
}
