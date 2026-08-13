# Dashboard

`asterism dashboard` is your live terminal console over **every** agent at once. The
things that make Asterism distinct — reviewable memory, dialable autonomy, the
destructive-action gate, visibly separate agents — are easy to miss one command at a
time. The dashboard makes them legible in one view, and lets you act on them:

- the **roster** — every agent, its character, and how much it may do on its own
- **dial autonomy** up or down on the spot
- **approve or decline** an action an agent has paused for your confirmation
- **review proposed memories** — accept, edit, or reject each
- the **activity timeline**, following live

```console
$ asterism dashboard
```

![The Asterism dashboard touring its views: the agent roster with one autonomous agent paused for confirmation, the autonomy (trust) chooser, the memory-review card, and the help overlay.](assets/img/dashboard.gif)

| Key | Action |
|---|---|
| `↑`/`↓`, `j`/`k` | Select an agent |
| `t` | Set the selected agent's autonomy level |
| `c` / `x` | Approve / decline the agent's pending destructive action |
| `m` | Reflect — review proposed memories (`a` accept · `e` edit · `r` reject) |
| `r` | Refresh now · `?` help · `q` quit |

## A thin client, nothing more

The dashboard holds **no behavior of its own**. Every action you take is one request
to a small local console endpoint that spans your agents — the same kernel-backed
surface the command line and [`serve`](./http.md) use. So everything behind it is
unchanged: trust enforcement, the destructive-action gate, the memory firewall, and
the agent boundary all apply exactly as they do on the command line. If the dashboard
can do something, it is because the endpoint can — there is no second path.

It shows many agents, but it never crosses between them. It only ever asks the
endpoint about **one agent at a time**, and each agent's data is scoped to it — so
"separate lives" holds here just as it does in storage. The console is *your* console
over *your own* agents; no agent can reach it, and one agent's memory, runs, or
events never appear in another's view.

