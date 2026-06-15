// The Discord transport — tested without a network. `interpretFrame` is pinned as a
// pure function over canned Gateway frames; `deliver` is driven with a fake transport
// and dispatcher; the `fetch`-backed REST transport is checked for request shape and
// error surfacing; and `runDiscord` is run end-to-end against the real kernel with a
// fake socket + fake `fetch`, so the connection lifecycle (identify, dispatch,
// reconnect, fatal close, shutdown) is exercised with no sockets and no timers firing.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { AsterismStore } from "@qmilab/asterism-core";
import type { Agent, RunOutput, RuntimeAdapter } from "@qmilab/asterism-core";

import type { ChannelDispatcher } from "./dispatch.ts";
import {
  deliver,
  discordTransport,
  DISCORD_INTENTS,
  DISCORD_MAX_CHARS,
  interpretFrame,
  runDiscord,
} from "./discord.ts";
import type { DiscordTransport, WebSocketFactory, WebSocketLike } from "./discord.ts";
import type { FetchLike } from "./shared.ts";

// --- interpretFrame (pure) -------------------------------------------------

test("interpretFrame: a Hello starts heartbeating, then identifies", () => {
  expect(interpretFrame({ op: 10, d: { heartbeat_interval: 41250 } }, "BOT")).toEqual([
    { kind: "startHeartbeat", intervalMs: 41250 },
    { kind: "identify" },
  ]);
});

test("interpretFrame: a heartbeat request and an ack map to their effects", () => {
  expect(interpretFrame({ op: 1 }, "BOT")).toEqual([{ kind: "heartbeat" }]);
  expect(interpretFrame({ op: 11 }, "BOT")).toEqual([{ kind: "ack" }]);
});

test("interpretFrame: reconnect and invalid-session both reconnect", () => {
  expect(interpretFrame({ op: 7 }, "BOT")).toEqual([{ kind: "reconnect" }]);
  expect(interpretFrame({ op: 9, d: false }, "BOT")).toEqual([{ kind: "reconnect" }]);
});

test("interpretFrame: a real user's message becomes a dispatch", () => {
  expect(
    interpretFrame(
      { op: 0, s: 3, t: "MESSAGE_CREATE", d: { channel_id: "C1", content: "do it", author: { id: "U1", bot: false } } },
      "BOT",
    ),
  ).toEqual([{ kind: "dispatch", channelId: "C1", text: "do it" }]);
});

test("interpretFrame: our own messages and other bots are ignored (no loops)", () => {
  const self = interpretFrame(
    { op: 0, t: "MESSAGE_CREATE", d: { channel_id: "C1", content: "echo", author: { id: "BOT", bot: true } } },
    "BOT",
  );
  const otherBot = interpretFrame(
    { op: 0, t: "MESSAGE_CREATE", d: { channel_id: "C1", content: "hi", author: { id: "OTHER", bot: true } } },
    "BOT",
  );
  expect(self).toEqual([]);
  expect(otherBot).toEqual([]);
});

test("interpretFrame: an empty or content-free message is not a task", () => {
  // content-free is what MESSAGE CONTENT-not-granted looks like — nothing to run.
  expect(
    interpretFrame({ op: 0, t: "MESSAGE_CREATE", d: { channel_id: "C1", content: "", author: { id: "U1" } } }, "BOT"),
  ).toEqual([]);
  expect(
    interpretFrame({ op: 0, t: "MESSAGE_CREATE", d: { channel_id: "C1", author: { id: "U1" } } }, "BOT"),
  ).toEqual([]);
});

test("interpretFrame: other dispatch types and unknown opcodes are ignored", () => {
  expect(interpretFrame({ op: 0, t: "READY", d: { user: { id: "BOT" } } }, "BOT")).toEqual([]);
  expect(interpretFrame({ op: 99 }, "BOT")).toEqual([]);
});

test("interpretFrame: a DM (no guild) runs without needing a mention", () => {
  expect(
    interpretFrame(
      { op: 0, t: "MESSAGE_CREATE", d: { channel_id: "D1", content: "do it", author: { id: "U1", bot: false } } },
      "BOT",
    ),
  ).toEqual([{ kind: "dispatch", channelId: "D1", text: "do it" }]);
});

test("interpretFrame: a server message is ignored unless it @mentions the bot", () => {
  // The bot sees every readable channel message; unrelated chatter must not run it.
  expect(
    interpretFrame(
      {
        op: 0,
        t: "MESSAGE_CREATE",
        d: { guild_id: "G1", channel_id: "C1", content: "just chatting", author: { id: "U1" }, mentions: [] },
      },
      "BOT",
    ),
  ).toEqual([]);
});

