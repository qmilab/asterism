import { describe, expect, test } from "bun:test";
import { AsterismStore, createToolRegistry } from "@qmilab/asterism-core";
import type { RunEvent, RunRequest, ScopedTool } from "@qmilab/asterism-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PiAdapter } from "./index";

// --- Compile-time proof that the run contract carries no path to the store. ---
// If RunRequest ever grew a `store` / credential / memory / agentId key, the
// matching alias below would resolve to `never` and this file would fail to
// compile. The boundary is enforced by the type, not just by convention.
type AssertAbsent<K extends string> = K extends keyof RunRequest ? never : true;
const _noStore: AssertAbsent<"store"> = true;
const _noCredentials: AssertAbsent<"credentials"> = true;
const _noMemories: AssertAbsent<"memories"> = true;
const _noAgentId: AssertAbsent<"agentId"> = true;
void _noStore;
void _noCredentials;
void _noMemories;
void _noAgentId;

const MODEL = { provider: "test", id: "test-model", baseUrl: "http://localhost" };

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A canned LLM stream: emits one assistant text turn and stops. No network and
 * no API key — yet it drives Pi's real agent loop (events, tool dispatch,
 * settlement) end to end, exercising the path that matters for the adapter.
 */
function textStreamFn(text: string): StreamFn {
  const fn: StreamFn = (model) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: 0,
    };
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };
  return fn;
}

/** First turn requests a tool; the second turn returns text and stops. */
function toolThenTextStreamFn(
  toolName: string,
  args: Record<string, unknown>,
  finalText: string,
): StreamFn {
  let call = 0;
  const fn: StreamFn = (model) => {
    call += 1;
    const stream = createAssistantMessageEventStream();
    const base = {
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      timestamp: 0,
    } as const;
    if (call === 1) {
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: toolName, arguments: args }],
        stopReason: "toolUse",
        ...base,
      };
      stream.push({ type: "done", reason: "toolUse", message });
    } else {
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: finalText }],
        stopReason: "stop",
        ...base,
      };
      stream.push({ type: "done", reason: "stop", message });
    }
    return stream;
  };
  return fn;
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("PiAdapter — a run executes through the adapter", () => {
  test("a hard-coded trivial run produces output and a lifecycle event stream", async () => {
    const adapter = new PiAdapter({
      model: MODEL,
      streamFn: textStreamFn("pong from canned stream"),
    });

    const handle = adapter.run({
      workspaceDir: "/tmp/agent-ws",
      input: "ping",
      tools: createToolRegistry([]),
    });

    const events = await collect(handle.events);
    const output = await handle.output;

    expect(output.status).toBe("done");
    expect(output.text).toBe("pong from canned stream");

    const types = events.map((e) => e.type);
    expect(types).toContain("message_end");
    expect(types[0]).toBe("agent_start");
    expect(types[types.length - 1]).toBe("agent_end");
  });

  test("a kernel-scoped tool executes through Pi's loop", async () => {
    let executedArgs: unknown = null;
    const echo: ScopedTool = {
      name: "echo",
      description: "echo the input back",
      inputSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      execute: ({ args }) => {
        executedArgs = args;
        return { output: "echoed" };
      },
    };

    const adapter = new PiAdapter({
      model: MODEL,
      streamFn: toolThenTextStreamFn("echo", { msg: "hi" }, "finished"),
    });

    const handle = adapter.run({
      workspaceDir: "/tmp/agent-ws",
      input: "use the echo tool",
      tools: createToolRegistry([echo]),
    });

    const events = await collect(handle.events);
    const output = await handle.output;

    expect(executedArgs).toEqual({ msg: "hi" });
    expect(output.status).toBe("done");
    expect(output.text).toBe("finished");
    expect(events.map((e) => e.type)).toContain("tool_execution_end");
  });
});

describe("PiAdapter — the adapter cannot reach a credential or memory store", () => {
  test("a real secret + private memory never reach the run, which is handed only workspace + scoped tools", async () => {
    // A populated kernel store: the agent has a secret and a private memory.
    const store = AsterismStore.open(":memory:");
    const agent = store.agents.create({
      name: "work",
      role: "careful consultant",
      soulRef: "careful-consultant",
      workspaceDir: "/tmp/work-ws",
      trustLevel: "propose",
    });
    const SECRET_REF = "secret://work/API_SECRET";
    const PRIVATE_MEMORY = "PRIVATE_MEMORY_DO_NOT_LEAK_42";
    store.credentials.create(agent.id, { key: "API_SECRET", valueRef: SECRET_REF });
    store.memories.create(agent.id, {
      memoryType: "semantic",
      content: PRIVATE_MEMORY,
    });

    // The request is exactly what the kernel hands an adapter: a confined
    // workspace, the task, and a pre-scoped tool registry — no store at all.
    const noteTool: ScopedTool = {
      name: "note",
      description: "record a note",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      execute: ({ args }) => ({ output: `noted ${JSON.stringify(args)}` }),
    };
    const request: RunRequest = {
      workspaceDir: agent.workspaceDir,
      input: "summarize the work",
      tools: createToolRegistry([noteTool]),
    };

    // Structural proof: nothing on the request reaches the store or its scope.
    expect("store" in request).toBe(false);
    expect("credentials" in request).toBe(false);
    expect("memories" in request).toBe(false);
    expect("agentId" in request).toBe(false);
    // The registry is read-only — the adapter cannot widen its own capability.
    expect(Object.isFrozen(request.tools.list())).toBe(true);
    expect((request.tools as Record<string, unknown>).add).toBeUndefined();

    const adapter = new PiAdapter({ model: MODEL, streamFn: textStreamFn("done") });
    const handle = adapter.run(request);
    const events = await collect(handle.events);
    const output = await handle.output;

    // Behavioral proof: the secret value and private memory surface nowhere,
    // because the adapter was never given a way to read them.
    const transcript = JSON.stringify(events) + output.text;
    expect(transcript).not.toContain(SECRET_REF);
    expect(transcript).not.toContain("API_SECRET");
    expect(transcript).not.toContain(PRIVATE_MEMORY);
    expect(output.status).toBe("done");

    // The adapter instance exposes no store handle of any kind.
    const surface = adapter as Record<string, unknown>;
    expect(surface.store).toBeUndefined();
    expect(surface.credentials).toBeUndefined();
    expect(surface.memories).toBeUndefined();

    store.close();
  });
});
