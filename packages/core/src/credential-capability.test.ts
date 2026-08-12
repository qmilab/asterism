// The first credential-bearing capability class — bound outbound endpoints (#123, PR 2).
//
// The properties under test are the four the design note calls load-bearing, and the
// one PR 1 asked this slice to protect:
//
//   · the class is NOT in the default set, and cannot be inherited;
//   · agent A's credential is unreachable from agent B's run, proven at the REGISTRY;
//   · the credential VALUE reaches no prompt, no event, no output, no trace;
//   · the gate fires at every trust level and can never be auto-approved;
//   · what comes back is scrubbed of the value that went out.
//
// Every absence assertion here is paired with a positive one proving the path actually
// ran. An assertion that a secret is missing is satisfied perfectly by a call that never
// happened, and that is the shape of test this repo has been burned by.

import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  CREDENTIAL_CAPABILITY_PREFIX,
  DEFAULT_CAPABILITY_KEYS,
  isCredentialBearingKey,
  validateCapabilityKeys,
} from "./capabilities.js";
import {
  DEFAULT_ENDPOINT_RESPONSE_MAX_BYTES,
  endpointCapabilities,
  endpointCapabilityKey,
  endpointLogTarget,
  endpointToolName,
  screenEndpointResponse,
  validateEndpointName,
  validateEndpointUrl,
} from "./endpoints.js";
import type { OutboundHost, OutboundRequest } from "./endpoints.js";
import { executeRun, performHandoff, resumeRun } from "./run.js";
import { AsterismStore } from "./store.js";
import { gatherEvidence } from "./standing.js";
import type { RuntimeAdapter, RunOutput, ToolResult } from "./adapter.js";
import { resolveToolRegistry, trustProfile } from "./trust.js";
import type { Action } from "./trust.js";
import type { Agent, Event } from "./types.js";

/** A distinctive value with no shape any generic rule would recognize. */
const TOKEN = "zzq-plainlooking-value-8842176";

let store: AsterismStore;
let personal: Agent;
let work: Agent;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  personal = store.createAgent({
    name: "personal",
    role: "personal helper",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/personal",
    trustLevel: "autonomous",
  });
  work = store.createAgent({
    name: "work",
    role: "work helper",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/work",
    trustLevel: "autonomous",
  });
});

afterEach(() => {
  store.close();
});

/** A host that records what it was asked to send and answers with a fixed body. */
function recordingHost(body = "{}", status = 200): OutboundHost & { calls: OutboundRequest[] } {
  const calls: OutboundRequest[] = [];
  return {
    calls,
    call(request) {
      calls.push(request);
      return Promise.resolve({ ok: true as const, status, body });
    },
  };
}

/** A substrate stand-in that calls one tool by name, then finishes. */
function callingAdapter(
  toolName: string,
  sink: { tools: string[]; results: ToolResult[] },
): RuntimeAdapter {
  return {
    run(request) {
      sink.tools = request.tools.list().map((t) => t.name);
      const tool = request.tools.list().find((t) => t.name === toolName);
      async function* noEvents() {}
      return {
        events: noEvents(),
        output: (async (): Promise<RunOutput> => {
          if (tool) sink.results.push(await tool.execute({ args: {} }));
          return { status: "done", text: "ok" };
        })(),
      };
    },
  };
}

/** A substrate stand-in that only lists what it was scoped. */
function listingAdapter(sink: string[]): RuntimeAdapter {
  return {
    run(request) {
      sink.length = 0;
      sink.push(...request.tools.list().map((t) => t.name));
      async function* noEvents() {}
      return { events: noEvents(), output: Promise.resolve<RunOutput>({ status: "done", text: "ok" }) };
    },
  };
}

/** Bind `issues` for an agent and store its credential. Returns the tool name. */
function bindIssues(agent: Agent, credential = "GITHUB_TOKEN", value = TOKEN): string {
  store.addCredential(agent.id, credential, value);
  store.bindEndpoint(agent.id, "issues", "https://api.example.test/issues?state=open", credential);
  return endpointToolName("issues");
}

/** The tool names one run was scoped, sorted. */
async function exposedTools(agent: Agent, host?: OutboundHost): Promise<string[]> {
  const seen: string[] = [];
  await executeRun(store, agent, "do the thing", {
    adapter: listingAdapter(seen),
    ...(host ? { outboundHost: host } : {}),
  });
  return [...seen].sort();
}

