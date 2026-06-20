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
  trust <agent> --review            Grant capabilities an agent has earned to act on
  secrets add <agent> <KEY> [value] Give an agent a private credential
  skill add <agent> <file.md>       Teach an agent a skill from a markdown file
  objective add <agent> "<text>"    Give an agent a standing goal to work toward
  notes inspect <agent>             See an agent's own working notes (its situation)
  run <agent> "<task>"              Put an agent to work on a task
  confirm [<agent>] <run>           Confirm a paused action and let the run finish
  runs <agent>                      Review an agent's run history
  memory inspect <agent>            Review what an agent remembers
  events tail <agent>               Review what an agent has done
  reflect <agent> --review          Review memories an agent proposes to keep
  reflect <agent> --propose         Queue proposals to review later (schedulable)
  config                            Show or change the model agents run on
  serve <agent>                     Offer an agent over a local HTTP endpoint
  dashboard                         Watch and steer every agent in one live view
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
asterism trust <agent> --review
asterism trust <agent> show
asterism trust <agent> revoke <capability>
asterism trust <agent> threshold [--clean <n>] [--targets <n>]  ·  --unset

Set how much an agent may do on its own — both the overall level, and, capability by
capability, the few destructive actions it has earned the right to take without
pausing for you.

  trust <agent> <level>     Set the overall level: propose, notify, or autonomous.
  trust <agent> --review    Review capabilities the agent has EARNED the right to act
                            on without pausing — by handling them cleanly, several
                            times, across different targets, with nothing declined or
                            failed in between. You grant or decline each; nothing is
                            granted without your yes.
  trust <agent> show        Show the agent's level, which capabilities now act
                            without pausing, and its earning bar.
  trust <agent> revoke <capability>
                            Take a grant back — the capability pauses for your
                            confirmation again.
  trust <agent> threshold [--clean <n>] [--targets <n>]
                            Tune how much clean track record review asks for before it
                            proposes a grant: how many confirmed executions (--clean),
                            across how many different targets (--targets). Set either
                            or both; leave the other as it is.
  trust <agent> threshold --unset
                            Clear the custom bar — back to the built-in default.
  trust <agent> threshold   Show this agent's current earning bar.

A grant is earned, never automatic, and lost the moment something goes wrong: a
declined or failed action on a capability resets it, so it has to be re-earned. A
higher bar only asks for more evidence before proposing — it never lets anything act
without your yes. Even a granted capability stays inside the agent's own workspace and
never carries to another agent.

${AUTONOMY_HELP}`,

  secrets: `asterism secrets add <agent> <KEY> [value]

Give one agent a private credential. The value is stored for that agent alone and
is never printed back, logged, or readable by any other agent. If you omit the
value, Asterism reads it from the environment variable of the same name, or from
standard input when piped.`,

  skill: `asterism skill add <agent> <file.md>

Teach an agent a skill from a markdown file. The file is copied into the agent's
own workspace; other agents cannot see it.`,

  objective: `asterism objective add  <agent> "<text>"
asterism objective list <agent>
asterism objective done <agent> <id>
asterism objective drop <agent> <id>

Give an agent a standing objective — what it should be working toward, ongoing. Unlike
a memory (something it learned and you reviewed), an objective is current purpose you
set and manage. Every active objective frames the agent's runs as standing context, so
it keeps the goal in view across many runs. Only ever the named agent's objectives.

  objective add <agent> "<text>"   Declare a new objective (it starts active).
  objective list <agent>           Show the agent's objectives — the active ones that
                                   frame its runs, then completed and dropped history.
  objective done <agent> <id>      Mark an objective completed; it stops framing runs.
  objective drop <agent> <id>      Abandon an objective; it stops framing runs.

Identify an objective by the short id shown in \`objective list\`. An objective is the
agent's own scoped state — managing it is never destructive, and never crosses to
another agent.`,

  notes: `asterism notes inspect <agent>
asterism notes set     <agent> "<subject>" "<value>"
asterism notes clear   <agent> "<subject>"

See and manage an agent's working notes — its own running record of the current
situation, like "deploy version: v0.2.1" or "migration: 60% done". The agent writes
and updates these itself as it runs (recording a subject again replaces its value), and
they frame its later runs as context. They are the agent's OWN unverified notes, shown
and framed as such — never as facts you reviewed (unlike its memory).

  notes inspect <agent>                Show the agent's working notes (its own record).
  notes set <agent> "<subject>" "<value>"
                                       Set or correct a note yourself.
  notes clear <agent> "<subject>"      Remove a note.

A note is the agent's own scoped state — writing or clearing one is never destructive,
and never crosses to another agent. The agent keeps a bounded number of notes; when
full, it must clear one before recording a new subject. Notes you set are screened for
safety exactly like the agent's own.`,

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
asterism reflect <agent> --propose

