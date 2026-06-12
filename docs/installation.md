# Installation

Get Asterism running locally and create your first agent. Everything lives on
your machine — there is no account, no hosted service, and nothing leaves your
computer unless you configure a model that does.

## Prerequisites

- **A JavaScript runtime — [Node](https://nodejs.org) 20 or newer, or
  [Bun](https://bun.sh) 1.1.0 or newer.** The `asterism` command runs on either;
  Node 20+ is the floor every install can rely on. To install Bun:

  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

- **A model** (optional until you `run` or `reflect`). Creating agents,
  inspecting memory, reading the event log, and serving the read endpoints all
  work with no model configured. You only need one once you want an agent to
  actually do a task. See [Configuring a model](#configuring-a-model).

## Install

The fastest way to try Asterism is without installing anything permanently — use
your runtime's package runner:

```bash
npx @qmilab/asterism init           # Node 20+
bunx --bun @qmilab/asterism init    # Bun
```

That fetches the latest published version and runs it. To get the `asterism`
command on your `PATH`, install it globally with Node:

```bash
npm install --global @qmilab/asterism
asterism --version
```

The rest of this documentation writes commands as `asterism …`. If you prefer not
to install globally, prefix any command with `npx @qmilab/` (or
`bunx --bun @qmilab/`): `npx @qmilab/asterism new writer`.

> **Which runtime runs it.** The published `asterism` binary carries a `node`
> shebang, so a bare `asterism` — and `npx @qmilab/asterism` — runs under Node,
> the floor every install has. Bun runs the same code: `bunx --bun` forces Bun's
> runtime (plain `bunx`, like the shebang, looks for Node on your `PATH`; pass
> `--bun` to use Bun instead). The only thing that differs by runtime is the local
> store: under Bun it uses the built-in `bun:sqlite`; under Node it uses
> `better-sqlite3`, a native module that ships prebuilt binaries for common
> platforms (no compiler needed in the usual case).

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

`asterism run` and `asterism reflect` need a model. Asterism reads its model
configuration from environment variables, so you can point it at any provider
you have a key for.

| Variable | Required | Purpose |
|---|---|---|
| `ASTERISM_MODEL_ID` | **Yes** | The model identifier, e.g. `gpt-4o` or `claude-sonnet-4-6`. |
| `ASTERISM_MODEL_PROVIDER` | No | Provider name. Default: `openai`. Built-in: `openai`, `anthropic`. |
| `ASTERISM_MODEL_BASE_URL` | No | Override the provider's API base URL (required for providers other than the built-ins). |
| `ASTERISM_MODEL_API` | No | Override the wire protocol when it differs from the provider default. |

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
which variable to set, and exit without doing anything.

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