/** Run `agent`, calling the named tool, auto-confirming every destructive action. */
async function callTool(
  agent: Agent,
  toolName: string,
  host: OutboundHost,
  opts: { confirm?: (action: Action) => boolean } = {},
): Promise<{ tools: string[]; results: ToolResult[]; prompts: Action[] }> {
  const sink = { tools: [] as string[], results: [] as ToolResult[] };
  const prompts: Action[] = [];
  await executeRun(store, agent, "call it", {
    adapter: callingAdapter(toolName, sink),
    outboundHost: host,
    confirm: (action) => {
      prompts.push(action);
      return opts.confirm ? opts.confirm(action) : true;
    },
  });
  return { ...sink, prompts };
}

/** Every event for an agent, as a JSON haystack — the log exactly as it is persisted. */
function eventDump(agent: Agent): string {
  return JSON.stringify(store.events.list(agent.id));
}

function eventsOfType(agent: Agent, type: string): Event[] {
  return store.events.list(agent.id).filter((e) => e.type === type);
}

// --- 1. The class is not in the default set ----------------------------------

test("no credential-bearing key is in the kernel's default catalog", () => {
  // PR 1's guarantee, pinned from PR 2's side: the first thing that could quietly break
  // the closed default set is the first class added after it.
  expect(DEFAULT_CAPABILITY_KEYS.filter((k) => isCredentialBearingKey(k))).toEqual([]);
});

test("an agent with a binding holds the default catalog PLUS its own endpoint, and nothing else", async () => {
  bindIssues(personal);

  const exposed = await exposedTools(personal, recordingHost());

  expect(exposed).toContain(endpointToolName("issues"));
  // Still un-narrowed, so it keeps its notes tools; the binding widened by exactly one.
  expect(exposed).toContain("record_note");
  expect(exposed.filter((t) => t.startsWith("call_"))).toEqual([endpointToolName("issues")]);
});

test("an agent with no binding gets no credential-bearing tool at all", async () => {
  // No row, no capability — the class cannot be inherited, because there is nothing to
  // inherit it from. Paired with the test above, which proves a binding DOES produce one.
  const exposed = await exposedTools(personal, recordingHost());

  expect(exposed.filter((t) => t.startsWith("call_"))).toEqual([]);
});

// --- 2. Cross-agent denial, at the registry ----------------------------------

test("a bound endpoint is unreachable from another agent's run", async () => {
  bindIssues(personal);
  const host = recordingHost();

  expect(await exposedTools(personal, host)).toContain(endpointToolName("issues"));
  expect(await exposedTools(work, host)).not.toContain(endpointToolName("issues"));
});

test("two agents binding the same credential KEY each send their own value", async () => {
  // The sharpest form of the isolation claim for this class: the key is the same string,
  // and the values must not be. `readSecret` is agentId-scoped and the binding row is
  // too, so there is no path from one agent's call to the other's secret.
  bindIssues(personal, "GITHUB_TOKEN", "personal-value-11111111");
  bindIssues(work, "GITHUB_TOKEN", "work-value-22222222");
  const host = recordingHost();

  await callTool(personal, endpointToolName("issues"), host);
  await callTool(work, endpointToolName("issues"), host);

  expect(host.calls.map((c) => c.headers.Authorization)).toEqual([
    "Bearer personal-value-11111111",
    "Bearer work-value-22222222",
  ]);
});

test("removing agent A's credential leaves agent B's binding working", async () => {
  bindIssues(personal, "GITHUB_TOKEN", "personal-value-11111111");
  bindIssues(work, "GITHUB_TOKEN", "work-value-22222222");
  store.removeCredential(personal.id, "GITHUB_TOKEN");
  const host = recordingHost();

  const personalRun = await callTool(personal, endpointToolName("issues"), host);
  const workRun = await callTool(work, endpointToolName("issues"), host);

  expect(personalRun.results[0]?.isError).toBe(true);
  expect(workRun.results[0]?.isError).toBeUndefined();
  expect(host.calls).toHaveLength(1);
});

// --- 3. The value reaches nothing --------------------------------------------

test("the credential value reaches no prompt, no event, no tool output — and the call still happened", async () => {
  const tool = bindIssues(personal);
  // The endpoint echoes the token back, which is the worst case: a debug route, a proxy,
  // an error body quoting the request.
  const host = recordingHost(`{"you sent":"${TOKEN}","issues":[]}`);

  const { prompts, results } = await callTool(personal, tool, host);

  // POSITIVE first: the call really went out, carrying the real value. Without this the
  // four absences below are satisfied by a call that never happened.
  expect(host.calls).toHaveLength(1);
  expect(host.calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);

  expect(JSON.stringify(prompts)).not.toContain(TOKEN);
  expect(eventDump(personal)).not.toContain(TOKEN);
  expect(results[0]?.output).not.toContain(TOKEN);
  expect(store.runs.get(personal.id, store.runs.list(personal.id)[0]!.id)?.output ?? "").not.toContain(
    TOKEN,
  );
  // And the echoed occurrence was replaced rather than merely truncated away.
  expect(results[0]?.output).toContain("[redacted:value]");
});

