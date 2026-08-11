// Capability ownership — WHICH capabilities an agent holds at all (#123).
//
// The property under test is exposure: a capability an agent does not own must not
// reach the registry, and therefore never reaches the substrate. Everything here is
// asserted at the REGISTRY the kernel hands the adapter — not at the repository —
// because that is the boundary the claim is about.
//
// The one that carries the migration: an agent with nothing declared gets exactly the
// catalog it got before this existed. "Nothing declared" is a legitimate permanent
// state; there is no backfill, and no install changes behaviour.

import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  DEFAULT_CAPABILITY_KEYS,
  RESERVED_CAPABILITY_KEYS,
  resolveOwnedCapabilityKeys,
  validateCapabilityKeys,
} from "./capabilities.js";
import { executeRun, performHandoff, resolveRecallBudget, resumeRun } from "./run.js";
import { AsterismStore } from "./store.js";
import type { RuntimeAdapter, RunOutput } from "./adapter.js";
import type { Capability } from "./trust.js";
import type { Agent } from "./types.js";
import { WORLD_FACT_FORGET_TOOL, WORLD_FACT_RECORD_TOOL } from "./world-facts.js";

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

/** A capability whose tool name IS its key, so a registry listing reads as keys. */
function capability(key: string, effect: "read" | "write" | "destructive" = "write"): Capability {
  return {
    key,
    effect,
    tool: {
      name: key,
      description: `${key} (fixture)`,
      inputSchema: { type: "object", properties: {} },
      execute: () => ({ output: `${key}: done` }),
    },
  };
}

/** A stand-in for the shipped catalog: one capability per default key. */
function fakeCatalog(): Capability[] {
  return DEFAULT_CAPABILITY_KEYS.map((k) => capability(k, k === "fs.delete" ? "destructive" : "write"));
}

/** A substrate stand-in that records the tool names the kernel scoped into the run. */
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

/** The tool names one run was scoped, sorted. */
async function exposedTools(agent: Agent, capabilities: readonly Capability[]): Promise<string[]> {
  const seen: string[] = [];
  await executeRun(store, agent, "do the thing", {
    adapter: listingAdapter(seen),
    capabilities,
  });
  return [...seen].sort();
}

// --- The migration, in one assertion ----------------------------------------

test("an agent with nothing declared holds exactly the default catalog, plus its own notes tools", async () => {
  expect(store.agentSettings.getCapabilities(personal.id)).toBeUndefined();

  const exposed = await exposedTools(personal, fakeCatalog());

  expect(exposed).toEqual(
    [...DEFAULT_CAPABILITY_KEYS, WORLD_FACT_RECORD_TOOL, WORLD_FACT_FORGET_TOOL].sort(),
  );
});

test("the default catalog is a CLOSED set — a host capability outside it is not inherited", async () => {
  // The PR-2 guarantee, pinned here: a capability class the kernel gains later is never
  // handed to an agent that never asked for it. `send_email` stands in for one.
  const exposed = await exposedTools(personal, [...fakeCatalog(), capability("net.send_email")]);

  expect(exposed).not.toContain("net.send_email");
  expect(exposed).toContain("fs.read");
});

test("a declared agent can hold a capability the default catalog does not name", async () => {
  // The other half: the closed default is not a closed VOCABULARY. A host's own tool is
  // legitimate; it just has to be declared, per agent.
  store.setAgentCapabilities(personal.id, ["net.send_email"]);

  const exposed = await exposedTools(personal, [...fakeCatalog(), capability("net.send_email")]);

  expect(exposed).toContain("net.send_email");
  // …and declaring narrowed the rest away, because a declaration is the whole set.
  expect(exposed).not.toContain("fs.read");
});

// --- Isolation ---------------------------------------------------------------

test("a capability one agent owns is unreachable from another agent's run", async () => {
  store.setAgentCapabilities(personal.id, ["fs.delete"]);
  store.setAgentCapabilities(work.id, ["fs.read"]);
  const catalog = fakeCatalog();

  // The host hands BOTH runs the same catalog — the kernel, not the host, is what
  // keeps them apart.
  expect(await exposedTools(personal, catalog)).toContain("fs.delete");
  expect(await exposedTools(work, catalog)).not.toContain("fs.delete");
  expect(await exposedTools(work, catalog)).toContain("fs.read");
  expect(await exposedTools(personal, catalog)).not.toContain("fs.read");
});

test("declaring one agent's capabilities leaves every other agent untouched", () => {
  store.setAgentCapabilities(personal.id, ["fs.read"]);

  expect(store.agentSettings.getCapabilities(work.id)).toBeUndefined();
  expect([...store.resolveOwnedCapabilities(work.id)].sort()).toEqual(
    [...DEFAULT_CAPABILITY_KEYS, ...RESERVED_CAPABILITY_KEYS].sort(),
  );
});

