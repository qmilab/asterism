// `delegated-tool` — the fifth and last Track-A connection mode (Phase 3 · T3b, #137).
//
// The mode's claim is "the result of a tool the callee OWNS, run under the callee's gate,
// for the caller's benefit, never exposing the callee's credential". Each clause is a test
// here, and so is each of the two locks the grant is split into.
//
// Every absence assertion is paired with a positive one proving the path actually ran — an
// assertion that a credential is missing is satisfied perfectly by a call that never
// happened, and that is the shape of test this repo has been burned by.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { isDelegableCapabilityKey } from "./capabilities.js";
import { endpointCapabilities, endpointCapabilityKey } from "./endpoints.js";
import type { OutboundHost, OutboundRequest } from "./endpoints.js";
import { performDelegatedCall } from "./run.js";
import { AsterismStore } from "./store.js";
import { gatherEvidence } from "./standing.js";
import type { Action } from "./trust.js";
import type { Agent, Connection, Event } from "./types.js";

/** A distinctive value with no shape any generic redaction rule would recognize. */
const TOKEN = "zzq-plainlooking-value-8842176";
const URL_A = "https://api.example.test/issues?state=open";

let store: AsterismStore;
let writer: Agent;
let helper: Agent;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  writer = store.createAgent({
    name: "writer",
    role: "drafts",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/writer",
    trustLevel: "autonomous",
  });
  helper = store.createAgent({
    name: "helper",
    role: "digs",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/helper",
    trustLevel: "notify",
  });
});

afterEach(() => {
  store.close();
});

/** A host that records what it was asked to send and answers with a fixed body. */
function recordingHost(body = '{"open":3}', status = 200): OutboundHost & { calls: OutboundRequest[] } {
  const calls: OutboundRequest[] = [];
  return {
    calls,
    call(request) {
      calls.push(request);
      return Promise.resolve({ ok: true as const, status, body });
    },
  };
}

/** Approve every confirmation. */
const approve = (): boolean => true;
/** Refuse every confirmation — the non-interactive default, stated explicitly. */
const refuse = (): boolean => false;

/** Bind `issues` on the callee, with its credential stored. */
function bindIssues(agent: Agent = helper, url = URL_A, key = "GITHUB_TOKEN"): void {
  store.addCredential(agent.id, key, TOKEN);
  store.bindEndpoint(agent.id, "issues", url, key);
}

/** Open the channel and hand over `issues`, the ordinary two-act setup. */
function connectAndDelegate(name = "issues"): Connection {
  const connection = store.createConnection(writer.id, helper.id, "delegated-tool");
  const endpoint = store.endpoints.getByName(helper.id, name);
  if (!endpoint) throw new Error("test setup: no such endpoint");
  store.grantDelegation(connection, endpoint);
  return connection;
}

function typesOn(agent: Agent): string[] {
  return store.events.tail(agent.id).map((e: Event) => e.type);
}

// ---------------------------------------------------------------------------
// Lock 1 — the channel.
// ---------------------------------------------------------------------------

test("with no connection at all, a delegated call is refused and nothing is dialed", async () => {
  bindIssues();
  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: approve,
  });
  expect(outcome.kind).toBe("no_connection");
  expect(host.calls).toHaveLength(0);
  // Not merely refused — unrecorded. A channel that does not exist was not "used".
  expect(typesOn(writer)).not.toContain("delegation.requested");
  expect(typesOn(helper)).not.toContain("delegation.requested");
});

test("a connection in another mode does not authorize a delegated call", async () => {
  bindIssues();
  const connection = store.createConnection(writer.id, helper.id, "handoff");
  // The grant cannot even be MADE on the wrong channel — the mode is part of the write's
  // own predicate, not a check a caller performs.
  const endpoint = store.endpoints.getByName(helper.id, "issues")!;
  expect(store.grantDelegation(connection, endpoint)).toBeUndefined();

  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: approve,
  });
  expect(outcome.kind).toBe("no_connection");
  expect(host.calls).toHaveLength(0);
});