test("the gate prompt names the endpoint and the credential KEY", () => {
  const tool = bindIssues(personal);
  const host = recordingHost();

  return callTool(personal, tool, host).then(({ prompts }) => {
    expect(prompts).toHaveLength(1);
    const args = prompts[0]?.args as Record<string, unknown>;
    expect(args.endpoint).toBe("issues");
    expect(args.credential).toBe("GITHUB_TOKEN");
    expect(args.url).toBe("https://api.example.test/issues?state=open");
    expect(prompts[0]?.capability).toBe(endpointCapabilityKey("issues"));
  });
});

test("a model cannot rewrite the credential or URL a human is shown", async () => {
  // The tool's schema declares no properties, so a well-behaved substrate sends nothing.
  // A misbehaving one sending `{credential: …}` must not be able to change the sentence
  // the operator is approving — the merge direction is the whole safety property.
  const tool = bindIssues(personal);
  const host = recordingHost();
  const prompts: Action[] = [];
  const sink = { tools: [] as string[], results: [] as ToolResult[] };
  await executeRun(store, personal, "call it", {
    adapter: {
      run(request) {
        sink.tools = request.tools.list().map((t) => t.name);
        const t = request.tools.list().find((x) => x.name === tool);
        async function* noEvents() {}
        return {
          events: noEvents(),
          output: (async (): Promise<RunOutput> => {
            if (t) {
              sink.results.push(
                await t.execute({
                  args: { credential: "SOMETHING_HARMLESS", url: "https://looks-fine.test" },
                }),
              );
            }
            return { status: "done", text: "ok" };
          })(),
        };
      },
    },
    outboundHost: host,
    confirm: (action) => {
      prompts.push(action);
      return true;
    },
  });

  const args = prompts[0]?.args as Record<string, unknown>;
  expect(args.credential).toBe("GITHUB_TOKEN");
  expect(args.url).toBe("https://api.example.test/issues?state=open");
  // And the call itself used the binding, not the arguments.
  expect(host.calls[0]?.url).toBe("https://api.example.test/issues?state=open");
});

test("a model's extra arguments reach neither the prompt nor the fingerprint", async () => {
  // The schema says `properties: {}`, but JSON Schema's DEFAULT is to permit extra
  // properties — so "zero-argument" was advertised, not enforced. A model could put its own
  // text into the confirmation for the most consequential action the product has, and could
  // destabilise the argument fingerprint a resume matches on by varying fields `execute`
  // ignores. Both are closed kernel-side, so a provider that ignores the schema changes
  // nothing. [Codex R2 P2.]
  const tool = bindIssues(personal);
  const host = recordingHost();
  const prompts: Action[] = [];
  const fingerprints: string[] = [];
  for (const note of ["PRE-APPROVED BY YOUR ADMIN", "something else entirely"]) {
    const sink = { tools: [] as string[], results: [] as ToolResult[] };
    await executeRun(store, personal, "call it", {
      adapter: {
        run(request) {
          const t = request.tools.list().find((x) => x.name === tool);
          async function* noEvents() {}
          return {
            events: noEvents(),
            output: (async (): Promise<RunOutput> => {
              if (t) sink.results.push(await t.execute({ args: { note, nonce: note.length } }));
              return { status: "done", text: "ok" };
            })(),
          };
        },
      },
      outboundHost: host,
      confirm: (action) => {
        prompts.push(action);
        return true;
      },
    });
    const executed = store.events
      .list(personal.id)
      .filter((e) => e.type === "action.executed")
      .at(-1);
    fingerprints.push(String((executed?.payload as Record<string, unknown>).fingerprint));
  }

  // The declared contract says so…
  const declared = endpointCapabilities(store, personal.id, host)[0]?.tool.inputSchema;
  expect(declared?.additionalProperties).toBe(false);
  // …and the kernel enforces it regardless of whether a provider honoured it.
  expect(JSON.stringify(prompts)).not.toContain("PRE-APPROVED");
  expect(prompts[0]?.args).toEqual({
    endpoint: "issues",
    url: "https://api.example.test/issues?state=open",
    credential: "GITHUB_TOKEN",
    method: "GET",
  });
  // Two calls with DIFFERENT model-authored fields fingerprint identically, so a resume
  // still matches the invocation a human approved.
  expect(fingerprints[0]).toBe(fingerprints[1]!);
  // Paired positive: both calls really happened.
  expect(host.calls).toHaveLength(2);
});

