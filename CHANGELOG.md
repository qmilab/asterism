# Changelog

All notable changes to Asterism are documented here. Versions follow [SemVer](https://semver.org); all `@qmilab/asterism*` packages are versioned and released together.

## Unreleased

### Added

- **Terminal dashboard (`asterism dashboard`).** A live console over every agent at once — review proposed memories (accept/edit/reject), dial an agent's autonomy, approve or decline an action paused for confirmation, and watch activity stream in. It is a thin client over a new install-wide local console endpoint, so it inherits the same trust enforcement, destructive-action gate, and agent boundary as the CLI; it shows many agents but never crosses between them. Run `--headless` to host the console for a dashboard on another machine to attach to. Completes Phase 1.
- **Decline a paused action.** A destructive action awaiting confirmation can now be **refused**, not only approved — the run ends without it (`asterism dashboard`, and `POST …/runs/<run>/decline` on the console endpoint).

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
