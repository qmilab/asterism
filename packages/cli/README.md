# Asterism

### Many agents. One runtime. Separate lives.

Run distinct local AI agents from one install — each with its own **soul, memory, secrets, skills, workspace, event log, and autonomy level**. Agents run alone by default; nothing crosses between them unless you say so.

One agent for work, one per client, one for the side project — without a runtime, a config tree, or a VM each.

A *soul* is nothing exotic: a small persona file giving an agent its voice, values, and operating style.

## Quickstart

```bash
npx @qmilab/asterism init     # Node 22.19+   (Bun: bunx --bun @qmilab/asterism init)

# create two agents with distinct souls and autonomy
asterism new writer  --soul casual-helper       --trust autonomous
asterism new client  --soul careful-consultant  --trust propose

# give each agent its own secrets and skills
asterism secrets add client GITHUB_TOKEN ghp_example_token   # value: inline, piped, from $GITHUB_TOKEN — or omit it and be prompted
# a skill is just a markdown file you write
echo "# Blog writer: tighten drafts, keep the author's voice" > blog-writer.md
asterism skill   add writer blog-writer.md

# put them to work
asterism run writer "update my blog draft"
asterism run client "summarize the client meeting"

# review what each agent knows and did — separately
asterism memory inspect writer
asterism events tail client
asterism reflect writer --review
```

`writer`'s memory never appears in `client`, and `client`'s `GITHUB_TOKEN` cannot be read from `writer` — those boundaries hold from the moment the agents exist. The `run` and `reflect` steps need a model; [a local one](#bring-your-own-model) needs no key and no account.

Requires [Node](https://nodejs.org) 22.19+, [Bun](https://bun.sh) 1.1+, or [Deno](https://deno.com) 2+. The installed binary runs under Node by default; under Bun, force Bun's runtime with `bunx --bun`, and under Deno give it a `node_modules` directory. The [installation guide](https://qmilab.com/asterism/docs/installation/) has the one line each of those takes, and what npm, pnpm and yarn need.

## Autonomy you can dial

Every agent gets one of three trust levels:

- **`propose`** — never acts on its own; returns a plan or diff for you to apply.
- **`notify`** — acts automatically inside its workspace, then surfaces each action prominently for after-the-fact review. It does **not** ask first.
- **`autonomous`** — acts freely inside its workspace, recording everything to its event log.

One rule overrides all three. A **destructive** action — deleting files, force-pushes, reading out a secret, spending money, irreversible external calls — never happens without you, whatever the agent's trust level, unless you have specifically allowed that capability for it. At `notify` and `autonomous` the run stops and asks; a `propose` agent does not take one at all, and hands you the plan instead.

This is what the gate looks like when it fires — an `autonomous` agent, mid-run:

```console
$ asterism run writer "tighten the draft in posts/launch.md, then clear out dist/"
Run paused: a destructive action needs your confirmation before it can proceed.
Confirm it to continue:  asterism confirm writer a1b2c3d4
```

Whatever the agent had already done stands; the destructive step is parked, and stays parked until you type that line. The gate acts on an agent's *tools*: the shipped CLI registers a default catalog of workspace-scoped file tools behind it — read-only `read_file`/`list_dir`/`stat`/`find`, the writes `write_file`/`append_file`/`mkdir`/`move`, and `delete_file` — so with a configured model an ordinary edit runs under `autonomous` while a deletion pauses. None of that is asserted on trust: in the source, `packages/cli/src/acceptance.test.ts` proves all five claims of the [walkthrough](https://qmilab.com/asterism/docs/walkthrough/) end to end, and `catalog.test.ts` drives the shipped tools directly.

## What "separate" means today

Each agent's memory, secrets, skills, workspace, and event log are scoped to it and enforced everywhere data is read or written — real, tested separation. This is *logical* scoping, **not** OS-level containment: it does not yet claim to safely contain deliberately hostile code. Stronger execution isolation comes in a later phase. See [what isolation means today](https://qmilab.com/asterism/docs/concepts/#what-isolation-means-today), or the [threat model](https://qmilab.com/asterism/docs/threat-model/) for the enforced-versus-not account in full.

## Learning you can review

`asterism reflect <agent> --review` proposes typed memories from an agent's recent runs. Nothing is written until you accept it — and every memory belongs to exactly one agent. Run it by hand, or queue proposals with `--propose` and review the pile later.

## Bring your own model

Asterism does not ship a model; you point it at one. Name a hosted provider — `openai`, `anthropic`, `openrouter` and others — and the endpoint and wire protocol come with the name, with the key read from the environment and never stored. Or point it at [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) on your own machine, where there is nothing else to configure:

```console
$ asterism config set llama3.2 --provider ollama
Set the model for the install default: llama3.2 (provider: ollama).
API keys are never stored here — keep them in the environment (e.g. OPENAI_API_KEY).
```

Every provider and the variable it reads is listed under [Models and providers](https://qmilab.com/asterism/docs/models/).

## What else it does

| | |
|---|---|
| **Agents that work together** | Open a one-way channel between two agents and choose what it is for — a result, the files it made, a screened extract of what it knows, standing context both run with, or one tool called on its behalf. Only that crosses; memory, secrets and tools never do. → [Working together](https://qmilab.com/asterism/docs/collaboration/) |
| **Earned trust** | An agent can *earn* the right to take one capability without pausing — always proposed for your approval, and lost the moment something goes wrong. → [Earned autonomy](https://qmilab.com/asterism/docs/concepts/#earned-autonomy) |
| **Choose which tools an agent has** | Narrow a single agent to less than the standard toolkit, separately from how much it may do with it. → [`capabilities`](https://qmilab.com/asterism/docs/commands/#capabilities) |
| **One address, one credential** | Bind a stored credential to exactly one `https` address. The agent supplies nothing, never sees the credential, and can never earn its way out of asking you. → [`api`](https://qmilab.com/asterism/docs/commands/#api) |
| **Recall, objectives, working notes** | The most relevant memories ranked into each run under a budget; standing goals that frame what an agent works toward; and the agent's own running picture of its situation, shown as unverified and yours to accept or reject. → [Concepts](https://qmilab.com/asterism/docs/concepts/#recall) |
| **Cognition trace** | Opt one agent into an auditable, tool-by-tool record of its runs — observe-only, off by default. → [`trace`](https://qmilab.com/asterism/docs/commands/#trace) |
| **Live dashboard** | Watch and steer every agent — autonomy, approvals, memory — in one terminal view. → [Dashboard](https://qmilab.com/asterism/docs/dashboard/) |
| **Chat channels** | Reach one agent from a Telegram or Discord chat. → [Channels](https://qmilab.com/asterism/docs/channels/) |
| **Local HTTP endpoint** | Serve one agent over HTTP, token-protected, with the same guarantees as the CLI. → [HTTP](https://qmilab.com/asterism/docs/http/) |
| **Run as a service** | Keep an agent running in the background, started by your OS. → [Service](https://qmilab.com/asterism/docs/service/) |
| **Container image** | The same runtime, multi-arch, on any container host. → [Container](https://qmilab.com/asterism/docs/container/) |

---

[**Documentation**](https://qmilab.com/asterism/docs/) · [Getting started](https://qmilab.com/asterism/docs/getting-started/) · [Command reference](https://qmilab.com/asterism/docs/commands/) · [Five-claims walkthrough](https://qmilab.com/asterism/docs/walkthrough/) · [Source and issue tracker](https://github.com/qmilab/asterism)

Apache-2.0 © QMI Lab
