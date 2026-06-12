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

  memory: `asterism memory inspect <agent>

Show everything one agent remembers — what it has accepted, what is still proposed
for review, and where each memory came from.`,

  events: `asterism events tail <agent> [--limit <n>] [--type <type>] [--since <id>]

Review what an agent has done — an append-only record of its consequential
actions. Filter with --type, page forward with --since, or cap with --limit.`,

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
};
