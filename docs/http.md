# Local HTTP endpoint

`asterism serve <agent>` offers a single agent over a small local HTTP endpoint,
with exactly the same separation guarantees as the command line. It is a second
front door to one agent — not a way to reach the others.

## Starting it

```bash
asterism serve writer            # binds http://127.0.0.1:4831
asterism serve writer --port 8080
asterism serve writer --host 0.0.0.0 --port 8080   # bind beyond loopback (see security)
```

| Option | Default | Notes |
|---|---|---|
| `--port <n>` | `4831` | 0–65535. Pass `0` for an OS-assigned free port. |
| `--host <addr>` | `127.0.0.1` | Loopback by default — reachable only from this machine. |

The server runs until you press `Ctrl+C`, which shuts it down gracefully
(in-flight requests drain first).

## Authentication

The endpoint is **default-deny**: every request must carry a bearer token, on
loopback as much as anywhere else. A missing, empty, or wrong token is a `401`.
There is no unauthenticated mode — loopback is not private on a shared machine, so
it is defense-in-depth, not the gate.

The token resolves in this order:

1. **`ASTERISM_HTTP_TOKEN`** (environment) — set this to supply your own. It is the
   right choice for an **exposed or unattended** endpoint (a container, a service,
   a VPS), where the secret should be *injected* at runtime and never written to
   disk by Asterism. It is never read from the config file, never a flag, never
   logged.
2. **A saved per-agent token** — when the env var is unset, the **first** `serve`
   generates a strong token, saves it owner-only under your home, and prints it
   **once**. Later serves reuse it silently, so an interactive operator is not made
   to manage an env var every shell. Each agent gets its own token — a server for
   `writer` and one for `work` hold different keys.

Send it on every request:

```bash
export ASTERISM_HTTP_TOKEN=…            # the value serve printed, or your own
curl -s http://127.0.0.1:4831/agents/writer/runs \
  -H "Authorization: Bearer $ASTERISM_HTTP_TOKEN"
```

The token gates the **front door** only. Everything behind it — trust enforcement,
the destructive-action gate, secret scoping, the agent boundary — is unchanged; the
token decides *who may reach the door*, never what happens once through it. The
examples below assume `ASTERISM_HTTP_TOKEN` is exported.

## One agent per server

A running server is **bound to the one agent you named.** The `:agent` segment
in every path must match that name; any other name is a `404`. A process serving
`writer` can never be used to address `work`'s runs or events — the "separate
lives" guarantee holds at the network edge, not only in storage.

## Endpoints

All paths are scoped to the served agent. Responses are JSON.

### `POST /agents/<agent>/runs` — start a run

Request body: a JSON object with a non-empty `input` string.

```bash
curl -s -X POST http://127.0.0.1:4831/agents/writer/runs \
  -H "Authorization: Bearer $ASTERISM_HTTP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"input":"tighten the intro in posts/launch.md"}'
```

On success the run executes and returns `201` with the run resource, its final
status, the agent's output, and a reference-only summary of the actions it took:

```json
{
  "run": { "id": "…", "agentId": "…", "input": "…", "status": "done", "startedAt": "…", "finishedAt": "…" },
  "status": "done",
  "output": "…the agent's response…",
  "actions": [ { "capability": "write_file", "effect": "write", "decision": "executed" } ]
}
```

`status` is one of `done`, `failed`, or `awaiting_confirmation`. Because no one
is at a keyboard to confirm mid-run, a destructive action does **not** execute
over HTTP on the initial request — the run comes back `awaiting_confirmation` and
nothing destructive happened. Clear that pause out of band with the **confirm**
endpoint below. The destructive-action gate fires here exactly as it does on the
command line, at every trust level.

`actions` carries one entry per gate decision — `executed`, `withheld`, or
`paused` — with the capability key and its classified effect. **References only:**
like the event log, it never contains an argument value.

#### Watching a run live (Server-Sent Events)

Send `Accept: text/event-stream` to watch the run as it happens instead of
waiting for the single blob. The response is an SSE stream: an `activity` frame
per lifecycle event, then a terminal `result` frame carrying the same payload the
buffered response returns above.

```bash
curl -N -X POST http://127.0.0.1:4831/agents/writer/runs \
  -H "Authorization: Bearer $ASTERISM_HTTP_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"input":"tighten the intro in posts/launch.md"}'
```

```text
event: activity
data: {"type":"tool_execution_start","payload":{"tool":"write_file"}}

event: result
data: {"run":{…},"status":"done","output":"…","actions":[…]}
```

The run executes identically either way — only the framing differs. A destructive
action still parks the run; the stream simply ends with a `result` frame whose
`status` is `awaiting_confirmation`.

### `POST /agents/<agent>/runs/<run>/confirm` — confirm a paused run

Resume a run that came back `awaiting_confirmation`. This is the out-of-band
counterpart to the command line's [`confirm`](./commands.md#confirm): there is no
one to confirm mid-run over HTTP, so the action waits until you explicitly approve
it with this request. No body is required.