// --- The empty declaration ---------------------------------------------------

test("declaring NOTHING and declaring the EMPTY SET are different states", async () => {
  const catalog = fakeCatalog();
  expect(await exposedTools(personal, catalog)).toContain("fs.read");

  store.setAgentCapabilities(personal.id, []);
  expect(store.agentSettings.getCapabilities(personal.id)).toEqual([]);
  // No host tool survives — but the agent's own notes tools still do.
  expect(await exposedTools(personal, catalog)).toEqual(
    [WORLD_FACT_RECORD_TOOL, WORLD_FACT_FORGET_TOOL].sort(),
  );

  store.clearAgentCapabilities(personal.id);
  expect(store.agentSettings.getCapabilities(personal.id)).toBeUndefined();
  expect(await exposedTools(personal, catalog)).toContain("fs.read");
});

test("revoking the last capability does not silently widen back to the catalog", async () => {
  // The failure mode a row-per-key table would have had: with no rows left, "nothing
  // declared" and "declared nothing" become indistinguishable, and a REVOKE ends up
  // restoring everything.
  store.setAgentCapabilities(personal.id, ["fs.read", "fs.write"]);
  store.setAgentCapabilities(personal.id, ["fs.read"]);
  store.setAgentCapabilities(personal.id, []);

  const exposed = await exposedTools(personal, fakeCatalog());

  expect(exposed).not.toContain("fs.read");
  expect(exposed).not.toContain("fs.write");
});

// --- The reserved kernel tools ------------------------------------------------

test("the agent's own notes tools survive every narrowing, including the empty set", async () => {
  for (const declaration of [["fs.read"], []]) {
    store.setAgentCapabilities(personal.id, declaration);
    const exposed = await exposedTools(personal, fakeCatalog());
    expect(exposed).toContain(WORLD_FACT_RECORD_TOOL);
    expect(exposed).toContain(WORLD_FACT_FORGET_TOOL);
  }
});

test("a reserved key cannot be declared", () => {
  for (const key of RESERVED_CAPABILITY_KEYS) {
    expect(() => store.setAgentCapabilities(personal.id, [key])).toThrow(/reserved for the kernel/);
  }
  expect(store.agentSettings.getCapabilities(personal.id)).toBeUndefined();
});

// --- Exposure and standing do not cascade --------------------------------------

test("narrowing exposure leaves an earned standing grant intact, and inert", async () => {
  store.setCapabilityStanding(personal.id, "fs.delete", "standing-grant", "3 clean executions");
  store.setAgentCapabilities(personal.id, ["fs.read"]);

  // The grant is still on the record — exposure is not the verb that takes it back.
  expect(store.capabilityStanding.get(personal.id, "fs.delete")?.standing).toBe("standing-grant");
  // And it grants nothing while the capability is not exposed: there is no tool to run.
  expect(await exposedTools(personal, fakeCatalog())).not.toContain("fs.delete");

  // Restoring exposure restores the grant's effect — it was dormant, not destroyed.
  store.clearAgentCapabilities(personal.id);
  expect(await exposedTools(personal, fakeCatalog())).toContain("fs.delete");
});

// --- Re-read per run, including on resume ---------------------------------------

/** A substrate that calls one tool by name, so the gate sees a real invocation. */
function callingAdapter(toolName: string): RuntimeAdapter {
  return {
    run(request) {
      const output = (async (): Promise<RunOutput> => {
        const tool = request.tools.list().find((t) => t.name === toolName);
        if (!tool) return { status: "done", text: "(no such tool)" };
        const result = await tool.execute({ args: { path: "dist" } }, request.signal);
        return { status: "done", text: result.output };
      })();
      async function* noEvents() {}
      return { events: noEvents(), output };
    },
  };
}

test("a resume re-reads exposure: a capability revoked mid-pause cannot execute", async () => {
  const catalog = fakeCatalog();
  const parked = await executeRun(store, personal, "delete dist", {
    adapter: callingAdapter("fs.delete"),
    capabilities: catalog,
  });
  expect(parked.status).toBe("awaiting_confirmation");

  // The operator takes the capability away while the run sits paused, then confirms.
  store.setAgentCapabilities(personal.id, ["fs.read"]);
  const resumed = await resumeRun(store, personal, parked.run.id, {
    adapter: callingAdapter("fs.delete"),
    capabilities: catalog,
    confirm: () => true,
  });

  // The confirmation cannot resurrect a tool the agent no longer holds.
  expect(resumed.kind).toBe("resumed");
  if (resumed.kind !== "resumed") return;
  expect(resumed.result.output).toBe("(no such tool)");
  expect(resumed.result.actions).toEqual([]);
});

// --- The audit record -------------------------------------------------------------

