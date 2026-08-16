# Decisions

Architecture decision records — one file per decision, numbered, append-only.

These are **engineering records, not documentation.** They are tracked in git so
they can be reviewed in a pull request like any other change, and they are
deliberately *not* part of the published docs site: they use internal
architecture vocabulary, and several of them describe work that is decided but
not built. Public pages describe what Asterism does today; that is a different
job, and mixing the two is how a design note becomes an accidental promise.

`mkdocs.yml` builds from `docs/` only, so nothing here is ever published.

## Convention

- `NNNN-short-title.md`, numbered in the order decided.
- Front matter states **status** (`proposed` / `accepted` / `superseded`), the
  **date**, and the **commit it was decided against** — a decision is only
  meaningful relative to the tree that motivated it.
- A superseded record is never edited or deleted. It gains a
  `Superseded by: NNNN` line and stays.
- If a record rests on measurement, the harness lives beside it as
  `NNNN-short-title.bench.mjs` so the numbers can be reproduced or falsified
  rather than believed. These are evidence, not gates: nothing here runs in CI.

## Index

| # | Decision | Status |
|---|---|---|
| [0001](0001-execution-isolation.md) | Where OS-level execution isolation belongs | accepted |
