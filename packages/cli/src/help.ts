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

  A destructive action — deleting files, force-pushing, reading out a secret,
  spending, sending — never happens without you. At 'notify' and 'autonomous'
  the run stops and asks first, unless you have allowed that capability for it.
  A 'propose' agent does not take one at all; it hands you the plan instead.`;

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
  capabilities show <agent>         See which tools an agent has — and narrow them
  secrets add <agent> <KEY> [value] Give an agent a private credential
  api add <agent> <name> <url>      Let an agent call one address with one credential
  skill add <agent> <file.md>       Teach an agent a skill from a markdown file
  objective add <agent> "<text>"    Give an agent a standing goal to work toward
  notes inspect <agent>             See an agent's own working notes (its situation)
  run <agent> "<task>"              Put an agent to work on a task
  connect <from> <to> --mode <m>    Open a permissioned channel between two agents
  disconnect <from> <to>            Withdraw a channel you opened
  connections <agent>               Show an agent's connections
  handoff <from> <to> "<task>"      Have one agent hand a task to another
  artifact <from> <to> "<task>"     Like handoff, but hand back only the files produced
  fetch <from> <to> <path>          Copy one of those files into the asking agent's space
  summary <from> <to> ["<focus>"]   Read a curated extract of what another agent knows
  brief <from> <to> "<brief>"       Set standing context both agents run with
  unbrief <from> <to>               End that standing context
  briefs <agent>                    Show the briefs an agent runs with
  delegate <from> <to> <endpoint>   Let one agent ask another to use one of its tools
  undelegate <from> <to> <endpoint> Take that back, leaving the channel open
  call <from> <to> <endpoint>       Ask for it — the other agent calls, you approve
  confirm [<agent>] <run>           Confirm a paused action and let the run finish
  runs <agent>                      Review an agent's run history
  memory inspect <agent>            Review what an agent remembers
  events tail <agent>               Review what an agent has done
  trace <agent>                     Review an agent's recorded cognition trace (opt-in)
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

  capabilities: `asterism capabilities show <agent>
asterism capabilities set <agent> <key>...  ·  --none
asterism capabilities remove <agent> <key>...
asterism capabilities unset <agent>

Choose which tools an agent has at all. Every agent starts with the standard toolkit,
and staying that way is perfectly normal — an agent is already kept to its own
workspace and its own level of autonomy. This narrows it further, for an agent you
want kept to less. \`capabilities show\` is the exact picture for one agent.

  capabilities show <agent>   What this agent holds, and what is being withheld.
  capabilities set <agent> <key>...
                              Declare exactly what it holds from now on. Naming the
                              whole list is the point: this is the only way to give
                              something back, and it says plainly where you end up.
  capabilities set <agent> --none
                              It gets no tools from this workspace at all.
  capabilities remove <agent> <key>...
                              Take one away and leave the rest.
  capabilities unset <agent>  Stop narrowing — back to everything on offer.

An agent's own working notes are always available and are not listed here.

This is not the same as trust. \`capabilities\` decides WHICH tools an agent has;
\`trust\` decides what it may do with them — its overall level, and the few destructive
actions it has earned the right to take without pausing. Taking away a tool leaves any
grant it earned untouched and unused; give the tool back and the grant applies again.
Take a grant back with \`asterism trust <agent> revoke <capability>\`.

Endpoints you have bound with \`asterism api add\` are listed separately in
\`capabilities show\` and are not changed by any verb here — withdraw one with
\`asterism api remove <agent> <name>\`.`,

  api: `asterism api add    <agent> <name> <https-url> --credential <KEY>
asterism api list   <agent>
asterism api remove <agent> <name>

Let one agent call one web address, using one of its own stored credentials — without
ever seeing that credential. You choose the address and which credential goes with it;
the agent gets a tool that calls exactly that address and nothing else.

  api add <agent> <name> <url> --credential <KEY>
                              Bind the credential to the address. The agent gains a
                              tool named call_<name>. Re-run it to change the address
                              or the credential.
  api list <agent>            What this agent can call, and what each call sends.
  api remove <agent> <name>   Withdraw it. The credential itself is left alone.

Three things are worth knowing before you bind one:

  · The agent supplies nothing. You give the whole address, query string and all, so
    the agent cannot steer the call or attach anything of its own to it.
  · No call happens without you. At \`notify\` and \`autonomous\` the run pauses and asks;
    a \`propose\` agent never calls at all, it just tells you it would. And it cannot
    earn its way out of asking — sending a credential somewhere is the one thing this
    product will not learn to do on its own.
  · The credential never reaches the agent. It is attached on the way out and
    stripped from anything that comes back.

Addresses must be \`https\`, and cannot carry a username or password — store the
credential with \`asterism secrets add\` and name it with --credential.`,

  secrets: `asterism secrets add <agent> <KEY> [value]

Give one agent a private credential. The value is stored for that agent alone and
is never printed back, logged, or readable by any other agent. If you omit the
value, Asterism reads it from the environment variable of the same name, or from
standard input when piped, and otherwise asks you for it at the terminal — which
is the one way that keeps it out of your shell history. Nothing you type is shown.`,

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
asterism notes accept  <agent> "<subject>"
asterism notes reject  <agent> "<subject>"