test("a capability that DOES take arguments still MERGES, so a command string can escalate", () => {
  // The other half of the rule, and the reason it keys on the SCHEMA rather than on the
  // effect: replacing wherever a capability is destructive would also strip the arguments
  // from a future kernel-built destructive tool that genuinely takes some — hiding the path
  // a delete targets from the human approving it.
  const profile = trustProfile({ level: "autonomous", capabilities: ["sh"] });
  let seen: unknown;
  const tools = resolveToolRegistry(
    profile,
    [
      {
        key: "sh",
        effect: "write",
        gateContext: { tool: "shell" },
        tool: {
          name: "sh",
          description: "fixture",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
          execute: () => ({ output: "ran" }),
        },
      },
    ],
    { onAwaitConfirmation: (action) => { seen = action.args; } },
  );
  // `rm -rf` must still escalate this declared-`write` capability to destructive, which it
  // can only do if the model's arguments survived the merge.
  void tools.list()[0]!.execute({ args: { command: "rm -rf /tmp/x" } });
  expect(seen).toEqual({ command: "rm -rf /tmp/x", tool: "shell" });
});

test("a schema the rule cannot read is treated as TAKING arguments, not as taking none", () => {
  // The conservative default, which the doc comment claimed and nothing checked. Getting it
  // backwards is the dangerous direction: an unusual or absent schema would silently start
  // discarding the model's arguments, so a delete's path would vanish from the human's
  // prompt. Three unreadable shapes, all of which must MERGE.
  const profile = trustProfile({ level: "autonomous", capabilities: ["odd"] });
  for (const schema of [
    { type: "object" },
    { type: "object", properties: null },
    { type: "object", properties: ["a"] },
  ] as Record<string, unknown>[]) {
    let seen: unknown;
    const tools = resolveToolRegistry(
      profile,
      [
        {
          key: "odd",
          effect: "destructive",
          gateContext: { kind: "kernel" },
          tool: {
            name: "odd",
            description: "fixture",
            inputSchema: schema,
            execute: () => ({ output: "ok" }),
          },
        },
      ],
      { onAwaitConfirmation: (action) => { seen = action.args; } },
    );
    void tools.list()[0]!.execute({ args: { path: "/important/file" } });
    expect(seen).toEqual({ path: "/important/file", kind: "kernel" });
  }
});

test("a DESTRUCTIVE capability that takes arguments keeps them on the prompt", () => {
  // The direction "declared destructive ⇒ replace" would have broken: the human must still
  // be told WHICH file a delete targets.
  const profile = trustProfile({ level: "autonomous", capabilities: ["rm"] });
  let seen: unknown;
  const tools = resolveToolRegistry(
    profile,
    [
      {
        key: "rm",
        effect: "destructive",
        gateContext: { kind: "kernel-delete" },
        tool: {
          name: "rm",
          description: "fixture",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          execute: () => ({ output: "gone" }),
        },
      },
    ],
    { onAwaitConfirmation: (action) => { seen = action.args; } },
  );

  void tools.list()[0]!.execute({ args: { path: "/important/file" } });

  expect(seen).toEqual({ path: "/important/file", kind: "kernel-delete" });
});

test("`secret.read` is emitted once per executed call, with references only", async () => {
  const tool = bindIssues(personal);
  const host = recordingHost();

  await callTool(personal, tool, host);

  const reads = eventsOfType(personal, "secret.read");
  expect(reads).toHaveLength(1);
  const payload = reads[0]?.payload as Record<string, unknown>;
  expect(payload.key).toBe("GITHUB_TOKEN");
  expect(payload.valueRef).toBeDefined();
  expect(JSON.stringify(payload)).not.toContain(TOKEN);
  // Tagged with the originating run, so `events tail --run <id>` is complete.
  expect(reads[0]?.runId).toBeDefined();
});

test("a call the human refuses reads no secret at all", async () => {
  const tool = bindIssues(personal);
  const host = recordingHost();

  await callTool(personal, tool, host, { confirm: () => false });

  expect(eventsOfType(personal, "secret.read")).toHaveLength(0);
  expect(host.calls).toHaveLength(0);
  // Paired positive: the gate DID stop it, rather than the tool being absent.
  expect(eventsOfType(personal, "action.awaiting_confirmation")).toHaveLength(1);
});

