// The Telegram transport — the single network seam of the channel, the analog of
// the HTTP server's `serve()` / `serve-node.ts`. Everything else routes through
// the runtime-neutral `dispatch.ts`.
//
// Long-poll, not webhook: the bot pulls updates with `getUpdates`, so it needs no
// public URL and no inbound port — local-first, works behind NAT. The loop is
// split from the I/O the way the server splits `handleRequest` from `serve`:
// `pollOnce` is pure over an injected {@link TelegramTransport} (so it is tested
// with a fake, no socket), and `runTelegram` wires the real `fetch`-based
// transport, validates the token, and runs the loop until stopped.
//
// No dependency on a Telegram SDK: the Bot API is a handful of JSON-over-HTTPS
// calls, made with the global `fetch` (present on Node 20+ and Bun).

import { createDispatcher } from "./dispatch.js";
import type { ChannelDeps, ChannelDispatcher } from "./dispatch.js";

/** Telegram's hard cap on a single outgoing message; longer replies are chunked. */
export const TELEGRAM_MAX_CHARS = 4096;
/** How long (seconds) `getUpdates` holds the connection open waiting for updates. */
export const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
/** Pause after a transient poll error so a persistent failure doesn't spin the loop. */
const POLL_BACKOFF_MS = 3000;

/** The slice of a Telegram update this surface acts on. Other fields are ignored. */
export interface TelegramUpdate {
  update_id: number;
  message?: { chat?: { id?: number }; text?: string };
}

/**
 * The two Bot API calls the loop needs, behind an interface so `pollOnce` is
 * testable without a network. `getUpdates` long-polls (returning when an update
 * arrives or `timeoutSeconds` elapses); `sendMessage` posts a reply.
 */
export interface TelegramTransport {
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void>;
}

/** A running channel: how it identifies itself, and how to stop it gracefully. */
export interface ChannelHandle {
  /** The bot's `@username`, resolved at startup (absent if the API didn't report one). */
  botUsername?: string;
  /**
   * Stop polling and let the loop unwind. Aborts the in-flight long-poll and
   * resolves once the loop has exited — so a caller can await it before tearing
   * down the store the dispatcher still depends on (the `serve()` contract).
   */
  stop: () => Promise<void>;
}

/** Options for {@link runTelegram}: the dispatcher's deps plus the bot token. */
export interface TelegramOptions extends ChannelDeps {
  /** The Bot API token, from `@BotFather`. Resolved from the environment, never config. */
  token: string;
  /** Injectable `fetch` for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** The minimal `fetch` shape the transport uses — satisfied by the global `fetch`. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Fetch one batch of updates, dispatch each text message, and send the replies
 * (chunked to Telegram's limit). Returns the offset to poll from next — one past
 * the highest `update_id` seen, which acknowledges this batch so it is not
 * redelivered. Non-message and non-text updates are skipped: this surface speaks
 * text. Pure over the transport, so a test drives it with canned updates.
 *
 * Only a failed `getUpdates` propagates — there nothing was processed, so the
 * caller safely retries from the same offset. Once an update is dispatched, its
 * run has executed and persisted; a later failure (a reply that won't deliver, a
 * handler error) is therefore swallowed per-update and the offset still advances,
 * so a delivery hiccup can never reprocess the update and re-run the task.
 */
export async function pollOnce(
  transport: TelegramTransport,
  dispatcher: ChannelDispatcher,
  offset: number,
  signal?: AbortSignal,
): Promise<number> {
  const updates = await transport.getUpdates(offset, DEFAULT_POLL_TIMEOUT_SECONDS, signal);
  let next = offset;
  for (const update of updates) {
    if (typeof update.update_id === "number") next = Math.max(next, update.update_id + 1);

    const chatId = update.message?.chat?.id;
    const text = update.message?.text;
    if (typeof chatId !== "number" || typeof text !== "string") continue;

    try {
      const replies = await dispatcher.handle({ chatId: String(chatId), text });
      for (const reply of replies) {
        for (const chunk of chunkText(reply.text, TELEGRAM_MAX_CHARS)) {
          await transport.sendMessage(reply.chatId, chunk, signal);
        }
      }
    } catch {
      // The run (if any) already ran; do not let a delivery/handler failure
      // reprocess this update. Best-effort — drop it and move to the next.
    }
  }
  return next;
}

/**
 * Bind a Telegram bot to the agent and start listening. Validates the token via
 * `getMe` (a bad token throws here, surfaced by the surface that called this),
 * skips any backlog so starting the bot does not replay messages sent while it
 * was offline, then long-polls until {@link ChannelHandle.stop} is called.
 */
export async function runTelegram(options: TelegramOptions): Promise<ChannelHandle> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const transport = telegramTransport(options.token, fetchImpl);