test("the channel is directional — the reverse direction authorizes nothing", async () => {
  bindIssues(writer);
  const connection = store.createConnection(writer.id, helper.id, "delegated-tool");
  const endpoint = store.endpoints.getByName(writer.id, "issues")!;
  // The binding belongs to the CALLER, not the callee: refused at the write.
  expect(store.grantDelegation(connection, endpoint)).toBeUndefined();

  const host = recordingHost();
  // And asking in the other direction finds no channel.
  const outcome = await performDelegatedCall(store, helper, writer, "issues", {
    host,
    confirm: approve,
  });
  expect(outcome.kind).toBe("no_connection");
  expect(host.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Lock 2 — the delegation.
// ---------------------------------------------------------------------------

test("an open channel with nothing handed over reaches nothing", async () => {
  bindIssues();
  store.createConnection(writer.id, helper.id, "delegated-tool");
  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: approve,
  });
  expect(outcome.kind).toBe("not_delegated");
  expect(host.calls).toHaveLength(0);
});

test("an endpoint bound AFTER the channel opened is not reachable until it is handed over", async () => {
  bindIssues();
  connectAndDelegate();
  // A second endpoint appears on the callee later. The channel is untouched, and so is what
  // it reaches: this is the whole reason the grant is not implied by the connection.
  store.bindEndpoint(helper.id, "payroll", "https://api.example.test/payroll", "GITHUB_TOKEN");
  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, helper, "payroll", {
    host,
    confirm: approve,
  });
  expect(outcome.kind).toBe("not_delegated");
  expect(host.calls).toHaveLength(0);

  // …while the one that WAS handed over still works, so the refusal above is about the
  // grant and not about the channel having broken.
  const ok = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: approve,
  });
  expect(ok.kind).toBe("ok");
  expect(host.calls).toHaveLength(1);
});

test("a delegation cannot be granted for an endpoint the callee does not hold", () => {
  const connection = store.createConnection(writer.id, helper.id, "delegated-tool");
  expect(store.endpoints.getByName(helper.id, "issues")).toBeUndefined();
  // There is no `BoundEndpoint` to pass, which is the point: the kernel op takes the row,
  // so a grant for a name nobody has bound cannot be expressed. Proven through the store's
  // own read, the way the surface reaches it.
  expect(store.delegations.listActiveForConnection(writer.id, connection.id)).toHaveLength(0);
});

test("withdrawing one delegation leaves the channel and the other delegations alone", async () => {
  bindIssues();
  store.bindEndpoint(helper.id, "builds", "https://api.example.test/builds", "GITHUB_TOKEN");
  const connection = connectAndDelegate();
  store.grantDelegation(connection, store.endpoints.getByName(helper.id, "builds")!);

  expect(store.endDelegation(connection, endpointCapabilityKey("issues"))).toBeDefined();
  const host = recordingHost();
  expect(
    (await performDelegatedCall(store, writer, helper, "issues", { host, confirm: approve })).kind,
  ).toBe("not_delegated");
  expect(
    (await performDelegatedCall(store, writer, helper, "builds", { host, confirm: approve })).kind,
  ).toBe("ok");
  expect(host.calls).toHaveLength(1);
});

test("revoking the channel withdraws every delegation on it, without touching a delegation row", async () => {
  bindIssues();
  const connection = connectAndDelegate();
  store.revokeConnection(writer.id, helper.id, "delegated-tool");

  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: approve,
  });
  expect(outcome.kind).toBe("no_connection");
  expect(host.calls).toHaveLength(0);
  // Both reads agree, and both are the JOIN rather than a cascade: nothing rewrote the
  // delegation row, so a revoke stays a single write that cannot half-apply — and the list
  // an operator reads cannot disagree with what a call is authorized against, because it is
  // the same query.
  expect(store.delegations.findActive(connection, endpointCapabilityKey("issues"))).toBeUndefined();
  expect(store.listActiveDelegations(writer.id, connection.id)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// The binding underneath the grant (D42).
// ---------------------------------------------------------------------------

test("re-pointing a delegated endpoint ends the delegation, and the next call is refused", async () => {
  bindIssues();
  connectAndDelegate();
  const { endedDelegations } = store.bindEndpoint(
    helper.id,
    "issues",
    "https://api.example.test/pulls",
    "GITHUB_TOKEN",
  );
  expect(endedDelegations).toHaveLength(1);

  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: approve,
  });
  expect(outcome.kind).toBe("not_delegated");
  expect(host.calls).toHaveLength(0);
});

