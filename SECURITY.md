# Security Policy

Asterism's reason to exist is keeping many agents' lives — memory, secrets,
skills, workspaces, autonomy — genuinely separate. A vulnerability here is
usually a hole in that separation, so we take reports seriously and welcome
them.

## Reporting a vulnerability

**Please report privately, not in a public issue.**

Use GitHub's private vulnerability reporting:

1. Go to the [**Security** tab](https://github.com/qmilab/asterism/security) of
   this repository.
2. Click **Report a vulnerability** and describe the issue.

This opens a private advisory visible only to you and the maintainers. If you
can't use that flow, reach the maintainer through their GitHub profile and ask
for a private channel before sharing details.

Please include, as best you can:

- what breaks, and the impact (e.g. "agent A can read agent B's secret");
- the smallest steps or proof-of-concept that reproduces it;
- the version / commit you tested.

We'll acknowledge your report, work with you on a fix, and credit you in the
advisory unless you'd prefer to stay anonymous. Please give us a reasonable
window to ship a fix before any public disclosure.

## What's in scope

Anything that breaks an isolation or safety invariant, including:

- one agent reading or writing **another agent's** memory, secrets, or skills;
- reading a stored secret **value** out of the event log, a run transcript, or
  any log line (the log records references, never values);
- bypassing the **destructive-action confirmation gate** — getting a
  destructive action to run without confirmation when it isn't allow-listed;
- bypassing the **memory firewall** to persist an injection/exfiltration
  payload;
- the execution substrate reaching a credential, the memory store, or a tool
  the kernel did not scope for that run.

Out of scope for now: the Phase 0 model is **logical**, agent-scoped isolation
enforced by the kernel — not yet a hardened boundary against deliberately
hostile code running in-process. OS-level execution isolation (process /
container / microVM) is a later phase. Reports that depend on running hostile
native code inside an agent's own process are noted, but expected, in Phase 0.

## Supported versions

Asterism is pre-1.0 and under active development. Security fixes land on `main`
and in the latest published release; there is no back-port window yet.