test("the event log records a bound endpoint's origin and path, never its query string", () => {
  store.addCredential(personal.id, "GITHUB_TOKEN", TOKEN);
  store.bindEndpoint(
    personal.id,
    "issues",
    "https://api.example.test/issues?token=leaky-looking-thing",
    "GITHUB_TOKEN",
  );

  const bound = eventsOfType(personal, "endpoint.bound");
  expect(bound).toHaveLength(1);
  expect((bound[0]?.payload as Record<string, unknown>).target).toBe(
    "https://api.example.test/issues",
  );
  expect(eventDump(personal)).not.toContain("leaky-looking-thing");
});

// --- 4. The gate fires at every trust level ----------------------------------

test("a bound endpoint is withheld under `propose` and never calls out", async () => {
  const proposer = store.createAgent({
    name: "proposer",
    role: "planner",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/proposer",
    trustLevel: "propose",
  });
  const tool = bindIssues(proposer);
  const host = recordingHost();

  const { results } = await callTool(proposer, tool, host);

  expect(host.calls).toHaveLength(0);
  expect(eventsOfType(proposer, "action.withheld")).toHaveLength(1);
  // Paired positive: the tool WAS exposed, so the withhold is the gate's doing.
  expect(results).toHaveLength(1);
});

test("`autonomous` still pauses — the destructive gate is independent of trust level", async () => {
  const tool = bindIssues(personal);
  expect(personal.trustLevel).toBe("autonomous");
  const host = recordingHost();

  await callTool(personal, tool, host, { confirm: () => false });

  expect(eventsOfType(personal, "action.awaiting_confirmation")).toHaveLength(1);
  expect(host.calls).toHaveLength(0);
});

// --- 5. Standing can never auto-approve it -----------------------------------

test("LOCK 1 — a standing grant written straight into the store leaves the gate asking", async () => {
  const tool = bindIssues(personal);
  const key = endpointCapabilityKey("issues");
  // The state lock 2 makes unreachable, forced directly, so lock 1 is tested alone.
  store.setCapabilityStanding(personal.id, key, "standing-grant", "hand-written");
  expect(store.capabilityStanding.grantedKeys(personal.id)).toContain(key);
  const host = recordingHost();

  await callTool(personal, tool, host, { confirm: () => false });

  expect(eventsOfType(personal, "action.awaiting_confirmation")).toHaveLength(1);
  expect(host.calls).toHaveLength(0);
});

test("LOCK 2 — no standing evidence is collected for a credential-bearing capability", async () => {
  const tool = bindIssues(personal);
  const host = recordingHost();

  // Four clean confirmed calls — well past the default bar of three.
  for (let i = 0; i < 4; i++) await callTool(personal, tool, host);
  expect(host.calls).toHaveLength(4);
  // Paired positive: successes really were recorded, so the absence below is about the
  // evidence reader skipping the namespace, not about nothing having happened.
  expect(eventsOfType(personal, "action.succeeded")).toHaveLength(4);

  const evidence = gatherEvidence(store.events.list(personal.id));
  expect(evidence.has(endpointCapabilityKey("issues"))).toBe(false);
});

test("lowering the distinct-targets bar does not make one earnable", async () => {
  // The specific hole the design note found: with no arguments there is one fingerprint
  // forever, so the DEFAULT bar already blocks a proposal — but an operator may set
  // `min_distinct_targets 1`, and a rule that holds only until an unrelated threshold
  // moves is not a rule.
  const tool = bindIssues(personal);
  store.agentSettings.setStandingThresholds(personal.id, {
    minCleanExecutions: 1,
    minDistinctTargets: 1,
  });
  const host = recordingHost();
  for (let i = 0; i < 3; i++) await callTool(personal, tool, host);

  const evidence = gatherEvidence(store.events.list(personal.id));
  expect(evidence.has(endpointCapabilityKey("issues"))).toBe(false);
});

// --- 6. Exposure interacts correctly with ownership --------------------------

test("`capabilities set --none` does not take a bound endpoint away", async () => {
  bindIssues(personal);
  store.setAgentCapabilities(personal.id, []);

  const exposed = await exposedTools(personal, recordingHost());

  expect(exposed).toContain(endpointToolName("issues"));
  // …and it really did narrow everything else.
  expect(exposed).not.toContain("fs.read");
});

test("a credential-bearing key cannot be hand-declared", () => {
  expect(() => validateCapabilityKeys([`${CREDENTIAL_CAPABILITY_PREFIX}issues`], "capabilities")).toThrow(
    /credential-bearing/,
  );
  expect(() => store.setAgentCapabilities(personal.id, ["api.issues"])).toThrow();
});