test("changing only the CREDENTIAL a delegated endpoint sends also ends the delegation", async () => {
  bindIssues();
  connectAndDelegate();
  store.addCredential(helper.id, "OTHER_TOKEN", "another-value");
  const { endedDelegations } = store.bindEndpoint(helper.id, "issues", URL_A, "OTHER_TOKEN");
  expect(endedDelegations).toHaveLength(1);
});

test("an idempotent re-bind changes nothing and ends nothing", async () => {
  bindIssues();
  connectAndDelegate();
  const { endedDelegations } = store.bindEndpoint(helper.id, "issues", URL_A, "GITHUB_TOKEN");
  expect(endedDelegations).toHaveLength(0);
  const host = recordingHost();
  expect(
    (await performDelegatedCall(store, writer, helper, "issues", { host, confirm: approve })).kind,
  ).toBe("ok");
});

test("removing a delegated endpoint ends the delegation and says so on both logs", async () => {
  bindIssues();
  connectAndDelegate();
  const { removed, endedDelegations } = store.removeEndpoint(helper.id, "issues");
  expect(removed).toBe(true);
  expect(endedDelegations).toHaveLength(1);
  // BOTH participants' logs, not only the agent whose command it was: the other operator is
  // the one who is about to find a call refused.
  for (const agent of [writer, helper]) {
    expect(typesOn(agent).filter((t) => t === "delegation.ended")).toHaveLength(1);
  }
});

test("a grant whose binding changed behind the kernel's back is refused at the call", async () => {
  bindIssues();
  const connection = connectAndDelegate();
  // Bypass `bindEndpoint` entirely — the repository is the write the end-on-change hook sits
  // above, so writing through it is exactly the state that hook does not cover. This is the
  // fail-closed half of D42, and without it this call would go to a URL nobody delegated.
  store.endpoints.create(helper.id, {
    name: "issues",
    url: "https://api.example.test/elsewhere",
    credentialKey: "GITHUB_TOKEN",
  });
  expect(store.delegations.findActive(connection, endpointCapabilityKey("issues"))).toBeDefined();

  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: approve,
  });
  expect(outcome.kind).toBe("changed");
  expect(host.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// The callee's gate is sovereign (invariant 3), and E9's cost.
// ---------------------------------------------------------------------------

test("the call runs under the CALLEE's trust level, not the caller's", async () => {
  bindIssues();
  connectAndDelegate();
  // The caller is `autonomous`; the callee is `propose`. The callee's level decides.
  const cautious = store.setTrust(helper.id, "propose");
  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, cautious, "issues", {
    host,
    confirm: approve,
  });
  expect(outcome.kind).toBe("withheld");
  expect(host.calls).toHaveLength(0);
  // Withheld, not paused: a `propose` callee cannot serve this mode at all, and the
  // confirmation above was never consulted.
});

test("a delegated call always pauses — at notify AND at autonomous, and standing cannot buy it out", async () => {
  bindIssues();
  connectAndDelegate();
  for (const level of ["notify", "autonomous"] as const) {
    const at = store.setTrust(helper.id, level);
    const host = recordingHost();
    // No confirmation available ⇒ nothing is sent, at either level.
    const denied = await performDelegatedCall(store, writer, at, "issues", { host });
    expect(denied.kind).toBe("not_confirmed");
    expect(host.calls).toHaveLength(0);
    // With one, it runs.
    const allowed = await performDelegatedCall(store, writer, at, "issues", {
      host,
      confirm: approve,
    });
    expect(allowed.kind).toBe("ok");
    expect(host.calls).toHaveLength(1);
  }
});

test("a refused confirmation sends nothing and parks nothing", async () => {
  bindIssues();
  connectAndDelegate();
  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: refuse,
  });
  expect(outcome.kind).toBe("not_confirmed");
  expect(host.calls).toHaveLength(0);
  // Nothing to resume: no run was created on either side.
  expect(store.runs.list(helper.id)).toHaveLength(0);
  expect(store.runs.list(writer.id)).toHaveLength(0);
});

test("a delegated capability never enters the callee's standing evidence", async () => {
  bindIssues();
  connectAndDelegate();
  const host = recordingHost();
  await performDelegatedCall(store, writer, helper, "issues", { host, confirm: approve });
  // Lock 2 of E9, inherited: no evidence is collected for this class, so `trust --review`
  // can never propose the grant the empty `autoApprove` above would ignore.
  const evidence = gatherEvidence(store.events.tail(helper.id));
  expect([...evidence.keys()]).not.toContain(endpointCapabilityKey("issues"));
});

