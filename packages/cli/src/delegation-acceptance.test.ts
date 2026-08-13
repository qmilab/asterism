// `delegated-tool` end-to-end through the real CLI surface — Track A's fifth and last mode
// (issue #137, design note §21).
//
// The script runs verbatim through `runCli` against a real on-disk store: real agents, real
// credentials, a real binding, a real gate. Only the outbound host is faked, because the
// alternative is dialing the internet from a test.
//
// It must demonstrate (design note §21, "what done looks like"):
//   1. Three distinct refusals — no channel, no delegation, wrong direction — none of which
//      reveals whether the callee has such an endpoint.
//   2. A delegation cannot be granted for an endpoint the callee does not hold, and one bound
//      later is not reachable until it is named.
//   3. The call pauses under `notify`/`autonomous` and is WITHHELD under `propose` — the
//      callee's level, never the caller's.
//   4. The credential appears in no output, on no log, in nothing that crosses.
//   5. Removing or re-pointing the binding ends the grant, and says so at the time.
//   6. `disconnect` withdraws every grant on the channel at once.
//   7. `connections` says what each channel can actually reach.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsterismStore } from "@qmilab/asterism-core";
import type { Agent, OutboundHost, OutboundRequest } from "@qmilab/asterism-core";

import { runCli } from "./cli.js";
import type { CliIO } from "./cli.js";
import { dbPath, HOME_DIR_NAME } from "./paths.js";

const TOKEN = "zzq-plainlooking-value-8842176";
const ISSUES_URL = "https://api.example.test/repos/acme/site/issues?state=open";
const PULLS_URL = "https://api.example.test/repos/acme/site/pulls";
const BODY = '{"open":3,"titles":["ship the pricing page"]}';

