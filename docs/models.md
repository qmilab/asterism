# Models and providers

Asterism does not ship a model. You point it at one, and every agent in the
install uses it — unless you give an agent a model of its own.

Creating agents, inspecting memory, reading the event log, and opening
[connections](./collaboration.md) between agents all work with no model at all.
A model is needed the moment an agent has to *think*: `asterism run`, the chat
channels, and `asterism reflect`.

## Trying Asterism without an account anywhere

You do not need an OpenAI or Anthropic key to see what Asterism does. If you run
[Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) on your own
machine, name it as the provider and there is nothing else to configure:

```console
$ asterism config set llama3.2 --provider ollama
Set the model for the install default: llama3.2 (provider: ollama).
API keys are never stored here — keep them in the environment (e.g. OPENAI_API_KEY).
```

That is the whole setup. No key, no account, no environment variable — and
nothing your agents write is sent to anyone. From here the
[tutorial](./getting-started.md) reads the same as it does with a hosted model.

LM Studio works the same way, on its own default port:

```console
$ asterism config set qwen3-4b --provider lmstudio
Set the model for the install default: qwen3-4b (provider: lmstudio).
API keys are never stored here — keep them in the environment (e.g. OPENAI_API_KEY).
```

Both expect the server to already be listening where it normally does —
`localhost:11434` for Ollama, `localhost:1234` for LM Studio. Running on a
different port is a `--base-url` away:

```console
$ asterism config set llama3.2 --provider ollama --base-url http://127.0.0.1:12345/v1
Set the model for the install default: llama3.2 (provider: ollama).
API keys are never stored here — keep them in the environment (e.g. OPENAI_API_KEY).
```

## Built-in providers

Naming any of these is enough — the endpoint and the wire protocol come with the
name, and each reads its own key from the environment.

| Provider | Key it reads | Notes |
|---|---|---|
| `openai` | `OPENAI_API_KEY` | The default when no provider is named. |
| `anthropic` | `ANTHROPIC_API_KEY` | |
| `openrouter` | `OPENROUTER_API_KEY` | One key, many models — model ids look like `anthropic/claude-sonnet-4-6`. |
| `groq` | `GROQ_API_KEY` | |
| `deepseek` | `DEEPSEEK_API_KEY` | |
| `xai` | `XAI_API_KEY` | |
| `together` | `TOGETHER_API_KEY` | |
| `cerebras` | `CEREBRAS_API_KEY` | |
| `ollama` | *none* | Runs on your own machine. |
| `lmstudio` | *none* | Runs on your own machine. |

Any provider can also read `ASTERISM_API_KEY` instead, if you keep a single key
across providers. The two local providers are the exception, and deliberately so
— see [What "needs no key" means](#what-needs-no-key-means).

```console
$ asterism config set anthropic/claude-sonnet-4-6 --provider openrouter
Set the model for the install default: anthropic/claude-sonnet-4-6 (provider: openrouter).
API keys are never stored here — keep them in the environment (e.g. OPENAI_API_KEY).
```

## Any other provider

A provider that is not on the list is still reachable — it just needs its
endpoint typed once. Most are OpenAI-compatible, which is the assumed default:

```console
$ asterism config set some-model --provider mistral --base-url https://api.mistral.ai/v1
Set the model for the install default: some-model (provider: mistral).
API keys are never stored here — keep them in the environment (e.g. OPENAI_API_KEY).
```

The key is then read from `<PROVIDER>_API_KEY` — `MISTRAL_API_KEY` here — or from
`ASTERISM_API_KEY`. If the provider speaks Anthropic's protocol rather than
OpenAI's, add `--api anthropic-messages`.

## A model per agent

`--agent` pins one agent to its own model; everyone else keeps the install
default. Use it to keep a cheap local model for the agent that drafts and a
hosted one for the agent that has to be right:

```console
$ asterism config set llama3.2 --provider ollama
Set the model for the install default: llama3.2 (provider: ollama).
API keys are never stored here — keep them in the environment (e.g. OPENAI_API_KEY).

$ asterism config set claude-opus-4-8 --provider anthropic --agent work
Set the model for agent "work": claude-opus-4-8 (provider: anthropic).
```

`asterism config` shows what each agent actually resolves to, so a per-agent
override is never something you have to remember.

Switching an agent to a different provider always moves it to *that* provider's
own endpoint. An agent pinned to `anthropic` does not inherit a base URL you set
for OpenRouter or for a local server — pointing one provider's endpoint at
another provider's model is a mistake worth making impossible rather than
documenting.

## What "needs no key" means

`ollama` and `lmstudio` are the only providers Asterism will talk to without
authenticating, and two things have to be true at once, every time:

- the provider is one of those two, **and**
- the endpoint it resolved to is on this machine.

Both, because either one alone is a way to get it wrong. A provider name outlives
the endpoint attached to it, so `--provider ollama` pointed at someone else's
server would otherwise send an unauthenticated request there — years after you
typed the default that made it keyless. And a local-looking URL alone is not
enough either: if you run an OpenAI-compatible proxy on `localhost`, it still
gets your key, because you named a provider that has one.

So this is refused rather than guessed at:

```console
$ asterism config set llama3.2 --provider ollama --base-url https://ollama.example.com/v1
Set the model for the install default: llama3.2 (provider: ollama).
API keys are never stored here — keep them in the environment (e.g. OPENAI_API_KEY).
```

Saving it is fine — it is a legitimate setup. But *using* it stops and says so:

> "ollama" needs no API key when it is served from this machine, but
> https://ollama.example.com/v1 is not. Point --base-url at localhost, or set
> OLLAMA_API_KEY for that endpoint.

The shared `ASTERISM_API_KEY` is never sent to `ollama` or `lmstudio` at all, at
any endpoint. That variable is a key for a hosted provider you pay for, and
forwarding it to a server on your own machine — or to whatever a local provider
has since been re-pointed at — hands a real secret to something that never asked
for one. Set `OLLAMA_API_KEY` explicitly if your local server is behind an auth
proxy; that is unambiguous, and it is honoured.

## Keys are infrastructure, not agent secrets

The provider key talks to your model. It is **not** an agent-scoped credential:
it is never stored in the config file, never handed to an agent, and never
readable through one. Credentials that belong to an agent are added per agent
with [`asterism secrets add`](./commands.md#secrets-add), live in the kernel's
store under that agent's name, and are never shared with another agent.

The full list of environment variables, and where a model comes from when several
layers set one, is in
[Configuring a model](./installation.md#configuring-a-model).