See and manage an agent's working notes — its own running record of the current
situation, like "deploy version: v0.2.1" or "migration: 60% done". The agent writes
and updates these itself as it runs (recording a subject again replaces its value), and
they frame its later runs as context. They are the agent's OWN unverified notes, shown
and framed as such — never as facts you reviewed (unlike its memory).

  notes inspect <agent>                Show the agent's working notes (its own record).
  notes set <agent> "<subject>" "<value>"
                                       Set or correct a note yourself.
  notes clear <agent> "<subject>"      Remove a note.
  notes accept <agent> "<subject>"     Approve a note awaiting your review, so it frames runs.
  notes reject <agent> "<subject>"     Decline a note awaiting your review (it never frames).

A note is the agent's own scoped state — writing, clearing, or reviewing one is never
destructive, and never crosses to another agent. Notes you set yourself take effect
immediately. Some notes can arrive marked awaiting your review; until you accept one it
does not frame the agent's runs. The agent keeps a bounded number of notes; when full,
it must clear one before recording a new subject. Notes you set are screened for safety
exactly like the agent's own.`,

  run: `asterism run <agent> "<task>"

Put an agent to work on a task, framed by its role, character, skills, and the
memories it has accepted. What it may do on its own depends on its autonomy level;
a destructive action never happens without you.

The agent can read, write, and delete files in its own workspace. Reading and
writing run according to its autonomy level; deleting is destructive, so the run
stops and asks you first — and a 'propose' agent does not delete at all, it tells
you what it would have deleted.

Activity streams as it happens, and a run that can act on its own ends with a
short summary of what it did, withheld, or paused on. (Progress goes to standard
error, so the agent's own output on standard out stays clean to pipe.)

When a destructive action pauses a run, confirm it later with \`asterism confirm\`
— the run picks up and finishes the action you approved.

Choose a model with \`asterism config\` (or the ASTERISM_MODEL_ID environment
variable), and set an API key in the environment (e.g. OPENAI_API_KEY), before
running.`,

  connect: `asterism connect <from> <to> --mode <handoff|artifact-only|read-summary|shared-brief|delegated-tool>

Open an explicit channel from one agent to another, so the first can hand it work.
Agents are separate by default and can't reach each other; a connection is the only
thing that opens a path — and even then, only what the mode allows ever crosses.
Nothing of the other agent's memory, secrets, or tools is ever shared.

A connection is one-way: \`connect writer researcher\` lets writer hand off to
researcher, not the other way round. Open a second connection for the reverse. You can
re-run the same connect harmlessly — it won't make a duplicate.

  --mode <m>       What may cross the channel. Default: handoff.
                     handoff        The receiving agent does the task and hands back only
                                    its final result — use \`asterism handoff\`.
                     artifact-only  It does the task and hands back only a list of the
                                    files it produced — not its words, and not the file
                                    contents. Use \`asterism artifact\`.
                     read-summary   The receiving agent does NO work at all. It shares a
                                    short, screened extract of what it has already learned
                                    and you have accepted. Use \`asterism summary\`.
                     shared-brief   The one channel that carries context IN rather than
                                    results back. You write a brief and BOTH agents run
                                    with it as standing context. Use \`asterism brief\`.
                     delegated-tool The receiving agent uses one of its OWN tools and
                                    hands back what came out — its credentials never
                                    leave it. You then say which tool, with
                                    \`asterism delegate\`, and ask with \`asterism call\`.

Opening a connection is a deliberate act you take; from then on, either agent's record
shows the channel exists and each time it is used — never the task text or any result.

Close one with \`asterism disconnect\`.`,

  disconnect: `asterism disconnect <from> <to> [--mode <handoff|artifact-only|read-summary|shared-brief|delegated-tool>]

Withdraw a channel you opened. From then on the two agents are as separate as they were
before you connected them.

What it takes away depends on the channel, and it is more than the ability to ask for
work. Withdrawing an artifact-only channel also means files the other agent already
handed over can no longer be fetched — the list you were given stops resolving. And
withdrawing a read-summary channel means it stops sharing what it knows, including from
anything it learned while the channel was open. Withdrawing a shared-brief channel means
the brief stops shaping BOTH agents' runs, from their next run onward. And withdrawing a
delegated-tool channel takes back every tool you handed over on it at once.

  --mode <m>       Which channel, when the two agents have more than one open. With a
                   single open channel you can leave it out; with several, asterism will
                   ask you to name one rather than guess.

Work already underway is not interrupted. If the other agent is paused waiting for you to
confirm something, that confirmation still works and it still finishes its task in its own
space — but nothing it produces afterwards comes back across the withdrawn channel.

This cannot be undone. Connecting the two agents again opens a NEW channel; it does not
restore the old one, and files handed over on the old one stay unreachable. Both agents'
records keep showing the channel and the moment it was withdrawn.`,

  connections: `asterism connections <agent>

Show the channels one agent is on — the agents it can hand work to (outbound, →) and the
agents that can hand work to it (inbound, ←), with each channel's mode. Only ever the
named agent's own connections; it never reveals a channel between two other agents.

Channels you have withdrawn stay listed, marked, after the open ones — so you can always
see what was once open and that it is now closed.`,

  handoff: `asterism handoff <from> <to> "<task>"

Have one agent hand a task to another over a channel you've already opened (with
\`connect\`). The receiving agent does the work in ITS OWN workspace, at ITS OWN autonomy
level, framed by ITS OWN memory and skills — and hands back only its final result. The
asking agent never sees the other's memory, secrets, files, or how it got there.

Because the work runs as the receiving agent, that agent's protections apply: a
destructive action pauses for your confirmation according to the RECEIVING agent's
autonomy, no matter how much autonomy the asking agent has. A handoff can never be a way
around another agent's limits. If it pauses, confirm it on the receiving agent:
  asterism confirm <to> <run>

Open the channel first if you haven't:
  asterism connect <from> <to> --mode handoff

Choose a model (\`asterism config\` or ASTERISM_MODEL_ID, and an API key, e.g.
OPENAI_API_KEY) — the receiving agent needs one to run the task.`,

  artifact: `asterism artifact <from> <to> "<task>"

Have one agent ask another for work and get back only the FILES it produced — a list of
what it made, with sizes — instead of its written answer. For when you want the thing it
made, not its words.

Everything true of \`handoff\` is true here: the receiving agent does the work in its own
workspace, at its own autonomy level, framed by its own memory and skills. Its protections
apply too — a destructive action pauses for your confirmation according to the RECEIVING
agent's autonomy, no matter how much autonomy the asking agent has.

What comes back is narrower. You get each file's path and size, and whether it still
exists. You do NOT get the receiving agent's words, its memory, or the contents of those
files — those stay on its side. The files themselves sit in the receiving agent's own
workspace, on your machine, where you can read them directly.

To bring one of those files across, use \`asterism fetch\` — it asks you first.

Open the channel first if you haven't:
  asterism connect <from> <to> --mode artifact-only

A channel opened for handoff does not work here, and vice versa — each mode is its own
permission, so opening one never quietly grants the other.

Choose a model (\`asterism config\` or ASTERISM_MODEL_ID, and an API key, e.g.
OPENAI_API_KEY) — the receiving agent needs one to run the task.`,

  fetch: `asterism fetch <from> <to> <path>

Copy one file the receiving agent produced into the ASKING agent's own workspace. This is
how a list of files becomes an actual file: run \`asterism artifact\` first, read the paths
it hands back, and fetch the one you want.

  asterism artifact writer helper "draft the market section"
  asterism fetch    writer helper drafts/market-section.md

Nothing is copied without you, and this can never be earned away. At \`notify\` and
\`autonomous\` you are asked to confirm every single fetch — copying a file in is a change
to the asking agent's own workspace, and if a file is already there it says so before
replacing it. An agent set to \`propose\` writes nothing at all; it tells you what it would
copy and leaves it to you.

Only a file the other agent actually handed over can be fetched. A path it never produced
is refused, whatever is on disk — this brings across what you were shown, it is not a way
to read another agent's files.`,

  summary: `asterism summary <from> <to> ["<focus>"]

Read a short, screened extract of what another agent has learned. Add a focus in quotes to
ask about one subject:

  asterism summary writer researcher
  asterism summary writer researcher "pricing"

This is the one command where the other agent does NO work — nothing runs, no model is
called, and it works even with no model set up. It reads what that agent already knows.

Only what YOU have accepted can cross. Anything still waiting for your review, anything
you rejected, and anything archived stays where it is, at any size of extract. What comes
back is the knowledge itself — never the underlying records, when they were learned, what
run produced them, or how sure the agent is of them.

Anything that looks like a password or key is removed before it crosses, and a note whose
wording could be an attempt to steer the reading agent is held back whole. The extract
tells you how many notes were held back, and how many did not fit — ask again with a focus
to reach those.

Open the channel first if you haven't:
  asterism connect <from> <to> --mode read-summary

A channel opened for handoff or artifact-only does not work here — each mode is its own
permission, so opening one never quietly grants another.`,

  brief: `asterism brief <from> <to> "<brief>"

Set the standing context two connected agents both run with. Unlike every other channel,
this one carries something IN rather than handing a result back:

  asterism brief writer researcher "Q3 launch: enterprise buyers, ship by Friday"

From then on, BOTH agents run with that brief in front of them — not just the one it was
written to, and not just when they work together. It shapes their ordinary runs too, until
you replace it, end it, or withdraw the channel. That is what makes it standing context
rather than a longer way of writing a task.

An agent has only one brief per channel. Writing a new one replaces the old one, which
stops shaping runs immediately.

What you write is screened before it goes anywhere. Wording that reads as an attempt to
steer or manipulate the other agent is refused outright — nothing is saved and nothing
crosses, and asterism tells you which rule it tripped without repeating what you wrote. It
is a brief, not a back door into another agent.

Each agent sees the brief clearly marked as coming from the channel, not as its own
purpose — an agent is never fooled into treating another agent's words as its own.

Open the channel first if you haven't:
  asterism connect <from> <to> --mode shared-brief

Nothing of the other agent comes back to you here — no result, no files, no memory. This
channel only carries the brief.`,

  unbrief: `asterism unbrief <from> <to>

End the standing brief on a channel. From their next run onward, neither agent sees it.

The channel itself stays open, so you can set a new brief whenever you like. To close the
channel too, use \`asterism disconnect\`. (Withdrawing the channel also ends the brief —
this is for when you want the channel kept.)

A brief that has ended does not come back; set a new one instead.`,

  briefs: `asterism briefs <agent>

Show the briefs an agent is running with, and the ones it used to. Each line says which
channel carries the brief and whether it is shaping runs right now.

A brief can be listed but no longer shaping runs for two reasons: you replaced or ended
it, or you withdrew the channel it lived on. Both are marked, so you never have to
cross-check \`connections\` to work out why a brief stopped applying.

Only ever the named agent's own briefs — it never reveals a brief between two other
agents.`,

  delegate: `asterism delegate <from> <to> <endpoint>

Hand one agent the ability to ask another to use ONE of its tools — and only that one.

Opening a delegated-tool channel is not enough on its own, and that is the point. The
channel says the first agent may ask for tool results at all; this says which tool. So an
endpoint you set up for an agent tomorrow is not something anyone else can reach through a
channel you opened today — you always name it.

  asterism connect  writer helper --mode delegated-tool
  asterism delegate writer helper issues

Only an endpoint the other agent already has can be handed over — there is nothing to
grant otherwise, and a grant left waiting for a tool to appear is exactly what this
avoids. What crosses when it is used is the tool's answer, screened. The credential goes
out with the call and never comes back into either agent.

Every call stops for you: the receiving agent asks before it sends anything, at any
autonomy level, and it can never earn its way out of asking. If the receiving agent is at
\`propose\` it will never call at all — it only ever tells you it would.

Take it back with \`asterism undelegate\`, which leaves the channel open. Withdrawing the
channel takes back everything on it at once.`,

  undelegate: `asterism undelegate <from> <to> <endpoint>

Take back one tool you handed over. The channel stays open and the other tools on it are
untouched — so this is how you narrow what one agent may ask for without closing the
channel or disturbing anything else.

The endpoint itself is left alone: the agent that owns it can still use it, and its
credential is not touched.

You can hand the same tool over again later; it opens a fresh grant.

Changing or removing the endpoint does this for you. If you re-point it at a different
address or credential, or remove it, anyone who could ask for it stops being able to —
what they were handed is no longer what would be sent, so asterism does not keep sending
it. asterism says so at the time, and you can hand it over again.`,

  call: `asterism call <from> <to> <endpoint>

Ask one agent to use a tool the other one has, and show what came back.

  asterism call writer helper issues

The asking agent chooses nothing but which tool. The address, the credential and the
request all belong to the agent that owns it, the call runs as that agent under its rules,
and what you see is its answer with anything credential-shaped stripped out.

You are asked before anything is sent, every time. That is not a setting: a call that
carries a credential always stops for a human, at any autonomy level, and no amount of
successful calls will change it. If the owning agent is at \`propose\`, nothing is sent at
all and you are told what it would have done.

Three things can turn this down, and they read differently on purpose: there is no
delegated-tool channel between the two agents, the channel is open but this tool was never
handed over, or what was handed over has changed since. Nothing here tells you anything
about tools that were not handed over.

Both agents' records show that the channel was used and how it ended — never the answer
itself, and never the credential.`,

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

  trace: `asterism trace <agent>

Review an agent's recorded cognition trace — an auditable record of what each of its
runs did, tool by tool, rendered as a report. Only the named agent's own trace; it is
never a way to see another agent's.

A trace exists only for an agent you opted in with
\`asterism config cognition-provider <agent> lodestar\`. It is observe-only: recording a
trace never changes what an agent may do (a destructive action still pauses for the
same confirmation). By default the trace records references only — which tool ran,
whether it succeeded, how much it returned — never the contents of a tool's input or
output. You can opt in to recording the redacted CONTENT of what each tool returned with
\`asterism config cognition-capture <agent> content\`; even then, the input arguments are
never kept, common secret shapes (keys, tokens, passwords, private keys) are scrubbed out,
and the captured text is bounded and stripped of terminal-control characters. That scrub is
best-effort, not a guarantee — leave content capture off for an agent that routinely handles
secrets you cannot risk in an audit record. The trace is kept in the install's own storage,
outside the agent's workspace, so the agent cannot reach or tamper with its own record. An
agent with no trace yet is told how to start one.`,

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
              Finally, if the latest run looks to have FINISHED one of the agent's
              standing objectives, it suggests marking that one done (or dropped) — apply
              or skip each. Only your apply changes it; the agent never finishes its own.
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
asterism config recall-budget <agent> <n>  ·  --unset  ·  --default <n>
asterism config world-fact-cap <agent> <n>  ·  --unset  ·  --default <n>
asterism config recall-provider <agent> local  ·  --unset
asterism config cognition-provider <agent> lodestar  ·  --unset
asterism config cognition-capture <agent> content  ·  references

