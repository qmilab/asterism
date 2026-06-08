# CLAUDE.md — Asterism

Guidance for Claude Code (and any contributor) working in this repo. Read this before writing code.

---

## What Asterism is

A local-first runtime for running **many distinct agents from one install**. Each agent is its own identity with its own soul, role, memory, secrets, skills, working directory (sandbox), and autonomy level — and nothing leaks between them. Agents run alone by default; collaboration, when it comes, is an explicit permissioned connection, never implicit shared state. Phase 0 ships a local CLI + a local HTTP endpoint; richer cognition and collaboration come later (see `ROADMAP.md`).

The codebase has three bands:

- **Kernel** — owns everything that matters for safety and isolation: agent identity, persistence, memory writes, credential issue, tool exposure, trust enforcement, and the event log.
- **Adapter** — the agent execution substrate (Pi) sits *behind an interface*. It receives a tool registry the kernel has already scoped; it never touches credentials or memory directly.
- **Surface** — CLI and HTTP. Thin. They call the kernel; they hold no business logic.

---

## Golden rules (do not violate)

1. **`agentId` on everything.** Every persisted row — memory, skill, credential, run, event — carries an `agentId`. No query is ever issued without it in the filter. The **agent is the isolation boundary**; this single decision keeps later phases from becoming rewrites.
2. **Pi never sees raw capability.** The kernel builds a *pre-scoped* tool registry per run (filtered by agent + trust level + session) and hands that to the adapter. Pi/the adapter must not read credentials, write memory, or expose tools the kernel didn't approve.
3. **Confined by default.** Every agent runs in its own workspace directory with only its scoped tool registry — confinement is the default, not an opt-in. Note this is *logical* scoping in Phase 0, not OS-level containment (see "Phase 0 isolation model" below); don't let copy imply otherwise.
4. **Destructive actions confirm regardless of trust level.** Even an `autonomous` agent must pause for explicit confirmation before an action classified destructive (file deletion, force-push, outbound spend, irreversible external calls) unless that specific capability is explicitly allow-listed for that agent. This "safety through cognition" beat is the product's signature — never quietly remove it.
5. **No shared state across agents, ever.** Memory, secrets, and skills are scoped to one agent. There is no "global" store an agent can reach. Cross-agent reads are a bug, not a feature. Future collaboration happens only through explicit channels (handoff, artifact exchange, curated summaries) — **never** implicit shared memory or credentials.
6. **Replaceable substrate.** Treat Pi as disposable. All Pi-specific code lives in `adapter-pi` behind `RuntimeAdapter`. Nothing outside that package may import Pi.
7. **Public copy stays clean.** README, CLI help text, and any user-facing string sell the *behavioral outcome* ("distinct agents, dialable autonomy, reviewable memory, separate lives"). No internal architecture vocabulary, no roadmap/positioning language, no commercialization language in user-facing text. (Strategy context lives in `CONTEXT_HANDOFF.md`, which is not committed.)

---

## Package layout (Bun workspaces monorepo)

```
asterism/
├── packages/
│   ├── core/            @qmilab/asterism-core      the kernel — entities, persistence, trust, events, interfaces
│   ├── adapter-pi/      @qmilab/asterism-adapter-pi RuntimeAdapter implemented over Pi
│   ├── reflect/         @qmilab/asterism-reflect    default ReflectionProvider (TS + hosted model)
│   ├── server/          @qmilab/asterism-server     thin local HTTP endpoint
│   └── cli/             @qmilab/asterism            the `asterism` CLI (umbrella package; bin: asterism)
├── package.json
├── tsconfig.base.json
└── README.md
```

**Dependency direction:** `cli` and `server` depend on `core`. `core` defines the `RuntimeAdapter` and `ReflectionProvider` interfaces and depends on **neither** Pi nor the reflect implementation. `adapter-pi` and `reflect` depend on `core` and implement its interfaces. The CLI wires concrete implementations into the kernel at startup. Keep the arrows pointing inward.

### `core` — the kernel
Owns: entities & persistence (local SQLite in Phase 0, every row scoped by `agentId`); the `RuntimeAdapter` interface; the `ReflectionProvider` interface; trust enforcement (resolves trust level + the destructive-action rule into the tool registry a run is allowed); the memory firewall (screens any inbound memory write for injection/exfiltration before persistence); the append-only event log.

### `adapter-pi`
Implements `RuntimeAdapter` over Pi. Receives a scoped tool registry + workspace path; runs the agent loop; returns structured run output and a stream of events. **No credential, memory, or unscoped-tool access here.**

