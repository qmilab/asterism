# Command reference

Every `asterism` command, its options, and what it prints. Commands map directly
to operations — each one parses its arguments, performs the operation, and
formats the result.

```
asterism <command> [options]
```

| Global option | Effect |
|---|---|
| `-h`, `--help` | Show help. Works on any command: `asterism <command> --help`. |
| `-v`, `--version` | Print the installed version. |

**Exit codes:** `0` on success, `1` on any error (unknown agent, missing
argument, no workspace, bad value). Errors print to standard error; results
print to standard output.

Almost every command takes an agent by **name** and must be run inside an
initialized workspace (the `.asterism/` home, discovered by walking up from the
current directory). If no workspace is found, the command tells you to run
`asterism init` first.

---

## `init`

```
asterism init
```

Set up Asterism in the current directory. Creates a local `.asterism/` home that
holds every agent's separate store and workspace. **Safe to re-run** — an
existing home is left untouched and reported as already set up.

```console
$ asterism init
Initialized Asterism in /home/you/project/.asterism
Create your first agent:  asterism new <name> --role "..." --trust propose
```

---

## `new`

```
asterism new <agent> [--soul <name|path>] [--role "<text>"] [--trust <level>]
              [--model <id>] [--provider <name>] [--base-url <url>] [--api <protocol>]
```

Create a new agent with its own memory, secrets, skills, and workspace, kept
separate from every other agent.

