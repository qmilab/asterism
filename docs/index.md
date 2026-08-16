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

- **[Working together](./collaboration.md)** — open a channel between two agents,
  choose what it is for, and withdraw it.
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
- **[Threat model](./threat-model.md)** — what the runtime enforces and by what
  mechanism, each claim carrying the test that proves it — and, just as plainly,
  what today's boundary does not contain.

## Quick links

| I want to… | Go to |
|---|---|
| Get it running | [Installation](./installation.md) |
| Follow a guided first run | [Tutorial](./getting-started.md) |
| Point it at a model — hosted, or one on your own machine with no key | [Models and providers](./models.md) |
| Understand trust levels and the destructive-action gate | [Concepts → Trust](./concepts.md#trust-levels) |
| Have two agents work together | [Working together](./collaboration.md) |
| Let an agent call an API with a stored credential | [Command reference → `api`](./commands.md#api) |
| Choose which tools an agent has | [Command reference → `capabilities`](./commands.md#capabilities) |
| Look up a command | [Command reference](./commands.md) |
| See the separation guarantees proven | [Walkthrough](./walkthrough.md) |
| Know exactly what is enforced — and what is not | [Threat model](./threat-model.md) |
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

Agents can also **work together** without giving up any of that: you open a
channel between two of them by hand, choose what it is for, and only that ever
crosses — see [Working together](./collaboration.md).

Stronger execution isolation is still ahead; follow along in the repo's
[issues](https://github.com/qmilab/asterism/issues). For the precise scope of what
"separate" guarantees today, see
[Concepts → What isolation means today](./concepts.md#what-isolation-means-today).
