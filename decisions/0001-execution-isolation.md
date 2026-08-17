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
| **Workspace is a directory, not a jail** | **no** — tools touch the filesystem, not the model loop | **partly, and only this** — see below |
| Data is not encrypted at rest | no | no |
| Runtime cannot vouch for the model | no | no |

"Partly" is doing real work in that table, and §5 measures exactly how much:
writes and network become OS-enforced absolutely, reads become OS-enforced for
**user data**, and system paths stay readable. When the page is eventually
updated it must say that, not "the workspace is now a jail".

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
| Read outside `$HOME` — `/private/tmp`, the real `$TMPDIR`, `/private/var/tmp` | **denied, both** |
| Read of a system path (`/etc/hosts`) | **allowed — by design** |
| **Write** outside the workspace, in `$HOME` and outside it | **denied, both** |
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

All twelve security assertions (six claims × two runtimes) now flip under
`--falsify` and pass without it. Two further claims are asserted but deliberately
**outside** the matrix, because they are not security properties: that the runtime
boots, and that the published `stat` limitation still holds — the latter asserted
so the record is known to be stale if it ever changes.

Later rounds found three more, all of the same family — **an assertion that was
never made reads as one that passed**:

- **Write confinement was claimed and never tested.** The probe only wrote
  *inside* the workspace, which proves the allow and not the deny, and `--falsify`
  never granted writes back. A profile leaking `file-write*` would have passed
  every assertion in the file.
- **`execSync` starts `/bin/sh -c`**, so a denial proved only that the *shell*
  could not start. Under a profile that permitted a non-runtime binary directly
  while denying `sh`, the check still passed. It uses `execFileSync` now — the
  stated property, with no shell in between.
- **An absent prerequisite shrank the matrix instead of failing it.** The expected
  pairs were derived from the runtimes the *host* happened to have, so a machine
  without Bun quietly dropped six claims, and a machine without `sandbox-exec`
  reached the success branch and printed *"all 0 runtime/claim pairs falsified"*.
  The matrix is now derived from what the **record claims**, and a missing pair is
  a failed falsification. Verified by simulating both.

It also **exits non-zero** when a required assertion is missing or inert, and when
the normal run has any failure. A security harness that prints a failure and exits
`0` cannot be composed with anything — and this file is meant to be the skeleton
of an acceptance test, so it has to be scriptable.

**Every defect found across five review rounds was in this harness or in a
supporting claim, and none in the decision.** That is worth recording as a
property of the work rather than a coincidence: the shape of the answer was
reasoned from the code and held, while everything asserted rather than measured
had to be corrected.

