// The Discord transport — the second chat surface, built on the same runtime-neutral
// `dispatch.ts` as Telegram. Where Telegram pulls updates over HTTP long-poll,
// Discord delivers them over a persistent Gateway WebSocket: the bot dials OUT to
// Discord (no public URL, no inbound port — local-first, works behind NAT, the same
// property the Telegram long-poll has), then receives `MESSAGE_CREATE` events on the
// socket and replies over the REST API.
//
// The split mirrors `telegram.ts`:
//   • `interpretFrame` is pure over a parsed Gateway frame — it decides what the
//     connection should do (identify, heartbeat, dispatch a message, reconnect)
//     without touching a socket, so the protocol is tested with canned frames.
//   • `deliver` is the per-message body (dispatch + chunked reply), pure over an
//     injected {@link DiscordTransport}.
//   • `runDiscord` wires the real `fetch`-backed transport and a real WebSocket,
//     validates the token, and runs the connection until stopped.
//
// No Discord SDK: the REST calls are a couple of JSON-over-HTTPS requests, and the
// Gateway is a handful of opcodes over the WHATWG `WebSocket` (a global on Bun and
// Node 22+; the package needs no DOM lib because it declares only the slice it uses,
// {@link WebSocketLike}). The same dispatcher means every chat-edge guarantee —
// one agent per bot, the allow-list boundary, the destructive-action gate — holds
// here identically; only the wire protocol differs.

import { createDispatcher } from "./dispatch.js";
import type { ChannelDeps, ChannelDispatcher } from "./dispatch.js";
import { chunkText, delay } from "./shared.js";
import type { ChannelHandle, FetchLike } from "./shared.js";

/** Discord's hard cap on a single message; longer replies are chunked to fit. */
export const DISCORD_MAX_CHARS = 2000;
/** REST base; the bot token rides the `Authorization` header, never the URL. */
const DISCORD_API_BASE = "https://discord.com/api/v10";
/** The Gateway URL — JSON encoding, API v10. Overridable for tests. */
const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
/** Fallback heartbeat cadence if a Hello somehow omits one (Discord sends ~41s). */
const DEFAULT_HEARTBEAT_MS = 41250;
/** Pause before reconnecting after a transient drop, so a blip doesn't spin. */
const RECONNECT_BACKOFF_MS = 5000;

// Gateway opcodes (https://discord.com/developers/docs/topics/gateway-events).
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// Gateway intents. MESSAGE_CONTENT is privileged: it must be enabled for the bot in
// the Developer Portal, or the Gateway closes the connection with code 4014.
const INTENT_GUILD_MESSAGES = 1 << 9; // 512
const INTENT_DIRECT_MESSAGES = 1 << 12; // 4096
const INTENT_MESSAGE_CONTENT = 1 << 15; // 32768
/** The intents the channel identifies with: guild + DM messages, with content. */
export const DISCORD_INTENTS = INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGES | INTENT_MESSAGE_CONTENT;

/**
 * Close codes the Gateway uses for conditions a reconnect can never fix (a bad
 * token, an intent that isn't granted, an unsupported API version). On these the
 * loop stops and reports, rather than reconnecting forever. Everything else is
 * treated as transient and retried.
 */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** The minimal REST surface the channel uses: validate identity, and send a reply. */
export interface DiscordTransport {
  /** Resolve the bot's own user (validates the token; a bad token throws). */
  getSelf(signal?: AbortSignal): Promise<{ id: string; username?: string }>;
  /** Post a message to a channel (a DM channel or a server channel). */
  sendMessage(channelId: string, text: string, signal?: AbortSignal): Promise<void>;
}

/**
 * The slice of the WHATWG `WebSocket` the Gateway loop uses — declared here so the
 * package needs no DOM lib and a test can drive the loop with a fake socket. The
 * global `WebSocket` (Bun, Node 22+) satisfies it structurally.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Opens a socket to a Gateway URL. `(url) => new WebSocket(url)` in production. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** Options for {@link runDiscord}: the dispatcher's deps plus the bot token. */
