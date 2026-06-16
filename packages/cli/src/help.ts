// User-facing help text. Public copy rule (CLAUDE.md golden rule 7): every string
// here sells the *behavioral outcome* — distinct agents, dialable autonomy,
// reviewable memory, separate lives — and never leaks internal architecture
// vocabulary. The middle autonomy level's copy must state plainly that it acts
// first and notifies after; it must never read as "asks before acting".

/** Shared description of the three autonomy levels, reused across command help. */
export const AUTONOMY_HELP = `Autonomy levels (set with \`new --trust\` or \`trust\`):
  propose      Never acts on its own. Hands you a plan or diff to run yourself.
  notify       Acts on its own inside its workspace, then shows you each action
               afterward. It does NOT ask first — choose 'propose' if you want
               to approve actions before they happen.
  autonomous   Acts freely inside its workspace, keeping a reviewable record of
               everything it did.

  At every level, an agent pauses for your explicit confirmation before a
  destructive action — deleting files, force-pushing, reading out a secret,
  spending, sending — unless you have allowed that capability for it.`;

export const USAGE = `asterism — run many distinct agents from one place. Each agent has its own
memory, secrets, skills, workspace, and level of autonomy, and nothing leaks
between them.

Usage:
  asterism <command> [options]

Commands:
  init                              Set up Asterism in the current directory
  new <agent>                       Create a new agent with a separate life
  list                              Show every agent and how much it may do
  trust <agent> <level>             Set how much an agent may do on its own
  secrets add <agent> <KEY> [value] Give an agent a private credential
  skill add <agent> <file.md>       Teach an agent a skill from a markdown file
  run <agent> "<task>"              Put an agent to work on a task
  confirm [<agent>] <run>           Confirm a paused action and let the run finish
  runs <agent>                      Review an agent's run history
  memory inspect <agent>            Review what an agent remembers
  events tail <agent>               Review what an agent has done
  reflect <agent> --review          Review memories an agent proposes to keep
  config                            Show or change the model agents run on
  serve <agent>                     Offer an agent over a local HTTP endpoint
  channel telegram <agent>          Reach an agent from a Telegram chat
  channel discord <agent>           Reach an agent from a Discord channel
  service install <agent>           Keep an agent running as a background service

Options:
  -h, --help                        Show help
  -v, --version                     Show the version

${AUTONOMY_HELP}

Run \`asterism <command> --help\` for details on a command.`;

