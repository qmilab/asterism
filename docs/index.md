# Asterism documentation

Run many distinct AI agents from one local install — each with its own soul,
memory, secrets, skills, workspace, event log, and autonomy level.

**Nothing leaks between them.**

**New here? Start with the [getting-started tutorial](./getting-started.md)** — a
~15-minute walk from install to a working agent that writes a file, pauses before
deleting one, and remembers what you approve.

## Getting started

- **[Installation](./installation.md)** — install Asterism on Node, Bun, or Deno,
  initialize a workspace, and configure a model.
- **[Tutorial](./getting-started.md)** — the gentle, end-to-end on-ramp: create an
  agent, run it, watch the destructive-action gate fire, and approve a memory.
- **[Concepts](./concepts.md)** — agents, souls, roles, trust, memory and recall,
  skills, secrets, standing objectives, and working notes — and exactly what
  "separate" means today.

## Guides

- **[Dashboard](./dashboard.md)** — watch and steer every agent in one live
  terminal view.
- **[Chat channels](./channels.md)** — reach one agent from a Telegram or Discord
  chat.
- **[Run as a service](./service.md)** — keep an agent running in the background,
  started by your OS.
- **[Run in a container](./container.md)** — package the same runtime to run on any
  container host.
- **[Local HTTP endpoint](./http.md)** — serve one agent over HTTP, with the same
  guarantees as the command line.

## Reference

- **[Command reference](./commands.md)** — every command, option, and its output.

## Deep dive

- **[Five-claims walkthrough](./walkthrough.md)** — the canonical demo, with the
  separation and trust guarantees proven end to end. The skeptic's version of the
  tutorial.

## Quick links

| I want to… | Go to |
|---|---|
| Get it running | [Installation](./installation.md) |
| Follow a guided first run | [Tutorial](./getting-started.md) |
| Point it at OpenAI / Anthropic / another provider | [Configuring a model](./installation.md#configuring-a-model) |
| Understand trust levels and the destructive-action gate | [Concepts → Trust](./concepts.md#trust-levels) |
| Look up a command | [Command reference](./commands.md) |
| See the separation guarantees proven | [Walkthrough](./walkthrough.md) |
| Call an agent over HTTP | [HTTP endpoint](./http.md) |
| Watch and steer every agent at once | [Dashboard](./dashboard.md) |
| Keep an agent running in the background | [Run as a service](./service.md) |

## What Asterism does today

Asterism runs distinct agents from one local install — each with its own memory,
secrets, skills, workspace, and autonomy, with a destructive-action gate that holds
at every trust level. On top of that core it adds **governed learning** — how an
agent improves with you in control: structured [recall](./concepts.md#recall),
earned [per-capability trust](./concepts.md#earned-autonomy), reviewed
[reflection](./concepts.md#reflection) you can put on a schedule, standing
[objectives](./concepts.md#standing-objectives), and the agent's own
[working notes](./concepts.md#working-notes). You can drive an agent from the live
dashboard, a Telegram or Discord chat, an HTTP endpoint, or a background service,
and run the whole thing in a container.

Agent-to-agent collaboration and stronger execution isolation are still ahead;
follow along in the repo's [issues](https://github.com/qmilab/asterism/issues). For
the precise scope of what "separate" guarantees today, see
[Concepts → What isolation means today](./concepts.md#what-isolation-means-today).