export interface DiscordOptions extends ChannelDeps {
  /** The bot token, from the Discord Developer Portal. Resolved from the environment. */
  token: string;
  /** Injectable `fetch` for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /**
   * Injectable WebSocket factory for tests; defaults to the global `WebSocket`.
   * Absent here AND absent globally (an old Node without the global) ⇒ the launch
   * fails with a clear pointer to run on Node 22+ or Bun.
   */
  WebSocket?: WebSocketFactory;
  /** Override the Gateway URL (tests point this at a fake socket). */
  gatewayUrl?: string;
  /** Backoff before reconnecting after a transient drop. Defaults to 5s. */
  reconnectDelayMs?: number;
  /** Sink for connection notices (reconnects, a fatal refusal). Defaults to silent. */
  log?: (message: string) => void;
}

/**
 * What the connection should do in response to one inbound Gateway frame — the
 * pure decision, with the socket/timer effects applied by {@link runDiscord}. The
 * token never reaches this layer: an `identify`/`heartbeat` action only names the
 * effect, and `runDiscord` fills in the secret.
 */
type GatewayAction =
  | { kind: "startHeartbeat"; intervalMs: number }
  | { kind: "identify" }
  | { kind: "heartbeat" }
  | { kind: "ack" }
  | { kind: "dispatch"; channelId: string; text: string }
  | { kind: "reconnect" };

/** A parsed Gateway frame. Only these fields are read; the rest is ignored. */
interface GatewayFrame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

/**
 * Decide what a single Gateway frame means for the connection. Pure: it reads the
 * frame (and our own id, to skip our own echoes) and returns the effects to apply,
 * so the whole protocol is testable without a socket.
 *
 *   - Hello (10)            → start heartbeating, then identify.
 *   - Heartbeat request (1) → send a heartbeat now.
 *   - Heartbeat ACK (11)    → clear the "awaiting ack" flag (the link is alive).
 *   - Reconnect (7) /
 *     Invalid Session (9)   → drop and reconnect with a fresh identify.
 *   - Dispatch (0)          → a `MESSAGE_CREATE` from a real user becomes a task;
 *                             our own messages, other bots, and empty/no-content
 *                             messages are ignored.
 */
export function interpretFrame(frame: GatewayFrame, selfId: string): GatewayAction[] {
  switch (frame.op) {
    case OP_HELLO: {
      const d = frame.d as { heartbeat_interval?: unknown } | undefined;
      const intervalMs =
        typeof d?.heartbeat_interval === "number" ? d.heartbeat_interval : DEFAULT_HEARTBEAT_MS;
      return [{ kind: "startHeartbeat", intervalMs }, { kind: "identify" }];
    }
    case OP_HEARTBEAT:
      return [{ kind: "heartbeat" }];
    case OP_HEARTBEAT_ACK:
      return [{ kind: "ack" }];
    case OP_RECONNECT:
    case OP_INVALID_SESSION:
      return [{ kind: "reconnect" }];
    case OP_DISPATCH:
      return frame.t === "MESSAGE_CREATE" ? messageCreateActions(frame.d, selfId) : [];
    default:
      return [];
  }
}

/** Turn a `MESSAGE_CREATE` payload into a dispatch action, or nothing if we skip it. */
function messageCreateActions(d: unknown, selfId: string): GatewayAction[] {
  const m = d as
    | { channel_id?: unknown; content?: unknown; author?: { id?: unknown; bot?: unknown } }
    | undefined;
  if (!m || typeof m.channel_id !== "string") return [];
  // Ignore our own messages (the echo of every reply we send) and any other bot, so
  // the agent never runs on bot chatter or loops on itself. The allow-list (keyed on
  // the channel, below) is the access boundary; this is just self/bot suppression.
  const author = m.author;
  if (author && (author.bot === true || author.id === selfId)) return [];
  // Nothing to act on: an attachment-only message, or MESSAGE CONTENT not granted
  // (content arrives empty), is not a task. Mirrors Telegram skipping non-text.
  if (typeof m.content !== "string" || m.content.length === 0) return [];
  return [{ kind: "dispatch", channelId: m.channel_id, text: m.content }];
}

/**
 * Dispatch one inbound message and send its reply(ies), chunked to Discord's limit.
 * The chat-edge analog of `pollOnce`'s per-update body: once the run has executed
 * and persisted, a later failure (a reply that won't deliver, a handler error) is
 * swallowed so a delivery hiccup can never reprocess the message and re-run the task.
 */