test("the human is told WHO asked, on the prompt they approve", async () => {
  bindIssues();
  connectAndDelegate();
  const seen: Action[] = [];
  await performDelegatedCall(store, writer, helper, "issues", {
    host: recordingHost(),
    confirm: (action) => {
      seen.push(action);
      return true;
    },
  });
  expect(seen).toHaveLength(1);
  const args = seen[0]!.args as Record<string, unknown>;
  // References only: who asked, which endpoint, which address, which credential KEY.
  expect(args.requestedBy).toBe("writer");
  expect(args.endpoint).toBe("issues");
  expect(args.url).toBe(URL_A);
  expect(args.credential).toBe("GITHUB_TOKEN");
  expect(JSON.stringify(args)).not.toContain(TOKEN);
});

// ---------------------------------------------------------------------------
// What crosses, and what does not.
// ---------------------------------------------------------------------------

test("the response crosses; the credential does not, anywhere", async () => {
  bindIssues();
  connectAndDelegate();
  // The endpoint echoes the credential straight back — a debug route, a proxy quoting the
  // request. The exact-match scrub is what stops it reaching the caller.
  const host = recordingHost(`{"open":3,"seen":"${TOKEN}"}`);
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: approve,
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error("unreachable");
  // The call really happened, and really carried the credential.
  expect(host.calls).toHaveLength(1);
  expect(host.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  // …and none of it came back.
  expect(outcome.output).toContain('"open":3');
  expect(outcome.output).not.toContain(TOKEN);
  // Nor is it anywhere on either log.
  for (const agent of [writer, helper]) {
    expect(JSON.stringify(store.events.tail(agent.id))).not.toContain(TOKEN);
  }
});

test("the caller supplies nothing that leaves the machine", async () => {
  bindIssues();
  connectAndDelegate();
  const host = recordingHost();
  await performDelegatedCall(store, writer, helper, "issues", { host, confirm: approve });
  expect(host.calls).toHaveLength(1);
  const request = host.calls[0]!;
  // The URL is the operator's declared one, byte for byte — the caller chose which endpoint
  // and contributed nothing else. The only header is the credential.
  expect(request.url).toBe(URL_A);
  expect(Object.keys(request.headers)).toEqual(["Authorization"]);
  expect(JSON.stringify(request)).not.toContain("writer");
});

test("every delegable capability accepts no arguments — the property D38 rests on", () => {
  bindIssues();
  store.bindEndpoint(helper.id, "builds", "https://api.example.test/builds", "GITHUB_TOKEN");
  const delegable = endpointCapabilities(store, helper.id, recordingHost()).filter((c) =>
    isDelegableCapabilityKey(c.key),
  );
  // Positive first: there IS something to check, so an empty set cannot pass this.
  expect(delegable.length).toBeGreaterThan(0);
  for (const capability of delegable) {
    const schema = capability.tool.inputSchema as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    // Delegation is safe because the CALLER can author nothing. If a future change gives a
    // delegable capability an input surface (#132 adds query parameters to this class), this
    // is what turns red — the mode must be re-decided, not silently widened.
    expect(Object.keys(schema.properties ?? {})).toHaveLength(0);
    expect(schema.additionalProperties).toBe(false);
  }
});

test("nothing of the callee beyond the response crosses — memory, credentials and other tools stay put", async () => {
  bindIssues();
  store.addCredential(helper.id, "PRIVATE_KEY", "helper-only-secret");
  store.recordMemory(helper.id, {
    memoryType: "semantic",
    content: "helper knows something private",
    confidence: 0.9,
    reviewState: "accepted",
  });
  connectAndDelegate();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host: recordingHost(),
    confirm: approve,
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error("unreachable");
  expect(outcome.output).not.toContain("helper knows something private");
  expect(outcome.output).not.toContain("helper-only-secret");
  // The channel did not make the callee's own state reachable either — the Phase 0
  // cross-agent denial, exercised across a live delegated channel.
  expect(store.memories.list(writer.id)).toHaveLength(0);
  expect(store.credentials.getByKey(writer.id, "PRIVATE_KEY")).toBeUndefined();
  expect(store.readSecret(writer.id, "GITHUB_TOKEN")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Audit.
// ---------------------------------------------------------------------------

test("a use of the channel is recorded on both logs, references only, with its outcome", async () => {
  bindIssues();
  connectAndDelegate();
  await performDelegatedCall(store, writer, helper, "issues", {
    host: recordingHost(),
    confirm: approve,
  });
  for (const agent of [writer, helper]) {
    const types = typesOn(agent);
    expect(types).toContain("delegation.granted");
    expect(types).toContain("delegation.requested");
    expect(types).toContain("delegation.completed");
  }
  const completed = store.events
    .tail(writer.id)
    .find((e: Event) => e.type === "delegation.completed");
  expect((completed?.payload as { outcome?: string }).outcome).toBe("executed");
  // The response body is nowhere on the log.
  expect(JSON.stringify(store.events.tail(writer.id))).not.toContain('"open":3');
  // The disclosure is recorded on the CALLEE's log alone — it is the callee's credential.
  expect(typesOn(helper)).toContain("secret.read");
  expect(typesOn(writer)).not.toContain("secret.read");
});

test("a refused call is still recorded as a use of the channel", async () => {
  bindIssues();
  connectAndDelegate();
  await performDelegatedCall(store, writer, helper, "issues", {
    host: recordingHost(),
    confirm: refuse,
  });
  const completed = store.events
    .tail(helper.id)
    .find((e: Event) => e.type === "delegation.completed");
  expect((completed?.payload as { outcome?: string }).outcome).toBe("not_confirmed");
  // No credential was ever read, because the call never happened.
  expect(typesOn(helper)).not.toContain("secret.read");
});

// ---------------------------------------------------------------------------
// The window between the prompt and the call.
// ---------------------------------------------------------------------------

test("a channel withdrawn while the human is deciding stops the call", async () => {
  bindIssues();
  connectAndDelegate();
  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: () => {
      // The operator on the other side runs `disconnect` while this prompt is open.
      store.revokeConnection(writer.id, helper.id, "delegated-tool");
      return true;
    },
  });
  expect(outcome.kind).toBe("no_connection");
  expect(host.calls).toHaveLength(0);
});

test("a delegation withdrawn while the human is deciding stops the call", async () => {
  bindIssues();
  const connection = connectAndDelegate();
  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: () => {
      store.endDelegation(connection, endpointCapabilityKey("issues"));
      return true;
    },
  });
  expect(outcome.kind).toBe("no_connection");
  expect(host.calls).toHaveLength(0);
});

