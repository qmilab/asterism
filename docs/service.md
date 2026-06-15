# Run an agent as a service

`asterism serve` and the [chat channels](./channels.md) run an agent in the
foreground until you press `Ctrl+C`. To keep one running unattended — surviving a
logout or reboot, and restarting if it stops — install it as a background service
your operating system supervises.

`asterism service` does that by wrapping the service manager already on your
machine: **launchd** on macOS, a **systemd user service** on Linux. It writes the
service definition, registers it, and starts it. There is no daemon of our own to
trust and nothing new to keep patched — the OS does the supervising.

A service is the same agent, with the **same separate lives** as the command line.
It runs one long-lived command for one agent; it is not a way to reach another
agent, and it adds no path around the trust gate.

## What a service runs

Each service supervises exactly one long-lived command, chosen with `--kind`:

| `--kind` | Runs | Reaches the agent over |
|---|---|---|
| `serve` *(default)* | [`asterism serve`](./http.md) | a local HTTP endpoint |
| `telegram` | [`asterism channel telegram`](./channels.md) | a Telegram chat |
| `discord` | [`asterism channel discord`](./channels.md) | a Discord channel |

One agent can have more than one service — say a `serve` endpoint and a `telegram`
channel — because each kind is its own service. Each is named for its agent and
kind (`writer (serve)`, `writer (telegram)`), so they install, report, and uninstall
independently.

## Install it

```console
$ asterism service install writer
Installed service "writer (serve)".
  Keeps `asterism serve writer` running and restarts it if it fails.
  ...
  Review it: asterism service status writer
  Remove it: asterism service uninstall writer
```

`install` writes the service files, registers the service so it runs **now and at
login**, and prints exactly what to do next. Re-running `install` replaces the
definition (handy after an upgrade) and keeps the settings file you have edited.

Pass options to the supervised command after `--`. A `serve` service needs a port
of its own if you run more than one; a channel carries its allow-list:

```console
$ asterism service install writer -- --port 8080
$ asterism service install writer --kind telegram -- --allow 12345
```

## Give it its secrets

A background service can't read the secrets you exported in your shell — it starts
from a clean environment. So `install` creates a **private environment file** for
the service (readable only by you, mode `0600`) that *names* what it needs, with no
values:

```bash
# ~/.config/asterism/services/writer.telegram/service.env
# Required — your Telegram bot token (from @BotFather).
# ASTERISM_TELEGRAM_TOKEN=
# Required — your model API key — every chat message is a task, so a channel needs one.
# OPENAI_API_KEY=
```

Fill in the values, uncomment the lines, and restart the service the way `install`
told you. **Nothing secret is ever written for you**, and the file is the same idea
as everywhere else in Asterism: a credential lives where you put it, not baked into
a definition that could be shared or committed. Until the file is filled in, the
service keeps restarting and `status` shows it as not running.

If you have **already exported** those variables in your shell, skip the hand-copy:

```console
$ asterism service install writer --kind telegram --capture-env
```

`--capture-env` writes the values currently set in your environment into the same
`0600` file. It is the one case where `install` writes a secret to disk, and only
because you asked for it; each use overwrites the file, and any variable you haven't
set is left as a commented placeholder.

If you choose your model through the environment (`ASTERISM_MODEL_*`) or keep one
`ASTERISM_API_KEY` across providers rather than using
[`asterism config`](./commands.md#config), those variables are named in the file too
— and `--capture-env` copies them — so the service resolves its model exactly the way
your shell does. (Whatever you set with `asterism config` is read from disk and needs
nothing here.)

A `serve` service needs only your model API key, and only to *start runs* — its read
endpoints work without one. A channel needs both the API key and its chat token,
because every message is a task.

## Check on it

```console
$ asterism service status writer
writer (serve) — running (pid 51324)
  env:  ~/.config/asterism/services/writer.serve/service.env
  log:  ~/.config/asterism/services/writer.serve/service.log
```

With no `--kind`, `status` reports every kind installed for the agent. On macOS the
service's output goes to the log file shown; on Linux it goes to the journal
(`journalctl --user -u asterism-writer-serve.service`).

## Remove it

```console
$ asterism service uninstall writer
Removed service "writer (serve)".
  Left its env file in place (it may hold secrets): ~/.config/asterism/services/writer.serve/service.env
```

Uninstall stops the service and removes its definition, but **leaves the settings
file** — it may hold secrets you filled in, so deleting it is your call. Use
`--kind` to remove just one kind; with none, every installed kind for the agent is
removed.

## The destructive-action gate still applies

A service does not loosen the [trust model](./concepts.md#trust-levels) one bit. A
destructive action still pauses for your explicit confirmation, exactly as it does
at the keyboard — even for an `autonomous` agent. With no one watching, an HTTP run
parks at `awaiting_confirmation` and waits until you approve it
[out of band](./http.md#confirm-a-paused-run); a chat run asks in the chat for a
`/confirm` reply. Always-on does not mean unattended approval.

## Boot start and finding the right install

A few practical notes:

- **Start before you log in (Linux).** A systemd *user* service starts at login by
  default. To have it start at boot before anyone logs in, enable lingering once:
  `loginctl enable-linger`.
- **The service is tied to this install.** It runs from the directory that holds
  your `.asterism/` workspace and launches Asterism by absolute path. If you
  installed Asterism only as a throwaway (a one-off `npx`/`bunx` run), `install`
  warns you: the service would break once that cache is cleared. Install Asterism
  durably — globally or in the project — before relying on a service.

## Platform support

`asterism service` is supported on **macOS** (launchd) and **Linux** (systemd user
services). On any other platform it declines, and you can still run `serve` or a
channel in the foreground, or supervise it with whatever process manager you prefer.