  // Validate the token and learn the bot's identity before we commit to looping.
  const me = await getMe(options.token, fetchImpl);

  const dispatcher = createDispatcher({
    ...options,
    ...(me.username !== undefined ? { botUsername: me.username } : {}),
  });
  const controller = new AbortController();

  // Skip the backlog so a task sent while the bot was offline doesn't suddenly run
  // when it comes online. The queue can span several pages, so this drains them all.
  let offset = 0;
  try {
    offset = await drainBacklog(transport, controller.signal);
  } catch {
    // A failed backlog drain is non-fatal — start from 0 and let the loop catch up.
  }

  const loop = pollLoop(transport, dispatcher, offset, controller.signal);

  const handle: ChannelHandle = {
    stop: async () => {
      controller.abort();
      await loop;
    },
  };
  if (me.username !== undefined) handle.botUsername = me.username;
  return handle;
}

/**
 * Acknowledge and discard every queued update so none replay as a fresh task on
 * startup. `getUpdates` returns at most one page (~100 updates), so a large offline
 * backlog needs several calls: each one, given the advanced offset, acknowledges
 * the previous page and returns the next. Returns the offset to begin live polling
 * from — one past the last queued update. Stops on an empty page, on a page that
 * fails to advance the offset (malformed, so it can't spin), or on abort.
 */
export async function drainBacklog(transport: TelegramTransport, signal?: AbortSignal): Promise<number> {
  let offset = 0;
  for (;;) {
    const batch = await transport.getUpdates(offset, 0, signal);
    if (batch.length === 0) break;
    const before = offset;
    for (const u of batch) {
      if (typeof u.update_id === "number") offset = Math.max(offset, u.update_id + 1);
    }
    if (offset === before || signal?.aborted) break;
  }
  return offset;
}

/** Long-poll until aborted, backing off on transient errors so a blip doesn't spin. */
async function pollLoop(
  transport: TelegramTransport,
  dispatcher: ChannelDispatcher,
  offset: number,
  signal: AbortSignal,
): Promise<void> {
  let cursor = offset;
  while (!signal.aborted) {
    try {
      cursor = await pollOnce(transport, dispatcher, cursor, signal);
    } catch {
      // The abort that stops the loop aborts the in-flight poll too — treat that as
      // a clean exit, not an error. Anything else is transient: pause and retry.
      if (signal.aborted) break;
      await delay(POLL_BACKOFF_MS, signal);
    }
  }
}

/** A `fetch`-backed transport against `https://api.telegram.org/bot<token>/…`. */
export function telegramTransport(token: string, fetchImpl: FetchLike): TelegramTransport {
  return {
    async getUpdates(offset, timeoutSeconds, signal) {
      const result = await callApi(
        fetchImpl,
        token,
        "getUpdates",
        { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
        signal,
      );
      return Array.isArray(result) ? (result as TelegramUpdate[]) : [];
    },
    async sendMessage(chatId, text, signal) {
      await callApi(fetchImpl, token, "sendMessage", { chat_id: chatId, text }, signal);
    },
  };
}

/** Resolve the bot's identity (and validate the token) via `getMe`. */
async function getMe(token: string, fetchImpl: FetchLike): Promise<{ username?: string }> {
  const result = await callApi(fetchImpl, token, "getMe", {}, undefined);
  const username = (result as { username?: unknown }).username;
  return typeof username === "string" ? { username } : {};
}

/**
 * Make one Bot API call and unwrap its `{ ok, result }` envelope. A non-ok
 * response (bad token, revoked bot, malformed request) throws with Telegram's own
 * description so the surface can report it — never the token, which is only ever
 * in the URL path, never logged.
 */
async function callApi(
  fetchImpl: FetchLike,
  token: string,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    ...(signal ? { signal } : {}),
  });
  const data = (await res.json()) as { ok?: unknown; result?: unknown; description?: unknown };
  if (data.ok !== true) {
    const desc = typeof data.description === "string" ? data.description : `HTTP ${res.status}`;
    throw new Error(`Telegram ${method} failed: ${desc}`);
  }
  return data.result;
}

/** Resolve after `ms`, or immediately if the signal aborts first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Split text into pieces no longer than `max`, preferring to break at a newline so
 * a chunk boundary lands between lines rather than mid-word. A run with no newline
 * in range is hard-split at the limit. Empty pieces are dropped (Telegram rejects
 * an empty message).
 */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const newline = rest.lastIndexOf("\n", max);
    const cut = newline > 0 ? newline : max;
    const piece = rest.slice(0, cut);
    if (piece.length > 0) chunks.push(piece);
    // Drop a single boundary newline so it isn't re-emitted at the next chunk's head.
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