test("a reconnect during the pause does not launder the withdrawn grant", async () => {
  bindIssues();
  connectAndDelegate();
  const host = recordingHost();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: () => {
      store.revokeConnection(writer.id, helper.id, "delegated-tool");
      // A FRESH channel, which does not inherit the old one's grants (D20).
      store.createConnection(writer.id, helper.id, "delegated-tool");
      return true;
    },
  });
  expect(outcome.kind).toBe("no_connection");
  expect(host.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Failure, reported honestly.
// ---------------------------------------------------------------------------

test("a surface with no outbound support reports itself unavailable rather than refusing", async () => {
  bindIssues();
  connectAndDelegate();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", { confirm: approve });
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") throw new Error("unreachable");
  expect(outcome.reason).toMatch(/no outbound support/i);
});

test("a missing credential fails loudly, and discloses nothing", async () => {
  store.bindEndpoint(helper.id, "issues", URL_A, "GITHUB_TOKEN");
  connectAndDelegate();
  const outcome = await performDelegatedCall(store, writer, helper, "issues", {
    host: recordingHost(),
    confirm: approve,
  });
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") throw new Error("unreachable");
  expect(outcome.reason).toMatch(/GITHUB_TOKEN/);
  expect(typesOn(helper)).not.toContain("secret.read");
});

test("an ungranted capability is refused identically whether or not the callee has one", async () => {
  // The refusal must not be an oracle over the callee's tools. Both cases, same answer.
  store.createConnection(writer.id, helper.id, "delegated-tool");
  const host = recordingHost();
  const missing = await performDelegatedCall(store, writer, helper, "payroll", {
    host,
    confirm: approve,
  });
  bindIssues();
  const present = await performDelegatedCall(store, writer, helper, "issues", {
    host,
    confirm: approve,
  });
  expect(missing.kind).toBe("not_delegated");
  expect(present.kind).toBe("not_delegated");
  expect(host.calls).toHaveLength(0);
});
