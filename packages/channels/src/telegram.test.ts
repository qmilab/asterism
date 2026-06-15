// The Telegram transport — tested without a network. `pollOnce` is driven with a
// fake transport (canned updates + a sink for sends); the `fetch`-backed transport
// is checked against a fake `fetch` for request shape and error surfacing; and the
// chunker is pinned at its boundaries.

import { expect, test } from "bun:test";

import type { Agent, AsterismStore } from "@qmilab/asterism-core";

import type { ChannelDispatcher, OutboundMessage } from "./dispatch.ts";
import { chunkText } from "./shared.ts";
import type { FetchLike } from "./shared.ts";
import {
  drainBacklog,
  pollOnce,
  runTelegram,
  telegramTransport,
  TELEGRAM_MAX_CHARS,
} from "./telegram.ts";
import type { TelegramTransport, TelegramUpdate } from "./telegram.ts";

/** A transport that hands out canned update batches and records what it sent. */
function fakeTransport(batches: TelegramUpdate[][]): {
  transport: TelegramTransport;
  sent: OutboundMessage[];
} {
  let call = 0;
  const sent: OutboundMessage[] = [];
  const transport: TelegramTransport = {
    async getUpdates() {
      return batches[call++] ?? [];
    },
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
    },
  };
  return { transport, sent };
}

/** A dispatcher whose reply is computed from the inbound message by `fn`. */
function fakeDispatcher(fn: (text: string, chatId: string) => string): ChannelDispatcher {
  return { handle: async ({ chatId, text }) => [{ chatId, text: fn(text, chatId) }] };
}

test("pollOnce dispatches a text message, sends the reply, and advances the offset", async () => {
  const { transport, sent } = fakeTransport([
    [{ update_id: 5, message: { chat: { id: 42 }, text: "hello" } }],
  ]);
  const dispatcher = fakeDispatcher((text) => `echo:${text}`);

  const next = await pollOnce(transport, dispatcher, 0);

  expect(next).toBe(6); // one past the highest update_id, to acknowledge the batch
  expect(sent).toEqual([{ chatId: "42", text: "echo:hello" }]);
});

test("pollOnce skips non-text and non-message updates but still advances past them", async () => {
  let dispatched = 0;
  const { transport, sent } = fakeTransport([
    [
      { update_id: 7, message: { chat: { id: 1 } } }, // a message with no text
      { update_id: 8 }, // not a message at all (e.g. an edited_message / callback)
    ],
  ]);
  const dispatcher: ChannelDispatcher = {
    async handle({ chatId }) {
      dispatched++;
      return [{ chatId, text: "x" }];
    },
  };

  const next = await pollOnce(transport, dispatcher, 0);

  expect(dispatched).toBe(0);
  expect(sent).toHaveLength(0);
  expect(next).toBe(9); // advanced past both so they are not redelivered
});

test("pollOnce chunks a reply longer than Telegram's limit into multiple sends", async () => {
  const big = "a".repeat(TELEGRAM_MAX_CHARS + 904);
  const { transport, sent } = fakeTransport([
    [{ update_id: 1, message: { chat: { id: 1 }, text: "x" } }],
  ]);
  const dispatcher = fakeDispatcher(() => big);

  await pollOnce(transport, dispatcher, 0);

  expect(sent).toHaveLength(2);
  expect(sent[0]!.text.length).toBe(TELEGRAM_MAX_CHARS);
  expect(sent.map((s) => s.text).join("")).toBe(big); // reassembles to the original
});

test("pollOnce stops dispatching the rest of a batch once shutdown is requested", async () => {
  // Ctrl+C while a batch is being processed must let the in-flight run drain but
  // not kick off the remaining updates' runs.
  const controller = new AbortController();
  let dispatched = 0;
  const dispatcher: ChannelDispatcher = {
    async handle({ chatId }) {
      dispatched++;
      controller.abort(); // shutdown requested while handling the first update
      return [{ chatId, text: "ok" }];
    },
  };
  const transport: TelegramTransport = {
    async getUpdates() {
      return [
        { update_id: 1, message: { chat: { id: 1 }, text: "a" } },
        { update_id: 2, message: { chat: { id: 2 }, text: "b" } },
      ];
    },
    async sendMessage() {},
  };

  await pollOnce(transport, dispatcher, 0, controller.signal);

  expect(dispatched).toBe(1); // the second update in the batch was not dispatched
});

