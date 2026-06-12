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
```

Change how much an agent may do on its own: `propose`, `notify`, or
`autonomous`. Records an `agent.trust_changed` event.

```console
$ asterism trust writer autonomous
Set writer to autonomous.
```

Remember: `notify` and `autonomous` both act without asking first. Only the
[destructive-action gate](./concepts.md#the-destructive-action-gate) still
pauses them — that gate is independent of trust level.

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
  ✓ executed write_file (write)
<the agent's response>
```

(The arrowed lines and the `Actions` summary are on stderr; only `<the agent's
response>` lands on stdout.)

> **Tools:** the shipped CLI registers a default catalog of workspace-scoped file
> tools — `read_file`, `write_file`, and `delete_file` — behind the trust gate.
> `read_file`/`write_file` are ordinary read/write effects; `delete_file` is
> destructive and pauses for confirmation at every trust level. Each is confined
> to the agent's workspace (Phase 0 logical scoping — see
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
asterism memory inspect <agent>
```

Show everything one agent remembers — what it has accepted, what is still
proposed for review, and where each memory came from. Only ever shows the named
agent's memory.

```console
$ asterism memory inspect writer
Memory for writer (1):

• convention · accepted · confidence 0.86
  This blog uses sentence case in headings.
  2026-06-10T12:00:00.000Z · from run a1b2c3d4
```

An agent with no memories prints `writer has no memories yet.`

---

## `events tail`

```
asterism events tail <agent> [--limit <n>] [--type <type>] [--since <id>]
```

Review what an agent has done — an append-only record of its consequential
actions ([event types](./concepts.md#event-log)). The log holds references
only, never secret values.

| Option | Description |
|---|---|
| `--limit <n>` | Cap the number of events shown. |
| `--type <type>` | Show only events of one type, e.g. `--type action.executed`. |
| `--since <id>` | Page forward — show events after the given event id. |

```console
$ asterism events tail writer --limit 3
Activity for writer (3):

2026-06-10T12:00:00.000Z  agent.created
  {"name":"writer","role":"tightens blog drafts","trustLevel":"notify"}
2026-06-10T12:01:00.000Z  run.started  run=a1b2c3d4
  {"runId":"a1b2c3d4-…","status":"pending"}
2026-06-10T12:01:02.000Z  action.executed  run=a1b2c3d4
  {"capability":"edit_files","effect":"write"}
```

---

## `reflect`

```
asterism reflect <agent> --review
```

Look back over an agent's latest completed run and review the memories it
proposes to keep. Nothing is saved without your approval — for each proposal you
**accept**, **edit**, or **reject**, and anything that looks unsafe to remember
is flagged. `--review` is required; reflection never runs in a silent auto mode.

Requires a [configured model](./installation.md#configuring-a-model) to draft
the proposals. In an interactive terminal each proposal prompts
`[a]ccept / [e]dit / [r]eject`; a non-interactive (piped) session rejects
everything — nothing is written.

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

---

## `config`

```
asterism config
asterism config set <model-id> [--provider <name>] [--base-url <url>] [--api <protocol>] [--agent <name>]
asterism config unset [--agent <name>]
```

Choose the model your agents run on. Set one install-wide default, and give any
single agent its own model when you want it to run on something different. The
settings live in `.asterism/config.json` and hold **only** which model to use —
never an API key (keys stay in the [environment](./installation.md#api-keys)).

| Form | What it does |
|---|---|
| `config` (or `config show`) | Show the saved settings and the model each agent resolves to. |
| `config set <id>` | Set the install-wide default model. |
| `config set <id> --agent <name>` | Pin one agent to its own model. |
| `config unset` | Clear the install default. |
| `config unset --agent <name>` | Clear one agent's override. |

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

API keys are never stored here — set them in the environment (e.g. OPENAI_API_KEY).
```

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
Press Ctrl+C to stop.
```

Without a configured model the read endpoints still work; starting a run is
declined until a model is set. A destructive action has no one at the keyboard to
confirm it, so the run **pauses and waits** rather than running unattended — you
clear it out of band by POSTing to the run's confirm endpoint (or with
[`confirm`](#confirm)). See the [HTTP reference](./http.md) for full
request/response details.

---

## Reference tables

**Trust levels** — `propose` · `notify` · `autonomous`
([details](./concepts.md#trust-levels)).

**Built-in souls** — `casual-helper` (default) · `careful-consultant`, or a path
to your own Markdown file.

**Memory types** — `semantic` · `procedural` · `convention` · `negative` ·
`episodic` (reflection proposes the first four).

**Event types** — see [the event log](./concepts.md#event-log).
