<div align="center">

# Asterism

**Many agents. One runtime. Separate lives.**

Run separate AI agents for work, clients, side projects, and experiments from one local install — each with its own **soul, memory, secrets, skills, workspace, event log, and autonomy level**. Agents run alone by default. When they collaborate, they do it through explicit connections — never shared memory or shared credentials.

`@qmilab/asterism` · Apache-2.0

</div>

---

## Why

Tools like OpenClaw and Hermes are powerful, but they're naturally centered on **one** long-lived agent identity at a time. The moment you want several distinct agents, you end up duplicating runtimes, configs, workspaces — sometimes whole VMs — just to keep their memory, secrets, and credentials apart. You're doing systems administration instead of building.

Asterism makes a distinct agent a first-class thing you create in one command. Each agent is its own body — its own soul, memory, secrets, workspace, and autonomy — and nothing crosses between them unless you say so. A soul is nothing exotic: a small persona file defining an agent's voice, values, and operating style.

The name is the idea. The stars in an asterism aren't bound to each other; they can sit light-years apart and only form a pattern from where you're standing. That's the model: agents that are genuinely separate, organized and navigated as one grouping from a single runtime.

Unlike multi-agent *orchestration* frameworks — which coordinate agents to finish a task and share context freely — Asterism starts with **identity and boundaries**. Collaboration is a later, explicit, permissioned connection, not the default and never implicit shared state.

## Quickstart

```bash
bunx @qmilab/asterism init

# create two agents with distinct souls and autonomy
asterism new writer  --soul calm-editor       --trust autonomous
asterism new client  --soul careful-consultant --trust propose

# scoped secrets and skills — never shared across agents
asterism secrets add client GITHUB_TOKEN
asterism skill   add writer blog-style.md

# run them
asterism run writer "tighten the draft in posts/launch.md"
asterism run client "summarize the meeting and tidy the notes folder"

# inspect what each one knows and did
asterism memory inspect writer
asterism events tail client
```

What you'll see: `writer`'s memory never appears in `client`, `client`'s `GITHUB_TOKEN` can't be read from `writer`, the `client` agent *proposes* while `writer` *acts* — and even an autonomous agent **pauses for confirmation before anything destructive**.

## Continuous, reviewable learning

```bash
asterism reflect writer --review
```

```
Proposed memory writes:
  [convention] This blog uses sentence case in headings.   confidence 0.86
  [procedural] Run a spell pass before saving.             confidence 0.78
  [negative]   Don't rewrite quotes inside blockquotes.    confidence 0.91
Accept? edit? reject?
```

Each agent grows with use — but on its own track, inside its own boundary. Every memory it forms is **typed, scoped to that agent, and yours to approve**; nothing is written silently. Continuity, but plural: many agents growing separately, not one assistant growing around you.

## Pairs with Lodestar

A lodestar is the single star you steer by. An asterism is the grouping you navigate within. Asterism runs your agents and keeps them apart; [Lodestar](https://github.com/qmilab/lodestar) is the layer that makes each one trustworthy — what it knows, believes, and is allowed to do.

## Status

Phase 0 (Core) — in active development. Local CLI + HTTP, per-agent scoping (memory, secrets, skills, workspace), souls and roles, trust profiles, reviewable memory. Richer cognition, collaboration, and stronger execution isolation come in later phases.

## License

Apache-2.0 © QMI Lab