The recurring failure was never a wrong belief — it was an **unenumerated** one.
The realpath fact was known and written down as trap 1, then not applied to
`/private/var/folders`. The missing-runtime hole was fixed for "one absent" and
not for "none present". Each time the correction was narrower than the thing it
was correcting.

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
;; every root that can hold USER DATA — not $HOME alone
(deny  file-read-data (subpath "/Users"))
(deny  file-read-data (subpath "<$HOME, realpath'd>"))
(deny  file-read-data (subpath "/tmp"))
(deny  file-read-data (subpath "/private/tmp"))
(deny  file-read-data (subpath "/Volumes"))
(deny  file-read-data (subpath "/private/var"))           ; $TMPDIR *and* /var/tmp
(allow file-read-data (subpath "/private/var/db"))        ; …minus what the runtime needs
(allow file-read-data (subpath "/private/var/select"))
(allow file-read-data (subpath "<runtime dir>"))
(allow file-read-data (subpath "<Asterism install dir>"))   ; the host's own code
(allow file-read-data (subpath "<this agent's workspace>"))
(allow file-write*    (subpath "<this agent's workspace>") (literal "/dev/null"))
(deny  network*)                                        ; redundant under deny-default
```

**Denying `$HOME` alone is not enough, and an earlier draft of this record did
exactly that.** It produced a profile that confined *writes* to the workspace
while a read of `/tmp/anything` still succeeded — a jail on one axis, wide open on
the other, and the harness never noticed because its only escape probe was a
sibling directory inside `$HOME`. Both runtimes still boot with the full deny list.

**And `/tmp` is not where the temp files are.** `os.tmpdir()` on macOS returns
`/var/folders/…`, whose real path is under `/private/var/folders`; `/var/tmp` is a
third, separate root again. **Three consecutive review rounds each found another
one missing** — `/tmp`, then the `$TMPDIR` root, then `/private/var/tmp`. Adding
leaves one at a time was losing to the problem, so the profile now denies
**`/private/var` entire** and allows back only `db` and `select`, which is what the
runtime actually needs. Measured on both runtimes.

### The structural limit: seatbelt cannot express a closed read boundary

The right answer to "which roots did you forget" is to stop enumerating. That was
tried and **it does not work**: `(deny file-read-data (subpath "/"))` with the
needed roots allowed back **fails to boot a JS runtime at all** — silently, with
no stderr, the same failure as trap 2 — and stayed dead through three successive
widenings of the allow-list.

So the macOS tier is **unavoidably a deny-list, and therefore enumerative**. That
is a real and permanent weakness of this tier, not a defect in the profile: its
correctness depends on having listed every user-data root, and this record's own
history is three rounds of evidence that such lists are gotten wrong.

**A Linux `bubblewrap`/mount-namespace tier would be closed by construction** — the
namespace is built from nothing and contains only what is mounted in, so a root
nobody thought of is absent rather than readable. That is a reason to expect the
Linux tier to be **stronger than the macOS one**, not merely different, and it
should inform which platform the eventual build treats as the reference
implementation.

So state what the tier is, precisely: **no reads of user data anywhere outside the
workspace; no writes anywhere but the workspace; no network; no exec beyond the
runtime.** It is *not* "no reads outside the workspace" — `/usr`, `/etc`,
`/System` and `/Library` stay readable, deliberately, because the runtime needs
them and they are not the agent's secrets.

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

**At-most-once assumes this boundary for _destructive_ actions only — and that is
the sharpest open problem this spike found.** In the destructive branch,
`onExecute` fires *before* `await tool.execute` (`trust.ts:675`) precisely because
a lost response does not tell you whether the effect happened. That pessimism is
exactly what a process boundary needs.

**The ordinary branch does the opposite, deliberately** (`trust.ts:694-705`): a
`read`/`write` action is awaited first and recorded *only on success*, so "a
transient failure simply re-runs". The comment justifies it in one word —
*reversible*.

Check that word against the catalog. Of the nine `fs.*` capabilities **only
`fs.delete` is `destructive`**; `fs.write`, `fs.mkdir`, `fs.move` and **`fs.append`
are all `write`**. `fs.append` is neither reversible nor idempotent: running it
twice duplicates content. `fs.move` is not idempotent either.

In-process this is close to harmless — `appendFileSync` returns or throws in the
same memory, so a throw means it almost certainly did not happen. **A process
boundary widens that window into a real one:** the child can complete the append
and die before the reply is delivered, and the current design will re-run it.

So the earlier draft's prescription — "a child that dies mid-call must map to the
existing throw path, never to a retry" — was wrong, because the existing path for
a reversible action *is* to re-run. **This is a design question the build must
answer, not a property it inherits.** The options are to record `write` actions
up front as destructive ones already are (costing a re-run on genuinely transient
failures), to make the tool host's replies idempotent by call id, or to
reclassify the non-idempotent writes. It is not decided here.

This is the repo's recurring shape, again: *the sentence explaining why a check is
unnecessary is where the check is missing.*

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
  seatbelt was tested, on one machine. Given the enumeration weakness above, the
  Linux tier is the one worth measuring next, and possibly the one to treat as the
  reference.
- Whether the availability detector ships as an `asterism doctor`-style report.
- Encryption at rest, and model trust — untouched by any tier here.
- **How much further reads can be narrowed.** `/etc` and `/usr` stay readable in
  the measured profile. Whether a tighter list still boots on a clean machine —
  and what a Linux tier's equivalent list is — is unmeasured.
- **The metadata leak is accepted but not designed away.** Because path resolution
  needs `lstat` on every component, `stat` of a known path outside the workspace
  still succeeds (enumeration does not). Whether that is worth further narrowing
  is open; it must be published as a limitation either way.
- **How a non-idempotent `write` survives a child that dies mid-call** — see §7.
  Record up front, idempotent replies keyed by call id, or reclassify. This is the
  one open question that must be settled before any code is written.
- Nothing ships behind a flag this cycle. The bugs in this design are lifecycle
  bugs (a child that dies, hangs, or orphans), and they want a full slice with
  its own review rounds.

## 9. How this gets verified when built

The acceptance test is the falsification, not the happy path: **disable the
kernel's `resolvesOutsideWorkspace` check and assert the OS still denies.** That
is the barrier-independence proof gap 4 asks for, and it is the reason to prefer
this shape over one that merely adds a second copy of the same logic.