Reviewing memory runs reflection on demand, so it needs a [configured
model](./commands.md#config); the roster, trust, approvals, and the timeline all work
without one.

## Watching another machine

By default the dashboard self-hosts its console in-process on a loopback port and
connects to it for you — one command, nothing to manage. To watch a machine's agents
from elsewhere, run the console there with `--headless` (no terminal view) and attach
to it:

```console
# on the host
$ asterism dashboard --headless
Console for all agents at http://127.0.0.1:4832
  …
  Access token (generated, save it — shown only once):
    9f2c…(64 hex chars)…

# on your laptop
$ asterism dashboard http://host:4832 --token 9f2c…
```

## Authentication

The console is **default-deny**, exactly like [`serve`](./http.md#authentication):
every request carries a bearer token, on loopback as much as anywhere else, and a
missing or wrong token is a `401` that reveals nothing — not even which agents exist.

The token resolves the same way, but **install-wide** rather than per-agent:

1. `ASTERISM_HTTP_TOKEN` (environment) — inject this for an exposed or unattended
   console; never written to disk, never logged.
2. otherwise a saved token under the home (`console.token`, owner-only), minted once
   on first use and printed by `--headless`, reused silently after.

Binding `--headless` beyond loopback (`--host`) carries the same caveats as `serve`:
there is no TLS here, so put a TLS-terminating, authenticating proxy in front before
exposing it to a network.

## The console endpoints

All paths sit under `/agents`, are scoped per agent, and return JSON. This is an
operator surface over your own install; it complements the single-agent
[`serve`](./http.md) endpoint rather than replacing it.

| Method & path | What it does |
|---|---|
| `GET /agents` | The roster: each agent's name, role, soul, trust level, last-active time, and pending-confirmation count. |
| `GET /agents/<a>/runs` | The agent's runs, oldest-first. |
| `GET /agents/<a>/events` | The agent's event log — same tail filters as [`serve`](./http.md) (`limit`, `type`, `run`, `since`). |
| `GET /agents/<a>/memory` | The agent's memories (`?reviewState=`, `?type=`). |
| `PUT /agents/<a>/trust` | Set autonomy. Body `{ "level": "propose" \| "notify" \| "autonomous" }`. |
| `POST /agents/<a>/runs/<run>/confirm` | Approve a paused destructive action and let the run finish. |
| `POST /agents/<a>/runs/<run>/decline` | Refuse a paused action; the run ends without it ever running. |
| `POST /agents/<a>/reflect` | Propose reviewable memories from a run (default: the latest with output). Nothing is persisted. Needs a model (`503` otherwise). |
| `POST /agents/<a>/memory` | Persist an accepted (or edited) memory. The memory firewall re-screens — a blocked write is `422` with the findings. |
| `POST /agents/<a>/memory/<id>/accept` | Accept a queued proposal by id (optionally with an edited `content`); the firewall re-screens. Drains the review pile a scheduled [`reflect --propose`](./commands.md#reflect) fills. |
| `POST /agents/<a>/memory/<id>/reject` | Reject a queued proposal by id — it never becomes active. |

The destructive-action gate is unchanged at the network edge: confirm and decline are
the two ways to clear a pause, and the grant a confirm makes is bounded to that one
action and recorded on the event log (`run.resumed` / `run.declined`).

## Collaboration between agents

Everything in [Working together](./collaboration.md) is reachable over the console
endpoint too — opening a channel between two agents, handing over work, and withdrawing
it. (These are endpoints, not keys: the terminal view above does not drive collaboration
yet.) They are the only routes that name two agents, and they are all rooted at the
**asking** agent, matching the command line's `<from> <to>` order.

| Method & path | What it does |
|---|---|
| `GET /agents/<a>/connections` | The channels `<a>` is on, both directions, with each mode and whether it is still open. |
| `POST /agents/<a>/connections` | Open a channel. Body `{ "to": "<agent>", "mode": "handoff" \| "artifact-only" \| "read-summary" \| "shared-brief" }`. |
| `DELETE /agents/<a>/connections/<b>?mode=<mode>` | Withdraw a channel. `mode` is required — it is never guessed. |
| `POST /agents/<a>/connections/<b>/handoff` | Hand `<b>` a task; body `{ "task": "…" }`. Returns `<b>`'s final result. |
| `POST /agents/<a>/connections/<b>/artifact` | Same, but returns only the files `<b>` produced; body `{ "task": "…" }`. |
| `POST /agents/<a>/connections/<b>/summary` | A screened extract of what `<b>` has accepted; body `{ "focus"?: "…" }`. `<b>` runs nothing. |
| `POST /agents/<a>/connections/<b>/fetch` | Copy one handed-over file into `<a>`'s workspace; body `{ "path": "…" }`, then again with `confirm` (below). |
| `PUT /agents/<a>/connections/<b>/brief` | Set the standing context both agents run with; body `{ "content": "…" }`. |
| `DELETE /agents/<a>/connections/<b>/brief` | End that standing context. The channel stays open. |
| `GET /agents/<a>/briefs` | The standing briefs on `<a>`'s channels. |

Three things carry over from the command line unchanged, because they are enforced
before any of this is reached:

- **A mode is always explicit.** It is never defaulted or inferred from the request, so
  a channel opened for one purpose can never be used for another by omission.
- **`fetch` asks twice, and the second request must echo the first's answer.** Because
  no one is at a keyboard, the first request copies nothing: it comes back `409` with the
  plan — the file's size, and whether a file already there would be replaced. Send it
  again with those values in `confirm` and the bytes land:

  ```
  POST { "path": "drafts/market-section.md" }
    → 409 { "path": …, "sizeBytes": 4300, "overwrites": false }
  POST { "path": "drafts/market-section.md", "confirm": { "sizeBytes": 4300, "overwrites": false } }
    → 200
  ```

  `overwrites` is the point: it describes *your own* workspace at that instant, and it
  can change between the two requests. Get it wrong and the fetch is refused with the
  true plan — so nothing can quietly replace a file you did not acknowledge. Nothing is
  parked between the two requests, and no fetch confirmation is ever remembered: each one
  is approved on its own or not at all.
- **Names, not internal ids.** Responses name agents the way you do.

A request over a channel that does not exist, or that exists for a different mode, is
refused with `409` — the same refusal the command line gives, for the same reason.