export const COMMAND_HELP: Readonly<Record<string, string>> = {
  init: `asterism init

Set up Asterism in the current directory. Creates a local \`.asterism/\` home that
holds every agent's separate store and workspace. Safe to re-run.`,

  new: `asterism new <agent> [--soul <name|path>] [--role "<text>"] [--trust <level>]
              [--model <id>] [--provider <name>] [--base-url <url>] [--api <protocol>]

Create a new agent with its own memory, secrets, skills, and workspace — kept
separate from every other agent.

Options:
  --soul <name|path>   The agent's character and operating style. Built-in souls:
                       casual-helper, careful-consultant. Or a path to your own.
                       Default: casual-helper.
  --role "<text>"      One line describing what the agent is responsible for.
  --trust <level>      propose | notify | autonomous. Default: propose.
                       'notify' acts on its own, then notifies you — it does not
                       ask first.
  --model <id>         Pin this agent to a specific model, overriding the install
                       default. With --provider/--base-url/--api for a provider
                       other than the default. Change it later with \`asterism
                       config\`. No API key goes here — keep keys in the environment.

${AUTONOMY_HELP}`,

  list: `asterism list

Show every agent in this workspace — its name, how much it may do on its own, what
it is responsible for, and when it last ran. Reads the roster only; it never
reaches into any agent's memory, secrets, or files.`,

  trust: `asterism trust <agent> <level>

Set how much an agent may do on its own: propose, notify, or autonomous.

${AUTONOMY_HELP}`,

  secrets: `asterism secrets add <agent> <KEY> [value]

Give one agent a private credential. The value is stored for that agent alone and
is never printed back, logged, or readable by any other agent. If you omit the
value, Asterism reads it from the environment variable of the same name, or from
standard input when piped.`,

  skill: `asterism skill add <agent> <file.md>

Teach an agent a skill from a markdown file. The file is copied into the agent's
own workspace; other agents cannot see it.`,

  run: `asterism run <agent> "<task>"

Put an agent to work on a task, framed by its role, character, skills, and the
memories it has accepted. What it may do on its own depends on its autonomy level;
destructive actions always pause for your confirmation first.

The agent can read, write, and delete files in its own workspace. Reading and
writing run according to its autonomy level; deleting is destructive and pauses
for your confirmation at every level.

Activity streams as it happens, and a run that can act on its own ends with a
short summary of what it did, withheld, or paused on. (Progress goes to standard
error, so the agent's own output on standard out stays clean to pipe.)

When a destructive action pauses a run, confirm it later with \`asterism confirm\`
— the run picks up and finishes the action you approved.

Choose a model with \`asterism config\` (or the ASTERISM_MODEL_ID environment
variable), and set an API key in the environment (e.g. OPENAI_API_KEY), before
running.`,

  confirm: `asterism confirm [<agent>] <run>

Confirm the destructive action a run paused on, and let the run finish. Use this
when a run stopped for your approval — including a run started somewhere with no
prompt, like the HTTP endpoint or a piped command.

Identify the run by the short id shown when it paused (or in \`runs\`). Give the
agent name too if the same short id could mean different runs:
  asterism confirm personal 3f9c1a2b
  asterism confirm 3f9c1a2b            (when it is unambiguous)

You approve only the action it paused on — nothing else is unlocked. A further
destructive step pauses again for its own confirmation: the same kind of action
aimed at a new target (confirming a delete of \`dist\` does not also clear a delete
of \`cache\`), and, when a run stopped on several actions at once, each of those too
— you clear them one confirm at a time. Approving is always explicit; nothing
destructive runs unattended.

Choose a model (\`asterism config\` or ASTERISM_MODEL_ID, and an API key, e.g.
OPENAI_API_KEY) — the run resumes through the same model that started it.`,

  runs: `asterism runs <agent>

Review one agent's run history — each run's short id, status, what it was asked to
do, and when it started and finished. Shows only the named agent's runs, oldest
first.`,

  memory: `asterism memory inspect <agent> [--type <type>] [--review-state <state>] [--run <run>]

Show what one agent remembers — what it has accepted, what is still proposed for
review, and where each memory came from. Only ever the named agent's memory.

Options:
  --type <type>            Show only one kind of memory: semantic, procedural,
                           convention, negative, or episodic.
  --review-state <state>   Show only proposed, accepted, or rejected memories —
                           e.g. --review-state proposed to see what is awaiting you.
  --run <run>              Show only what was learned from one run (its short id).

A filter only ever narrows within this agent's own memory — never another's.`,

  events: `asterism events tail <agent> [--limit <n>] [--type <type>] [--run <run>] [--since <id>] [--follow]

Review what an agent has done — an append-only record of its consequential
actions. Only ever the named agent's activity.

Options:
  --limit <n>     Show only the most recent n events.
  --type <type>   Show only one event type, e.g. --type action.executed.
  --run <run>     Show only one run's activity (its short id).
  --since <id>    Page forward — show only events after the given event id.
  --follow        Keep watching and print new events as they happen. Press Ctrl+C
                  to stop.

Every filter narrows within this agent's own activity — never another's.`,

  reflect: `asterism reflect <agent> --review

Look back over an agent's latest work and review the memories it proposes to keep.
Nothing is saved without your approval — you accept, edit, or reject each one, and
anything that looks unsafe to remember is flagged for you.

Uses the agent's configured model (\`asterism config\` or ASTERISM_MODEL_ID, and an
API key, e.g. OPENAI_API_KEY) to draft the proposals.`,

  config: `asterism config
asterism config set <model-id> [--provider <name>] [--base-url <url>] [--api <protocol>] [--agent <name>]
asterism config unset [--agent <name>]

Choose the model your agents run on. Set one install-wide default, and give any
single agent its own model when you want it to run on something different.

  asterism config                       Show the current setup and the model each
                                        agent resolves to.
  asterism config set <model-id>        Set the install-wide default model.
  asterism config set <model-id> --agent <name>
                                        Pin one agent to its own model.
  asterism config unset [--agent <name>]
                                        Clear the default, or one agent's override.

Where a model comes from, most specific first: an agent's own model, then the
ASTERISM_MODEL_* environment variables, then the install default, then built-in
provider settings. So an environment variable overrides the saved default, and an
agent's own model overrides everything.

Options for \`set\`:
  --provider <name>   Provider name. Built-in: openai, anthropic. Default: openai.
  --base-url <url>    The provider's API base URL (needed for other providers).
  --api <protocol>    The wire protocol, when it differs from the provider default.
  --agent <name>      Apply to this one agent instead of the install default.

API keys are never stored here. Keep them in the environment (e.g. OPENAI_API_KEY)
— this configuration holds only which model to use, and is safe to share.`,

  serve: `asterism serve <agent> [--port <n>] [--host <addr>]

Offer one agent over a local HTTP endpoint, with the same separation guarantees as
the command line. The endpoint serves only this agent — it is never a way to reach
another. A destructive action still pauses for confirmation even with no one at the
keyboard: the run waits, and you approve it out of band — POST to its confirm
endpoint, or run \`asterism confirm\`.

Every request needs an access token: Authorization: Bearer <token>. On first serve
a token is generated, saved (owner-only), and printed once; later serves reuse it.
Set ASTERISM_HTTP_TOKEN to supply your own — the right choice for an exposed or
unattended endpoint, where the secret should be injected, not read off disk. There
is no unauthenticated mode, on loopback or anywhere else.

Endpoints (with <agent> fixed to the one you serve):
  POST /agents/<agent>/runs            start a run; JSON body {"input":"<task>"}
                                       send Accept: text/event-stream to watch it live
  POST /agents/<agent>/runs/<run>/confirm
                                       approve a paused run and let it finish
  GET  /agents/<agent>/runs            list the agent's runs
  GET  /agents/<agent>/events          review the agent's activity

Options:
  --port <n>      Port to listen on. Default 4831.
  --host <addr>   Address to bind. Default 127.0.0.1 (this machine only).

Choose a model (\`asterism config\` or ASTERISM_MODEL_ID, and an API key, e.g.
OPENAI_API_KEY) to start runs; without one, the read endpoints still work. Press
Ctrl+C to stop.`,

  channel: `asterism channel <telegram|discord> <agent> [--allow <id>[,<id>...]]

Reach one agent from a chat app, with the same separation guarantees as the command
line. The bot drives only this agent — it is never a way to reach another.

Only the chats you allow can use the bot. A message from anywhere else is refused and
told its own id, so you can decide whether to allow it. A destructive action still
pauses for your confirmation: the bot asks in the chat, and you reply \`/confirm\` to
approve just that action — the same gate you get at the keyboard.

Telegram:
  1. Create a bot with @BotFather in Telegram and copy its token.
  2. export ASTERISM_TELEGRAM_TOKEN=<token>
  3. Start the channel, then message the bot — it replies with your chat id.
  4. Re-run with --allow <that-id> so your chat can put the agent to work.

Discord:
  1. Create an app and bot in the Discord Developer Portal, copy the bot token, and
     turn on the MESSAGE CONTENT intent (Bot -> Privileged Gateway Intents).
  2. export ASTERISM_DISCORD_TOKEN=<token>
  3. Invite the bot to a server then @mention it in a channel (or just DM it) — it
     replies with the channel id. Needs a WebSocket runtime: Node 22+ or Bun.
  4. Re-run with --allow <that-id> so that channel can put the agent to work. In a
     server the bot acts only when @mentioned; a DM needs no mention.

Options:
  --allow <id,...>   Ids allowed to use the bot, comma-separated. You can also set
                     ASTERISM_TELEGRAM_ALLOW / ASTERISM_DISCORD_ALLOW; each is
                     combined with its --allow. With none, the bot starts but only
                     hands out ids until you add one.

Choose a model (\`asterism config\` or ASTERISM_MODEL_ID, and an API key, e.g.
OPENAI_API_KEY) before starting — the bot needs one to run tasks. Press Ctrl+C to
stop.`,

  service: `asterism service install <agent> [--kind serve|telegram|discord] [--capture-env] [-- <args>]
asterism service status <agent> [--kind <kind>]
asterism service uninstall <agent> [--kind <kind>]

Keep one agent running in the background as a service your computer starts for you
and restarts if it stops — the same separate-lives guarantees as the command line,
just always on. It runs one long-lived command for one agent:

  --kind serve      Offer the agent over its local HTTP endpoint (the default).
  --kind telegram   Run the agent's Telegram chat channel.
  --kind discord    Run the agent's Discord chat channel.

Pass options to that command after \`--\`:
  asterism service install writer -- --port 8080
  asterism service install writer --kind telegram -- --allow 12345

  install     Write the service, register it with macOS (launchd) or Linux
              (systemd), and start it. It also starts again at login.
  status      Show whether the agent's services are running, and where to find
              each one's private settings and logs.
  uninstall   Stop and remove a service. Its settings file is left in place, in
              case it holds secrets you want to keep.

Secrets stay out of the service definition. install creates a private environment
file (readable only by you) that names what the service needs — your model API key,
and a chat token for a channel. You fill it in; nothing secret is ever written for
you. Edit it, then restart the service as install tells you.

  --capture-env   Convenience for an environment you have already exported: write
                  the values currently set in your shell into that private file, so
                  you don't copy them by hand. It writes secret values to disk (only
                  the 0600 file, only when you ask) and overwrites the file on each
                  use. Without it, nothing secret is ever written for you.

A destructive action still pauses for your confirmation. With no one at the keyboard,
an HTTP run waits until you approve it out of band (POST its confirm endpoint, or run
\`asterism confirm\`); a chat run asks in the chat for a \`/confirm\` reply.

Supported on macOS and Linux.`,
};
