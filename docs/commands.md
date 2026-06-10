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
```

Create a new agent with its own memory, secrets, skills, and workspace, kept
separate from every other agent.

| Option | Default | Description |
|---|---|---|
| `--soul <name\|path>` | `casual-helper` | The agent's character. A built-in name (`casual-helper`, `careful-consultant`) or a path to your own Markdown file. |
| `--role "<text>"` | *(none)* | One line describing what the agent is responsible for. |
| `--trust <level>` | `propose` | `propose`, `notify`, or `autonomous`. See [trust levels](./concepts.md#trust-levels). |

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
  interactive terminal you are prompted `[y/N]`; a non-interactive (piped) run
  never auto-approves and stays paused.
- **failed** — an error is printed and the command exits `1`.

```console
$ asterism run writer "tighten the intro in posts/launch.md"
<the agent's response>
```

> **Tools:** the shipped CLI registers a default catalog of workspace-scoped file
> tools — `read_file`, `write_file`, and `delete_file` — behind the trust gate.
> `read_file`/`write_file` are ordinary read/write effects; `delete_file` is
> destructive and pauses for confirmation at every trust level. Each is confined
> to the agent's workspace (Phase 0 logical scoping — see
> [what isolation means today](./concepts.md#what-isolation-means-today)). The
> end-to-end behavior is shown in the [walkthrough](./walkthrough.md).

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
  GET  http://127.0.0.1:4831/agents/writer/runs    list runs
  GET  http://127.0.0.1:4831/agents/writer/events  review activity
Press Ctrl+C to stop.
```

Without a configured model the read endpoints still work; starting a run is
declined until a model is set. Over HTTP there is no one to confirm a
destructive action, so a run that would pause is declined rather than run
unattended. See the [HTTP reference](./http.md) for full request/response
details.

---

## Reference tables

**Trust levels** — `propose` · `notify` · `autonomous`
([details](./concepts.md#trust-levels)).

**Built-in souls** — `casual-helper` (default) · `careful-consultant`, or a path
to your own Markdown file.

**Memory types** — `semantic` · `procedural` · `convention` · `negative` ·
`episodic` (reflection proposes the first four).

**Event types** — see [the event log](./concepts.md#event-log).
