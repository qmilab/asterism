# Changelog

All notable changes to Asterism are documented here. Versions follow [SemVer](https://semver.org); all `@qmilab/asterism*` packages are versioned and released together.

## 0.5.0 — unreleased

> These notes are written and reviewed ahead of the release. Every `@qmilab/asterism*` package is still at `0.4.0`, which remains the latest published version; this heading gets its date when the version bump and the `v0.5.0` tag land.

Agents that can work together — without giving up a single thing that kept them apart. Until now an agent was reachable only by you. This release adds an explicit channel you open by hand between two agents, and lets you choose what that channel is for: hand over a result, hand over files, read what the other agent knows, or share standing context. Only that ever crosses. Alongside it, two ways to draw an agent's boundary more finely: choose which tools it has at all, and let it call exactly one web address with one of its stored credentials — without ever seeing that credential.

### Added

- **Agents that work together, over a channel you open.** `asterism connect <from> <to> --mode <mode>` opens an explicit, one-way channel between two agents; without one they cannot reach each other at all. Four modes, each its own permission — opening one never grants another, and asking over the wrong one is refused:
  - `handoff` — the other agent does the task and hands back only its final result (`asterism handoff`);
  - `artifact-only` — it hands back only a list of the files it produced, not its words and not the contents (`asterism artifact`, then `asterism fetch` to bring one across, which asks you every time);
  - `read-summary` — a short, screened extract of what it has already learned, with no work done and no model needed (`asterism summary`);
  - `shared-brief` — the one channel that carries context *in*: a brief **both** agents then run with (`asterism brief` / `unbrief` / `briefs`).

  What never crosses, whatever the channel: the other agent's memory records, secrets, tools, working notes, and transcript. Work handed over runs as the **receiving** agent — in its workspace, at its autonomy level — so a handoff can never be a way around another agent's limits. See what is open with `asterism connections`, and withdraw a channel with `asterism disconnect`; withdrawing is final, and it also stops files already handed over from being fetched. Every use is recorded on both agents' event logs, as a reference — never the task text or the result.
- **Collaboration from the console.** The same channels, handoffs, briefs and summaries are reachable over the install-wide console the dashboard runs on, so you can drive them from another machine. `fetch` there asks twice and the second request must echo the first's plan, so nothing can quietly replace a file you did not acknowledge.
- **Choose which tools an agent has.** `asterism capabilities show | set | remove | unset` narrows an agent to a subset of the workspace toolkit — for an agent you want kept to less. Every agent starts with the standard toolkit, and staying that way is perfectly ordinary; an agent is already kept to its own workspace and its own autonomy level. This is deliberately *not* the same as trust, and the two do not cascade: taking a tool away leaves any standing grant it earned intact and unused, and giving the tool back makes that grant apply again.
- **Let an agent call one address, with one credential it never sees.** `asterism api add <agent> <name> <https-url> --credential <KEY>` binds one stored credential to one address; the agent gets a tool that calls exactly that and nothing else. Three properties are the point of it: **the agent supplies nothing** (you give the whole address, so nothing the agent wrote leaves your machine), **no call happens without you** — at `notify` and `autonomous` the run pauses and asks, a `propose` agent never calls at all, and this is the one capability that can never *earn* its way out of asking — and **the credential never reaches the agent**, being attached on the way out and stripped from whatever comes back. Addresses must be `https`. Inspect and withdraw with `asterism api list | remove`; removing leaves the credential itself alone.

### Fixed

- **A mistyped option on `connect` silently opened the widest channel.** `asterism connect a b --mdoe artifact-only` opened a **`handoff`** channel — where the other agent's full result crosses — and reported success. An unrecognized option was accepted and swallowed the value after it, leaving `--mode` absent, and an absent `--mode` means `handoff`. `connect`, `disconnect` and `config set` now refuse an option they do not define, naming it, the way `capabilities` and `api` already did. (`config set`'s version of this quietly retuned *every* agent instead of the one named.) Correctly spelled commands are unaffected.
- **Copy that promised a pause `propose` never performs.** In eleven places — `asterism --help`, `asterism run --help`, `asterism fetch --help`, `asterism trust <agent> show`, the dashboard's autonomy chooser, and six documentation pages — Asterism said a destructive action pauses for your confirmation "at every trust level". It does not: at `propose` the action is *withheld* and you get a plan, so nothing is ever asked. The gate does hold at every level, and nothing destructive happens without you either way; but only `notify` and `autonomous` stop to ask. Every one of those now says which.

### Documentation

