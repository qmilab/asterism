// Does every surface that can start a run actually carry the outbound host?
//
// This is the failure the design note named before the code was written, and it is
// worse-shaped than the usual "did you miss a call site?": a missing `OutboundHost` does
// not throw. The capability is still exposed and reports itself unavailable, which reads
// like a working refusal. So a surface that forgot to thread it looks, from the outside,
// exactly like one enforcing a rule — and no test fails.
//
// The answer is a test per surface rather than an argument. Two shapes, because the
// surfaces divide into two kinds:
//
//   · `run` and `confirm` drive the kernel directly — asserted by CALLING a bound
//     endpoint end to end through `runCli` and checking the host was reached.
//   · `serve`, `dashboard` and the chat channels hand a deps object to a start function —
//     asserted by capturing that object and checking the host is in it. The receiving
//     package's own tests prove it is then forwarded to the kernel.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  OutboundHost,
  OutboundRequest,
  RunOutput,
  RuntimeAdapter,
  ToolResult,
} from "@qmilab/asterism-core";
import type { ChannelHandle, DiscordOptions, TelegramOptions } from "@qmilab/asterism-channels";
import type { RunningServer, ServeConsoleOptions, ServeOptions } from "@qmilab/asterism-server";

import type { CliIO } from "./cli.js";
import { runCli } from "./cli.js";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const URL_A = "https://api.example.test/issues";
const CALL_TOOL = "call_issues";

/** A host that records what it was asked to send. */
function recordingHost(): OutboundHost & { calls: OutboundRequest[] } {
  const calls: OutboundRequest[] = [];
  return {
    calls,
    call(request) {
      calls.push(request);
      return Promise.resolve({ ok: true as const, status: 200, body: '{"ok":true}' });
    },
  };
}

/** A substrate stand-in that calls the bound endpoint's tool if it was given one. */
function endpointCallingAdapter(sink: { tools: string[]; results: ToolResult[] }): RuntimeAdapter {
  return {
    run(request) {
      sink.tools = request.tools.list().map((t) => t.name);
      const tool = request.tools.list().find((t) => t.name === CALL_TOOL);
      async function* noEvents() {}
      return {
        events: noEvents(),
        output: (async (): Promise<RunOutput> => {
          if (tool) sink.results.push(await tool.execute({ args: {} }));
          return { status: "done", text: "done" };
        })(),
      };
    },
  };
}

interface Harness {
  io: CliIO;
  out: string[];
  err: string[];
  host: ReturnType<typeof recordingHost>;
  sink: { tools: string[]; results: ToolResult[] };
}

/** An install with one agent, one credential, and one bound endpoint. */
async function install(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "asterism-surfaces-"));
  tempDirs.push(dir);
  const out: string[] = [];
  const err: string[] = [];
  const host = recordingHost();
  const sink = { tools: [] as string[], results: [] as ToolResult[] };
  const io: CliIO = {
    cwd: dir,
    env: {},
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    outboundHost: host,
    makeAdapter: () => ({ adapter: endpointCallingAdapter(sink) }),
  };
  await runCli(["init"], io);
  await runCli(["new", "personal", "--trust", "autonomous"], io);
  await runCli(["secrets", "add", "personal", "TOK", "tok-value-12345678"], io);
  await runCli(["api", "add", "personal", "issues", URL_A, "--credential", "TOK"], io);
  out.length = 0;
  err.length = 0;
  return { io, out, err, host, sink };
}

const fakeServer = (): RunningServer => ({
  port: 4831,
  hostname: "127.0.0.1",
  url: "http://127.0.0.1:4831",
  stop: () => {},
});
const fakeChannel = (): ChannelHandle => ({ stop: async () => {} });

// --- surfaces that drive the kernel directly ---------------------------------

test("`asterism run` reaches the outbound host for a bound endpoint", async () => {
  const h = await install();

  expect(await runCli(["run", "personal", "check the issues"], { ...h.io, confirm: () => true })).toBe(
    0,
  );

  expect(h.sink.tools).toContain(CALL_TOOL);
  expect(h.host.calls).toHaveLength(1);
  expect(h.host.calls[0]?.url).toBe(URL_A);
  expect(h.host.calls[0]?.headers.Authorization).toBe("Bearer tok-value-12345678");
});

test("`asterism confirm` reaches it on the RESUME path too", async () => {
  const h = await install();
  // Pause: no `confirm` hook, so the destructive gate parks the run.
  await runCli(["run", "personal", "check the issues"], h.io);
  expect(h.host.calls).toHaveLength(0);
  const paused = h.sink.results;
  expect(paused).toHaveLength(1);

  // `confirm` takes a run reference, so read the paused run's short id back out of the
  // CLI's own listing rather than reaching into the store — the surface under test here
  // is the CLI, and this keeps the whole path inside it.
  h.out.length = 0;
  await runCli(["runs", "personal"], h.io);
  const ref = h.out.join("\n").match(/• (\w{8}) · awaiting_confirmation/)?.[1];
  expect(ref).toBeDefined();

  h.out.length = 0;
  expect(await runCli(["confirm", "personal", ref!], h.io)).toBe(0);

  // The resume built its own registry, and it carried the host.
  expect(h.host.calls).toHaveLength(1);
  expect(h.host.calls[0]?.headers.Authorization).toBe("Bearer tok-value-12345678");
});

