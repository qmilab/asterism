# Asterism documentation

Run many distinct AI agents from one local install — each with its own soul,
memory, secrets, skills, workspace, event log, and autonomy level. Nothing leaks
between them.

New here? Read in this order:

1. **[Installation](./installation.md)** — install Asterism, initialize a
   workspace, and configure a model.
2. **[Concepts](./concepts.md)** — what an agent is, how souls, roles, trust,
   memory, skills, and secrets fit together, and exactly what "separate" means
   today.
3. **[Command reference](./commands.md)** — every command, option, and its
   output.
4. **[Five-claims walkthrough](./walkthrough.md)** — the canonical demo, with the
   separation and trust guarantees proven end to end.
5. **[Local HTTP endpoint](./http.md)** — serve one agent over HTTP, with the
   same guarantees as the command line.
6. **[Dashboard](./dashboard.md)** — watch and steer every agent in one live
   terminal view.

## Quick links

| I want to… | Go to |
|---|---|
| Get it running | [Installation](./installation.md) |
| Point it at OpenAI / Anthropic / another provider | [Configuring a model](./installation.md#configuring-a-model) |
| Understand trust levels and the destructive-action gate | [Concepts → Trust](./concepts.md#trust-levels) |
| Look up a command | [Command reference](./commands.md) |
| See the separation guarantees proven | [Walkthrough](./walkthrough.md) |
| Call an agent over HTTP | [HTTP endpoint](./http.md) |
| Watch and steer every agent at once | [Dashboard](./dashboard.md) |
| Keep an agent running in the background | [Run as a service](./service.md) |

## About this phase

This documentation covers **Phase 0** — the local-first core. Richer cognition,
agent-to-agent collaboration, and stronger execution isolation come in later
phases; follow along in the repo's
[issues](https://github.com/qmilab/asterism/issues). For the precise scope of
what "separate" guarantees today, see
[Concepts → What isolation means today](./concepts.md#what-isolation-means-today).
