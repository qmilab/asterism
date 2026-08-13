# Working together

Agents are separate by default and cannot reach each other at all. When you want two
of them to work together, you open a **channel** between them by hand — and choose
what that channel is for. Only that ever crosses.

Nothing else changes. Each agent still works in its own space, at its own autonomy
level, with its own memory, secrets and skills. A channel does not merge two agents;
it carries one specific kind of thing between them, and you can withdraw it.

## What a connection is

Three properties do most of the work, and they are worth having straight before you
open one.

**It is one-way.** `connect writer researcher` lets `writer` hand work to
`researcher`. It does not let `researcher` hand work back. If you want that too, open
the reverse connection.

**It is for one thing.** A channel opened to hand over *results* is not a channel to
read what the other agent *knows*. Each mode is its own permission, so opening one
never quietly grants another — and asking over the wrong one is refused, even between
two agents you have already connected.

**Withdrawing it is final.** `disconnect` closes a channel for good. Connecting the
two agents again opens a *new* channel; it does not restore the old one, and anything
handed over on the old one stays out of reach.

## The five modes

A mode answers one question: *how much of the other agent comes back?*

| Mode | What crosses | The command that uses it |
|---|---|---|
| `handoff` | its final answer, and nothing behind it | [`asterism handoff`](#handoff-hand-over-a-task) |
| `artifact-only` | a list of the files it made — not its words, not the contents | [`asterism artifact`](#artifact-only-get-the-files-not-the-words) |
| `read-summary` | a short, screened extract of what it has learned | [`asterism summary`](#read-summary-read-what-it-knows) |
| `shared-brief` | nothing comes back — this one carries context **in** | [`asterism brief`](#shared-brief-context-both-agents-run-with) |
| `delegated-tool` | the answer from one tool it owns, run by it, credentials and all | [`asterism call`](#delegated-tool-borrow-one-tool-not-the-credential) |

Whatever the mode, these never cross: the other agent's **memory records**, its
**secrets**, its **tools**, its **working notes**, and its **transcript** — how it got
to the answer. You get the thing the mode names, and nothing behind it.

## A walkthrough

Two agents: `writer`, which drafts, and `researcher`, which digs through source
material. Every command below runs, and every response is what asterism prints — only
the agents' own words, which come from whichever model you configure, will differ.

```console
$ asterism new writer --soul casual-helper --role "drafts and tightens blog posts" --trust autonomous
Created agent "writer" (autonomous) — soul: casual-helper
  role: drafts and tightens blog posts
  workspace: /Users/you/work/.asterism/agents/writer

$ asterism new researcher --soul careful-consultant --role "digs through source material" --trust notify
Created agent "researcher" (notify) — soul: careful-consultant
  role: digs through source material
  workspace: /Users/you/work/.asterism/agents/researcher
```

Note the two different autonomy levels. They stay that way — that matters below.

### `handoff` — hand over a task

Right now these two agents have no path between them at all, so there is nothing to
refuse:

```console
$ asterism handoff writer researcher "summarize the Q3 deck"
No active handoff connection from writer to researcher. Open one first: asterism connect writer researcher --mode handoff
```

Open the channel, then use it:

```console
$ asterism connect writer researcher --mode handoff
Connected writer → researcher (handoff). Use it with: asterism handoff writer researcher "<task>"

$ asterism handoff writer researcher "summarize what the Q3 deck says about pricing"
The deck holds enterprise pricing flat and moves the team tier up 12%.
```

`researcher` did that work **as itself** — in its own workspace, framed by its own
memory and skills, at its own autonomy level. What came back is its final answer.
`writer` did not see its memory, its files, or how it got there.

That last point is the one worth being precise about, because it is the obvious thing
to worry about: **a handoff is not a way around another agent's limits.** The work
runs under the *receiving* agent's autonomy, so if the task needs a destructive
action, it stops and asks according to `researcher`'s level — no matter how much
autonomy `writer` has. Confirm it on the agent that paused:

```
asterism confirm researcher <run>
```

### `artifact-only` — get the files, not the words

Sometimes you want the thing an agent made, not its account of making it.

```console
$ asterism connect writer researcher --mode artifact-only
Connected writer → researcher (artifact-only). Use it with: asterism artifact writer researcher "<task>"

$ asterism artifact writer researcher "draft the market section"
Actions (1 executed):
  ✓ executed fs.write (write)
researcher produced 1 artifact:
  drafts/market-section.md   55 B

Only these references crossed — not researcher's words, memory, or the file contents.
The files are in researcher's own workspace.
```

You get each file's path and size. You do **not** get the contents — the files sit in
`researcher`'s own workspace, on your machine, where you can read them yourself.

To bring one across into `writer`'s workspace, fetch it. This writes into the asking
agent's space, so nothing is copied without you: at `notify` and `autonomous` it asks
before every single fetch, and a `propose` agent copies nothing at all. Unlike other
destructive actions, this one can never be earned away.

```console
$ asterism fetch writer researcher drafts/market-section.md
Fetching 'drafts/market-section.md' from researcher into writer's workspace.
Fetched 'drafts/market-section.md' from researcher into writer's workspace (55 B).
```

Only a file the other agent actually handed over can be fetched. A path it never
produced is refused whatever is on disk — this brings across what you were shown, it
is not a way to read another agent's files.

### `read-summary` — read what it knows

This is the one mode where the other agent does **no work at all**. Nothing runs, no
model is called, and it works with no model configured. It reads what that agent has
already learned.

The two channels open so far do not authorize it. This is what "each mode is its own
permission" looks like in practice — same two agents, already connected twice, still
refused:

```console
$ asterism summary writer researcher "pricing"
No active read-summary connection from writer to researcher. Open one first: asterism connect writer researcher --mode read-summary
```

```console
$ asterism connect writer researcher --mode read-summary
Connected writer → researcher (read-summary). Use it with: asterism summary writer researcher ["<focus>"]

$ asterism summary writer researcher
researcher knows 3 of 3 ratified notes:

  semantic    Enterprise buyers weigh seat price over total contract value.
  semantic    The Q3 deck prices the team tier 12% above Q2.
  convention  Draft sections in Markdown, never HTML.

Only this extract crossed — not researcher's memory records, its runs, or anything it has not accepted.
```

Add a focus in quotes to ask about one subject:

```console
$ asterism summary writer researcher "pricing"
```

**Only what you have accepted can cross.** A memory still waiting for your review, one
you rejected, and anything archived all stay where they are — at any size of extract.
What comes back is the knowledge itself, never the underlying records, when they were
learned, which run produced them, or how sure the agent is.

Anything that looks like a password or key is removed before it crosses, and a note
whose wording could be an attempt to steer the reading agent is held back whole. The
extract says how many notes were held back and how many did not fit; ask again with a
focus to reach those.

### `shared-brief` — context both agents run with

Every other mode hands something back. This one carries something **in**.

```console
$ asterism connect writer researcher --mode shared-brief
Connected writer → researcher (shared-brief). Use it with: asterism brief writer researcher "<brief>"

$ asterism brief writer researcher "Q3 launch: enterprise buyers, ship by Friday"
Briefed writer → researcher.
Both agents now run with it as standing context, until: asterism unbrief writer researcher
```

From then on **both** agents run with that brief in front of them — not just the one
it was written to, and not only when they work together. It shapes their ordinary runs
too, until you replace it, end it, or withdraw the channel. That is what makes it
standing context rather than a longer way of writing a task.

Each agent sees the brief clearly marked as coming from the channel, not as its own
purpose, so neither is fooled into treating another agent's words as its own. What you
write is screened first: wording that reads as an attempt to steer or manipulate the
other agent is refused outright — nothing is saved and nothing crosses.

An agent has one brief per channel; writing a new one replaces it. See what an agent
is running with:

```console
$ asterism briefs writer
Briefs for writer (1):

• → researcher · 1e572c21  (framing every run of both agents)
  Q3 launch: enterprise buyers, ship by Friday

A brief frames BOTH agents' runs while it is live — the arrow shows whose channel carries it.
```

End the brief but keep the channel:

```console
$ asterism unbrief writer researcher
Ended the brief on writer → researcher. Neither agent sees it from their next run.
The channel is still open — set a new brief with: asterism brief writer researcher "<brief>"
```

### `delegated-tool` — borrow one tool, not the credential

The other four modes are about work the other agent does with its own head. This one is
about a tool it holds — an [address it can call](./commands.md#api) using a credential of
its own — and it is the only mode where the asking agent gets the use of something
without ever getting the thing itself.

Two grants, not one, and the second is the point:

```console
$ asterism connect writer researcher --mode delegated-tool
Connected writer → researcher (delegated-tool). Use it with: asterism delegate writer researcher <endpoint>

$ asterism delegate writer researcher issues
writer may now ask researcher to call 'issues' — and only that. researcher's credential stays with researcher.
Every call stops for you first: researcher asks before it sends anything, at any trust level.
Use it with: asterism call writer researcher issues
```

The channel says `writer` may ask for tool results at all; the second command says
**which** tool. So a tool you give `researcher` next month is not something `writer` can
reach through the channel you opened today — you name each one, and you can take one back
without disturbing the rest.

Asking is one command, and it stops for you every time:

```console
$ asterism call writer researcher issues
writer is asking researcher to call 'issues' with researcher's credential.
Approve this destructive action? [y/N] y
```

What comes back is the tool's own answer — whatever that address returns, screened. The
credential goes out with the call and comes back into nothing: not the answer you see, not
either agent's record, not its memory.

That confirmation is not a setting you can turn off. A call that carries a credential
always asks, at every autonomy level, and it can never earn its way out of asking the way
other actions can — sending a credential somewhere is the one thing asterism will not
learn to do on its own. If the agent that owns the tool is at `propose`, nothing is sent
at all; it tells you what it would have done.

Changing the tool takes the grant back, because what was handed over is no longer what
would be sent:

```console
$ asterism api add researcher issues "https://api.github.com/repos/acme/site/pulls" --credential GITHUB_TOKEN
Bound api.issues for researcher — it may now send credential GITHUB_TOKEN to api.github.com.
No call happens without you: at notify and autonomous it pauses and asks; a propose agent only ever plans it.
This changed what the call sends, so writer can no longer ask researcher to make it.
  Grant it again with: asterism delegate writer researcher issues
```

## Seeing what is open

```console
$ asterism connections writer
Connections for writer (5):

• → researcher · handoff · active · d0277553
• → researcher · artifact-only · active · 23487a14
• → researcher · read-summary · active · 1fcbb509
• → researcher · shared-brief · active · c3c463a4
• → researcher · delegated-tool · active · ba00a306
    may call api.issues

→ outbound (this agent initiates over the channel) · ← inbound (the other agent initiates)
```

All five channels from the walkthrough, each still its own permission. `→` is outbound
(this agent initiates); `←` is inbound (the other agent does). You only
ever see the named agent's own channels — it never reveals a channel between two other
agents.

## Withdrawing a channel

```console
$ asterism disconnect writer researcher --mode handoff
Disconnected writer → researcher (handoff). writer can no longer hand work to researcher.
Reconnecting opens a new channel — it does not bring the old one back.
```

What that takes away is more than the ability to ask for work:

- withdrawing an **artifact-only** channel means files already handed over can no
  longer be fetched — the list you were given stops resolving;
- withdrawing a **read-summary** channel stops it sharing what it knows, including
  anything learned while the channel was open;
- withdrawing a **shared-brief** channel un-frames the brief for both agents, from
  their next run;
- withdrawing a **delegated-tool** channel takes back every tool handed over on it at
  once — which is why taking back a single tool has its own command,
  [`undelegate`](./commands.md#undelegate).

Work already underway is not interrupted. If the other agent is paused waiting for you
to confirm something, that confirmation still works and it still finishes in its own
space — but nothing it produces afterwards comes back across the withdrawn channel.

Withdrawn channels stay listed, marked, after the open ones, so you can always see what
was once open and that it is now closed:

```console
$ asterism connections writer
Connections for writer (5):

• → researcher · artifact-only · active · 23487a14
• → researcher · read-summary · active · 1fcbb509
• → researcher · shared-brief · active · c3c463a4
• → researcher · delegated-tool · active · ba00a306
    may call api.issues
• → researcher · handoff · revoked · d0277553  (withdrawn — nothing crosses it)

→ outbound (this agent initiates over the channel) · ← inbound (the other agent initiates)
```

Both agents' records keep showing the channel and the moment it was withdrawn. Every
use of a channel is recorded on **both** agents' logs — that it happened, never the
task text or the result:

```
asterism events tail writer
```

## From the console

Everything here is also available over the install-wide console the
[dashboard](./dashboard.md) runs on, so you can open channels, hand off work and read a
summary from another machine. See
[the collaboration endpoints](./dashboard.md#collaboration-between-agents).

## What "separate" means here

The separation these channels preserve is the same one described in
[what isolation means today](./concepts.md#what-isolation-means-today): memory,
secrets, skills, workspaces, autonomy and logs are scoped per agent and enforced on
every read and write. A channel narrows what may cross that boundary to one named
thing; it does not weaken the boundary.

That is *logical* scoping, not an OS-enforced jail. It is exactly as strong as the
rest of the product's separation — no stronger because two agents are talking, and no
weaker.

## Where to go next

- [Command reference → connect](./commands.md#connect) — every collaboration command,
  option by option.
- [Concepts → Connections](./concepts.md#connections) — the shorter statement of the
  same model.
- [Dashboard](./dashboard.md) — the console endpoints that expose all of this over HTTP,
  and the live terminal view over every agent.