test("interpretFrame: a server @mention dispatches with the mention stripped", () => {
  expect(
    interpretFrame(
      {
        op: 0,
        t: "MESSAGE_CREATE",
        d: {
          guild_id: "G1",
          channel_id: "C1",
          content: "<@BOT> summarize the thread",
          author: { id: "U1", bot: false },
          mentions: [{ id: "BOT" }],
        },
      },
      "BOT",
    ),
  ).toEqual([{ kind: "dispatch", channelId: "C1", text: "summarize the thread" }]);
});

test("interpretFrame: the legacy <@!id> mention form is also stripped", () => {
  expect(
    interpretFrame(
      {
        op: 0,
        t: "MESSAGE_CREATE",
        d: { guild_id: "G1", channel_id: "C1", content: "<@!BOT> ship it", author: { id: "U1" }, mentions: [{ id: "BOT" }] },
      },
      "BOT",
    ),
  ).toEqual([{ kind: "dispatch", channelId: "C1", text: "ship it" }]);
});

test("interpretFrame: a bare server @mention dispatches (empty text) so discovery can answer", () => {
  // The mention is the whole message: it must still reach the dispatcher — an
  // unauthorized channel needs its id back, and the dispatcher nudges for a task.
  expect(
    interpretFrame(
      {
        op: 0,
        t: "MESSAGE_CREATE",
        d: { guild_id: "G1", channel_id: "C1", content: "<@BOT>", author: { id: "U1" }, mentions: [{ id: "BOT" }] },
      },
      "BOT",
    ),
  ).toEqual([{ kind: "dispatch", channelId: "C1", text: "" }]);
});

test("interpretFrame: a server /confirm reply is honored without a mention", () => {
  // The pause prompt tells users to "reply /confirm" — the guild @mention gate must
  // not strand a paused run by dropping a plain control reply.
  expect(
    interpretFrame(
      {
        op: 0,
        t: "MESSAGE_CREATE",
        d: { guild_id: "G1", channel_id: "C1", content: "/confirm", author: { id: "U1" }, mentions: [] },
      },
      "BOT",
    ),
  ).toEqual([{ kind: "dispatch", channelId: "C1", text: "/confirm" }]);
});

test("interpretFrame: another bot's slash-command in a server still needs a mention", () => {
  expect(
    interpretFrame(
      {
        op: 0,
        t: "MESSAGE_CREATE",
        d: { guild_id: "G1", channel_id: "C1", content: "/giphy cat", author: { id: "U1" }, mentions: [] },
      },
      "BOT",
    ),
  ).toEqual([]);
});

// --- deliver (dispatch + chunked reply) ------------------------------------

/** A transport that records what it sent (and a self id for completeness). */
function sink(): { transport: DiscordTransport; sent: { channelId: string; text: string }[] } {
  const sent: { channelId: string; text: string }[] = [];
  const transport: DiscordTransport = {
    async getSelf() {
      return { id: "BOT" };
    },
    async sendMessage(channelId, text) {
      sent.push({ channelId, text });
    },
  };
  return { transport, sent };
}

/** A dispatcher whose reply is computed from the inbound message. */
function echoDispatcher(fn: (text: string, chatId: string) => string): ChannelDispatcher {
  return { handle: async ({ chatId, text }) => [{ chatId, text: fn(text, chatId) }] };
}

test("deliver dispatches a message and sends the reply", async () => {
  const { transport, sent } = sink();
  await deliver(transport, echoDispatcher((t) => `echo:${t}`), "C1", "hello");
  expect(sent).toEqual([{ channelId: "C1", text: "echo:hello" }]);
});

test("deliver chunks a reply longer than Discord's limit", async () => {
  const big = "a".repeat(DISCORD_MAX_CHARS + 250);
  const { transport, sent } = sink();
  await deliver(transport, echoDispatcher(() => big), "C1", "x");
  expect(sent).toHaveLength(2);
  expect(sent[0]!.text.length).toBe(DISCORD_MAX_CHARS);
  expect(sent.map((s) => s.text).join("")).toBe(big); // reassembles to the original
});

test("deliver swallows a send failure — the run already ran", async () => {
  const transport: DiscordTransport = {
    async getSelf() {
      return { id: "BOT" };
    },
    async sendMessage() {
      throw new Error("Missing Permissions");
    },
  };
  // Must not throw: a failed delivery is best-effort, never a reprocess.
  await deliver(transport, echoDispatcher((t) => t), "C1", "hi");
});

// --- discordTransport (REST request shape) ---------------------------------

test("discordTransport.getSelf authenticates with the bot token and returns identity", async () => {
  const calls: { url: string; method: string; auth: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization! });
    return { ok: true, status: 200, json: async () => ({ id: "BOT", username: "agentbot" }) };
  };

  const me = await discordTransport("TOKEN", fetchImpl).getSelf();

  expect(me).toEqual({ id: "BOT", username: "agentbot" });
  expect(calls[0]!.url).toBe("https://discord.com/api/v10/users/@me");
  expect(calls[0]!.method).toBe("GET");
  expect(calls[0]!.auth).toBe("Bot TOKEN"); // token rides the header, never the URL
});

