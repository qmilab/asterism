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

The destructive-action gate is unchanged at the network edge: confirm and decline are
the two ways to clear a pause, and the grant a confirm makes is bounded to that one
action and recorded on the event log (`run.resumed` / `run.declined`).
