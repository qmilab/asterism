# 0001 — Where OS-level execution isolation belongs

- **Status:** accepted (spike — decides shape, authorises no build)
- **Date:** 2026-08-16
- **Decided against:** `main` @ `b36d618`
- **Supersedes:** nothing. **Superseded by:** nothing.

Asterism's published threat model states, in the open, that today's boundary is
logical scoping and not OS containment. This decides what the OS-level tier
should be, and — as importantly — what it will not be.

---

## 1. The question

The runtime has two candidate places to put a real boundary, and they sound
interchangeable:

- **around the agent** — the model loop runs inside a sandbox;
- **around the tools** — tool execution runs inside a sandbox.

They are not interchangeable. They contain **disjoint** threats, cost different
things, and close different items on the published gap list.

## 2. What is actually true today

Verified against `b36d618` rather than assumed.

| Fact | Where |
|---|---|
| `ScopedTool.execute` is `(invocation: {args}, signal?) => Promise<ToolResult>` | `packages/core/src/adapter.ts:83` |
| `ToolResult` is `{output: string, isError?, observation?}` — RPC-shaped in practice | `packages/core/src/adapter.ts:61` |
| `RuntimeAdapter` is one method, `run(request)` | `packages/core/src/adapter.ts:196` |
| `RunRequest` is serialisable but for `signal` and the one `execute` member | `packages/core/src/adapter.ts:144` |
| The destructive gate **wraps** `cap.execute` from outside | `packages/core/src/trust.ts:729` |
| The gate records `onExecute` *before* awaiting the tool | `packages/core/src/trust.ts:675` |
| Default host capabilities are **nine `fs.*` operations** | `packages/core/src/capabilities.ts:46` |
| Reserved kernel capabilities are the two world-fact tools (agent's own store) | `packages/core/src/capabilities.ts:69` |
| Credential-bearing capabilities are the `api.<name>` namespace | `packages/core/src/capabilities.ts` |
| Path confinement is a kernel realpath check, self-described as best-effort | `packages/cli/src/capabilities.ts:223` |

**The shipped catalog contains no shell, no exec, no plugin, and no
bundled-script capability.** `matchDestructiveCommand` guards a shell tool that
does not ship; the threat model's gap 1 says exactly that.

Two qualifications, both load-bearing and both easy to overstate:

- **`run()` accepts host-supplied capabilities** (`run.ts:69`), so an embedder can
  introduce an `exec`-class tool the shipped CLI never offers. "None ships" is not
  "none can exist" — which is part of why this infrastructure is worth having
  before one does.
- **Nothing enforces that a `ToolResult` is serialisable.** `ObservedFact.object`
  is `unknown` and `ToolInvocation.args` is `unknown`; the only structural
  copy anywhere is `structuredClone` on `inputSchema` (`adapter.ts:128`). The
  values are JSON *in practice* because they come from a model's tool call and
  from kernel-authored tools — but an RPC boundary must **validate and serialise
  defensively**, and a value that fails to encode has to surface as a tool error,
  not as a crash in the transport.

This reframes the fork. Today:

- **Tool execution is over-reaching _trusted_ code** — nine functions we wrote,
  running with the user's full privileges.
- **Untrusted _code_ is on the other side** — the substrate and its transitive
  dependency tree, in the same process as the SQLite handle and every credential
  closure.

## 3. Three placements, not two

| | What it contains | Credentials |
|---|---|---|
| **(a)** sandbox substrate **and** tools together | most things | **cross into the sandbox** — rejected on sight |
| **(b)** sandbox the substrate; tools stay in the kernel, reached by RPC | a compromised substrate / dependency | never move |
| **(c)** sandbox tool execution; substrate stays in-process | over-reach, and a future `exec`-class capability | must be **excluded by construction** |

(a) destroys the product's headline property — the agent never sees the
credential — and is not considered further.

(b) and (c) are the real fork, and **(c) drops in underneath the gate with zero
_contract_ change**: `ScopedTool`, `RuntimeAdapter` and `gateTool` are all
untouched, because `execute` is already a function from arguments to a result.

Zero contract change is **not** zero code change. The nine capability closures in
`packages/cli/src/capabilities.ts` do direct filesystem calls today; under (c)
they become RPC stubs and their bodies move into a tool-host process. That file
is the bulk of the work, and it is a rewrite, not a wrapper.

## 4. What each buys against the four published gaps

From `docs/threat-model.md` § "What this boundary is not":

| Published gap | (b) substrate | (c) tools |
|---|---|---|
| Agents share a process | closes it for the substrate | closes the residue |
| **Workspace is a directory, not a jail** | **no** — tools touch the filesystem, not the model loop | **yes, and only this** |
| Data is not encrypted at rest | no | no |
| Runtime cannot vouch for the model | no | no |

**Two of the four gaps are untouched by any isolation tier.** Encryption at rest
and model trust are separate work. A writeup implying "spike C closes the gap
list" would be the overclaim this project exists to avoid.

## 5. Measured, not argued

A harness (`0001-execution-isolation.bench.mjs`, macOS 26.6.1, Apple Silicon,
unsigned) settled the cost question and the feasibility question together.
Medians over repeated runs; figures are approximate because they vary by a few
tens of microseconds between runs.

The harness runs a **runtime matrix** — Node (the compatibility floor) and Bun
(the recommended runtime) — because a feasibility claim about "a JS runtime" that
is measured for one and asserted for the other is not evidence. **18/18 assertions
pass, on both.**

| Measurement | Result |
|---|---|
| Seatbelt denies a read outside the granted subpath | **EPERM** |
| Boots under `(deny default)` | **Node ✓ Bun ✓** |
| Workspace read + write inside the jail | **works, both** |
| Read of a neighbouring directory in `$HOME` | **denied, both** |
| Directory enumeration of `$HOME` | **denied, both** |
| `stat` of a *known* outside path | **succeeds — published limitation** |
| Network from the tool host | **denied, both** |
| `exec` of anything but the runtime itself | **EPERM, both** |
| In-process `fs.read` today | ≈ **0.011 ms** |
| Long-lived jailed child, RPC per tool call | ≈ **0.03 ms** |
| **Added latency per tool call** | ≈ **0.02 ms** |
| Spawn + first call | **32–46 ms, once per run** |
| Per-**call** spawn, had we designed it that way | ≈ **1000× worse** |

**Latency does not decide this fork.** Hundredths of a millisecond against a
model round-trip of 300–3000 ms is not perceptible — *provided the child is
long-lived*. A per-call spawn is fatal, which is why the design is a supervised
long-lived host.

The boundary is crossed **once per tool call, not once per syscall**, which is
what keeps the expensive capabilities cheap: `fs.find` walks up to 20 000 nodes
(`capabilities.ts`) entirely inside the host and returns one result. The RPC cost
is paid on the call, not on the walk.

### The harness had to be falsified before it could be believed

`--falsify` grants back what the profile denies and requires every security
assertion, on every runtime, to flip. Doing that found **three defects in the
harness itself**, none of which a passing run would have revealed:

- The network check treated anything other than `CONNECTED` as a pass — but a
  *permitted* connection to a dead port returns `ECONNREFUSED`. It would have
  reported a green network jail with the sandbox wide open.
- Removing `(deny network*)` did not falsify anything, because `(deny default)`
  already denies it. **That line is belt-and-braces, not the mechanism** — a real
  falsification has to *grant* the capability, not un-deny it.
- The inert-check *reporter* was itself broken: a prefix matching no result read
  as `undefined` rather than as a failure, so a mistyped assertion name would have
  been silently excluded from the matrix.

All eight security assertions (four claims × two runtimes) now flip under
`--falsify` and pass without it. Two further claims are asserted but deliberately
**outside** the falsification matrix, because they are not security properties:
that the runtime boots, and that the published `stat` limitation still holds —
the latter asserted so the record is known to be stale if it ever changes.

### Five traps the harness found, each a design constraint

1. **Seatbelt matches on the real path.** `/var/folders/…` is a symlink to
   `/private/var/folders/…`; a profile written against the symlinked form matches
   nothing and the sandbox is silently a no-op. The profile builder must realpath
   every path it emits. (`resolvesOutsideWorkspace` already learned this; the
   profile builder does not inherit it for free.)
2. **A `(deny …)` is only overridden by an allow at the _same granularity_.**
   `(deny file-read-data (subpath $HOME))` is **not** overridden by
   `(allow file-read* (subpath <workspace>))`. Mixing granularities produces a
   jail that denies the agent its own workspace — and the failure is a silent
   `SIGABRT` with no stderr, because the runtime dies before it has one.
3. **Metadata cannot be denied wholesale.** Module resolution `lstat`s every path
   component, so denying metadata on `$HOME` makes anything re-allowed beneath it
   unreachable. Denying `file-read-data` while leaving metadata readable is what
   works. Measured consequence, stated precisely: **directory enumeration outside
   the workspace is denied** (`readdir($HOME)` → `EPERM`) **but `stat` of a
   already-known path succeeds** — so existence, size and mtime of a guessed path
   remain observable while its contents do not. A real, bounded limitation, and it
   must be published as one.
4. **The tool host must be started with its cwd inside a granted path.** Bun reads
   its working directory at startup; launched from a directory inside the denied
   subtree it dies with `error: An unknown error occurred (Unexpected)` — no
   mention of the sandbox, nothing to search for. Node does not care, so this is
   invisible until the Bun-first product hits it. Setting cwd to the agent's
   workspace fixes it, which is where the tool host belongs anyway.
5. **The errno is runtime-specific; judge by reachability, not by error code.** A
   denied socket surfaces as `EPERM` on Node and **`ECONNREFUSED` on Bun**. A check
   reading "ECONNREFUSED means it was allowed" therefore fails a jail that is
   holding. Proven by connecting to a **real listener**: Bun unsandboxed connects,
   Bun sandboxed does not. The assertion must test whether a connection was
   *established*, never what error came back.

The profile that actually works, in full:

```scheme
(version 1)
(deny default)
(allow process-fork)
(allow process-exec (literal "<the runtime binary>"))   ; NOT (allow process*)
(allow sysctl*) (allow mach*) (allow signal)
(allow file-read*)
(deny  file-read-data (subpath "<$HOME, realpath'd>"))
(allow file-read-data (subpath "<runtime dir>"))
(allow file-read-data (subpath "<Asterism install dir>"))   ; the host's own code
(allow file-read-data (subpath "<this agent's workspace>"))
(allow file-write*    (subpath "<this agent's workspace>") (literal "/dev/null"))
(deny  network*)                                        ; redundant under deny-default
```

Two notes on that profile. **`(allow process*)` is broader than the tier needs** —
narrowing to `process-fork` plus an exec of the runtime alone still boots, and
`/bin/echo` then gets `EPERM`; a filesystem tool host should not be able to launch
arbitrary binaries. And **the host's own code needs its own grant**, separate from
the workspace: the child cannot load itself otherwise. Code and data are
different grants.

## 6. Decision

**Put the boundary around tool execution — (c) — and build the transport so it
can be turned around for (b) later. Do not commit to (b) now.**

Four reasons:

1. **(c) closes the gap the page actually names.** A reader attacking "the
   workspace is a directory, not a jail" is attacking a check whose own comment
   says *best-effort*.
2. **(c) makes _one pair_ of barriers auditable** — the kernel's path check and
   the OS. Stub out the kernel check, watch the OS deny anyway. Gap 4 ("barrier
   independence is asserted, not audited") is not thereby closed: this is one
   pair, demonstrated, not a systematic audit of every layer. It is the first
   pair that *can* be demonstrated, which is the claim — and no more than that.
3. **(c) unlocks; (b) only hardens.** Bundled skill scripts were refused (#147)
   *because* there is no containment. This is what makes that refusal relaxable.
4. **(c) sandboxes the component with the narrowest needs.** The nine `fs.*`
   capabilities need one directory and **zero network** — the easiest correct
   profile there is. The substrate needs the open internet.

### Why (b) is demoted rather than scheduled

**An earlier draft of this record demoted (b) on a false premise** — that its
sandbox must choose between denying network (breaking local models) and allowing
it (handing a compromised dependency an exfiltration path). That binary is wrong,
and adversarial review caught it. Measured:

| Profile | loopback:11434 | external:443 |
|---|---|---|
| `(deny network*)` | `EPERM` | `EPERM` |
| **`(allow network-outbound (remote tcp "localhost:*"))`** | **allowed** | **`EPERM`** |
| `(allow network-outbound (remote tcp "*:443"))` | `EPERM` | allowed |

SBPL filters by host and port. **A substrate sandbox can allow loopback only** —
so with a local model, (b) is not merely feasible, it is *tight*: the substrate
reaches `localhost:11434` and nothing else. Local models would not break.

(b) is still second, for three reasons that survive the correction:

1. **It does not close the gap the page names.** The workspace is still not a
   jail under (b), because the tools are not what is sandboxed.
2. **Cost.** (b) moves the model client across the boundary and has to stream
   `RunEvent`s back and settle `output` independently. (c) is `{key, args} →
   ToolResult` over nine functions in one file.
3. **Against a hosted provider its containment is weak, and the residual path is
   in-band.** Host filtering degrades to "any host on port 443", which is a broad
   exfil channel. And even a perfect host filter would not help: **the substrate's
   legitimate function is to send workspace content to the model endpoint**, so no
   network policy can separate "the prompt" from "the prompt plus your SSH key".

That third point is the honest shape of it: **(b)'s value is a function of where
the model runs.** Airtight for local models, weak for hosted ones — which is the
majority configuration today.

The threat (b) contains — a compromised dependency — also has cheaper mitigations
that cost the user nothing: lockfile provenance, dependency review, and the fact
that `RuntimeAdapter` already hands the substrate no store, no credential reader
and no memory writer.

**Trigger to revisit (b), sharpened by the above:** when **local models become the
common configuration** — that is when loopback-only makes (b) genuinely airtight
rather than partial. Also if an `exec`-class capability ships, or the substrate's
dependency surface grows materially. Same trigger-gating already used for
#144/#146/#147.

## 7. Consequences

**The gate is unchanged, and strictly strengthened.** It stays kernel-side,
outside the RPC: it classifies, decides, and prompts *before* anything is sent.
The thing it guards loses the ability to bypass it — a jailed host cannot delete
outside its namespace even if its own logic were wrong.

**At-most-once already assumes this boundary.** `onExecute` fires *before*
`await tool.execute` (`trust.ts:675`) precisely because a lost response does not
tell you whether the effect happened. That pessimism was written for an
in-process call and is exactly what a process boundary needs. One new failure
mode: **a child that dies mid-call must map to the existing throw path, never to
a retry.**

**Credential rule, one line:** credential-bearing capabilities never cross the
boundary. `fs.*` and any future `exec` go in; `api.<name>` and the two reserved
world-fact capabilities stay in the kernel. **This follows a line the code
already draws** (`DEFAULT_CAPABILITY_KEYS` vs `RESERVED_CAPABILITY_KEYS` vs the
`api.` namespace), so no new taxonomy is required — a strong signal it is the
right seam.

**Per-run, scoped to the agent.** It matches the `RunHandle` lifecycle, a
compromise does not persist between runs, agent-to-agent isolation follows for
free, and there is no daemon to supervise. A warm per-agent pool is a later
optimisation that *weakens* the property; do not start there.

**Neither opt-in nor default: resolved and reported.** The tier is detected per
host and named. Where unavailable it degrades to exactly today's behaviour, so
**no user is ever blocked** — they simply do not get the backstop. This is the
safest kind of platform variance precisely because **(c) adds no new user
*decisions***: same tools, same reach, same allow-list, same confirmations. There
is nothing new to grant, configure or install.

That is a claim about decisions, not about invisibility. Two things do become
observable, and both are the point: an escape that used to produce a kernel
refusal can now produce `EPERM` from underneath it, and a host without a tier
reports a weaker posture than one with it.

**The kernel check stays in front.** It is what produces a human-readable
refusal; the OS is the silent backstop. Defence in depth here is also the
better error message.

**The threat model page does not change until a tier is default-on.** A
conditional security page is worse than an honest static one, and
`check:safety-case` cannot gate prose that says "depends".

## 8. What this does not decide

- Linux (`bubblewrap` / Landlock) and Windows tiers — unmeasured. Only macOS
  seatbelt was tested, on one machine.
- Whether the availability detector ships as an `asterism doctor`-style report.
- Encryption at rest, and model trust — untouched by any tier here.
- **The metadata leak is accepted but not designed away.** Because path resolution
  needs `lstat` on every component, `stat` of a known path outside the workspace
  still succeeds (enumeration does not). Whether that is worth further narrowing
  is open; it must be published as a limitation either way.
- Nothing ships behind a flag this cycle. The bugs in this design are lifecycle
  bugs (a child that dies, hangs, or orphans), and they want a full slice with
  its own review rounds.

## 9. How this gets verified when built

The acceptance test is the falsification, not the happy path: **disable the
kernel's `resolvesOutsideWorkspace` check and assert the OS still denies.** That
is the barrier-independence proof gap 4 asks for, and it is the reason to prefer
this shape over one that merely adds a second copy of the same logic.
