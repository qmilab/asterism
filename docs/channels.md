# Chat channels

A **channel** gives one agent a chat-app front door — a way to reach and run it
from a chat app, not only the terminal or the [local HTTP endpoint](./http.md). It
carries exactly the same separation guarantees as the command line: a channel is a
second front door to **one** agent, never a way to reach the others.

Two chat apps are supported today:

- **Telegram** — `asterism channel telegram <agent>`
- **Discord** — `asterism channel discord <agent>`

Each channel binds a single agent, the same one-agent-per-instance rule the HTTP
server follows. Both are local-first: the bot dials *out* to the chat app, so
neither needs a public URL or an inbound port — it runs from your machine.

You also need a [configured model](./installation.md#configuring-a-model) — every
message to the bot is a task, so unlike `serve`, a channel will not start without
one. A channel runs until you press `Ctrl+C`, which stops it gracefully (an
in-flight run finishes first).

## Setting up Telegram

You need a bot and its token from Telegram, then the chat ids allowed to use it.

1. **Create a bot.** In Telegram, message [@BotFather](https://t.me/BotFather),
   send `/newbot`, and follow the prompts. It gives you a token that looks like
   `123456789:AAx…`.
2. **Give Asterism the token** through the environment — it is a secret, so it
   never goes in a config file or on the command line:
   ```bash
   export ASTERISM_TELEGRAM_TOKEN=123456789:AAx…
   ```
3. **Find your chat id.** Start the channel once with no allow-list and message
   the bot — it replies with your chat id (this is *discovery mode*; see below):
   ```bash
   asterism channel telegram writer
   ```
4. **Allow your chat** and restart:
   ```bash
   asterism channel telegram writer --allow 8675309
   ```

A private chat's id is a positive number; a **group or supergroup** id is negative
(e.g. `-1001234567890`) — pass it just the same, `--allow -1001234567890`.

## Setting up Discord

You need a bot and its token from the Discord Developer Portal, then the channel
ids allowed to use it.

1. **Create an app and bot.** In the
   [Developer Portal](https://discord.com/developers/applications), create an
   application, add a **Bot**, and copy its token.
2. **Turn on the MESSAGE CONTENT intent.** On the bot page, under *Privileged
   Gateway Intents*, enable **MESSAGE CONTENT**. Without it Discord won't deliver
   message text, and the channel will tell you so and stop rather than run blind.
3. **Give Asterism the token** through the environment — a secret, like the
   Telegram one:
   ```bash
   export ASTERISM_DISCORD_TOKEN=…
   ```
4. **Invite the bot** to a server (use the portal's *OAuth2 → URL Generator* with
   the `bot` scope), or open a DM with it.
5. **Find the channel id.** Start the channel once with no allow-list, then in a
   server **@mention the bot** (or just DM it) — it replies with the channel id
   (discovery mode):
   ```bash
   asterism channel discord writer
   ```
6. **Allow that channel** and restart:
   ```bash
   asterism channel discord writer --allow 4035…21
   ```

Discord ids are **channel ids**: a DM channel (your 1:1 with the bot) or a server
channel. Allowing a channel authorizes that conversation — a DM authorizes you, a
server channel authorizes everyone who can post in it, the same way an allowed
Telegram group authorizes its members.

In a **server**, the bot sees every message in a channel it can read, so it acts
only when you **@mention it** — it ignores ordinary chatter, and replies with the
mention removed from your task. (A `/confirm` or `/cancel` reply is honored without
a mention, so you can clear a paused run by replying just as the prompt says.) In a
**DM** there is nothing to mention: every message is a task.

> **Runtime.** The Discord channel talks to Discord's Gateway over a WebSocket, so
> it needs a runtime with one: **Node 22+ or Bun**. On an older Node the channel
> declines at startup with a pointer to upgrade. (Telegram has no such requirement.)

## The allow-list is the boundary

A bot's handle is reachable by **anyone** on the chat app. There is no loopback to
hide behind the way the HTTP server binds `127.0.0.1`. So the allow-list of ids
*is* the channel's access control — the boundary that keeps the bot from being an
open door to an agent that may hold your credentials.

- A message from an allowed chat/channel runs the agent.
- A message from **any other** one is refused before anything runs. The reply tells
  it only its own id, so you can decide whether to allow it — it never reveals
  anything about the agent or runs anything.

```bash
asterism channel telegram writer --allow 8675309
asterism channel discord  writer --allow 4035…21,5120…07     # several channels
ASTERISM_TELEGRAM_ALLOW=8675309 asterism channel telegram writer   # via the env
ASTERISM_DISCORD_ALLOW=4035…21  asterism channel discord  writer
```

Each `--allow` is **combined** with its matching env var
(`ASTERISM_TELEGRAM_ALLOW` / `ASTERISM_DISCORD_ALLOW`), so you can keep a base list
in the environment and add to it per run.

### Discovery mode

Starting with **no** allow-list is allowed and safe: nobody is authorized, so the
bot runs nothing — it only replies to each sender with their chat/channel id. That
is the intended way to learn your id. Re-run with `--allow <id>` to let it actually
put the agent to work.

## Running tasks

Send the bot a message and it runs the agent on that text, then replies with the
agent's output. For a `notify` or `autonomous` agent, the reply also carries a
short, reference-only summary of what it did — the same after-the-fact account you
get on the command line. A `propose` agent replies with its plan and runs nothing.

## Confirming a destructive action by reply

The [destructive-action gate](./concepts.md) fires over chat exactly as it does at
the keyboard, **at every trust level**. When a run needs to do something
destructive — delete a file, force-push, read out a secret, spend, send — it
pauses and asks:

```text
⏸ This needs your OK before I can continue:
  • delete_files (destructive)

Reply /confirm to approve it, or /cancel to leave the run paused.
```

- **`/confirm`** resumes the run with **only that action** approved. If the run
  then reaches a *different* destructive action, it pauses again for its own
  confirmation — one approval clears one gate, never a blanket on the capability.
- **`/cancel`** leaves the run paused and frees the chat for a new task. (You can
  still confirm a left-paused run later with [`asterism confirm`](./commands.md#confirm).)

While a run is waiting on your confirmation, the bot holds that chat to it: another
message just reminds you to `/confirm` or `/cancel`, rather than starting a second
run in parallel.

This out-of-band confirm is what makes a chat channel safe for an autonomous agent:
nothing destructive ever happens unattended, even though no one is "at the keyboard."

## Commands

| You send | What happens |
|---|---|
| *any text* | Run the agent on it (when no confirmation is pending). |
| `/confirm` | Approve the action a paused run stopped on. |
| `/cancel` | Leave a paused run alone and free the chat for a new task. |
| `/help` | Show the agent and these commands. |
| `/start` | A short greeting from the agent. |

## What this surface is — and isn't (Phase 1)

- **The same boundary as the CLI.** Runs go through the identical path as
  `asterism run`, so trust enforcement, the destructive-action gate, secret
  scoping, and the agent boundary all apply unchanged. The channel adds no way
  around them, and one bot can only ever reach the one agent it was started with.
- **Local-first, no public URL.** Telegram pulls updates over HTTP long-poll;
  Discord receives them over an outbound Gateway WebSocket. Either way the bot
  connects out from your machine — no inbound port, no webhook to host.
- **Buffered replies.** A reply arrives when the run settles; long replies are
  split to fit the chat app's message limit. Live token-by-token streaming to chat
  is a later concern.
- **The allow-list is the only access control.** There is no per-message
  authentication beyond the id allow-list. Treat your bot token like a password:
  anyone holding it can send messages as the bot. Keep it in the environment, and
  allow only the chats you trust.