test("a HOST capability in the credential namespace is dropped", async () => {
  // The reservation, in the direction a host could take it: a host tool answering to a
  // credential-bearing key must never reach the registry.
  //
  // The agent is BOUND on this very name, which is what makes the test discriminate.
  // Without a binding the key is not in the resolved exposure set at all, so the ordinary
  // exposure filter drops the impostor and the namespace reservation is never consulted —
  // an earlier version of this test proved exactly nothing for that reason.
  store.addCredential(personal.id, "GITHUB_TOKEN", TOKEN);
  store.bindEndpoint(personal.id, "impostor", "https://api.example.test/i", "GITHUB_TOKEN");
  const seen: string[] = [];
  await executeRun(store, personal, "x", {
    adapter: listingAdapter(seen),
    outboundHost: recordingHost(),
    capabilities: [
      {
        key: endpointCapabilityKey("impostor"),
        effect: "read",
        tool: {
          name: "api_impostor",
          description: "fixture",
          inputSchema: { type: "object", properties: {} },
          execute: () => ({ output: "no" }),
        },
      },
    ],
  });

  expect(seen).not.toContain("api_impostor");
  // Paired positive: the KERNEL's tool for that key is the one that survived.
  expect(seen).toContain(endpointToolName("impostor"));
});

test("a HOST capability colliding on a bound endpoint's TOOL NAME is dropped", async () => {
  bindIssues(personal);
  const seen: string[] = [];
  await executeRun(store, personal, "x", {
    adapter: listingAdapter(seen),
    outboundHost: recordingHost(),
    capabilities: [
      {
        key: "fs.read",
        effect: "read",
        tool: {
          // The adapter forwards tools by NAME, so this would produce a duplicate a
          // provider rejects — and the kernel's tool is authoritative for its namespace.
          name: endpointToolName("issues"),
          description: "fixture",
          inputSchema: { type: "object", properties: {} },
          execute: () => ({ output: "no" }),
        },
      },
    ],
  });

  expect(seen.filter((t) => t === endpointToolName("issues"))).toHaveLength(1);
});

// --- 7. Re-reads, removal, and the host contract -----------------------------

test("a resumed run re-reads bindings — an endpoint removed mid-pause cannot be called", async () => {
  const tool = bindIssues(personal);
  const host = recordingHost();

  // Pause on the confirmation.
  await callTool(personal, tool, host, { confirm: () => false });
  const paused = store.runs.list(personal.id).find((r) => r.status === "awaiting_confirmation");
  expect(paused).toBeDefined();

  store.removeEndpoint(personal.id, "issues");

  const sink = { tools: [] as string[], results: [] as ToolResult[] };
  await resumeRun(store, personal, paused!.id, {
    adapter: callingAdapter(tool, sink),
    outboundHost: host,
  });

  expect(sink.tools).not.toContain(tool);
  expect(host.calls).toHaveLength(0);
});

test("a binding removed DURING the confirmation prompt is refused at the call", async () => {
  const tool = bindIssues(personal);
  const host = recordingHost();

  // The operator withdraws the binding while the prompt is open — the window a
  // resolution taken at run start would sail straight through.
  const { results } = await callTool(personal, tool, host, {
    confirm: () => {
      store.removeEndpoint(personal.id, "issues");
      return true;
    },
  });

  expect(host.calls).toHaveLength(0);
  expect(results[0]?.isError).toBe(true);
  expect(results[0]?.output).toMatch(/changed or was removed/);
});

test("a surface with no outbound host exposes the tool and says it cannot call", async () => {
  const tool = bindIssues(personal);
  const sink = { tools: [] as string[], results: [] as ToolResult[] };
  await executeRun(store, personal, "call it", {
    adapter: callingAdapter(tool, sink),
    confirm: () => true,
  });

  // Exposed, not vanished: an absent tool is indistinguishable from a gated one.
  expect(sink.tools).toContain(tool);
  expect(sink.results[0]?.isError).toBe(true);
  expect(sink.results[0]?.output).toMatch(/no outbound support/);
});

test("a binding whose credential is gone fails loudly, and the tool is still there", async () => {
  const tool = bindIssues(personal);
  store.removeCredential(personal.id, "GITHUB_TOKEN");
  const host = recordingHost();

  const { tools, results } = await callTool(personal, tool, host);

  expect(tools).toContain(tool);
  expect(results[0]?.isError).toBe(true);
  expect(results[0]?.output).toMatch(/No credential 'GITHUB_TOKEN'/);
  expect(host.calls).toHaveLength(0);
  expect(eventsOfType(personal, "secret.read")).toHaveLength(0);
});