| Option | Default | Description |
|---|---|---|
| `--soul <name\|path>` | `casual-helper` | The agent's character. A built-in name (`casual-helper`, `careful-consultant`) or a path to your own Markdown file. |
| `--role "<text>"` | *(none)* | One line describing what the agent is responsible for. |
| `--trust <level>` | `propose` | `propose`, `notify`, or `autonomous`. See [trust levels](./concepts.md#trust-levels). |
| `--model <id>` | *(install default)* | Pin this agent to a specific model. Combine with `--provider`/`--base-url`/`--api` for a non-default provider. Stored as a per-agent override in [`config`](#config); change it later there. No API key goes here. |

An agent name must be a single safe path segment: letters, digits, dot, dash, or
underscore — no spaces or slashes, up to 64 characters. A flag given with no
value (`--trust` with nothing after it) is an error rather than a silent fall
back to the default. If you point `--soul` at a file that does not exist yet,
the agent is still created and uses a default character until the file appears.

```console
$ asterism new writer --soul careful-consultant --role "tightens blog drafts" --trust notify
Created agent "writer" (notify) — soul: careful-consultant
  role: tightens blog drafts
  workspace: /home/you/project/.asterism/agents/writer
```

---

## `list`

```
asterism list
```

Show every agent in this workspace — its name, how much it may do on its own, the
one line it is responsible for, and when it last ran. Reads the roster only; it
never reaches into any agent's memory, secrets, or files.

```console
$ asterism list
Agents (2):

• writer · autonomous
  role: tightens blog drafts
  last run 2026-06-10T12:01:00.000Z
• work · propose
  role: client-facing consultant
  never run
```

Before any agent exists it prints `No agents yet. Create one with: asterism new
<name>`.

---

## `trust`

```
asterism trust <agent> <level>
asterism trust <agent> --review
asterism trust <agent> show
asterism trust <agent> revoke <capability>
asterism trust <agent> threshold [--clean <n>] [--targets <n>]  ·  --unset
```

Set how much an agent may do on its own — both the overall **level**, and, capability
by capability, the few destructive actions it has **earned** the right to take without
pausing for you.

### Set the level

```console
$ asterism trust writer autonomous
Set writer to autonomous.
```

`propose`, `notify`, or `autonomous` — see [trust levels](./concepts.md#trust-levels).
Records an `agent.trust_changed` event. Remember: `notify` and `autonomous` both act
without asking first. Only the
[destructive-action gate](./concepts.md#the-destructive-action-gate) still pauses
them — that gate is independent of trust level.

### Earned autonomy — per-capability grants

The destructive-action gate pauses *every* destructive action by default. An agent can
**earn** the standing to take one specific capability without that pause — by handling
it cleanly, several times, across different targets, with nothing declined or failed in
between. Earned standing is always **proposed for your approval**, never granted
automatically, and **lost the moment something goes wrong**: a declined or failed action
on a capability resets it, and it has to be re-earned. A grant only ever lets *that one
capability* skip the pause — it never weakens the classification, never crosses to
another capability, and never carries to another agent.

| Form | What it does |
|---|---|
| `trust <agent> --review` | Review the capabilities the agent has earned the right to act on without pausing. You grant or decline each; nothing is granted without your yes. |
| `trust <agent> show` | Show the agent's level, which capabilities now act without pausing, and its earning bar. |
| `trust <agent> revoke <capability>` | Take a grant back — the capability pauses for your confirmation again. |
| `trust <agent> threshold [--clean <n>] [--targets <n>]` | Tune how much clean track record review asks for before it proposes a grant: how many confirmed executions (`--clean`), across how many different targets (`--targets`). Set either or both; leave the other as it is. |
| `trust <agent> threshold --unset` | Clear the custom bar — back to the built-in default. |
| `trust <agent> threshold` | Show this agent's current earning bar. |

A higher bar only asks for *more* evidence before proposing a grant — it never lets
anything act without your yes. Granting and revoking are recorded as
`agent.standing_changed` events; tuning the bar as `agent.setting_changed`.

---

## `secrets add`

```
asterism secrets add <agent> <KEY> [value]
```

Give one agent a private credential. The value is stored for that agent alone
and is never printed back, logged, or readable by any other agent.

The value is resolved in this order:

1. the inline `[value]` argument, if given;
2. otherwise the environment variable of the same name as `KEY`;
3. otherwise standard input, if piped.

The inline value is taken **verbatim** — a value beginning with a dash
(`-----BEGIN…`) is stored as given, not parsed as an option.

```console
$ asterism secrets add work GITHUB_TOKEN ghp_xxx
Stored credential GITHUB_TOKEN for agent work.

# from the environment
$ GITHUB_TOKEN=ghp_xxx asterism secrets add work GITHUB_TOKEN
Stored credential GITHUB_TOKEN for agent work.

# piped (nothing echoed)
$ cat token.txt | asterism secrets add work GITHUB_TOKEN
Stored credential GITHUB_TOKEN for agent work.
```

---

## `skill add`

```
asterism skill add <agent> <file.md>
```

Teach an agent a skill from a Markdown file. The file is **copied into the
agent's own workspace**; other agents cannot see it. The skill is named after
the file (without the `.md`). The source must be an existing `.md` file.

```console
$ asterism skill add writer blog-style.md
Attached skill "blog-style" to agent writer.
```

---

## `objective`

```
asterism objective add  <agent> "<text>"
asterism objective list <agent>
asterism objective done <agent> <id>
asterism objective drop <agent> <id>
```

Give an agent a **standing objective** — what it should be working toward, ongoing.
Unlike a memory (a lesson it learned and you reviewed), an objective is *current
purpose* you set and manage. Every active objective frames the agent's runs as
standing context, so the goal stays in view across many runs. See
[standing objectives](./concepts.md#standing-objectives).

| Verb | What it does |
|---|---|
| `objective add <agent> "<text>"` | Declare a new objective. It starts **active** and begins framing the agent's runs. |
| `objective list <agent>` | Show the agent's objectives — the active ones that frame runs first, then any proposed for review, then completed/dropped history. |
| `objective done <agent> <id>` | Mark an objective completed; it stops framing runs. |
| `objective drop <agent> <id>` | Abandon an objective; it stops framing runs. |

Identify an objective by the short id shown in `objective list`. An objective is the
named agent's own scoped state — only ever its own, never another agent's — and its
text is run through the same [safety screen](./concepts.md#reflection) as memory
before it is saved (a write that trips the screen is refused, not stored). Declaring
or retiring one is **not** destructive: it touches only the agent's own purpose,
nothing external.

Reflection can also **propose** objectives it notices the agent working toward —
surfaced for your approval, never adopted on its own. A proposed objective does not
frame runs until you accept it; review proposals with
[`asterism reflect <agent> --review`](#reflect).

```console
$ asterism objective add writer "keep the launch blog current and on-brand"
Declared objective a1b2c3d4 for writer.

$ asterism objective list writer
Objectives for writer (2, 1 active):

• a1b2c3d4 · active
  keep the launch blog current and on-brand
  declared 2026-06-20T09:00:00.000Z

• e5f6a7b8 · done
  ship the Q2 retrospective post
  declared 2026-06-18T14:00:00.000Z

$ asterism objective done writer a1b2c3d4
Marked objective a1b2c3d4 done for writer.
```

An agent with no objectives prints `writer has no objectives yet.` alongside the
command to declare one. A `done`/`drop` whose id matches nothing — or matches more
than one — says so rather than guessing.

---

## `notes`

```
asterism notes inspect <agent>
asterism notes set     <agent> "<subject>" "<value>"
asterism notes clear   <agent> "<subject>"
```

See and manage an agent's **working notes** — its own running record of the current
situation, kept as `subject: value` pairs. The agent writes these **itself** as it
works, to carry context from one run into the next, and they frame its later runs.
They are the agent's *own unverified notes*, distinct from memory: nothing here was
reviewed by you, so they are shown and framed plainly as the agent's own record,
**not facts**. See [working notes](./concepts.md#working-notes).

| Verb | What it does |
|---|---|
| `notes inspect <agent>` | Show the agent's working notes — its own record, and how full it is. |
| `notes set <agent> "<subject>" "<value>"` | Set or correct a note yourself. Re-setting a subject **replaces** its value. |
| `notes clear <agent> "<subject>"` | Remove one note. |

The agent records and forgets its own notes mid-run through its tools; these operator
verbs are how **you** inspect and revert them. A note is the agent's own scoped
state — writing or clearing one is never destructive, and never crosses to another
agent. An agent keeps a **bounded** number of notes; when they are full, clear one
before a new subject will save. A note you set is run through the same
[safety screen](./concepts.md#reflection) as the agent's own (a write that trips the
screen is refused, not stored).

```console
$ asterism notes inspect writer
Working notes for writer (2 of 32) — the agent's own unverified record, not facts:

• draft status: intro rewritten, closing still needs a pass
  updated 2026-06-20T09:14:00.000Z
• house style: sentence case in headings
  updated 2026-06-20T09:02:00.000Z

$ asterism notes set writer "draft status" "ready for review"
Set working note "draft status" for writer.

$ asterism notes clear writer "house style"
Cleared working note "house style" for writer.
```

An agent with no working notes says so, with the command to set one. Clearing a
subject that has no note, or setting one when notes are full, reports the problem
plainly rather than failing silently.

---

## `run`

```
asterism run <agent> "<task>"
```

Put an agent to work on a task, framed by its role, character, skills, and the
memories it has accepted. What it may do on its own depends on its
[trust level](./concepts.md#trust-levels); destructive actions always pause for
your confirmation first.

Requires a [configured model](./installation.md#configuring-a-model). The task
can be quoted or left as trailing words — both are preserved in full.

A run ends in one of three ways:

- **done** — the agent's output is printed.
- **paused** — a destructive action needs confirmation: `Run paused: a
  destructive action needs your confirmation before it can proceed.` In an
  interactive terminal you are prompted `[y/N]` to approve it right away. Otherwise
  the run stays paused — it also prints the exact command to resume it later
  (`asterism confirm <agent> <id>`; see [`confirm`](#confirm)). A non-interactive
  (piped) run never auto-approves.
- **failed** — an error is printed and the command exits `1`.

The run's activity streams as it happens, and an agent that can act on its own
(`notify` or `autonomous`) ends with a short summary of what it did, withheld, or
paused on — the `notify` level's promise to show you each action, kept. Both the
live activity and the summary go to **standard error**, so the agent's own output
on **standard out** stays clean to pipe or redirect:

```console
$ asterism run writer "tighten the intro in posts/launch.md"
  → write_file
  ✓ write_file
Actions (1 executed):
  ✓ executed fs.write (write)
<the agent's response>
```

(The arrowed lines and the `Actions` summary are on stderr; only `<the agent's
response>` lands on stdout.)

> **Tools:** the shipped CLI registers a default catalog of workspace-scoped file
> tools — `read_file`, `list_dir`, `stat`, and `find` to look around, plus
> `write_file`, `append_file`, `mkdir`, and `move` to change things and
> `delete_file` to remove them — behind the trust gate. The read-only tools and
> the write tools are ordinary read/write effects; `delete_file` is destructive
> and pauses for confirmation at every trust level, while `move` refuses to
> overwrite an existing destination (so it never silently destroys anything). Each is confined
> to the agent's workspace (logical scoping, not an OS-enforced jail — see
> [what isolation means today](./concepts.md#what-isolation-means-today)). The
> end-to-end behavior is shown in the [walkthrough](./walkthrough.md).

---

## `confirm`

```
asterism confirm [<agent>] <run>
```

Confirm the destructive action a run paused on, and let the run finish. This is how
you clear a pause from anywhere — including a run that stopped with nobody at the
prompt, like one started over the [HTTP endpoint](./http.md) or from a pipe.

Identify the run by the short id shown when it paused (or by [`runs`](#runs)). Name
the agent too when the same short id could mean different runs:

```console
$ asterism run writer "delete the generated files in dist/"
Run paused: a destructive action needs your confirmation before it can proceed.
Confirm it to continue:  asterism confirm writer e5f6a7b8

$ asterism confirm writer e5f6a7b8
  → delete_file
  ✓ delete_file
Actions (1 executed):
  ✓ executed fs.delete (destructive)
Deleted 'dist'.
```

A bare `asterism confirm e5f6a7b8` works too when the id is unambiguous across your
agents.

Confirming approves **only** the action the run paused on — nothing else is
unlocked, and the grant applies to this run alone. The approval is bounded, not a
blanket on the capability: confirming a delete of `dist` clears that delete, but a
later delete of `cache` (the same kind of action, a new target) pauses again for
its own `confirm`, as does any other destructive step. If a run stopped on several
destructive actions at once, you clear them one confirm at a time — a single `yes`
never approves several distinct actions together. Resuming re-runs the task from the
start, so any ordinary writes the agent had already made happen again; but a
destructive action you already confirmed is **not** repeated — the run recognizes it
as done and moves on — so confirming step by step never double-charges or
double-deletes. Requires a [configured model](./installation.md#configuring-a-model)
— the same one the run started with.

---

## `runs`

```
asterism runs <agent>
```

Review one agent's run history — each run's short id, status, what it was asked to
do, and when it started and finished. Shows **only the named agent's runs**,
oldest first.

```console
$ asterism runs writer
Runs for writer (2):

• a1b2c3d4 · done
  tighten the intro in posts/launch.md
  started 2026-06-10T12:01:00.000Z · finished 2026-06-10T12:01:04.000Z
• e5f6a7b8 · awaiting_confirmation
  delete the generated files in dist/
  started 2026-06-10T12:05:00.000Z
```

A run shown as `awaiting_confirmation` is waiting for you — resume it with
[`confirm`](#confirm). An agent with no runs prints `writer has no runs yet.`

---

## `memory inspect`

```
asterism memory inspect <agent> [--type <type>] [--review-state <state>] [--run <run>]
```

Show what one agent remembers — what it has accepted, what is still proposed for
review, and where each memory came from. Only ever shows the named agent's
memory.

| Option | Description |
|---|---|
| `--type <type>` | One memory type: `semantic`, `procedural`, `convention`, `negative`, `episodic`. |
| `--review-state <state>` | One review state: `proposed`, `accepted`, `rejected`. |
| `--run <run>` | Only what was learned from one run (its short id, e.g. `a1b2c3d4`). |

Filters AND-combine and stay scoped to this agent — a `--run` value can only name
one of *its own* runs, never reach another agent's. An unknown `--type` or
`--review-state` is a clear error, not a silent empty list.

```console
$ asterism memory inspect writer --review-state proposed
Memory for writer (1 matching review-state=proposed):

• convention · proposed · confidence 0.86
  This blog uses sentence case in headings.
  recorded 2026-06-10T12:00:00.000Z · from run a1b2c3d4
```

An agent with no memories prints `writer has no memories yet.` A filter that
matches nothing names what was filtered, e.g.
`writer has no memories matching type=negative.`

---

## `events tail`

```
asterism events tail <agent> [--limit <n>] [--type <type>] [--run <run>] [--since <id>] [--follow]
```

Review what an agent has done — an append-only record of its consequential
actions ([event types](./concepts.md#event-log)). The log holds references
only, never secret values. Only ever shows the named agent's activity.

| Option | Description |
|---|---|
| `--limit <n>` | Cap the number of events shown. |
| `--type <type>` | Show only events of one type, e.g. `--type action.executed`. |
| `--run <run>` | Show only one run's activity (its short id). |
| `--since <id>` | Page forward — show events after the given event id. |
| `--follow` | Keep watching and print new events as they happen. `Ctrl+C` to stop. |

```console
$ asterism events tail writer --limit 3
Activity for writer (3):

2026-06-10T12:00:00.000Z  agent.created
  {"name":"writer","role":"tightens blog drafts","trustLevel":"notify"}
2026-06-10T12:01:00.000Z  run.started  run=a1b2c3d4
  {"runId":"a1b2c3d4-…","status":"pending"}
2026-06-10T12:01:02.000Z  action.executed  run=a1b2c3d4
  {"capability":"fs.write","effect":"write"}
```

`--follow` prints the current backlog (after any `--limit`/`--type`/`--run`
filter), then streams each new event as it lands until you stop it. Like every
other read, a live tail is scoped to the one agent.

---

## `reflect`

```
asterism reflect <agent> --review
asterism reflect <agent> --propose
```

Turn an agent's work into things it might keep — typed **memories**, and the
**standing objectives** it could take on. Reflection only ever **proposes**; you
stay the one who decides what an agent remembers and what it works toward. There are
two halves: one fills a review pile, the other lets you go through it. One of
`--review` / `--propose` is required; reflection never runs in a silent auto mode.

### `--review` — go through the pile

Review the proposals waiting for an agent and **accept**, **edit**, or **reject**
each one — memory proposals first, then any standing-objective proposals, in one
pass. Anything that looks unsafe to remember is flagged. If proposals are already
waiting (see `--propose`), it reviews those — no model needed, since they are already
drafted. Otherwise it looks over the agent's latest completed run and drafts new
proposals on the spot (which needs a
[configured model](./installation.md#configuring-a-model)).

In an interactive terminal each proposal prompts `[a]ccept / [e]dit / [r]eject`.
Outside a terminal — piped, or launched from a scheduler — nothing is ever
accepted, and a pile already **queued** by `--propose` is left **untouched** (with
a note to review it in a terminal) rather than silently rejected, since rejecting a
queued proposal is a durable choice. Either way, nothing is written without you.

```console
$ asterism reflect writer --review
Reviewing 2 proposed memories for writer (from run a1b2c3d4).
Nothing is saved unless you accept it.

(1/2) convention · confidence 0.86
  This blog uses sentence case in headings.
  Keep this memory? [a]ccept / [e]dit / [r]eject (default: reject): a
  ✓ saved

(2/2) procedural · confidence 0.78
  Run a spell pass before saving.
  Keep this memory? [a]ccept / [e]dit / [r]eject (default: reject): r
  ✗ rejected

Done — 1 saved, 1 rejected.
```

If a proposal trips the memory firewall it is flagged with a `⚠`; if you accept
a flagged one anyway, the firewall still refuses to save it (`⛔ blocked`).

### `--propose` — fill the pile, unattended

Look over an agent's new work and set aside what might be worth keeping — a memory
to remember, or a standing objective to take on — for you to review later. It
**saves nothing as active and asks nothing**; it just adds to the review pile, which
you drain with `--review` when you're ready. Anything that looks unsafe is held back
rather than added. Safe to re-run: it only looks at work it hasn't already looked
over, and never queues the same thing twice.

Because `--propose` is unattended, it's the form you can put on a schedule (below).
Drafting proposals needs a [configured model](./installation.md#configuring-a-model).

```console
$ asterism reflect writer --propose
Queued 2 proposed memories for writer from 1 run.
Queued 1 proposed objective.
Review them with: asterism reflect writer --review
```

### Schedule it yourself

Asterism ships no clock of its own. **Nothing reflects on a schedule unless you
set that up** — wire `reflect --propose` to your operating system's scheduler, the
same way you'd schedule any command. It fills the review pile in the background;
you still review and accept everything yourself, on your own time.

**cron (Linux/macOS)** — propose for `writer` every night at 2am, via `crontab -e`.
`flock -n` keeps a slow run from overlapping the next one (Asterism also guards against
double-queueing internally, but skipping the overlap entirely is cleaner):

```cron
0 2 * * *  flock -n ~/.asterism/reflect-writer.lock asterism reflect writer --propose >> ~/.asterism/reflect.log 2>&1
```

**launchd (macOS)** — `~/Library/LaunchAgents/com.asterism.reflect.writer.plist`,
then `launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.asterism.reflect.writer</string>
  <key>ProgramArguments</key>
  <array>
    <string>asterism</string><string>reflect</string>
    <string>writer</string><string>--propose</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>
</dict></plist>
```

**systemd timer (Linux)** — a templated `asterism-reflect@.service` plus its
`.timer`, then `systemctl --user enable --now asterism-reflect@writer.timer`:

```ini
# asterism-reflect@.service
[Service]
Type=oneshot
ExecStart=asterism reflect %i --propose

# asterism-reflect@writer.timer
[Timer]
OnCalendar=*-*-* 02:00:00
[Install]
WantedBy=timers.target
```

Whatever the cadence, the deal is the same: a scheduled run only ever **adds to
the pile**. An agent never starts remembering — or taking on a new objective — on
its own; every memory and objective still waits for your `--review`.

---

## `config`

```
asterism config
asterism config set <model-id> [--provider <name>] [--base-url <url>] [--api <protocol>] [--agent <name>]
asterism config unset [--agent <name>]
asterism config recall-budget <agent> <n>  ·  --unset
asterism config recall-provider <agent> local  ·  --unset
```

Choose the model your agents run on, and tune how each agent recalls its memory.
Set one install-wide default model, and give any single agent its own model, its own
recall budget, or its own recall provider when you want it to differ. The model
settings live in `.asterism/config.json` and hold **only** which model to use —
never an API key (keys stay in the [environment](./installation.md#api-keys)); the
per-agent recall settings are kept in the kernel store, scoped to each agent.

| Form | What it does |
|---|---|
| `config` (or `config show`) | Show the saved settings and the model, recall budget, and recall provider each agent resolves to. |
| `config set <id>` | Set the install-wide default model. |
| `config set <id> --agent <name>` | Pin one agent to its own model. |
| `config unset` | Clear the install default. |
| `config unset --agent <name>` | Clear one agent's override. |
| `config recall-budget <agent> <n>` | Cap how many memories this agent recalls into a run. `--unset` returns it to the default; with no value, shows the current setting. |
| `config recall-provider <agent> local` | Rank this agent's memory by meaning using a local embeddings endpoint (opt-in; see [Tuning recall](#tuning-recall)). `--unset` returns it to the built-in keyword ranker; with no value, shows the current setting. |

| Option (for `set`) | Description |
|---|---|
| `--provider <name>` | Provider name. Built-in: `openai`, `anthropic`. Default: `openai`. |
| `--base-url <url>` | The provider's API base URL (needed for providers other than the built-ins). |
| `--api <protocol>` | The wire protocol, when it differs from the provider default. |
| `--agent <name>` | Apply to this one agent instead of the install default. The agent must already exist. |

**Where a model comes from**, most specific first: an agent's own model →
`ASTERISM_MODEL_*` environment variables → the install default → built-in
provider settings. So an environment variable overrides the saved default, and an
agent's own model overrides everything.

```console
$ asterism config set gpt-4o-mini --provider openai
Set the model for the install default: gpt-4o-mini (provider: openai).
API keys are never stored here — keep them in the environment (e.g. OPENAI_API_KEY).

$ asterism config set claude-opus-4-8 --provider anthropic --agent work
Set the model for agent "work": claude-opus-4-8 (provider: anthropic).

$ asterism config
Configuration  (/home/you/project/.asterism/config.json)

Install default model: gpt-4o-mini (provider: openai)

Per-agent model:
  work  →  claude-opus-4-8 (provider: anthropic)  [agent override]
  personal  →  gpt-4o-mini (provider: openai)  [install default]

Per-agent recall budget:
  work  →  20  [default]
  personal  →  20  [default]

Per-agent recall provider:
  work  →  keyword (built-in)  [default]
  personal  →  keyword (built-in)  [default]

API keys are never stored here — set them in the environment (e.g. OPENAI_API_KEY).
```

### Tuning recall

Before each run, an agent recalls the most relevant of its saved memories to frame
the task. Two per-agent knobs tune that — each scoped to the one agent, never shared:

**Recall budget** — how *many* memories a run may frame. The most relevant are kept
under the cap; leave it unset to use the built-in default.

```console
$ asterism config recall-budget work 40
Set work's recall budget to 40 memories.
```

**Recall provider** — *how* that relevance is ranked. The default is a built-in
keyword ranker that needs nothing and makes no network call. You can opt a single
agent into `local`, which ranks its memory by **meaning** using a local embeddings
endpoint that **you** run — for example [Ollama](https://ollama.com).

> **Opt-in, and off by default.** Nothing here sends your memory anywhere unless you
> turn it on *and* point it at your own endpoint. The default install pulls no ML and
> makes no network call for recall. The embeddings stay between Asterism and your own
> local endpoint.

Point Asterism at the endpoint with environment variables, then opt the agent in:

| Variable | What it is |
|---|---|
| `ASTERISM_RECALL_EMBED_URL` | The embeddings endpoint — an OpenAI-compatible `/embeddings` route, e.g. `http://localhost:11434/v1/embeddings` for Ollama. |
| `ASTERISM_RECALL_EMBED_MODEL` | The embedding model to use, e.g. `nomic-embed-text`. |
| `ASTERISM_RECALL_EMBED_KEY` | *(optional)* A bearer token, for endpoints that need one. A purely-local endpoint usually needs none. |

```console
$ export ASTERISM_RECALL_EMBED_URL=http://localhost:11434/v1/embeddings
$ export ASTERISM_RECALL_EMBED_MODEL=nomic-embed-text
$ asterism config recall-provider work local
Set work's recall provider to local. Configure the endpoint with ASTERISM_RECALL_EMBED_URL and ASTERISM_RECALL_EMBED_MODEL.
```

If an opted-in agent has no endpoint configured, its runs stop with a clear message
rather than quietly falling back — so the misconfiguration is visible. If the
endpoint is configured but *unreachable* during a run, recall degrades to the keyword
ranker (it still frames correct memories) and says so, rather than failing the run.

---

## `serve`

```
asterism serve <agent> [--port <n>] [--host <addr>]
```

Offer one agent over a local HTTP endpoint, with the same separation guarantees
as the command line. The endpoint serves **only this agent** — it is never a way
to reach another.

| Option | Default | Description |
|---|---|---|
| `--port <n>` | `4831` | Port to listen on (0–65535). |
| `--host <addr>` | `127.0.0.1` | Address to bind. The default is loopback — this machine only. |

```console
$ asterism serve writer
Serving agent "writer" at http://127.0.0.1:4831
  POST http://127.0.0.1:4831/agents/writer/runs    start a run  (JSON body: {"input":"<task>"})
  POST http://127.0.0.1:4831/agents/writer/runs/<run>/confirm    approve a paused run
  GET  http://127.0.0.1:4831/agents/writer/runs    list runs
  GET  http://127.0.0.1:4831/agents/writer/events  review activity
  Access token (generated, save it — shown only once):
    9f2c…(64 hex chars)…
    Send it on every request:  Authorization: Bearer <token>
    Stored owner-only at …/.asterism/http-tokens/writer.token; set ASTERISM_HTTP_TOKEN to override.
Press Ctrl+C to stop.
```

Every request needs that bearer token — the endpoint is default-deny, on loopback
as anywhere else. The first serve generates and prints one (and saves it for next
time); set `ASTERISM_HTTP_TOKEN` to supply your own, which is what you want for an
exposed or unattended endpoint. See the [HTTP reference](./http.md#authentication)
for the full token model.

Without a configured model the read endpoints still work; starting a run is
declined until a model is set. A destructive action has no one at the keyboard to
confirm it, so the run **pauses and waits** rather than running unattended — you
clear it out of band by POSTing to the run's confirm endpoint (or with
[`confirm`](#confirm)). See the [HTTP reference](./http.md) for full
request/response details.

---

## `dashboard`

```
asterism dashboard [<url>] [--token <token>] [--headless] [--port <n>] [--host <addr>]
```

Your live terminal console over **every** agent at once — the one place to see
what each agent is doing and steer it: review proposed memories, dial autonomy up
or down, approve or decline an action an agent has paused for confirmation, and
watch activity stream in. It shows many agents but never crosses between them — it
only ever asks about one agent at a time, so their separate lives hold here too.

Run with no arguments, it opens the live view for this machine's agents:

```console
$ asterism dashboard
```

| Key | Action |
|---|---|
| `↑`/`↓`, `j`/`k` | Select an agent |
| `t` | Set the selected agent's autonomy (trust) level |
| `c` | Approve the agent's pending destructive action |
| `x` | Decline the agent's pending destructive action |
| `m` | Reflect — review proposed memories (`a` accept · `e` edit · `r` reject) |
| `r` | Refresh now |
| `?` | Toggle help · `q` quit |

The dashboard is a **thin client** — it holds no logic of its own. Every action is
one request to a small local console endpoint that spans your agents, the same
kernel-backed surface the CLI and [`serve`](#serve) use, so it inherits the exact
same trust enforcement, destructive-action gate, and agent boundary. Reviewing
memory needs a configured model (it runs reflection on demand); the rest works
without one.

| Option | Default | Description |
|---|---|---|
| `--headless` | — | Run the console **without** the terminal view — the endpoint a dashboard on another machine attaches to. Prints an access token like `serve`. |
| `--token <t>` | — | The access token when attaching to a remote console (or set `ASTERISM_HTTP_TOKEN`). |
| `--port <n>` | `4832` | With `--headless`, the port to listen on. |
| `--host <addr>` | `127.0.0.1` | With `--headless`, the address to bind (loopback by default). |

To watch a machine's agents from elsewhere, run the console there and attach to it:

```console
# on the host
$ asterism dashboard --headless
# on your laptop
$ asterism dashboard http://host:4832 --token <token>
```

See the [dashboard reference](./dashboard.md) for the console endpoints behind it.

---

## `channel telegram`

```
asterism channel telegram <agent> [--allow <chat-id>[,<chat-id>...]]
```

Reach one agent from a Telegram chat, with the same separation guarantees as the
command line. The bot drives **only this agent** — never a way to reach another.

Set the bot token in the environment (`ASTERISM_TELEGRAM_TOKEN`, from
[@BotFather](https://t.me/BotFather)) — it is a secret and never goes in a flag or
config. The **allow-list** is the channel's access boundary: only the chat ids you
allow can use the bot; anyone else is refused and told only their own chat id. A
destructive action pauses the run and asks in the chat — you reply `/confirm` to
approve just that action, the same gate you get at the keyboard.

| Option | Default | Description |
|---|---|---|
| `--allow <id,...>` | *(none)* | Chat ids allowed to use the bot, comma-separated. Combined with `ASTERISM_TELEGRAM_ALLOW`. With none, the bot starts but only hands out chat ids until you add one. |

```console
$ export ASTERISM_TELEGRAM_TOKEN=123456789:AAx…
$ asterism channel telegram writer --allow 8675309
Listening as @writer_bot for agent "writer".
  1 authorized chat; messages from any other chat are refused.
  A destructive action pauses the run and asks the chat to reply /confirm.
Press Ctrl+C to stop.
```

A channel needs a [configured model](./installation.md#configuring-a-model) —
every message is a task — so it will not start without one. See the
[chat channels guide](./channels.md) for setup, the confirm-by-reply flow, and
limitations.

---

## `channel discord`

```
asterism channel discord <agent> [--allow <channel-id>[,<channel-id>...]]
```

Reach one agent from a Discord channel, with the same separation guarantees as the
command line. The bot drives **only this agent** — never a way to reach another.

Set the bot token in the environment (`ASTERISM_DISCORD_TOKEN`, from the
[Discord Developer Portal](https://discord.com/developers/applications)) — it is a
secret and never goes in a flag or config. Enable the bot's **MESSAGE CONTENT**
intent in the portal, or it can't read the messages it's sent. The **allow-list**
is the channel's access boundary: only the channel ids you allow can use the bot;
anyone else is refused and told only their own channel id. In a server the bot acts
only when you **@mention** it (a DM needs no mention). A destructive action pauses
the run and asks in the channel — you reply `/confirm` to approve just that action,
the same gate you get at the keyboard.

| Option | Default | Description |
|---|---|---|
| `--allow <id,...>` | *(none)* | Channel ids allowed to use the bot, comma-separated. Combined with `ASTERISM_DISCORD_ALLOW`. With none, the bot starts but only hands out channel ids until you add one. |

```console
$ export ASTERISM_DISCORD_TOKEN=…
$ asterism channel discord writer --allow 403592…21
Listening as @writer for agent "writer".
  1 authorized channel; messages from any other channel are refused.
  In a server, @mention the bot; a DM needs no mention.
  A destructive action pauses the run and asks the channel to reply /confirm.
Press Ctrl+C to stop.
```

The Discord channel talks to the Gateway over a WebSocket, so it needs **Node 22+
or Bun** (an older Node has no WebSocket; the channel declines at startup). Like
Telegram, it needs a [configured model](./installation.md#configuring-a-model). See
the [chat channels guide](./channels.md) for setup, the confirm-by-reply flow, and
limitations.

---

## `service`

```
asterism service install   <agent> [--kind serve|telegram|discord] [-- <args>]
asterism service status    <agent> [--kind <kind>]
asterism service uninstall <agent> [--kind <kind>]
```

Keep one agent running in the background as a service your computer starts for you
and restarts if it stops — the same separate-lives guarantees as the command line,
just always on. A service runs **one long-lived command for one agent**: its local
HTTP endpoint (`serve`, the default) or one of its chat channels. Supported on
**macOS** (launchd) and **Linux** (systemd user services).

Anything after `--` is passed straight to the supervised command, so a `serve`
service can pick a port and a channel can carry its allow-list:

```console
$ asterism service install writer -- --port 8080
$ asterism service install writer --kind telegram -- --allow 12345
```

| Subcommand | What it does |
|---|---|
| `install` | Write the service, register it with the OS, and start it (also at login). Re-running it replaces the definition and keeps your edited settings file. |
| `status` | Show whether the agent's services are running, and where each one's settings and logs live. With no `--kind`, reports every kind. |
| `uninstall` | Stop and remove a service. Its settings file is **left in place**, in case it holds secrets you want to keep. |

| Option | Default | Description |
|---|---|---|
| `--kind <kind>` | `serve` | Which long-lived command to run: `serve`, `telegram`, or `discord`. |
| `--capture-env` | *(off)* | On `install`, write the values currently set in your shell into the private env file, instead of an empty template. A convenience that writes secret values to the `0600` file — only when you ask — and overwrites that file each time. |

**Secrets stay out of the service definition.** By default `install` creates a
private environment file (readable only by you) that *names* what the service needs
— your model API key, and a chat token for a channel — with no values filled in. You
edit that file; nothing secret is ever written for you. Until it's filled in, the
service keeps restarting and `status` shows it not running. If you have already
exported those variables, `--capture-env` copies their current values into the
`0600` file for you (the one case where `install` writes a secret to disk — and only
because you asked).

```console
$ asterism service install writer --kind telegram
Installed service "writer (telegram)".
  Keeps `asterism channel telegram writer` running and restarts it if it fails.
  Before it can work, set these in its private environment file:
    ASTERISM_TELEGRAM_TOKEN   your Telegram bot token (from @BotFather).
    OPENAI_API_KEY   your model API key — every chat message is a task, so a channel needs one.
  Env file (0600): ~/.config/asterism/services/writer.telegram/service.env
  Edit it, then restart: systemctl --user restart asterism-writer-telegram.service
  Review it: asterism service status writer
  Remove it: asterism service uninstall writer --kind telegram
```

The **destructive-action gate still fires** in a service exactly as it does at the
keyboard: an HTTP run parks at `awaiting_confirmation` until you approve it out of
band, and a chat run asks for a `/confirm` reply. A background service never
loosens that gate. See the [run-as-a-service guide](./service.md) for the full
setup, the boot-start note, and how a service finds the right install.

---

## Reference tables

**Trust levels** — `propose` · `notify` · `autonomous`
([details](./concepts.md#trust-levels)).

**Built-in souls** — `casual-helper` (default) · `careful-consultant`, or a path
to your own Markdown file.

**Memory types** — `semantic` · `procedural` · `convention` · `negative` ·
`episodic` (reflection proposes the first four).

**Event types** — see [the event log](./concepts.md#event-log).

**Environment variables** — model selection (`ASTERISM_MODEL_*`, `ASTERISM_API_KEY`;
see [`config`](#config)) · HTTP token (`ASTERISM_HTTP_TOKEN`; see [`serve`](#serve)) ·
channel tokens and allow-lists (`ASTERISM_TELEGRAM_*`, `ASTERISM_DISCORD_*`; see
[chat channels](./channels.md)) · opt-in recall endpoint
(`ASTERISM_RECALL_EMBED_URL` / `_MODEL` / `_KEY`; see [Tuning recall](#tuning-recall)).
