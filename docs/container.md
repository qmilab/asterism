# Run in a container

A container image packages the Asterism runtime so the **same** local runtime runs
anywhere a container runs — your laptop's Docker, a small VPS, any container host.
It is the same single-agent `serve` or [chat channel](./channels.md) process you run
on the command line, just carried somewhere else.

> **This is packaging and portability, not a security boundary.** The runtime's
> [separation guarantees](./concepts.md#what-isolation-means-today) are exactly the
> same inside the container as on the host — no more, no less. The image lets you run
> the same runtime elsewhere; it does **not** add isolation or containment around an
> agent. Confinement of agent code is a [later phase](./concepts.md#what-isolation-means-today),
> in the container as on your machine.

## Use the published image

The released image is published to the GitHub Container Registry and runs **natively on
both `linux/amd64` and `linux/arm64`** — Intel/AMD servers and Apple Silicon Macs alike,
with no `--platform` flag:

```console
$ docker pull ghcr.io/qmilab/asterism        # or :0.3.0 to pin a version
$ docker run --rm ghcr.io/qmilab/asterism --help
```

Tags: `latest`, the exact version (e.g. `0.3.0`), and the minor line (`0.3`). The examples
below use the short local tag `asterism`; substitute `ghcr.io/qmilab/asterism` anywhere to
run the published image instead of building your own.

## Build the image

From a checkout of the repo:

```console
$ docker build -t asterism .
```

That produces a minimal image with the `asterism` CLI as its entrypoint: whatever
you pass after the image name *is* the command line.

```console
$ docker run --rm asterism --help
```

## Where state lives: the `/data` volume

The container itself is **disposable**. Everything an install owns — the SQLite
store, each agent's workspace, the access token — lives under `/data`, which you
mount as a **named volume** so it outlives any single container:

```console
$ docker volume create asterism-data
```

Every command below mounts that volume with `-v asterism-data:/data`. The working
directory inside the container is `/data`, so the runtime puts its `.asterism/` home
there and finds it again on the next run — state survives `docker rm` and upgrades.

## Set it up: init and create an agent

Run these as one-off containers that share the volume. They write to `/data` and
exit:

```console
$ docker run --rm -v asterism-data:/data asterism init
$ docker run --rm -v asterism-data:/data asterism new writer --soul casual-helper --trust notify
```

[Add secrets and skills](./commands.md) the same way — each is a short-lived
container over the same volume:

```console
$ docker run --rm -i -v asterism-data:/data asterism secrets add writer OPENAI_API_KEY
```

A [model](./installation.md#configuring-a-model) is configured the usual way:
either with `docker run … asterism config …` (written to the volume) or by passing
the provider key and model coordinates as environment variables on the serve
container below.

## Serve one agent over HTTP

This is the long-lived container. Three things differ from the one-offs:

```console
$ export ASTERISM_HTTP_TOKEN=$(openssl rand -hex 32)
$ docker run -d --name writer-serve \
    -v asterism-data:/data \
    -e ASTERISM_HTTP_TOKEN \
    -e OPENAI_API_KEY=sk-… \
    -p 4831:4831 \
    asterism serve writer --host 0.0.0.0
```

- **`--host 0.0.0.0`** — the runtime's default binds `127.0.0.1`, which is only the
  loopback *inside* the container and cannot be published. Binding `0.0.0.0` lets the
  published port reach it. (Override the port with `--port`; the default is `4831`,
  matched by `-p 4831:4831`.)
- **`-e ASTERISM_HTTP_TOKEN`** — the [access token](./http.md#authentication) every
  request must carry. Generating it into your shell first (the `export` above) and
  passing the bare `-e ASTERISM_HTTP_TOKEN` forwards that value into the container and
  keeps it in your shell, so the `curl` below sends the same token. **Always inject it
  for an exposed container.** The endpoint is
  [default-deny](./http.md#authentication) and will not serve a request without the
  bearer token. If you omit the variable, the runtime falls back to generating a
  per-agent token and printing it **once** to the container log (`docker logs
  writer-serve`) — fine for a quick local try, but an injected secret is the right
  choice for anything exposed, because it is stable and never depends on what is on
  the volume.
- **`-p 4831:4831`** — publish the port. Reach it with the token:

```console
$ curl -H "Authorization: Bearer $ASTERISM_HTTP_TOKEN" \
    http://localhost:4831/agents/writer/runs
```

## Run a chat channel instead

A [Telegram or Discord channel](./channels.md) is outbound — it dials the chat
platform, so it needs **no** published port, just its bot token, a model key, and
the [allow-list](./channels.md#the-allow-list-is-the-boundary) of channel ids
permitted to drive the agent:

```console
$ docker run -d --name writer-discord \
    -v asterism-data:/data \
    -e ASTERISM_DISCORD_TOKEN=… \
    -e ASTERISM_DISCORD_ALLOW=4035…21 \
    -e OPENAI_API_KEY=sk-… \
    asterism channel discord writer
```

The allow-list is the channel's only access control, so set it. Don't know the id
yet? Start the container **without** `ASTERISM_DISCORD_ALLOW` once — that is
[discovery mode](./channels.md#the-allow-list-is-the-boundary): every message is
refused and the bot replies only with the sender's channel id. Read it from `docker
logs writer-discord`, then re-run with the variable set. (Telegram is identical with
`ASTERISM_TELEGRAM_TOKEN` / `ASTERISM_TELEGRAM_ALLOW`.)

## Environment and volume reference

| Mount / variable | For | Notes |
|---|---|---|
| `-v asterism-data:/data` | every command | The install's state. Use the same volume for setup and for serving so they share one install. |
| `-p 4831:4831` | `serve` (exposed) | Publish the HTTP port; pair with `--host 0.0.0.0`. Not needed for channels. |
| `ASTERISM_HTTP_TOKEN` | `serve` (exposed) | The bearer token requests must carry. Inject it for anything exposed. |
| `ASTERISM_TELEGRAM_TOKEN` | `channel telegram` | The bot token from @BotFather. |
| `ASTERISM_TELEGRAM_ALLOW` | `channel telegram` | Comma-separated chat ids allowed to drive the agent. Empty ⇒ discovery mode. |
| `ASTERISM_DISCORD_TOKEN` | `channel discord` | The bot token from the Discord developer portal. |
| `ASTERISM_DISCORD_ALLOW` | `channel discord` | Comma-separated channel ids allowed to drive the agent. Empty ⇒ discovery mode. |
| *provider key* (e.g. `OPENAI_API_KEY`) | starting runs | Needed to start runs; a `serve` container's read endpoints work without one. |
| `ASTERISM_MODEL_*` / `ASTERISM_API_KEY` | model selection | Choose the model through the [environment](./installation.md#configuring-a-model) instead of `asterism config`. |
| `ASTERISM_RECALL_EMBED_URL` / `_MODEL` / `_KEY` | opt-in recall provider | The local embeddings endpoint, for an agent opted into `local` recall ([`config recall-provider`](./commands.md#tuning-recall)). Optional; unset ⇒ the built-in keyword ranker. `_KEY` only if the endpoint needs a token. |

No secret is ever baked into the image — every credential is injected at run time
with `-e`, exactly as it is sourced from the environment everywhere else in Asterism.

## The destructive-action gate still applies

A container loosens the [trust model](./concepts.md#trust-levels) not one bit. A
destructive action still pauses for explicit confirmation, even for an `autonomous`
agent. With no terminal attached, an HTTP run parks at `awaiting_confirmation` and
waits until you approve it [out of band over HTTP](./http.md); a chat run
asks for a `/confirm` reply. Running in a container does not mean unattended approval.

## Same runtime, same boundaries

The image is a way to run *this* runtime somewhere else, with the same separate
lives it has on your machine: one container serves one agent, it is not a path to
another agent, and it adds no route around the trust gate. It also does not, on its
own, harden the runtime against hostile agent code — that containment is a later
phase. Treat the container as portability, and keep the published endpoint behind its
token.