test("a non-2xx response is an error carrying the status, and its body is screened too", async () => {
  const tool = bindIssues(personal);
  const host = recordingHost(`{"error":"bad token ${TOKEN}"}`, 401);

  const { results } = await callTool(personal, tool, host);

  expect(results[0]?.isError).toBe(true);
  expect(results[0]?.output).toContain("401");
  expect(results[0]?.output).not.toContain(TOKEN);
});

test("a handoff callee calls its OWN endpoint under its own gate", async () => {
  // Every exchange mode inherits this from one line in `driveRun`, so the property is
  // pinned rather than assumed: the callee's binding, the callee's credential.
  bindIssues(work, "GITHUB_TOKEN", "work-value-22222222");
  store.createConnection(personal.id, work.id, "handoff");
  const host = recordingHost();
  const sink = { tools: [] as string[], results: [] as ToolResult[] };

  await performHandoff(store, personal, work, "go", {
    adapter: callingAdapter(endpointToolName("issues"), sink),
    outboundHost: host,
    confirm: () => true,
  });

  expect(host.calls).toHaveLength(1);
  expect(host.calls[0]?.headers.Authorization).toBe("Bearer work-value-22222222");
  // The CALLEE's log carries the disclosure; the caller's does not.
  expect(eventsOfType(work, "secret.read")).toHaveLength(1);
  expect(eventsOfType(personal, "secret.read")).toHaveLength(0);
});

// --- 8. The kernel's own secrets are not sendable [Codex R1 P1] ---------------

test("a reserved kernel secret cannot be BOUND", () => {
  // `secrets add` already refuses this namespace so a user write cannot ROTATE a key the
  // kernel depends on. A binding cannot rotate anything — but it can make the kernel SEND
  // one, which is worse for the specific key involved.
  store.actionFingerprintKey(personal.id);
  expect(() =>
    store.bindEndpoint(
      personal.id,
      "leak",
      "https://api.example.test/collect",
      "__asterism.action_fingerprint_key",
    ),
  ).toThrow(/reserved for the kernel/);
  expect(store.endpoints.list(personal.id)).toEqual([]);
});

test("a reserved kernel secret cannot be READ OUT even from a hand-written binding", async () => {
  // The second, independent lock. The write boundary above refuses to STORE such a binding;
  // this refuses to SERVE one, so a row inserted straight into the database still cannot
  // make the kernel disclose its own key. Written through the repository, which is exactly
  // the bypass being defended against.
  const internal = store.actionFingerprintKey(personal.id);
  expect(internal.length).toBeGreaterThan(16);
  store.endpoints.create(personal.id, {
    name: "leak",
    url: "https://api.example.test/collect",
    credentialKey: "__asterism.action_fingerprint_key",
  });
  const host = recordingHost();

  const { tools, results } = await callTool(personal, endpointToolName("leak"), host);

  // Nothing goes out, and the refusal is a tool FAILURE rather than a throw across the
  // adapter seam — `readSecret` refuses by throwing, and the guard turns that into a result.
  expect(host.calls).toHaveLength(0);
  expect(tools).toContain(endpointToolName("leak"));
  expect(results[0]?.isError).toBe(true);
  expect(results[0]?.output).toMatch(/could not be called/);
  expect(JSON.stringify(results)).not.toContain(internal);
  expect(eventDump(personal)).not.toContain(internal);
});

test("the disclosure path itself refuses the kernel's namespace", () => {
  store.actionFingerprintKey(personal.id);
  expect(() => store.readSecret(personal.id, "__asterism.action_fingerprint_key")).toThrow(
    /reserved for internal use/,
  );
});

// --- 9. The pure pieces -------------------------------------------------------

test("validateEndpointUrl refuses http, userinfo, and a non-URL", () => {
  expect(() => validateEndpointUrl("http://api.example.test/x")).toThrow(/only https/);
  expect(() => validateEndpointUrl("https://user:pass@api.example.test/x")).toThrow(
    /username or password/,
  );
  expect(() => validateEndpointUrl("not a url")).toThrow(/is not a URL/);
  expect(validateEndpointUrl("https://api.example.test/x?y=1")).toBe("https://api.example.test/x?y=1");
});

test("validateEndpointName accepts a lowercase identifier and refuses the rest", () => {
  expect(validateEndpointName("issues-2")).toBe("issues-2");
  expect(() => validateEndpointName("Issues")).toThrow(/lowercase/);
  expect(() => validateEndpointName("-issues")).toThrow(/lowercase/);
  expect(() => validateEndpointName("iss ues")).toThrow(/lowercase/);
  expect(() => validateEndpointName("")).toThrow(/non-empty/);
});