export async function deliver(
  transport: DiscordTransport,
  dispatcher: ChannelDispatcher,
  channelId: string,
  text: string,
): Promise<void> {
  try {
    const replies = await dispatcher.handle({ chatId: channelId, text });
    for (const reply of replies) {
      for (const chunk of chunkText(reply.text, DISCORD_MAX_CHARS)) {
        await transport.sendMessage(reply.chatId, chunk);
      }
    }
  } catch {
    // The run (if any) already ran and persisted; do not let a delivery/handler
    // failure reprocess it. Best-effort — drop it and move on.
  }
}

/**
 * Bind a Discord bot to the agent and start listening. Validates the token via the
 * REST `users/@me` (a bad token throws here, surfaced by the surface that called
 * this — the analog of Telegram's `getMe`), which also yields the bot's id (used to
 * skip its own messages) and username. Then it opens the Gateway and runs until
 * {@link ChannelHandle.stop} is called, reconnecting through transient drops.
 */
export async function runDiscord(options: DiscordOptions): Promise<ChannelHandle> {
  const makeSocket = options.WebSocket ?? globalWebSocketFactory();
  if (!makeSocket) {
    throw new Error(
      "Discord needs a WebSocket runtime — run on Node 22+ or Bun (this runtime has no global WebSocket).",
    );
  }
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const transport = discordTransport(options.token, fetchImpl);

  // Validate the token and learn our own identity before committing to the loop.
  const me = await transport.getSelf();

  const dispatcher = createDispatcher(options);
  const controller = new AbortController();

  const loop = gatewayLoop({
    makeSocket,
    gatewayUrl: options.gatewayUrl ?? DEFAULT_GATEWAY_URL,
    token: options.token,
    selfId: me.id,
    transport,
    dispatcher,
    signal: controller.signal,
    reconnectDelayMs: options.reconnectDelayMs ?? RECONNECT_BACKOFF_MS,
    log: options.log ?? (() => {}),
  });

  const handle: ChannelHandle = {
    stop: async () => {
      controller.abort();
      await loop;
    },
  };
  if (me.username !== undefined) handle.botUsername = me.username;
  return handle;
}

/** Everything one Gateway connection needs, gathered so the loop reads cleanly. */
interface GatewayContext {
  makeSocket: WebSocketFactory;
  gatewayUrl: string;
  token: string;
  selfId: string;
  transport: DiscordTransport;
  dispatcher: ChannelDispatcher;
  signal: AbortSignal;
  reconnectDelayMs: number;
  log: (message: string) => void;
}

/**
 * Connect, run until the socket closes, then — unless we are shutting down or the
 * close was fatal — back off and reconnect with a fresh identify. Re-identifying
 * (rather than resuming) means a reconnect never replays the messages sent while we
 * were briefly away, the same "don't replay backlog" stance the Telegram start has.
 */
async function gatewayLoop(ctx: GatewayContext): Promise<void> {
  while (!ctx.signal.aborted) {
    const disposition = await connectOnce(ctx);
    if (ctx.signal.aborted || disposition === "fatal") break;
    await delay(ctx.reconnectDelayMs, ctx.signal);
  }
}

/**
 * One Gateway connection. Opens the socket, drives the protocol from inbound frames
 * via {@link interpretFrame}, heartbeats on the interval the Hello sets, and
 * resolves when the socket closes — `"fatal"` if the close code is unrecoverable,
 * `"transient"` otherwise. Runs are serialized (chained on `runTail`) so two quick
 * messages never execute concurrently, exactly as Telegram processes a batch one
 * update at a time; heartbeats sit on their own timer, so a long run never stalls
 * the keep-alive.
 */