test("discordTransport.sendMessage posts the content to the channel", async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    return { ok: true, status: 200, json: async () => ({ id: "m1" }) };
  };

  await discordTransport("TOKEN", fetchImpl).sendMessage("C1", "hello");

  expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/C1/messages");
  expect(calls[0]!.method).toBe("POST");
  // `allowed_mentions: { parse: [] }` ⇒ a model-generated reply can never ping anyone.
  expect(JSON.parse(calls[0]!.body!)).toEqual({ content: "hello", allowed_mentions: { parse: [] } });
});

test("discordTransport surfaces Discord's own error message", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ message: "Missing Access", code: 50001 }),
  });

  await expect(discordTransport("TOKEN", fetchImpl).sendMessage("C1", "x")).rejects.toThrow("Missing Access");
});

// --- runDiscord (connection lifecycle, real kernel + fake socket) ----------

let store: AsterismStore;
let personal: Agent;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  personal = store.createAgent({
    name: "personal",
    role: "personal helper",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/personal",
    trustLevel: "autonomous",
  });
});

afterEach(() => {
  store.close();
});

/** A substrate stand-in that ignores tools and resolves canned output. */
function cannedAdapter(output: RunOutput): RuntimeAdapter {
  return {
    run() {
      async function* noEvents() {}
      return { events: noEvents(), output: Promise.resolve(output) };
    },
  };
}

/** A fake Gateway socket the test drives by hand — no network, no timers fire. */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.onclose?.({ code, reason });
  }

  // Test drivers:
  open(): void {
    this.onopen?.();
  }
  recv(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  frames(): Array<{ op: number; d?: unknown }> {
    return this.sent.map((s) => JSON.parse(s) as { op: number; d?: unknown });
  }
}

/** A factory that records every socket it hands out, so reconnects are observable. */
function fakeSockets(): { factory: WebSocketFactory; created: FakeSocket[] } {
  const created: FakeSocket[] = [];
  return {
    created,
    factory: () => {
      const s = new FakeSocket();
      created.push(s);
      return s;
    },
  };
}

/** A `fetch` that answers `users/@me` and records every reply POST. */
function recordingFetch(): { fetchImpl: FetchLike; posts: Array<{ url: string; body?: string }> } {
  const posts: Array<{ url: string; body?: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith("/users/@me")) {
      return { ok: true, status: 200, json: async () => ({ id: "BOT", username: "agentbot" }) };
    }
    posts.push({ url, body: init.body });
    return { ok: true, status: 200, json: async () => ({ id: "m1" }) };
  };
  return { fetchImpl, posts };
}

const HELLO = { op: 10, d: { heartbeat_interval: 600000 } }; // huge interval ⇒ no beat fires in a test

/** Poll until a predicate holds (the run/deliver chain settles over a few ticks). */
async function waitFor(pred: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("waitFor timed out");
}

test("runDiscord identifies (with the privileged intents) after the Hello", async () => {
  const { factory, created } = fakeSockets();
  const { fetchImpl } = recordingFetch();

  const channel = await runDiscord({
    store,
    agent: personal,
    adapter: cannedAdapter({ status: "done", text: "hi from the agent" }),
    allow: new Set(["C1"]),
    token: "T",
    fetch: fetchImpl,
    WebSocket: factory,
    gatewayUrl: "ws://fake",
  });

  expect(channel.botUsername).toBe("agentbot"); // resolved from getSelf
  expect(created).toHaveLength(1);
  const sock = created[0]!;
  sock.open();
  sock.recv(HELLO);

  const identify = sock.frames().find((f) => f.op === 2);
  expect(identify).toBeDefined();
  expect((identify!.d as { token: string }).token).toBe("T");
  expect((identify!.d as { intents: number }).intents).toBe(DISCORD_INTENTS);

  await channel.stop();
});

test("runDiscord runs an authorized message and posts the reply back to the channel", async () => {
  const { factory, created } = fakeSockets();
  const { fetchImpl, posts } = recordingFetch();

  const channel = await runDiscord({
    store,
    agent: personal,
    adapter: cannedAdapter({ status: "done", text: "hi from the agent" }),
    allow: new Set(["C1"]),
    token: "T",
    fetch: fetchImpl,
    WebSocket: factory,
    gatewayUrl: "ws://fake",
  });
  const sock = created[0]!;
  sock.open();
  sock.recv(HELLO);
  sock.recv({
    op: 0,
    s: 1,
    t: "MESSAGE_CREATE",
    d: { channel_id: "C1", content: "write the draft", author: { id: "U1", bot: false } },
  });

  await waitFor(() => posts.length > 0);
  expect(posts[0]!.url).toBe("https://discord.com/api/v10/channels/C1/messages");
  expect(JSON.parse(posts[0]!.body!).content).toContain("hi from the agent");
  expect(store.runs.list(personal.id)).toHaveLength(1);

  await channel.stop();
});