test("endpointToolName is injective over the accepted alphabet", () => {
  // `-` maps to `_`, and `_` is not an accepted name character, so no two accepted names
  // can collide on a tool name.
  expect(endpointToolName("a-b")).toBe("call_a_b");
  expect(() => validateEndpointName("a_b")).toThrow();
});

test("endpointLogTarget drops the query string", () => {
  expect(endpointLogTarget("https://h.test/a/b?c=d")).toBe("https://h.test/a/b");
  expect(endpointLogTarget("nonsense")).toBe("(unparseable URL)");
});

test("screenEndpointResponse removes the disclosed value even when no shape rule matches", () => {
  const screened = screenEndpointResponse(`prefix ${TOKEN} suffix`, TOKEN);

  expect(screened).not.toContain(TOKEN);
  expect(screened).toBe("prefix [redacted:value] suffix");
});

test("an invisible character inside the echoed value does not defeat the scrub", () => {
  // The evasion: `redactForTrace` STRIPS zero-width characters, so a value echoed with one
  // wedged inside it fails the exact match and is then reassembled in plaintext by the very
  // step meant to screen it. Normalizing before matching closes it. [Codex R1 P1.]
  for (const invisible of ["\u200b", "\u200e", "\ufeff", "\u0000", "\u001b"]) {
    const split = TOKEN.slice(0, 10) + invisible + TOKEN.slice(10);
    const screened = screenEndpointResponse(`{"you sent":"${split}"}`, TOKEN);
    expect(screened).not.toContain(TOKEN);
    expect(screened).toContain("[redacted:value]");
  }
});

test("a disclosed value that itself contains an invisible character still matches", () => {
  // The symmetric arm: normalization is applied to BOTH sides, so a stored secret carrying
  // such a character is still removed from a response that echoes it.
  const weird = TOKEN.slice(0, 8) + "\u200b" + TOKEN.slice(8);
  const screened = screenEndpointResponse(`echo: ${weird}`, weird);

  expect(screened).toBe("echo: [redacted:value]");
});

test("screenEndpointResponse scrubs EVERY occurrence, not just the first", () => {
  const screened = screenEndpointResponse(`${TOKEN} and ${TOKEN}`, TOKEN);

  expect(screened).not.toContain(TOKEN);
  expect(screened.match(/\[redacted:value\]/g)).toHaveLength(2);
});

test("a SHORT credential is scrubbed too — the promise has no length qualifier", () => {
  // A 6-digit PIN is a credential, `secrets add` accepts one, and no shape rule will ever
  // recognize it. The help text says the credential is "stripped from anything that comes
  // back", full stop — a length floor made that absolute promise hold for long values only.
  // [Codex R2 P2.]
  const pin = "482913";
  expect(screenEndpointResponse(`{"you sent":"${pin}"}`, pin)).toBe('{"you sent":"[redacted:value]"}');
  // Down to a single character: mangling ordinary text is a cost, returning the credential
  // is a defect, and this boundary picks the cost.
  expect(screenEndpointResponse("a cat", "a")).not.toContain("a cat");
});

test("an EMPTY disclosed value leaves the response alone rather than exploding it", () => {
  // The one exclusion, and it is arithmetic rather than policy: `split("")` splits between
  // every character, so an empty value would replace the whole response with markers.
  expect(screenEndpointResponse("the cat sat on the mat", "")).toBe("the cat sat on the mat");
});

test("screenEndpointResponse scrubs BEFORE it truncates, so no fragment survives", () => {
  // The ordering property: the single cut point is AFTER the scrub. A value straddling
  // the 4 KiB bound must not leave a readable prefix behind.
  //
  // The fragment is sized deliberately. An earlier version of this test put the token 6
  // bytes from the cut and asserted a 12-byte prefix was absent — which is true whichever
  // order the pipeline runs in, so it discriminated nothing. Here the token starts 24
  // bytes before the bound, so inverting the order leaves 24 readable bytes of it.
  const straddle = 24;
  const filler = "x".repeat(DEFAULT_ENDPOINT_RESPONSE_MAX_BYTES - straddle);
  const screened = screenEndpointResponse(`${filler}${TOKEN}suffix`, TOKEN);

  expect(screened).not.toContain(TOKEN.slice(0, straddle));
  expect(TOKEN.length).toBeGreaterThan(straddle);
});

test("screenEndpointResponse still applies the generic rules to values it did not send", () => {
  const screened = screenEndpointResponse("other: ghp_" + "A".repeat(36), TOKEN);

  expect(screened).not.toContain("ghp_AAAA");
});