function connectOnce(ctx: GatewayContext): Promise<"transient" | "fatal"> {
  return new Promise((resolve) => {
    const socket = ctx.makeSocket(ctx.gatewayUrl);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let awaitingAck = false;
    let seq: number | null = null;
    let runTail: Promise<void> = Promise.resolve();
    let settled = false;

    const send = (frame: object): void => {
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        // The socket is closing/closed; the close handler drives the reconnect.
      }
    };

    // A shutdown closes the socket; its `onclose` then unwinds the connection.
    const onAbort = (): void => socket.close(1000, "shutting down");
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (disposition: "transient" | "fatal"): void => {
      if (settled) return;
      settled = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolve(disposition);
    };

    socket.onopen = (): void => {
      // Nothing to do until the Hello arrives — that is when we identify and start
      // heartbeating (sending Identify before Hello is a protocol error).
    };

    socket.onmessage = (event): void => {
      const frame = parseFrame(event.data);
      if (!frame) return;
      if (typeof frame.s === "number") seq = frame.s; // remember the sequence for heartbeats
      for (const action of interpretFrame(frame, ctx.selfId)) {
        switch (action.kind) {
          case "startHeartbeat":
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            awaitingAck = false;
            heartbeatTimer = setInterval(() => {
              // No ACK since the last beat ⇒ a zombie connection: drop it so the
              // loop reconnects, rather than talking into a dead socket.
              if (awaitingAck) {
                socket.close(4000, "heartbeat timeout");
                return;
              }
              awaitingAck = true;
              send({ op: OP_HEARTBEAT, d: seq });
            }, action.intervalMs);
            break;
          case "identify":
            send(identifyFrame(ctx.token));
            break;
          case "heartbeat":
            awaitingAck = true;
            send({ op: OP_HEARTBEAT, d: seq });
            break;
          case "ack":
            awaitingAck = false;
            break;
          case "dispatch":
            runTail = runTail.then(() =>
              deliver(ctx.transport, ctx.dispatcher, action.channelId, action.text),
            );
            break;
          case "reconnect":
            socket.close(4000, "reconnect requested");
            break;
        }
      }
    };

    socket.onerror = (): void => {
      // A `close` follows an error; the reconnect/stop decision is made there.
    };

    socket.onclose = (event): void => {
      const disposition: "transient" | "fatal" = FATAL_CLOSE_CODES.has(event.code)
        ? "fatal"
        : "transient";
      if (disposition === "fatal") ctx.log(fatalCloseMessage(event.code, event.reason));
      // Let an in-flight run finish (and its reply send) before the connection is
      // considered done, so a shutdown never tears the store out from under it.
      runTail.then(
        () => finish(disposition),
        () => finish(disposition),
      );
    };
  });
}

/** The Identify frame — carries the token and the intents we listen with. */
function identifyFrame(token: string): object {
  return {
    op: OP_IDENTIFY,
    d: {
      token,
      intents: DISCORD_INTENTS,
      properties: { os: "asterism", browser: "asterism", device: "asterism" },
    },
  };
}

/** Parse a Gateway text frame; ignore anything that isn't well-formed JSON text. */
function parseFrame(data: unknown): GatewayFrame | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as GatewayFrame;
    return typeof parsed.op === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A human pointer for a close the loop won't retry — names the likely fix. */
function fatalCloseMessage(code: number, reason: string): string {
  if (code === 4014 || code === 4013) {
    return `Discord refused the connection (code ${code}). Enable the MESSAGE CONTENT intent for the bot in the Developer Portal (Bot → Privileged Gateway Intents), then restart.`;
  }
  if (code === 4004) {
    return "Discord rejected the bot token (code 4004). Check ASTERISM_DISCORD_TOKEN.";
  }
  return `Discord closed the connection (code ${code}${reason ? `: ${reason}` : ""}) and will not reconnect.`;
}

/** A `fetch`-backed transport against `https://discord.com/api/v10`. */
export function discordTransport(token: string, fetchImpl: FetchLike): DiscordTransport {
  return {
    async getSelf(signal) {
      const data = await callApi(fetchImpl, token, "GET", "/users/@me", undefined, signal);
      const u = data as { id?: unknown; username?: unknown };
      if (typeof u.id !== "string") throw new Error("Discord getSelf failed: no bot id in response");
      return typeof u.username === "string" ? { id: u.id, username: u.username } : { id: u.id };
    },
    async sendMessage(channelId, text, signal) {
      await callApi(fetchImpl, token, "POST", `/channels/${channelId}/messages`, { content: text }, signal);
    },
  };
}

/**
 * Make one REST call with `Authorization: Bot <token>` and return the parsed body.
 * A non-ok response throws with Discord's own `message` (never the token, which is
 * only ever in the header, never logged).
 */
async function callApi(
  fetchImpl: FetchLike,
  token: string,
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const res = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bot ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: unknown };
    const desc = typeof data.message === "string" ? data.message : `HTTP ${res.status}`;
    throw new Error(`Discord ${method} ${path} failed: ${desc}`);
  }
  return res.json();
}

/** The global `WebSocket` as a factory, or undefined on a runtime without one. */
function globalWebSocketFactory(): WebSocketFactory | undefined {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  return Ctor ? (url: string) => new Ctor(url) : undefined;
}