test("runDiscord ignores a message the bot itself sent (no run, no loop)", async () => {
  const { factory, created } = fakeSockets();
  const { fetchImpl, posts } = recordingFetch();

  const channel = await runDiscord({
    store,
    agent: personal,
    adapter: cannedAdapter({ status: "done", text: "x" }),
    allow: new Set(["C1"]),
    token: "T",
    fetch: fetchImpl,
    WebSocket: factory,
    gatewayUrl: "ws://fake",
  });
  const sock = created[0]!;
  sock.open();
  sock.recv(HELLO);
  sock.recv({
    op: 0,
    s: 1,
    t: "MESSAGE_CREATE",
    d: { channel_id: "C1", content: "hi from the agent", author: { id: "BOT", bot: true } },
  });

  await new Promise((r) => setTimeout(r, 5));
  expect(posts).toHaveLength(0);
  expect(store.runs.list(personal.id)).toHaveLength(0);

  await channel.stop();
});

test("runDiscord reconnects with a fresh socket after a transient close", async () => {
  const { factory, created } = fakeSockets();
  const { fetchImpl } = recordingFetch();

  const channel = await runDiscord({
    store,
    agent: personal,
    adapter: cannedAdapter({ status: "done", text: "x" }),
    allow: new Set(["C1"]),
    token: "T",
    fetch: fetchImpl,
    WebSocket: factory,
    gatewayUrl: "ws://fake",
    reconnectDelayMs: 0,
  });

  created[0]!.open();
  created[0]!.recv(HELLO);
  created[0]!.close(4000, "blip"); // a transient drop, not a fatal code

  await waitFor(() => created.length === 2); // a new connection was opened
  await channel.stop();
});

test("runDiscord stops on a fatal close and points at the MESSAGE CONTENT intent", async () => {
  const { factory, created } = fakeSockets();
  const { fetchImpl } = recordingFetch();
  const logs: string[] = [];

  const channel = await runDiscord({
    store,
    agent: personal,
    adapter: cannedAdapter({ status: "done", text: "x" }),
    allow: new Set(["C1"]),
    token: "T",
    fetch: fetchImpl,
    WebSocket: factory,
    gatewayUrl: "ws://fake",
    reconnectDelayMs: 0,
    log: (m) => logs.push(m),
  });

  created[0]!.open();
  created[0]!.recv(HELLO);
  created[0]!.close(4014, "Disallowed intent(s)"); // privileged intent not granted

  await channel.closed; // the loop ends on its own — a surface can race this
  expect(created).toHaveLength(1); // did NOT reconnect
  expect(logs.join("\n")).toContain("MESSAGE CONTENT");

  await channel.stop(); // already unwound; resolves cleanly
});

test("runDiscord stop() closes the socket and does not reconnect", async () => {
  const { factory, created } = fakeSockets();
  const { fetchImpl } = recordingFetch();

  const channel = await runDiscord({
    store,
    agent: personal,
    adapter: cannedAdapter({ status: "done", text: "x" }),
    allow: new Set(["C1"]),
    token: "T",
    fetch: fetchImpl,
    WebSocket: factory,
    gatewayUrl: "ws://fake",
  });
  const sock = created[0]!;
  sock.open();
  sock.recv(HELLO);

  await channel.stop();

  expect(sock.closed?.code).toBe(1000); // a graceful close
  expect(created).toHaveLength(1); // no reconnect after an intentional stop
});

test("runDiscord rejects the launch when the token is invalid (no socket opened)", async () => {
  const { factory, created } = fakeSockets();
  const fetchImpl: FetchLike = async (url) => {
    if (url.endsWith("/users/@me")) {
      return { ok: false, status: 401, json: async () => ({ message: "401: Unauthorized" }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await expect(
    runDiscord({
      store: {} as AsterismStore, // never touched: getSelf throws first
      agent: {} as Agent,
      allow: new Set(["C1"]),
      token: "BAD",
      fetch: fetchImpl,
      WebSocket: factory,
    }),
  ).rejects.toThrow("Unauthorized");
  expect(created).toHaveLength(0);
});

test("runDiscord rejects when the runtime has no WebSocket", async () => {
  const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  try {
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    await expect(
      // No injected WebSocket and none global ⇒ a clear pointer to upgrade.
      runDiscord({ store: {} as AsterismStore, agent: {} as Agent, allow: new Set(), token: "T" }),
    ).rejects.toThrow(/WebSocket runtime/);
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  }
});