### `reflect`
Default `ReflectionProvider`: takes a run transcript, calls a hosted model via API, returns *proposed* typed memory writes with confidence. Pure TypeScript — **no Python, no local ML, no embeddings in Phase 0.** (A Python/local-ML provider is a deferred, opt-in alternative implementation of the same interface — `ROADMAP.md` Phase 2. Do not add it now.)

### `server`
Minimal HTTP over the kernel. Phase 0 endpoints only:
- `POST /agents/:agent/runs` — start a run, body `{ input }`
- `GET  /agents/:agent/runs` — list runs
- `GET  /agents/:agent/events` — read the event log

### `cli`
The `asterism` binary. Commands map 1:1 to kernel operations (below). No logic beyond argument parsing, kernel calls, and formatting.

---

## Data model (Phase 0)

The **agent is the first-class identity and the isolation boundary.** There is no separate Project/tenant entity in v1. A future **Team** groups agents for collaboration — its key is reserved now (`teamId?`), hidden, unused.

| Entity | Key fields |
|---|---|
| **Agent** | `id`, `name`, `role` (one-line responsibility), `soulRef` (name/path of the persona config), `workspaceDir`, `trustLevel` (`propose`\|`notify`\|`autonomous`), `createdAt`, `teamId?` *(reserved, nullable, hidden)*, `ownerPrincipalId?` *(reserved, nullable, hidden)* |
| **Run** | `id`, `agentId`, `input`, `status` (`pending`\|`running`\|`awaiting_confirmation`\|`done`\|`failed`), `startedAt`, `finishedAt?` |
| **Memory** | `id`, `agentId`, `memoryType` (`semantic`\|`procedural`\|`convention`\|`negative`\|`episodic`), `content`, `confidence`, `sourceRunId?`, `status` (`active`\|`archived`), `reviewState` (`proposed`\|`accepted`\|`rejected`), `createdAt` |
| **Skill** | `id`, `agentId`, `name`, `path` (markdown file in the workspace), `createdAt` |
| **Credential** | `id`, `agentId`, `key`, `valueRef` (reference into the local secret store — never the plaintext), `createdAt` |
| **TrustProfile** | resolved from `Agent.trustLevel` + capability allow-list; governs what the scoped tool registry contains and which actions require confirmation |
| **Event** | `id`, `agentId`, `runId?`, `type`, `payload`, `createdAt` *(append-only)* |

**Soul** = a persona config in the `SOUL.md` lineage (tone, values, operating style), referenced by name or path; it seeds how the agent frames itself. **Role** = a one-line responsibility. Both are stored fields that shape the agent's prompt/behavior — no new runtime machinery in v1. Keep `soul` minimal; do not invent a DSL.

Persistence note: scope at the storage layer (an `agentId` column on every table, asserted in every query path). Never rely on application code "remembering" to filter.

---

## Phase 0 isolation model (be precise; do not overclaim)

Phase 0 isolation means **agent-scoped** memory, credentials, skills, workspace paths, trust profiles, event logs, and tool registries — logical separation enforced by the kernel. It is **not** yet a hardened boundary against hostile code. Do **not** describe Phase 0 as microVM, container, or gVisor isolation, and do not imply it safely contains a deliberately adversarial agent. Stronger process / container / microVM execution isolation is a later phase (`ROADMAP.md` Phase 4).

Why this matters: autonomous agents with persistent memory, tools, and credentials are a *framework-level* security problem, not just a model problem. Because our copy leans on the word "boundary," we have to be exact about which boundary exists today — runtime scoping now, hardened containment later. In user-facing text prefer "separate" / "scoped" / "boundary" over "sandboxed" unless the OS-level mechanism is actually present.

---

## Trust model

Three levels, set per agent — a monotonic ramp of autonomy:
- **`propose`** — never executes a side-effecting action; returns a plan/diff for the human to run.
- **`notify`** — **acts automatically inside its sandbox, then surfaces each action prominently for after-the-fact review. It does _not_ ask first** — use `propose` if you want approval before anything happens. CLI help must state this plainly; the name must never be allowed to read as "asks before acting."
- **`autonomous`** — executes freely within its sandbox, recording actions to the event log rather than actively pushing each one at you.

**The override at every level:** any action classified **destructive** requires explicit confirmation unless that specific capability is allow-listed for the agent. Destructive classification is a kernel responsibility, not the adapter's — and it fires identically at `notify` and `autonomous`. This gate is the difference between "an isolated SQLite file" and an agent you can actually trust to act on its own.

