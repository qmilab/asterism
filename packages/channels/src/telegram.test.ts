// The Telegram transport — tested without a network. `pollOnce` is driven with a
// fake transport (canned updates + a sink for sends); the `fetch`-backed transport
// is checked against a fake `fetch` for request shape and error surfacing; and the
// chunker is pinned at its boundaries.

import { expect, test } from "bun:test";

import type { ChannelDispatcher, OutboundMessage } from "./dispatch.ts";
import { chunkText, pollOnce, telegramTransport, TELEGRAM_MAX_CHARS } from "./telegram.ts";
import type { FetchLike, TelegramTransport, TelegramUpdate } from "./telegram.ts";

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
