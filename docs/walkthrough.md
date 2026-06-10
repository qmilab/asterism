# Five-claims walkthrough

Asterism makes five promises about keeping agents separate and keeping you in
control. This page is the canonical demo that proves them, and an honest account
of which you can see by typing commands today versus which are demonstrated by
the automated acceptance test.

The five claims:

1. One agent's memory **never appears** in another's.
2. One agent's secret is **unreadable** from another.
3. A `propose` agent **returns a plan it never runs**; an `autonomous` agent
   **acts**.
4. Even an `autonomous` agent **pauses for confirmation before a destructive
   action** — the gate is independent of trust level.
5. Reflection **proposes** typed memories; nothing is written without your
   approval.

## The demo

```bash
asterism init
asterism new personal --soul casual-helper      --trust autonomous
asterism new work     --soul careful-consultant --trust propose
asterism secrets add work GITHUB_TOKEN

# a skill is just a markdown file you write
echo "# Blog writer: tighten drafts, keep the author's voice" > blog-writer.md
asterism skill   add personal blog-writer.md

# the run and reflect steps need a configured model — see Installation
asterism run personal "update my blog draft and delete the generated files in dist/"
asterism run work     "summarize the client meeting and propose a cleanup of the notes folder"

asterism memory inspect personal
asterism memory inspect work
asterism events tail personal
asterism reflect personal --review
```

Two agents, deliberately different: `personal` is `autonomous` and casual;
`work` is `propose` and careful, and holds a secret the other must never see.

## What you can see from the CLI today, and what the test proves

Three of the five claims are visible directly from a fresh install:

- **Claims 1 and 2** (memory and secret separation) hold structurally — they are
  true the moment you create the agents, with or without a model.
- **Claim 5** (reviewable reflection) runs end to end with a
  [configured model](./installation.md#configuring-a-model).

**Claims 3 and 4 are about an agent's *actions* — the tools it uses.** In
Phase 0 the shipped CLI runs agents with **no external tools registered**, so a
bare `asterism run` returns the model's text and there is no file-deleting tool
for the gate to stop. Tool registration is a deliberate host seam — the trust
profile and the destructive-action gate are fully built and tested; what Phase 0
does not yet ship is a default catalog of real tools behind them.

So claims 3 and 4 are proven by the **acceptance test**, which wires three demo
tools (`edit_files`, `tidy_notes`, `delete_files`) through that same seam and
runs the exact demo above against the real on-disk store. See
[Running the acceptance test](#running-the-acceptance-test).

---

## Claim 1 — separate memory

After `personal` has accepted a memory (via reflection), inspect both:

```console
$ asterism memory inspect personal
Memory for personal (1):

• semantic · accepted · confidence 0.9
  the blog drafts live in ./drafts
  2026-06-10T12:00:00.000Z · from run a1b2c3d4

$ asterism memory inspect work
work has no memories yet.
```

`personal`'s memory exists; `work`'s is empty. There is no store an agent can
reach into for another agent's memory — each query is scoped to one agent. A
cross-agent read is impossible, not merely discouraged.

## Claim 2 — separate secrets

`work` holds `GITHUB_TOKEN`; `personal` holds nothing:

```console
$ asterism events tail work --type credential.added
Activity for work (1):

2026-06-10T12:00:00.000Z  credential.added
  {"key":"GITHUB_TOKEN","valueRef":"…"}
```

The payload records the key and a *reference* to where the value is stored —
never the value itself. The secret never appears — not in the event log, not in
any command's output, and not in the framing of either agent's run. The
secret resolves for its owner and for no one else. `personal` has no way to read
`work`'s `GITHUB_TOKEN`, and `personal` has no credentials of its own.

## Claim 3 — propose plans, autonomous acts

This is where tools matter. With the demo tools wired (as the acceptance test
does):

- **`work` is `propose`.** Its run does not perform the notes cleanup — it
  withholds it as a plan step:

  ```
  [proposed] 'tidy_notes' was not executed (trust level: propose). The intended
  action has been recorded as a plan step for human review.
  ```

  The event log records `action.withheld`; the tool's real work never runs.

- **`personal` is `autonomous`.** Its ordinary edit executes without asking, and
  the event log records `action.executed`.

Same tools, same task shape — the difference is entirely the trust level.

## Claim 4 — the destructive gate fires regardless of trust

`personal` is `autonomous` — the highest trust level — and its task asks it to
**delete** the files in `dist/`. With the demo tools wired (as in Claim 3, and as
the acceptance test does), it still stops:

```console
# acceptance-test scenario — demo tools wired through the host seam
$ asterism run personal "update my blog draft and delete the generated files in dist/"
Run paused: a destructive action needs your confirmation before it can proceed.
```

The edit ran; the deletion did **not**. The run is parked at
`awaiting_confirmation`, and `events tail personal` shows
`action.awaiting_confirmation`. An autonomous agent acted freely right up to the
irreversible step — and there it waited for an explicit yes. That gate is the
same at `notify` and `autonomous`; trust level does not switch it off.

## Claim 5 — reflection proposes, you decide

```console
$ asterism reflect personal --review
Reviewing 2 proposed memories for personal (from run a1b2c3d4).
Nothing is saved unless you accept it.

(1/2) semantic · confidence 0.9
  the blog drafts live in ./drafts
  Keep this memory? [a]ccept / [e]dit / [r]eject (default: reject): a
  ✓ saved

(2/2) procedural · confidence 0.7
  regenerate dist/ before publishing
  Keep this memory? [a]ccept / [e]dit / [r]eject (default: reject): r
  ✗ rejected

Done — 1 saved, 1 rejected.
```

Exactly what you accepted persists — typed, attributed to its source run, and
marked accepted. The rejected proposal leaves no trace; nothing is written
silently. (This is the memory that then makes Claim 1 falsifiable: it exists for
`personal` and is absent from `work`.)

---

## Running the acceptance test

To watch all five claims verified end to end — including the tool-driven claims 3
and 4 — run the test from a clone of the repository:

```bash
git clone https://github.com/qmilab/asterism
cd asterism
bun install
bun test packages/cli/src/acceptance.test.ts
```

The test runs the canonical demo verbatim through the real command surface
against a real on-disk store in a temporary directory. Only the host seams are
faked: the model (a scripted stand-in that drives the scoped tools the way a
model loop would), the reflection model, and the interactive reviewer. The
boundary itself — separation, trust enforcement, the destructive-action gate,
the memory firewall, the event log — is the real thing, end to end.

Each claim is its own assertion in
[`packages/cli/src/acceptance.test.ts`](https://github.com/qmilab/asterism/blob/main/packages/cli/src/acceptance.test.ts).
If a change breaks any of the five, it does not ship.