**Destructive actions include, at minimum:**
- deleting, overwriting, renaming, or moving user files
- `git reset --hard`, force-push, branch deletion, destructive rebase
- reading or exporting a credential value
- outbound network calls carrying secrets or private content
- running package install scripts or untrusted shell scripts
- irreversible external actions: payment, email send, public post, production deploy

When in doubt, classify as destructive. This must be an explicit, testable classification in the kernel — never a vibe.

---

## Reflection (manual + reviewable in v1)

`asterism reflect <agent> --review` runs the default `ReflectionProvider`:

```
run transcript → reflection prompt (hosted model) → proposed typed memory writes
              → memory firewall screen → present to human → accept / edit / reject
```

v1 constraints: proposals only (nothing persists without approval); types limited to `semantic`/`procedural`/`convention`/`negative`; every proposed write carries `agentId`, `sourceRunId`, `memoryType`, `confidence`, `reviewState=proposed`; no cron, no embeddings, no trajectory export. Those are later phases behind the same interface.

---

## Phase 0 scope

**In:** CLI · `init` · agent create with `--soul` / `--role` / `--trust` · local persistence · scoped memory · scoped markdown skills · scoped credentials · trust profile (`propose`/`notify`/`autonomous` + destructive-action rule) · event log · `RuntimeAdapter` with `PiAdapter` · manual `reflect --review` · local HTTP endpoint.

**Out (do not build in v1):** Teams / memberships / RBAC · agent-to-agent collaboration channels · Telegram / Discord channels · Python or local-ML reflection sidecar · embeddings / RAG · microVM or gVisor isolation tiers · quotas · cron reflection · trajectory export / RL · hosted deployment.

**Milestone:** `bunx @qmilab/asterism init` produces a working, persistent, confined local agent, and the canonical demo (below) passes end-to-end.

---

## CLI surface (Phase 0)

```
asterism init                                       initialize asterism in the current directory
asterism new <agent> [--soul <name|path>]
                     [--role "<text>"] [--trust <level>]   create an agent
asterism trust <agent> <level>                      set propose | notify | autonomous
asterism secrets add <agent> <KEY> [value]          add an agent-scoped credential
asterism skill add <agent> <file.md>                attach an agent-scoped markdown skill
asterism run <agent> "<task>"                        run the agent on a task
asterism memory inspect <agent>                     show the agent's scoped memory
asterism events tail <agent>                         tail the agent's event log
asterism reflect <agent> --review                    propose typed memory writes for review
asterism serve <agent>                               start the local HTTP endpoint
```

---

## Coding standards

- **TypeScript, strict.** `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. No `any` without a written reason.
- **Bun-first, Node-floor.** Develop, test (`bun test`), and build with Bun; Bun is the recommended runtime. Node 20+ is a *tested compatibility floor* — no Bun-only API in `core` without a Node fallback. **First task before depending on Bun anywhere: run the Pi-on-Bun spike** (see `STARTER_PROMPTS.md`) and record the result. Multi-package-manager install is a Phase 1 concern.
- **ESM only.** `verbatimModuleSyntax`. No CommonJS.
- **Secrets never in code or logs.** Credentials live in the local secret store, referenced by `valueRef`. The event log stores references, never values.
- **Adapter boundary is law.** Outside `adapter-pi`, nothing imports Pi. Outside `reflect`, nothing imports a reflection model client.
- **Tests:** every kernel operation that touches isolation (memory scoping, credential scoping, trust enforcement, destructive-action gating) needs a test proving cross-agent access fails.

---

## Canonical demo = the acceptance test

Phase 0 is "done" when this runs clean and proves all five claims:

```bash
asterism init
asterism new personal --soul casual-helper      --trust autonomous
asterism new work     --soul careful-consultant --trust propose
asterism secrets add work GITHUB_TOKEN
asterism skill   add personal blog-writer.md
asterism run personal "update my blog draft and delete the generated files in dist/"
asterism run work     "summarize the client meeting and propose a cleanup of the notes folder"
asterism memory inspect personal
asterism memory inspect work
asterism events tail personal
asterism reflect personal --review
```

It must demonstrate:
1. `personal` memory never appears in `work`'s memory.
2. `work`'s `GITHUB_TOKEN` is unreadable from `personal`.
3. `work` (propose) returns a plan/diff — including a *proposed* notes cleanup it never executes; `personal` (autonomous) acts.
4. The `personal` run **pauses for confirmation before deleting** the generated files, despite being autonomous — the destructive-action gate fires independent of trust level.
5. `reflect --review` proposes typed memories that the human accepts or rejects; nothing is written silently.

If a change breaks any of these five, it doesn't ship.