test("runTelegram fails to start when the backlog drain errors (no replay from zero)", async () => {
  // getMe succeeds, but the drain's getUpdates fails — the launch must reject
  // rather than silently fall back to live-polling (and replaying) the backlog.
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes("/getMe")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: "bot" } }) };
    }
    return { ok: false, status: 502, json: async () => ({ ok: false, description: "Bad Gateway" }) };
  };

  await expect(
    runTelegram({
      store: {} as AsterismStore, // never touched: the drain throws before any handle()
      agent: {} as Agent,
      allow: new Set(["1"]),
      token: "T",
      fetch: fetchImpl,
    }),
  ).rejects.toThrow("Bad Gateway");
});

test("a reply for an already-finished run is sent even if shutdown was requested", async () => {
  // stop() aborts the long-poll signal while a run is in flight. The run finishes
  // and persists, so its reply must still be delivered — not dropped because the
  // shared signal is now aborted.
  const controller = new AbortController();
  const sent: OutboundMessage[] = [];
  const dispatcher: ChannelDispatcher = {
    async handle({ chatId }) {
      controller.abort(); // shutdown requested while the run is "in flight"
      return [{ chatId, text: "done" }];
    },
  };
  const transport: TelegramTransport = {
    async getUpdates() {
      return [{ update_id: 1, message: { chat: { id: 7 }, text: "go" } }];
    },
    async sendMessage(chatId, text, signal) {
      if (signal?.aborted) throw new Error("send must not get the aborted long-poll signal");
      sent.push({ chatId, text });
    },
  };

  await pollOnce(transport, dispatcher, 0, controller.signal);

  expect(sent).toEqual([{ chatId: "7", text: "done" }]);
});

test("pollOnce advances past an update even when sending its reply fails", async () => {
  // A failed delivery must NOT keep the offset pinned — otherwise the same update
  // is refetched and its task re-runs. The run already happened; the reply is
  // best-effort.
  const dispatcher = fakeDispatcher((text) => `echo:${text}`);
  const transport: TelegramTransport = {
    async getUpdates() {
      return [{ update_id: 11, message: { chat: { id: 1 }, text: "hi" } }];
    },
    async sendMessage() {
      throw new Error("bot was blocked by the user");
    },
  };

  const next = await pollOnce(transport, dispatcher, 0);

  expect(next).toBe(12); // advanced despite the send failure
});

test("chunkText prefers a newline boundary and drops empty input", () => {
  expect(chunkText("", 10)).toEqual([]);
  expect(chunkText("short", 10)).toEqual(["short"]);
  // "line1\nline2" is 11 long; it breaks at the newline (index 5), not mid-word.
  expect(chunkText("line1\nline2", 8)).toEqual(["line1", "line2"]);
});

test("drainBacklog skips every queued page, not just the first", async () => {
  // Two full pages then empty — the offset must end past the last update of page 2,
  // and each call must use the advanced offset (not refetch page 1 forever).
  const batches: TelegramUpdate[][] = [
    [{ update_id: 100 }, { update_id: 101 }],
    [{ update_id: 102 }, { update_id: 103 }],
    [],
  ];
  let call = 0;
  const seenOffsets: number[] = [];
  const transport: TelegramTransport = {
    async getUpdates(offset) {
      seenOffsets.push(offset);
      return batches[call++] ?? [];
    },
    async sendMessage() {},
  };

  const offset = await drainBacklog(transport);

  expect(offset).toBe(104);
  expect(seenOffsets).toEqual([0, 102, 104]);
});

test("drainBacklog stops on a page that can't advance the offset", async () => {
  // A malformed update with no numeric update_id must not spin the loop forever.
  const transport: TelegramTransport = {
    async getUpdates() {
      return [{ message: { chat: { id: 1 }, text: "x" } } as TelegramUpdate];
    },
    async sendMessage() {},
  };

  expect(await drainBacklog(transport)).toBe(0);
});

test("telegramTransport posts to the token's URL and unwraps the result envelope", async () => {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: [{ update_id: 1 }] }) };
  };

  const transport = telegramTransport("TOKEN", fetchImpl);
  const updates = await transport.getUpdates(3, 30);

  expect(calls[0]!.url).toContain("/botTOKEN/getUpdates");
  expect(JSON.parse(calls[0]!.body)).toMatchObject({ offset: 3, timeout: 30 });
  expect(updates).toEqual([{ update_id: 1 }]);
});

test("telegramTransport throws Telegram's own description on a non-ok response", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ ok: false, description: "Unauthorized" }),
  });

  const transport = telegramTransport("BAD-TOKEN", fetchImpl);

  await expect(transport.getUpdates(0, 0)).rejects.toThrow("Unauthorized");
});