```bash
curl -s -X POST http://127.0.0.1:4831/agents/writer/runs/<run-id>/confirm \
  -H "Authorization: Bearer $ASTERISM_HTTP_TOKEN"
```

On success the run re-enters the loop with **only the action it paused on**
approved, runs to completion, and returns `200` with the same shape the start
endpoint returns — the confirmed action now shows as `executed`:

```json
{
  "run": { "id": "…", "status": "done", "finishedAt": "…", … },
  "status": "done",
  "output": "…",
  "actions": [ { "capability": "delete_files", "effect": "destructive", "decision": "executed" } ]
}
```

The grant is bounded to that action and scoped to this one run; the gate is not
widened into a blanket on the capability. If the resumed run reaches a further
destructive action — a different capability, or the same one aimed at a new target
— it parks again (`awaiting_confirmation`), and you confirm that one in turn. The
resume is recorded on the event log as `run.resumed`, naming the capabilities it
granted.

| Outcome | Code | Meaning |
|---|---|---|
| Resumed | `200` | The run was paused and has now run to a terminal (or re-paused) state. |
| Unknown run | `404` | No such run for this agent. |
| Not paused | `409` | The run exists but is not `awaiting_confirmation` — nothing to confirm. The body carries its current `status`. |
| No model | `503` | A model is needed to resume; none is configured. |

Add `Accept: text/event-stream` to stream the resume live, exactly like the start
endpoint — `activity` frames then a terminal `result`. A run that cannot be resumed
(unknown, or not paused) is reported as an `error` frame instead.

### `GET /agents/<agent>/runs` — list runs

```bash
curl -s http://127.0.0.1:4831/agents/writer/runs \
  -H "Authorization: Bearer $ASTERISM_HTTP_TOKEN"
```

```json
{ "runs": [ { "id": "…", "status": "done", "input": "…", "startedAt": "…" } ] }
```

### `GET /agents/<agent>/events` — read the event log

Supports the same filters as [`events tail`](./commands.md#events-tail), as query
parameters:

| Query param | Description |
|---|---|
| `limit` | Cap the number of events. Must be a non-negative integer. |
| `type` | Filter to one event type, e.g. `?type=action.executed`. |
| `run` | Filter to one run's events. Use a full run id (from `GET …/runs`); it is scoped to this agent, so an unknown or foreign id simply returns `[]`. |
| `since` | Page forward from an event id. |

`run` and `since` take a **full id** here, where the CLI also accepts a short
prefix — an API client already holds the full id from `GET …/runs`. There is no
`--follow` equivalent; for live activity, watch a run with the
[SSE stream](#watching-a-run-live-server-sent-events).

```bash
curl -s 'http://127.0.0.1:4831/agents/writer/events?type=action.executed&limit=10' \
  -H "Authorization: Bearer $ASTERISM_HTTP_TOKEN"
```

```json
{ "events": [ { "id": "…", "type": "action.executed", "payload": { "capability": "…", "effect": "write" } } ] }
```

The event log holds **references only** — you will never find a secret value in
a response.

## Status codes

| Code | When |
|---|---|
| `200` | A successful `GET`, or a streaming `POST` (`Accept: text/event-stream`) — the outcome arrives in the terminal `result` frame. |
| `201` | A run was created and executed (check `status` in the body for the outcome). |
| `400` | Malformed request — body is not JSON, `input` missing/empty, or a bad `limit`. |
| `401` | Missing, empty, or wrong bearer token. Generic body; the gate runs before routing, so it never reveals whether a path or agent exists. |
| `404` | Unknown path, a `:agent` that is not the served agent, or a confirm for an unknown run. |
| `405` | Known path, wrong method (e.g. `DELETE /…/runs`). |
| `409` | A confirm for a run that is not `awaiting_confirmation` — nothing to confirm. |
| `503` | No model is configured, so a run cannot execute or resume. Reads still work. |
| `500` | An unexpected internal error (message is generic — internals never leak to the client). |

## Security notes

- **A bearer token on every request.** The endpoint is default-deny — a missing,
  empty, or wrong token is a `401`, on loopback as much as anywhere else (see
  [Authentication](#authentication)). The comparison is constant-time, and a bad
  token is indistinguishable from a missing one, so the gate leaks nothing — not
  even whether a path or agent exists. For an exposed or unattended endpoint,
  **inject** the token via `ASTERISM_HTTP_TOKEN` rather than relying on the saved
  per-agent file.
- **Loopback by default.** The endpoint binds `127.0.0.1`, reachable only from
  this machine. It will not be exposed to your network unless you explicitly set
  `--host` to a non-loopback address. The token is required either way — loopback
  is defense-in-depth, not the only gate.
- **No TLS here.** The token authenticates the caller but does not encrypt the
  connection. Before binding beyond loopback, put a TLS-terminating (and ideally
  also authenticating) reverse proxy in front of the endpoint.
- **The same boundary as the CLI.** Runs go through the identical path as
  `asterism run`, so trust enforcement, the destructive-action gate, secret
  scoping, and the agent boundary all apply unchanged — the token decides who
  reaches the door, and the HTTP surface adds no way around what is behind it.