test("declaring and clearing are audited; re-declaring the same set is not", () => {
  const settingEvents = (): unknown[] =>
    store.events
      .tail(personal.id)
      .filter((e) => e.type === "agent.setting_changed")
      .map((e) => e.payload);

  store.setAgentCapabilities(personal.id, ["fs.write", "fs.read"]);
  expect(settingEvents()).toEqual([
    { setting: "capabilities", from: null, to: ["fs.read", "fs.write"] },
  ]);

  // Canonical form means an unchanged declaration in a different order is a no-op.
  store.setAgentCapabilities(personal.id, ["fs.read", "fs.write"]);
  expect(settingEvents()).toHaveLength(1);

  store.setAgentCapabilities(personal.id, ["fs.read"]);
  store.clearAgentCapabilities(personal.id);
  expect(settingEvents()).toEqual([
    { setting: "capabilities", from: null, to: ["fs.read", "fs.write"] },
    { setting: "capabilities", from: ["fs.read", "fs.write"], to: ["fs.read"] },
    { setting: "capabilities", from: ["fs.read"], to: null },
  ]);

  // Clearing what was never declared changes nothing, so it records nothing.
  store.clearAgentCapabilities(personal.id);
  expect(settingEvents()).toHaveLength(3);
});

test("declaring the empty set is a real transition and IS audited", () => {
  store.setAgentCapabilities(personal.id, []);
  const events = store.events.tail(personal.id).filter((e) => e.type === "agent.setting_changed");
  expect(events).toHaveLength(1);
  expect(events[0]!.payload).toEqual({ setting: "capabilities", from: null, to: [] });
});

// --- Write-boundary validation -----------------------------------------------------

test("a declaration is canonicalized on write: de-duplicated and sorted", () => {
  store.setAgentCapabilities(personal.id, ["fs.write", "fs.read", "fs.write"]);
  expect(store.agentSettings.getCapabilities(personal.id)).toEqual(["fs.read", "fs.write"]);
});

test("a malformed key is refused at the write boundary", () => {
  for (const bad of ["", "fs read", "fs.read\n", "fs. read", "a".repeat(129)]) {
    expect(() => store.setAgentCapabilities(personal.id, [bad])).toThrow(/invalid/);
  }
  expect(() => store.setAgentCapabilities(personal.id, new Array(257).fill("k").map((k, i) => `${k}${i}`))).toThrow(
    /invalid/,
  );
  expect(store.agentSettings.getCapabilities(personal.id)).toBeUndefined();
});

test("validateCapabilityKeys is the shape check, not a membership check", () => {
  // A key the kernel has never heard of is fine — a host may ship its own tools.
  expect(validateCapabilityKeys(["zz.custom", "aa.custom"], "test")).toEqual([
    "aa.custom",
    "zz.custom",
  ]);
});

// --- A corrupt stored value fails LOUDLY, never widens ------------------------------

test("a corrupt declaration can be CLEARED — the recovery the error advises is reachable", () => {
  // Codex R6. The error says "clear the declaration"; clearing parsed the declaration
  // first, so the one documented way out of the state was the one command the state
  // blocked. The same false-reassurance shape as #119's error copy, inverted: advice that
  // cannot be followed.
  store.setAgentCapabilities(personal.id, ["fs.read"]);
  store.driver
    .prepare(`UPDATE agent_settings SET capabilities = ? WHERE agent_id = ?`)
    .run(["not json at all", personal.id]);

  expect(() => store.resolveOwnedCapabilities(personal.id)).toThrow(/corrupt/);
  expect(() => store.clearAgentCapabilities(personal.id)).not.toThrow();

  expect(store.agentSettings.getCapabilities(personal.id)).toBeUndefined();
  expect([...store.resolveOwnedCapabilities(personal.id)].sort()).toEqual(
    [...DEFAULT_CAPABILITY_KEYS, ...RESERVED_CAPABILITY_KEYS].sort(),
  );
  // The audit says what happened without pretending it could read what was there, and
  // without echoing an arbitrary stored string into the log.
  const settingEvents = store.events
    .tail(personal.id)
    .filter((e) => e.type === "agent.setting_changed");
  expect(settingEvents.at(-1)!.payload).toEqual({
    setting: "capabilities",
    from: "(unreadable declaration)",
    to: null,
  });
});

