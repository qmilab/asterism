// @qmilab/asterism-channels — chat-app front doors for Asterism agents.
//
// A channel lets you reach and run an agent from a chat app, not only the
// terminal or the local HTTP endpoint. It is a THIN surface over the kernel's run
// flow — `executeRun` / `resumeRun` — exactly like the HTTP server: it carries no
// trust logic and no scoping of its own, so it inherits the same guarantees the
// CLI has.
//
// Guarantees that hold at the chat edge:
//   • One agent per bot. A channel is bound to the single agent it was started
//     with and can address no other — never a back door to another agent's runs,
//     memory, or secrets.
//   • The allow-list is the access boundary. A bot handle is reachable by anyone,
//     so the set of authorized chat ids is what keeps the channel from being an
//     open door — the chat-edge analog of the HTTP server's loopback bind. A
//     message from any other chat is refused before the kernel is touched.
//   • The destructive-action gate fires here too. A run that would do something
//     destructive pauses and asks; you approve by replying `/confirm`. Confirming
//     authorizes only the action it stopped on; a new one pauses again.
//
// Two transports ship today: Telegram (HTTP long-poll) and Discord (Gateway
// WebSocket). Both are local-first — the bot dials out, so neither needs a public
// URL or an inbound port. The dispatcher (`createDispatcher`) is transport-neutral,
// so each is a thin wire-protocol shim over the same run flow.

export { createDispatcher } from "./dispatch.js";
export type {
  ChannelDeps,
  ChannelDispatcher,
  InboundMessage,
  OutboundMessage,
} from "./dispatch.js";

export { chunkText } from "./shared.js";
export type { ChannelHandle, FetchLike } from "./shared.js";

export {
  runTelegram,
  pollOnce,
  telegramTransport,
  TELEGRAM_MAX_CHARS,
  DEFAULT_POLL_TIMEOUT_SECONDS,
} from "./telegram.js";
export type {
  TelegramOptions,
  TelegramTransport,
  TelegramUpdate,
} from "./telegram.js";

export {
  runDiscord,
  interpretFrame,
  deliver,
  discordTransport,
  DISCORD_MAX_CHARS,
  DISCORD_INTENTS,
} from "./discord.js";
export type {
  DiscordOptions,
  DiscordTransport,
  WebSocketLike,
  WebSocketFactory,
} from "./discord.js";
