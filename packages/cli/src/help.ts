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
  trust <agent> <level>             Set how much an agent may do on its own
  secrets add <agent> <KEY> [value] Give an agent a private credential
  skill add <agent> <file.md>       Teach an agent a skill from a markdown file
  run <agent> "<task>"              Put an agent to work on a task
  memory inspect <agent>            Review what an agent remembers
  events tail <agent>               Review what an agent has done
  reflect <agent> --review          Review memories an agent proposes to keep
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

${AUTONOMY_HELP}`,

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

Configure a model with the ASTERISM_MODEL_ID environment variable (and an API key,
e.g. OPENAI_API_KEY) before running.`,

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

Uses your configured model (ASTERISM_MODEL_ID and an API key, e.g. OPENAI_API_KEY)
to draft the proposals.`,

  serve: `asterism serve <agent>

Offer one agent over a local HTTP endpoint, with the same separation guarantees as
the command line.`,
};