test("a corrupt declaration does not make the agent's OTHER settings unreadable", () => {
  // The parse used to live in the row-wide decoder, so one bad column threw for every
  // sibling setting — an agent's recall budget, providers and caps all became unreadable,
  // on the very commands an operator needs to diagnose it. Strictness belongs on the
  // exposure read, not on the row.
  store.setRecallBudget(personal.id, 7);
  store.setWorldFactCap(personal.id, 3);
  store.setAgentCapabilities(personal.id, ["fs.read"]);
  store.driver
    .prepare(`UPDATE agent_settings SET capabilities = ? WHERE agent_id = ?`)
    .run(["not json at all", personal.id]);

  expect(store.agentSettings.getRecallBudget(personal.id)).toBe(7);
  expect(store.agentSettings.getWorldFactCap(personal.id)).toBe(3);
  expect(resolveRecallBudget(store, personal).maxMemories).toBe(7);
  expect(() => store.agentSettings.get(personal.id)).not.toThrow();
  // …and the exposure read is still the strict one, so nothing widened.
  expect(() => store.resolveOwnedCapabilities(personal.id)).toThrow(/corrupt/);
});

test("a corrupt stored declaration throws rather than resolving to the full catalog", () => {
  store.setAgentCapabilities(personal.id, ["fs.read"]);
  // Only a hand-edited database can produce this: the setter canonicalizes.
  for (const corrupt of ['{"fs.read": true}', "fs.read", '["fs.read", 7]', '["notes.record"]']) {
    store.driver
      .prepare(`UPDATE agent_settings SET capabilities = ? WHERE agent_id = ?`)
      .run([corrupt, personal.id]);

    expect(() => store.resolveOwnedCapabilities(personal.id)).toThrow(
      /corrupt capability declaration/,
    );
  }
});

// --- The pure resolver ---------------------------------------------------------------

test("resolveOwnedCapabilityKeys: undefined is the default catalog, an array is itself", () => {
  expect([...resolveOwnedCapabilityKeys(undefined)].sort()).toEqual(
    [...DEFAULT_CAPABILITY_KEYS, ...RESERVED_CAPABILITY_KEYS].sort(),
  );
  expect([...resolveOwnedCapabilityKeys([])].sort()).toEqual([...RESERVED_CAPABILITY_KEYS].sort());
  expect([...resolveOwnedCapabilityKeys(["one.tool"])].sort()).toEqual(
    ["one.tool", ...RESERVED_CAPABILITY_KEYS].sort(),
  );
});

// --- Exposure across a connection ------------------------------------------------

test("in a handoff, the CALLEE's declaration governs — the caller's is irrelevant", async () => {
  // The callee's gate is sovereign (Phase 3, invariant 3); exposure is the same story
  // one layer earlier. Every exchange funnels through the same run path, so this is
  // inherited rather than re-implemented — which is exactly why it needs pinning.
  store.createConnection(personal.id, work.id, "handoff");
  store.setAgentCapabilities(personal.id, ["fs.delete"]); // the CALLER holds delete
  store.setAgentCapabilities(work.id, ["fs.read"]); // the CALLEE does not

  let scoped: string[] = [];
  const outcome = await performHandoff(store, personal, work, "delete the dist files", {
    adapter: {
      run(request) {
        scoped = request.tools.list().map((t) => t.name).sort();
        async function* noEvents() {}
        return { events: noEvents(), output: Promise.resolve<RunOutput>({ status: "done", text: "ok" }) };
      },
    },
    capabilities: fakeCatalog(),
  });

  expect(outcome.kind).toBe("ok");
  expect(scoped).toContain("fs.read");
  expect(scoped).not.toContain("fs.delete");
});

test("re-declaring the same set touches nothing at all — not even updated_at", async () => {
  // Codex R2 [P3]. The event was already suppressed, but the row was written first and
  // its timestamp advanced, so a true no-op still read as a change to anything syncing
  // or retrying on it. Every sibling setter here compares BEFORE it writes.
  const first = store.setAgentCapabilities(personal.id, ["fs.read", "fs.write"]);
  await Bun.sleep(2);
  const again = store.setAgentCapabilities(personal.id, ["fs.write", "fs.read", "fs.read"]);

  expect(again.updatedAt).toBe(first.updatedAt);
  expect(again.capabilities).toEqual(["fs.read", "fs.write"]);
  expect(
    store.events.tail(personal.id).filter((e) => e.type === "agent.setting_changed"),
  ).toHaveLength(1);

  // A real change still writes and still advances the timestamp.
  await Bun.sleep(2);
  const changed = store.setAgentCapabilities(personal.id, ["fs.read"]);
  expect(changed.updatedAt).not.toBe(first.updatedAt);
});

test("an invalid declaration throws even when a short-circuit could have swallowed it", () => {
  // Validation happens before the unchanged-value comparison, so a bad key cannot slip
  // through by resembling what is already stored.
  store.setAgentCapabilities(personal.id, ["fs.read"]);
  expect(() => store.setAgentCapabilities(personal.id, ["fs.read", "bad key"])).toThrow(/invalid/);
  expect(() => store.setAgentCapabilities(personal.id, ["notes.record"])).toThrow(/reserved/);
  expect(store.agentSettings.getCapabilities(personal.id)).toEqual(["fs.read"]);
});