Choose the model your agents run on, and tune how much — and how — each agent
remembers into a run. Set one install-wide default model, and give any single agent
its own model, its own recall budget, its own recall provider, or an auditable trace of
its runs when you want it to differ.

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
  asterism config recall-budget --default <n>
                                        Set the install-wide default budget for every
                                        agent without its own (·  --default --unset to
                                        clear, ·  --default to show). Precedence: a
                                        per-agent budget, then this, then the built-in.
  asterism config world-fact-cap <agent> <n>
                                        Set how many distinct working notes this agent
                                        may keep (a positive whole number). At the cap, a
                                        new note is refused until one is cleared — notes
                                        are never silently dropped.
  asterism config world-fact-cap <agent> --unset
                                        Clear it, so the agent uses the default again.
  asterism config world-fact-cap <agent>
                                        Show this agent's current world-fact cap.
  asterism config world-fact-cap --default <n>
                                        Set the install-wide default cap for every agent
                                        without its own (·  --default --unset to clear,
                                        ·  --default to show). Precedence: a per-agent
                                        cap, then this, then the built-in.
  asterism config recall-provider <agent> local
                                        Rank this agent's memory by meaning, using a
                                        local embeddings endpoint (opt-in, off by
                                        default; see below).
  asterism config recall-provider <agent> --unset
                                        Go back to the built-in keyword ranker.
  asterism config recall-provider <agent>
                                        Show this agent's current recall provider.
  asterism config cognition-provider <agent> lodestar
                                        Record an auditable trace of this agent's runs
                                        (opt-in, off by default; read it with
                                        \`asterism trace\`).
  asterism config cognition-provider <agent> --unset
                                        Stop recording a trace (the default).
  asterism config cognition-provider <agent>
                                        Show this agent's current cognition provider.
  asterism config cognition-capture <agent> content
                                        Also record the redacted content each tool
                                        returned (secrets scrubbed out), not just
                                        references. Needs a trace turned on above.
  asterism config cognition-capture <agent> references
                                        Go back to recording references only (the
                                        default — no content).
  asterism config cognition-capture <agent>
                                        Show this agent's current capture setting.

Where a model comes from, most specific first: an agent's own model, then the
ASTERISM_MODEL_* environment variables, then the install default, then built-in
provider settings. So an environment variable overrides the saved default, and an
agent's own model overrides everything.

An agent's recall budget caps how many of its saved memories are selected to frame a
run — the most relevant are kept under the cap. Each agent's budget is its own; leave
it unset to use the built-in default.

An agent's world-fact cap bounds how many distinct working notes it may keep at once. At
the cap, a new note is refused (loudly) rather than evicting an existing one — notes are
never silently dropped. Set it per agent, or set one install-wide default with
\`--default\`; the precedence is the same as the recall budget — a per-agent cap, then the
install-wide default, then the built-in.

Recall provider chooses HOW that selection is ranked. The default is a built-in
keyword ranker that needs nothing and makes no network call. Opt an agent into
\`local\` to rank its memory by meaning instead, using a local embeddings endpoint you
run yourself (e.g. Ollama) — set ASTERISM_RECALL_EMBED_URL and
ASTERISM_RECALL_EMBED_MODEL (and ASTERISM_RECALL_EMBED_KEY if it needs a token). This
is strictly opt-in and off by default; nothing here sends your memory anywhere unless
you turn it on and point it at your own endpoint. If that endpoint is unreachable
during a run, recall falls back to the keyword ranker (and says so) rather than
failing.

Cognition provider records an auditable trace of an agent's runs — what each tool did,
in order — so you can review it after the fact with \`asterism trace\`. The default is
off (no trace). Opt an agent into \`lodestar\` to record one, kept locally in the
install's own storage (outside the agent's workspace, so the agent cannot tamper with
its own record) and never shared with another agent. It is observe-only: the trace
records what a run did, it never changes what the agent is allowed to do — a destructive
action still pauses for the same confirmation. This first version records references
only (which tool ran, success or failure, output size) — never the contents of a tool's
input or output, so it cannot leak a secret.

Options for \`set\`:
  --provider <name>   Provider name. Default: openai. Naming one of these is
                      enough — the endpoint and wire protocol come with it:
                        openai  anthropic  openrouter  groq
                        deepseek  xai  together  cerebras
                      ...or, for a model running on your own machine, needing no
                      account and no key at all:
                        ollama  lmstudio
  --base-url <url>    The provider's API base URL (needed for any other provider).
  --api <protocol>    The wire protocol, when it differs from the provider default.
  --agent <name>      Apply to this one agent instead of the install default.

Each provider reads its own key from the environment — OPENAI_API_KEY,
OPENROUTER_API_KEY, and so on — or ASTERISM_API_KEY if you keep one key across
providers. A model on your own machine reads neither, and is never sent the
shared key.

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