Turn an agent's work into things it might keep — memories it could remember, and
standing objectives it could take on — always proposed, never adopted on its own. You
stay the one who decides what an agent remembers and what it works toward.

  --review    Review the proposals waiting for this agent and accept, edit, or reject
              each one — memories first, then standing objectives. Anything unsafe is
              flagged for you. If proposals are already waiting (see --propose), it
              reviews those — no model needed; otherwise it looks over the agent's
              latest work and drafts new ones. An accepted objective frames every later
              run; a proposed one does nothing until you accept it.
  --propose   Look over the agent's new work and set aside what it might be worth
              remembering or working toward, for you to review later. Saves nothing as
              active and asks nothing — it just fills the review pile. This is the form
              you can put on a schedule (see the docs); nothing reflects on a schedule
              unless you set that up yourself.

Drafting new proposals uses the agent's configured model (\`asterism config\` or
ASTERISM_MODEL_ID, and an API key, e.g. OPENAI_API_KEY). Reviewing a pile that is
already waiting needs no model.`,

  config: `asterism config
asterism config set <model-id> [--provider <name>] [--base-url <url>] [--api <protocol>] [--agent <name>]
asterism config unset [--agent <name>]
asterism config recall-budget <agent> <n>  ·  --unset
asterism config recall-provider <agent> local  ·  --unset

Choose the model your agents run on, and tune how much — and how — each agent
remembers into a run. Set one install-wide default model, and give any single agent
its own model, its own recall budget, or its own recall provider when you want it to
differ.

  asterism config                       Show the current setup: the model each agent
                                        resolves to, and its recall budget.
  asterism config set <model-id>        Set the install-wide default model.
  asterism config set <model-id> --agent <name>
                                        Pin one agent to its own model.
  asterism config unset [--agent <name>]
                                        Clear the default, or one agent's override.
  asterism config recall-budget <agent> <n>
                                        Set how many memories this agent may recall
                                        into a run (a positive whole number).
  asterism config recall-budget <agent> --unset
                                        Clear it, so the agent uses the default again.
  asterism config recall-budget <agent>
                                        Show this agent's current recall budget.
  asterism config recall-provider <agent> local
                                        Rank this agent's memory by meaning, using a
                                        local embeddings endpoint (opt-in, off by
                                        default; see below).
  asterism config recall-provider <agent> --unset
                                        Go back to the built-in keyword ranker.
  asterism config recall-provider <agent>
                                        Show this agent's current recall provider.

Where a model comes from, most specific first: an agent's own model, then the
ASTERISM_MODEL_* environment variables, then the install default, then built-in
provider settings. So an environment variable overrides the saved default, and an
agent's own model overrides everything.

An agent's recall budget caps how many of its saved memories are selected to frame a
run — the most relevant are kept under the cap. Each agent's budget is its own; leave
it unset to use the built-in default.

Recall provider chooses HOW that selection is ranked. The default is a built-in
keyword ranker that needs nothing and makes no network call. Opt an agent into
\`local\` to rank its memory by meaning instead, using a local embeddings endpoint you
run yourself (e.g. Ollama) — set ASTERISM_RECALL_EMBED_URL and
ASTERISM_RECALL_EMBED_MODEL (and ASTERISM_RECALL_EMBED_KEY if it needs a token). This
is strictly opt-in and off by default; nothing here sends your memory anywhere unless
you turn it on and point it at your own endpoint. If that endpoint is unreachable
during a run, recall falls back to the keyword ranker (and says so) rather than
failing.

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

  dashboard: `asterism dashboard [<url>] [--token <token>] [--headless] [--port <n>] [--host <addr>]

Your live console over every agent at once — the one place to see what each agent is
doing and steer it. In one terminal view:
  - every agent, its character, and how much it may do on its own
  - dial an agent's autonomy up or down on the spot
  - approve or decline an action an agent has paused for your confirmation
  - review memories an agent proposes to keep — accept, edit, or reject each
  - watch activity stream in as it happens

It shows many agents but never crosses between them: it only ever asks about one
agent at a time, so their separate lives hold here too.

  asterism dashboard                 open the live view for this machine's agents
  asterism dashboard --headless      run the console for a dashboard elsewhere to attach to
  asterism dashboard <url> --token … attach to a console running on another machine

Options:
  --headless      Run the console without the terminal view — for attaching a remote
                  dashboard, or scripting. Prints an access token like \`serve\`.
  --token <t>     The access token when attaching to a remote console (or set
                  ASTERISM_HTTP_TOKEN).
  --port <n>      With --headless, the port to listen on. Default 4832.
  --host <addr>   With --headless, the address to bind. Default 127.0.0.1.

Keys: ↑/↓ select · t set autonomy · c approve · x decline · m review memories ·
r refresh · ? help · q quit.`,

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
