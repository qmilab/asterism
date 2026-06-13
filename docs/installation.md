# Installation

Get Asterism running locally and create your first agent. Everything lives on
your machine — there is no account, no hosted service, and nothing leaves your
computer unless you configure a model that does.

## Prerequisites

- **A JavaScript runtime — [Node](https://nodejs.org) 20 or newer,
  [Bun](https://bun.sh) 1.1.0 or newer, or [Deno](https://deno.com) 2 or newer.**
  The `asterism` command runs on all three; Node 20+ is the floor every install
  can rely on. To install Bun:

  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

- **A model** (optional until you `run` or `reflect`). Creating agents,
  inspecting memory, reading the event log, and serving the read endpoints all
  work with no model configured. You only need one once you want an agent to
  actually do a task. See [Configuring a model](#configuring-a-model).

## Install

You don't have to install anything permanently to try Asterism — every common
package manager can fetch and run it in one step. Pick the tool you already use;
each command below is a tested path.

| Tool | Run Asterism |
|---|---|
| **npm** | `npx @qmilab/asterism init` — or install the command: `npm install --global @qmilab/asterism` |
| **pnpm** | `pnpm add --global @qmilab/asterism` *(then approve the build — see below)* |
| **yarn** | `yarn global add @qmilab/asterism` |
| **Bun** | `bunx --bun @qmilab/asterism init` |
| **Deno** | `deno run -A npm:@qmilab/asterism init` *(add a `deno.json` — see below)* |

After a global install, `asterism --version` should print the version. The rest of
this documentation writes commands as `asterism …`; if you didn't install
globally, prefix them with your runner — `npx @qmilab/asterism new writer`,
`bunx --bun @qmilab/asterism new writer`, or `deno run -A npm:@qmilab/asterism new
writer`.

### Which runtime runs it, and which SQLite it uses

Worth understanding up front, because it's why two of the tools need an extra
step. The published `asterism` binary carries a `node` shebang, so a **bare
`asterism` on your `PATH` always runs under Node** — whichever tool installed it —
and Node's store driver is `better-sqlite3`, a native module. The other two
runtimes you reach explicitly, and each brings its own built-in SQLite:

- **`bunx --bun @qmilab/asterism …`** forces **Bun**, which uses the built-in
  `bun:sqlite`. (Plain `bunx`, like the shebang, looks for Node; pass `--bun` to
  use Bun.)
- **`deno run -A npm:@qmilab/asterism …`** runs under **Deno**, which uses the
  built-in `node:sqlite`.

`bun:sqlite` and `node:sqlite` need no native build and no compiler.
`better-sqlite3` (the Node path) ships prebuilt binaries for common platforms,
fetched by an install script — which npm and yarn run automatically, but **pnpm
and Bun skip dependency build scripts by default**. Whichever runtime opens it,
the on-disk database is the same.

### pnpm: approve the native build

Because a global `asterism` runs under Node, pnpm needs `better-sqlite3`'s build
script — and pnpm does not run a dependency's install scripts unless you approve
them. Until you do, the first command that opens the store fails with a clear
*"could not load better-sqlite3"* message. Approve it once:

```bash
pnpm add --global @qmilab/asterism
pnpm approve-builds --global          # then select better-sqlite3
```

For a project-local install, run `pnpm approve-builds` (no `--global`), or add
`better-sqlite3` to `onlyBuiltDependencies` in your `package.json` and reinstall.
This is a one-time-per-machine step.

### Bun: use `bunx --bun`

`bunx --bun @qmilab/asterism …` is the simplest Bun path — it runs under Bun on
`bun:sqlite`, so there's no native build to approve. For a persistent command,
alias that invocation. (A global `bun add` install would instead leave a bare
`asterism` that runs under **Node**, which then needs `better-sqlite3`'s build —
the same gate as pnpm above — so `bunx --bun` is the cleaner choice.)

### Deno: enable a node_modules directory

Deno runs Asterism on its built-in `node:sqlite`, so it needs **no** native build
and **no** compiler. It does want a `node_modules` directory for the dependency
graph — add a `deno.json` beside where you run, with one line:

```json
{ "nodeModulesDir": "auto" }
```

Then `deno run -A npm:@qmilab/asterism init` works. Deno may print a one-time
notice that it skipped `better-sqlite3`'s build script — that's expected and
harmless: Deno never loads `better-sqlite3` (it can't — its native-addon ABI
isn't exposed to Deno) and uses `node:sqlite` instead. `-A` grants all
permissions; for everything except `run` and `serve` you can narrow it to
`--allow-read --allow-write --allow-env`, and add `--allow-net` for those two so
the agent can reach your model.

To get a shorter command, alias `deno run -A npm:@qmilab/asterism`, or install a
persistent one with `deno install -gAf -n asterism npm:@qmilab/asterism`. Either
way Deno still wants the `deno.json` above (the `node_modules` directory) in the
working directory, so the alias is usually the simpler choice.

## Initialize a workspace

From the directory where you want Asterism to keep its state:

```bash
asterism init
```

This creates a local `.asterism/` home in the current directory and prints where
it went. It is safe to re-run — an existing home is left untouched.

Commands discover this home by walking **up** the directory tree, the same way
`git` finds its repository root. So once a directory is initialized, every
`asterism` command works from it and any subdirectory beneath it.

### Where your data lives

```
.asterism/
  asterism.db        a local database holding every agent's separate store
  agents/
    <name>/          one workspace directory per agent (skills, files)
```

Each agent's memory, secrets, skills, and workspace are kept separate from every
other agent's — see [Concepts](./concepts.md). To remove an install completely,
delete the `.asterism/` directory.

## Configuring a model

`asterism run` and `asterism reflect` need a model. You can set one two ways, and
mix them freely:

- **A saved default** with [`asterism config`](./commands.md#config) — written to
  `.asterism/config.json`, so it persists without exporting anything.
- **Environment variables** — handy for a one-off session or CI, and they
  override the saved default.

### A saved default

```bash
asterism config set gpt-4o                       # install-wide default
asterism config set claude-sonnet-4-6 --provider anthropic
asterism config                                  # show what each agent resolves to
```

You can also give one agent its own model, so different agents run on different
models — without touching the others:

```bash
asterism config set claude-opus-4-8 --provider anthropic --agent work
# or pin it when you create the agent:
asterism new work --model claude-opus-4-8 --provider anthropic
```

The config file holds only **which** model to use — never an API key. Keys stay
in the environment (below).

### Environment variables

| Variable | Purpose |
|---|---|
| `ASTERISM_MODEL_ID` | The model identifier, e.g. `gpt-4o` or `claude-sonnet-4-6`. |
| `ASTERISM_MODEL_PROVIDER` | Provider name. Default: `openai`. Built-in: `openai`, `anthropic`. |
| `ASTERISM_MODEL_BASE_URL` | Override the provider's API base URL (required for providers other than the built-ins). |
| `ASTERISM_MODEL_API` | Override the wire protocol when it differs from the provider default. |

These override the saved default. **Where a model comes from**, most specific
first: an agent's own model → `ASTERISM_MODEL_*` → the saved install default →
built-in provider settings.

### API keys

The key is read from the provider's well-known variable, falling back to a
generic one:

- `openai` → `OPENAI_API_KEY`
- `anthropic` → `ANTHROPIC_API_KEY`
- any other provider → `<PROVIDER>_API_KEY` (e.g. `OPENROUTER_API_KEY`)
- or, for any provider, `ASTERISM_API_KEY`

The API key is infrastructure for talking to your model provider. It is **not**
an agent-scoped credential — those are added per agent with
[`asterism secrets add`](./commands.md#secrets-add) and are never shared.

### Examples

**OpenAI:**

```bash
export ASTERISM_MODEL_ID=gpt-4o
export OPENAI_API_KEY=sk-...
```

**Anthropic:**

```bash
export ASTERISM_MODEL_PROVIDER=anthropic
export ASTERISM_MODEL_ID=claude-sonnet-4-6
export ANTHROPIC_API_KEY=sk-ant-...
```

**An OpenAI-compatible provider** (e.g. OpenRouter) — name the provider, give it
a base URL, and it reads `<PROVIDER>_API_KEY`:

```bash
export ASTERISM_MODEL_PROVIDER=openrouter
export ASTERISM_MODEL_ID=anthropic/claude-sonnet-4-6
export ASTERISM_MODEL_BASE_URL=https://openrouter.ai/api/v1
export OPENROUTER_API_KEY=sk-or-...
```

If no model is configured, `run` and `reflect` print a clear message telling you
how to set one (`asterism config set` or the environment variable), and exit
without doing anything.

## Verify

```bash
asterism init
asterism new helper --role "tries things out"
asterism events tail helper
```

You should see the home initialized, an agent created, and an event log
containing an `agent.created` entry. If you have a model configured, add a real
task:

```bash
asterism run helper "say hello"
```

## Next steps

- [Concepts](./concepts.md) — what an agent is, and how separation works.
- [Command reference](./commands.md) — every command in detail.
- [Five-claims walkthrough](./walkthrough.md) — see the separation guarantees
  proven end to end.