- **The collaboration features are documented.** A new [Working together](https://qmilab.com/asterism/docs/collaboration/) guide covers what a connection is, all four modes, and a worked two-agent session; the command reference gains all twelve previously undocumented commands; concepts gains connections, per-agent tool exposure, and what an agent can do with a credential; and the console's collaboration endpoints are documented alongside the rest.
- **Every command the documentation shows is now checked against the shipped binary**, along with every internal link. The check found — and this release fixes — a `notes accept` example the binary refuses, a `config` output block missing two sections added since it was written, a `service install` synopsis missing a flag, and several pasted outputs that had drifted from what the binary prints.

### If you embed the kernel

Three changes visible only to code that depends on `@qmilab/asterism-core` directly. The shipped CLI, and every existing install, are unaffected.

- **Breaking: `SqlDriver` gained a required method, `readTransaction`.** A third-party implementation of that interface will no longer compile until it adds one. The type is exported for typing rather than as a documented extension point — `RuntimeAdapter` and `ReflectionProvider` are the supported seams — and every implementation in this repository lives in `packages/core`, so the impact is expected to be nil; it is noted here rather than left to be discovered.
- **A host shipping its own capabilities now needs a per-agent declaration for them.** The default set of tools an agent holds is a named, closed constant rather than "whatever the host handed in", so a capability outside the shipped nine needs an `asterism capabilities set` for each agent that should receive it. The shipped CLI's catalog is pinned equal to that constant by a test, so nothing changes for it.
- **`Capability` gained an optional `gateContext`, and a tool whose schema declares no input properties now has the model's arguments discarded.** Both are additive: no shipped capability sets `gateContext`, and a tool that declares properties is unaffected. But a host shipping a zero-property tool will see its invocation arguments stop appearing in confirmation prompts and audit fingerprints. That is deliberate — it is what stops a model addressing the human at the gate.

### Requirements

- [Bun](https://bun.sh) 1.1+ (recommended), or [Node](https://nodejs.org) 22.19+. Installable with npm, pnpm, yarn, or Bun.

## 0.4.0 — 2026-06-30

Phase 2 — Governed Learning, complete. This close-out release widens the learning loop from what you tell an agent to remember to what it *observes and does* in its own workspace: an agent proposes working notes from what its tools reveal, works with a richer set of workspace-scoped tools, and can keep an opt-in, observe-only record of how it thought through a run — all without loosening the agent boundary, the trust levels, or the destructive-action gate.

### Added

- **An auditable cognition trace — opt-in and observe-only.** Opt a single agent into recording a tool-by-tool trace of its runs — what it reached for and did, in order — and read it back with `asterism trace <agent>`. It is **off by default** and strictly **observe-only**: recording a trace never changes what an agent may do, remember, or reach. Turn it on per agent with `asterism config cognition-provider <agent> lodestar`; by default it records references only, and you can opt in to also capturing the content each tool returned — run through a best-effort scrub first — with `asterism config cognition-capture <agent> content`. This is where Asterism pairs with [Lodestar](https://github.com/qmilab/lodestar), wired in behind the same runtime seam as everything else.
- **A richer set of workspace tools.** An agent's default toolkit grows beyond `read_file` / `write_file` / `delete_file` to add the read-only `list_dir`, `stat`, and `find`, and the writes `append_file`, `mkdir`, and `move`. Each stays scoped to the agent's own workspace, and every write still answers to the destructive-action gate — `move` refuses to overwrite an existing file, and deleting one still pauses for your confirmation, `autonomous` agents included.
- **Working notes an agent proposes from what it observes.** Beyond the notes you set by hand, an agent now *proposes* working notes from what its tools reveal as it works — and, like a proposed memory, such a note is inert until you accept it (`asterism notes accept`, or `notes reject` to discard). A note you write yourself still applies directly; a note the agent proposes waits for your review, is screened the way memory is, stays scoped to that one agent, and is yours to inspect or revert. Cap how many an agent may keep with `asterism config world-fact-cap`.
- **Reflection proposes when an objective looks finished.** Alongside the memories and objectives it already proposes, reflection can now point out that a standing objective *looks done* — purely advisory. Only your `asterism objective done` (or accepting the suggestion in `reflect --review`) actually retires it; an agent never marks its own objective complete.
- **Install-wide defaults for recall and working notes.** Set one default for every agent that doesn't override it: `asterism config recall-budget --default <n>` for how many memories frame a run, and `asterism config world-fact-cap --default <n>` for how many working notes an agent may hold. Precedence is per-agent → install-wide → built-in.

### Hardened

- **Workspace confinement against symlink escape.** The file tools that read, write, append, create, move, and delete now resolve symbolic links before acting, so a symbolic link inside a workspace can no longer carry one of these operations outside it. This tightens the per-agent workspace boundary; as in every phase so far, it remains *logical* scoping — real, tested separation, but not yet containment of deliberately hostile code.

### Documentation

- The documentation home and README move off internal "phase" framing toward what each capability does for you, and the command reference and concepts gain the cognition trace, the richer workspace tools, agent-proposed working notes and their review, objective-completion proposals, and the install-wide `--default` caps.

### Requirements

- [Bun](https://bun.sh) 1.1+ (recommended), or [Node](https://nodejs.org) 20+. Installable with npm, pnpm, yarn, or Bun.

## 0.3.0 — 2026-06-20

Phase 2 — Governed Learning. Each agent gains a learning loop you stay in control of: it recalls the right memories into a run, earns autonomy capability by capability, proposes what to remember for you to ratify, and carries durable objectives and its own working notes — all without loosening the agent boundary, the trust levels, or the destructive-action gate.

### Added

- **Earned trust contracts.** An agent can now *earn* the standing to take one specific destructive capability without pausing — by handling it cleanly, several times, across different targets, with nothing declined or failed in between. Earned standing is always *proposed* for your approval (`asterism trust <agent> --review`), never granted automatically, and is lost the moment something goes wrong. A grant only ever lets that one capability skip the pause; it never weakens the classification, crosses to another capability, or carries to another agent. Inspect, revoke, and tune the earning bar with `asterism trust <agent> show | revoke | threshold`.
- **Structured recall.** Before each run, an agent recalls the *most relevant* of its memories to frame the task, under a per-agent budget, so memory can grow without flooding the run. Cap it per agent with `asterism config recall-budget`.
- **Recall by meaning (opt-in, local).** A single agent can be opted into ranking its memory by meaning using a local, OpenAI-compatible embeddings endpoint you run yourself (for example [Ollama](https://ollama.com)), via `asterism config recall-provider <agent> local`. Strictly opt-in and off by default: the default install pulls no ML and makes no network call for recall, and nothing leaves your machine unless you turn it on and point it at your own endpoint.
- **Reviewed reflection, on your schedule.** Reflection splits into an unattended proposer and a human-drained review: `asterism reflect <agent> --propose` fills a review pile in the background (safe to put on cron, launchd, or a systemd timer), and `asterism reflect <agent> --review` is where you accept, edit, or reject. Nothing is ever accepted on its own, and Asterism still ships no clock — nothing reflects on a schedule unless you wire it up yourself.
- **Reflection proposes standing objectives.** Alongside memories, reflection can now propose a *standing objective* it notices the agent working toward. Like a proposed memory, it is inert until you accept it — a single `reflect --review` goes through both, memories first.
- **Standing objectives.** Give an agent durable, current purpose that frames every run as standing context — what it is working toward, distinct from the lessons it has learned. Manage them with `asterism objective add | list | done | drop`; only active, accepted objectives frame runs.
- **Working notes.** An agent keeps its own running record of the current situation — `subject: value` notes it writes itself as it works and that frame its later runs, superseded in place rather than accumulated. They are framed and shown plainly as the agent's *own unverified notes*, never as fact; they are screened and bounded like memory, scoped to the one agent, non-destructive, and yours to inspect or revert with `asterism notes inspect | set | clear`.

### Documentation

- A getting-started tutorial, a restructured README with grouped documentation navigation, visual assets (an architecture diagram, a dashboard screenshot, the destructive-action gate in action), and accuracy and typography passes — now brought up to Phase 2, with the new `objective` and `notes` commands and the recall, standing-objectives, and working-notes concepts documented.

### Requirements

- [Bun](https://bun.sh) 1.1+ (recommended), or [Node](https://nodejs.org) 20+. Installable with npm, pnpm, yarn, or Bun.

## 0.2.1 — 2026-06-17

### Changed

- **The container image now runs natively on both Intel/AMD and ARM.** `docker pull ghcr.io/qmilab/asterism` (or `:0.2.1`) resolves a `linux/amd64` *and* a `linux/arm64` image, so it runs on Apple Silicon Macs and ARM servers without the `--platform linux/amd64` workaround that 0.2.0 required. No other changes since 0.2.0 — the published packages are otherwise identical.

## 0.2.0 — 2026-06-17

Phase 1 complete. Asterism gains reach and polish — chat channels, a background service, a live dashboard over every agent, broader runtime and package-manager support, and per-agent model choice — without loosening the agent boundary, the trust levels, or the destructive-action gate established in 0.1.0.

### Added

- **Terminal dashboard (`asterism dashboard`).** A live console over every agent at once — review proposed memories (accept/edit/reject), dial an agent's autonomy, approve or decline an action paused for confirmation, and watch activity stream in. It is a thin client over a new install-wide local console endpoint, so it inherits the same trust enforcement, destructive-action gate, and agent boundary as the CLI; it shows many agents but never crosses between them. Run `--headless` to host the console for a dashboard on another machine to attach to.
- **Decline a paused action.** A destructive action awaiting confirmation can now be **refused**, not only approved — the run ends without it (`asterism dashboard`, and `POST …/runs/<run>/decline` on the local endpoint).
- **Reach an agent from Telegram or Discord.** Connect an agent to a Telegram or Discord chat and talk to it there. Each connection is wired to exactly one agent — it reaches that agent and no other — and every message runs through the same trust level and destructive-action gate as any other run.
- **Run an agent as a background service.** Keep an agent running in the background instead of tying it to a single `run` invocation, so the HTTP endpoint and chat channels can reach it on demand.
- **Token-protected HTTP endpoint.** `asterism serve` now mints a bearer token and prints it on startup; requests without it are refused. A process that can see the port can no longer poke an agent without the token.
- **Per-agent model, via a config file.** A new config file lets you choose which model each agent thinks with, so a quick helper and a careful consultant can run on different models under one install.
- **Runs on Node and Deno, not just Bun.** The CLI and HTTP endpoint run on Node 20+ and Deno as well as Bun, and install under npm, pnpm, yarn, or Bun — Bun stays the recommended runtime.
- **Live run activity and action summaries.** Watch a run's activity as it happens, and get a summary of the actions it took once it finishes.
- **Resume a paused run out of band.** Approve or decline a confirmation-paused action from a separate command or HTTP call — you no longer have to hold the original run in the foreground. A paused run resumes at most once, so a stray second approval can't double-apply it.
- **Richer memory and events views.** Filter `memory inspect` and `events tail` by what you're looking for, and follow the event log live as new entries land.
- **Read-views: `asterism list` and `asterism runs`.** `asterism list` shows every agent at a glance; `asterism runs <agent>` lists that agent's run history.
- **Tools that work out of the box.** `asterism run` now ships with a default set of tools, so the trust level and destructive-action pause fire on a real run without extra wiring.
- **Container image.** Asterism is published as a container image, so you can run it without setting up a local toolchain.

### Fixed

- **A confirmed destructive action now resumes** instead of being stranded in the paused state after you approve it.

### Documentation

- A full documentation set and a project site at [qmilab.com/asterism](https://qmilab.com/asterism), including the five-claims walkthrough and a precise account of what "separate" means in this phase — logical scoping today, hardened containment later.

### Maintenance

- **Release automation.** Pushing a version tag now publishes every package and the container image and cuts the GitHub Release, after checking the tag matches the committed versions so a forgotten bump fails fast instead of mis-publishing.

### Requirements

- [Bun](https://bun.sh) 1.1+ (recommended), or [Node](https://nodejs.org) 20+. Installable with npm, pnpm, yarn, or Bun.

## 0.1.0 — 2026-06-10

First public release: Phase 0 complete, with the canonical demo running as an automated acceptance test on every change.

### Added

- **`asterism` CLI** — `init`, `new` (with `--soul`, `--role`, `--trust`), `trust`, `secrets add`, `skill add`, `run`, `memory inspect`, `events tail`, `reflect --review`, `serve`.
- **Distinct agents from one install.** Each agent has its own soul, role, memory, secrets, skills, workspace directory, event log, and autonomy level. Everything an agent owns is scoped to that agent; nothing is shared between agents.
- **Dialable autonomy.** Three trust levels per agent — `propose` (plans only, never acts), `notify` (acts, then surfaces every action for after-the-fact review), `autonomous` (acts freely inside its workspace, logging everything).
- **Destructive-action gate.** Deleting files, force-pushes, credential reads, outbound spend, and other irreversible actions pause for explicit confirmation at *every* trust level, unless that capability is explicitly allow-listed for the agent.
- **Reviewable learning.** `reflect --review` proposes typed memories (semantic, procedural, convention, negative) from run transcripts; nothing is written without approval, and every inbound memory write is screened before persistence.
- **Local HTTP endpoint.** `asterism serve` exposes start-run, list-runs, and event-log reads on `localhost`.
- **Local persistence.** SQLite on disk; append-only per-agent event log.
- **Acceptance test.** The canonical two-agent demo (memory separation, secret separation, propose-vs-autonomous behavior, the destructive-action pause, reviewable reflection) runs as an automated test suite.

### Requirements

- [Bun](https://bun.sh) 1.1+