test("a handoff callee's run carries the host through the exchange path", async () => {
  const h = await install();
  await runCli(["new", "helper", "--trust", "autonomous"], h.io);
  await runCli(["secrets", "add", "helper", "TOK", "helper-value-87654321"], h.io);
  await runCli(["api", "add", "helper", "issues", URL_A, "--credential", "TOK"], h.io);
  await runCli(["connect", "personal", "helper", "--mode", "handoff"], h.io);

  expect(
    await runCli(["handoff", "personal", "helper", "check the issues"], { ...h.io, confirm: () => true }),
  ).toBe(0);

  expect(h.host.calls).toHaveLength(1);
  // The CALLEE's credential, which is the whole point of the mode.
  expect(h.host.calls[0]?.headers.Authorization).toBe("Bearer helper-value-87654321");
});

// --- surfaces that hand a deps object to a start function ---------------------

test("`serve` hands the outbound host to the HTTP surface", async () => {
  const h = await install();
  let captured: ServeOptions | undefined;

  expect(
    await runCli(["serve", "personal", "--port", "9090"], {
      ...h.io,
      startServer: (options) => {
        captured = options;
        return fakeServer();
      },
      waitForShutdown: () => Promise.resolve(),
    }),
  ).toBe(0);

  expect(captured?.outboundHost).toBe(h.host);
});

test("`dashboard` hands the outbound host to the operator console", async () => {
  const h = await install();
  let captured: ServeConsoleOptions | undefined;

  expect(
    await runCli(["dashboard", "--headless"], {
      ...h.io,
      startConsole: (options) => {
        captured = options;
        return fakeServer();
      },
      waitForShutdown: () => Promise.resolve(),
    }),
  ).toBe(0);

  expect(captured?.outboundHost).toBe(h.host);
});

test("`channel telegram` hands the outbound host to the chat surface", async () => {
  const h = await install();
  let captured: TelegramOptions | undefined;

  expect(
    await runCli(["channel", "telegram", "personal", "--allow", "42"], {
      ...h.io,
      env: { ASTERISM_TELEGRAM_TOKEN: "123456:fake-bot-token" },
      startTelegram: (options) => {
        captured = options;
        return fakeChannel();
      },
      waitForShutdown: () => Promise.resolve(),
    }),
  ).toBe(0);

  expect(captured?.outboundHost).toBe(h.host);
});

test("`channel discord` hands the outbound host to the chat surface", async () => {
  const h = await install();
  let captured: DiscordOptions | undefined;

  expect(
    await runCli(["channel", "discord", "personal", "--allow", "42"], {
      ...h.io,
      env: { ASTERISM_DISCORD_TOKEN: "fake-discord-token" },
      startDiscord: (options) => {
        captured = options;
        return fakeChannel();
      },
      waitForShutdown: () => Promise.resolve(),
    }),
  ).toBe(0);

  expect(captured?.outboundHost).toBe(h.host);
});

// --- the allow-list flag itself ------------------------------------------------

test("a chat channel refuses an --allow that carries nothing, on both transports", async () => {
  // The channels have no synopsis line of their own, so `unknown-flags.test.ts`'s derived
  // sweep of "an option that refuses a missing value refuses an empty one" cannot reach
  // them — it says so, and points here. `--allow ""` is what `--allow "$IDS"` expands to
  // with the variable unset; taken as a value it started the bot with no allow-list at
  // all, silently, where the operator had named one (#174).
  const h = await install();
  let started = false;
  const startedIo = {
    startTelegram: () => {
      started = true;
      return fakeChannel();
    },
    startDiscord: () => {
      started = true;
      return fakeChannel();
    },
    waitForShutdown: () => Promise.resolve(),
  };

  for (const [transport, tokenVar, token, noun] of [
    ["telegram", "ASTERISM_TELEGRAM_TOKEN", "123456:fake-bot-token", "chat ids"],
    ["discord", "ASTERISM_DISCORD_TOKEN", "fake-discord-token", "channel ids"],
  ] as const) {
    const err: string[] = [];
    const io = { ...h.io, ...startedIo, env: { [tokenVar]: token }, err: (t: string) => err.push(t) };
    expect(await runCli(["channel", transport, "personal", "--allow", ""], io)).toBe(1);
    expect(err.join("\n")).toContain(`The --allow option needs a value (a comma-separated list of ${noun})`);
    // And the bot never started, so nothing was ever reachable without the list.
    expect(started).toBe(false);
    // The ordinary form still starts, so the refusal has not swallowed the flag.
    expect(await runCli(["channel", transport, "personal", "--allow", "42"], { ...io, err: () => {} })).toBe(0);
    expect(started).toBe(true);
    started = false;
  }
});

// --- and the honest negative --------------------------------------------------

test("with no outbound host the tool is still offered, and says why it cannot call", async () => {
  const h = await install();
  const io = { ...h.io };
  delete io.outboundHost;

  expect(await runCli(["run", "personal", "check the issues"], { ...io, confirm: () => true })).toBe(0);

  // Exposed, not vanished — the property that keeps a forgotten surface from looking
  // like an enforced refusal.
  expect(h.sink.tools).toContain(CALL_TOOL);
  expect(h.sink.results[0]?.isError).toBe(true);
  expect(h.sink.results[0]?.output).toMatch(/no outbound support/);
  expect(h.host.calls).toHaveLength(0);
});