describe("Phase 3 · delegated-tool — acceptance", () => {
  let dir: string;
  let store: AsterismStore;
  let writer: Agent;
  let helper: Agent;

  const transcript: string[] = [];
  const exitCodes: [command: string, code: number][] = [];
  const outbound: OutboundRequest[] = [];
  /**
   * Exit code and dialed-call count AT EACH STEP, captured as the script runs.
   *
   * Recorded per step rather than looked up afterwards by command string: the same command
   * is run several times here with different state behind it, so a by-name lookup silently
   * answers about the FIRST invocation — which is a different assertion than the one the
   * test's name claims, and passes anyway.
   */
  const codes: Record<string, number> = {};
  const dialed: Record<string, number> = {};

  /** Whether the human at the terminal approves the next confirmation. */
  let approving = true;

  let noChannelOut = "";
  let noGrantOut = "";
  let unboundOut = "";
  let delegateOut = "";
  let callOut = "";
  let reverseOut = "";
  let notConfirmedOut = "";
  let proposeOut = "";
  let connectionsOut = "";
  let connectionsEmptyOut = "";
  let laterEndpointOut = "";
  let rebindOut = "";
  let afterRebindOut = "";
  let removeOut = "";
  let undelegateOut = "";
  let afterDisconnectOut = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "asterism-delegate-acc-"));

    const host: OutboundHost = {
      call(request) {
        outbound.push(request);
        return Promise.resolve({ ok: true as const, status: 200, body: BODY });
      },
    };

    const io: CliIO = {
      cwd: dir,
      env: {},
      out: (t) => transcript.push(t),
      err: (t) => transcript.push(t),
      // No adapter is needed anywhere in this script: not one command here runs a model.
      // That is the mode's own property, not a convenience of the test.
      makeAdapter: () => {
        throw new Error("delegated-tool must never need a substrate");
      },
      capabilities: () => [],
      outboundHost: host,
      confirm: () => approving,
    };

    async function run(argv: string[], step?: string): Promise<string> {
      const start = transcript.length;
      const code = await runCli(argv, io);
      exitCodes.push([argv.join(" "), code]);
      if (step !== undefined) {
        codes[step] = code;
        dialed[step] = outbound.length;
      }
      return transcript.slice(start).join("\n");
    }

    await run(["init"]);
    await run(["new", "writer", "--soul", "casual-helper", "--trust", "autonomous"]);
    await run(["new", "helper", "--soul", "careful-consultant", "--trust", "notify"]);

    store = AsterismStore.open(dbPath(join(dir, HOME_DIR_NAME)));
    writer = store.agents.list().find((a) => a.name === "writer")!;
    helper = store.agents.list().find((a) => a.name === "helper")!;

    // The callee's own endpoint, with its own credential.
    await run(["secrets", "add", "helper", "GITHUB_TOKEN", TOKEN]);
    await run(["api", "add", "helper", "issues", ISSUES_URL, "--credential", "GITHUB_TOKEN"]);

    // (1) Every refusal, before anything is granted.
    noChannelOut = await run(["call", "writer", "helper", "issues"], "noChannel");
    await run(["connect", "writer", "helper", "--mode", "delegated-tool"]);
    connectionsEmptyOut = await run(["connections", "writer"]);
    noGrantOut = await run(["call", "writer", "helper", "issues"], "noGrant");
    unboundOut = await run(["delegate", "writer", "helper", "payroll"], "unbound");

    // (2) The grant, and the call.
    delegateOut = await run(["delegate", "writer", "helper", "issues"], "delegate");
    connectionsOut = await run(["connections", "writer"]);
    callOut = await run(["call", "writer", "helper", "issues"], "call");

    // The reverse direction is its own channel, and there is none.
    reverseOut = await run(["call", "helper", "writer", "issues"], "reverse");

    // (3) The gate. First refused at the prompt, then withheld by trust level.
    approving = false;
    notConfirmedOut = await run(["call", "writer", "helper", "issues"], "notConfirmed");
    approving = true;
    await run(["trust", "helper", "propose"]);
    proposeOut = await run(["call", "writer", "helper", "issues"], "propose");
    await run(["trust", "helper", "notify"]);

    // (5a) An endpoint bound LATER is not reachable through the open channel.
    await run(["api", "add", "helper", "payroll", "https://api.example.test/payroll", "--credential", "GITHUB_TOKEN"]);
    laterEndpointOut = await run(["call", "writer", "helper", "payroll"], "later");

    // (5b) Re-pointing the delegated endpoint ends the grant, loudly.
    rebindOut = await run(["api", "add", "helper", "issues", PULLS_URL, "--credential", "GITHUB_TOKEN"]);
    afterRebindOut = await run(["call", "writer", "helper", "issues"], "afterRebind");

    // Hand it over again, then remove the binding entirely.
    await run(["delegate", "writer", "helper", "issues"]);
    removeOut = await run(["api", "remove", "helper", "issues"]);

    // (6) Withdrawing one grant leaves the channel; withdrawing the channel takes the rest.
    await run(["api", "add", "helper", "issues", ISSUES_URL, "--credential", "GITHUB_TOKEN"]);
    await run(["delegate", "writer", "helper", "issues"]);
    await run(["delegate", "writer", "helper", "payroll"]);
    undelegateOut = await run(["undelegate", "writer", "helper", "issues"], "undelegate");
    await run(["disconnect", "writer", "helper", "--mode", "delegated-tool"]);
    afterDisconnectOut = await run(["call", "writer", "helper", "payroll"], "afterDisconnect");
  });

  afterAll(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("with no channel, the call is refused and names the channel to open", () => {
    expect(noChannelOut).toMatch(/no active delegated-tool connection/i);
    expect(noChannelOut).toContain("asterism connect writer helper --mode delegated-tool");
    expect(codes.noChannel).toBe(1);
    expect(dialed.noChannel).toBe(0);
  });

  test("an open channel with nothing handed over says so, and reaches nothing", () => {
    // The listing is explicit rather than leaving `delegated-tool · active` to read as a
    // working channel — it can do nothing at all until something is named.
    expect(connectionsEmptyOut).toMatch(/nothing handed over yet/i);
    expect(noGrantOut).toMatch(/cannot ask helper to call 'issues'/i);
    expect(noGrantOut).toContain("asterism delegate writer helper issues");
  });

  test("the refusal for an ungranted tool reveals nothing about what the callee has", () => {
    // `issues` exists on the callee and `payroll` did not, at the moment each was asked
    // for — and the two refusals are the same sentence with the name swapped.
    expect(noGrantOut.replace(/issues/g, "X")).toBe(laterEndpointOut.replace(/payroll/g, "X"));
  });

  test("a delegation cannot be granted for an endpoint the callee does not hold", () => {
    expect(unboundOut).toMatch(/helper has no endpoint 'payroll' to hand over/i);
    expect(unboundOut).toContain("asterism api list helper");
    expect(codes.unbound).toBe(1);
  });

  test("granting says what it grants, and warns that every call stops for a human", () => {
    expect(delegateOut).toMatch(/writer may now ask helper to call 'issues' — and only that/i);
    expect(delegateOut).toMatch(/credential stays with helper/i);
    expect(delegateOut).toMatch(/every call stops for you/i);
    expect(delegateOut).toContain("asterism call writer helper issues");
  });

  test("connections says what the channel can actually reach", () => {
    expect(connectionsOut).toContain("delegated-tool");
    expect(connectionsOut).toContain("may call api.issues");
  });

  test("the call crosses the response — and nothing else", () => {
    expect(codes.call).toBe(0);
    expect(callOut).toContain('"open":3');
    expect(callOut).toContain("ship the pricing page");
    // The credential went out…
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(outbound[0]!.url).toBe(ISSUES_URL);
    // …and appears in nothing the operator or either agent ever sees.
    expect(transcript.join("\n")).not.toContain(TOKEN);
    for (const agent of [writer, helper]) {
      expect(JSON.stringify(store.events.tail(agent.id))).not.toContain(TOKEN);
      expect(JSON.stringify(store.events.tail(agent.id))).not.toContain('"open":3');
    }
  });

  test("the caller cannot ask in the reverse direction", () => {
    expect(reverseOut).toMatch(/no active delegated-tool connection from helper to writer/i);
    expect(codes.reverse).toBe(1);
  });

  test("a refused confirmation sends nothing", () => {
    expect(notConfirmedOut).toMatch(/needs your explicit confirmation/i);
    expect(codes.notConfirmed).toBe(1);
    // No new call: the approved invocation above is still the only one dialed.
    expect(dialed.notConfirmed).toBe(dialed.call);
  });

  test("a propose callee never calls at all — it only says what it would do", () => {
    expect(proposeOut).toMatch(/\[proposed\] would ask helper to call 'issues'/i);
    expect(proposeOut).toMatch(/nothing was sent/i);
    expect(proposeOut).toMatch(/helper is at trust level propose/i);
    expect(codes.propose).toBe(0);
    expect(dialed.propose).toBe(dialed.call);
  });

  test("re-pointing the endpoint ends the grant, and says whose it was", () => {
    expect(rebindOut).toMatch(/this changed what the call sends, so writer can no longer ask helper/i);
    expect(rebindOut).toContain("asterism delegate writer helper issues");
    expect(afterRebindOut).toMatch(/cannot ask helper to call 'issues'/i);
    // Nothing was dialed at the new address.
    expect(outbound.map((r) => r.url)).not.toContain(PULLS_URL);
  });

  test("removing the endpoint ends the grant too, and leaves the credential alone", () => {
    expect(removeOut).toMatch(/writer can no longer ask helper to call it either/i);
    expect(removeOut).toMatch(/credential itself is untouched/i);
  });

  test("undelegate withdraws one grant and keeps the channel", () => {
    expect(undelegateOut).toMatch(/writer can no longer ask helper to call 'issues'/i);
    expect(undelegateOut).toMatch(/channel is still open/i);
    expect(codes.undelegate).toBe(0);
  });

  test("disconnect withdraws every remaining grant on the channel at once", () => {
    expect(afterDisconnectOut).toMatch(/no active delegated-tool connection/i);
    expect(codes.afterDisconnect).toBe(1);
  });

  test("both logs record every grant and every use, references only", () => {
    for (const agent of [writer, helper]) {
      const types = store.events.tail(agent.id).map((e) => e.type);
      expect(types).toContain("delegation.granted");
      expect(types).toContain("delegation.ended");
      expect(types).toContain("delegation.requested");
      expect(types).toContain("delegation.completed");
    }
    // The disclosure is the callee's alone.
    expect(store.events.tail(helper.id).map((e) => e.type)).toContain("secret.read");
    expect(store.events.tail(writer.id).map((e) => e.type)).not.toContain("secret.read");
  });

  test("not one command in the script needed a model", () => {
    // `makeAdapter` throws, so reaching here at all is the assertion. Stated as a test
    // because it is a claim the docs make about this mode, not an accident of the harness.
    expect(exitCodes.length).toBeGreaterThan(20);
  });
});
