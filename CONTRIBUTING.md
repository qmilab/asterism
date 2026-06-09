# Contributing to Asterism

Thanks for thinking about contributing. Asterism is a small, local-first
runtime that takes **isolation** seriously, so this guide is short and
concrete.

## Before opening a PR

1. Open an issue first for anything beyond a typo or a one-line fix. The
   Phase 0 architecture and its safety rules are written down in
   [`CLAUDE.md`](./CLAUDE.md) — read it before writing code. If your change
   touches one of those rules, surface it as a design discussion before
   writing code.
2. The single idea behind everything here is that **the agent is the
   isolation boundary**: every persisted row is scoped to one agent, and
   nothing leaks between agents. If a change could let one agent read
   another's memory, secrets, or skills, it is a bug, not a feature.

## Stack and conventions

- **Runtime / package manager**: [Bun](https://bun.sh). Bun is the
  recommended runtime; Node 20+ is a tested compatibility floor. Don't add a
  Bun-only API to the kernel without a Node fallback.
- **Language**: TypeScript, strict mode, with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` on. No `any` without a written reason.
- **ESM only** (`verbatimModuleSyntax`). Relative imports carry explicit
  `.js` specifiers so the build is resolvable under Node ESM.
- **Secrets never touch code or logs.** Credentials live in the local secret
  store, referenced by `valueRef`; the event log records references, never
  values.
- **The adapter boundary is law.** Nothing outside `packages/adapter-pi`
  imports Pi; nothing outside `packages/reflect` imports a reflection model
  client. The kernel hands the substrate a pre-scoped tool registry and
  nothing more.
- **User-facing copy sells behavior, not architecture.** README, CLI help,
  and any user-visible string describe the outcome ("separate", "scoped",
  "boundary") — not internal vocabulary, and never an isolation guarantee the
  current phase doesn't provide.

## The canonical demo is the acceptance test

`CLAUDE.md` ends with a canonical demo that proves the five claims Asterism
makes: scoped memory, unreadable cross-agent secrets, propose-vs-act trust
behavior, the destructive-action gate firing regardless of trust level, and
reviewable reflection. **If a change breaks any of those five, it doesn't
ship.** Any kernel operation that touches isolation (memory scoping,
credential scoping, trust enforcement, the destructive-action gate) needs a
test proving cross-agent access fails.

## Local development

```sh
bun install            # workspace install
bun run typecheck      # strict-TS check across all packages (tsc -b)
bun run build          # build all packages
bun test               # the full suite — every isolation invariant has a test
bun run asterism --help   # the CLI surface, run from source
```

## PR expectations

- One concept per PR. A bug fix doesn't need surrounding cleanup; a rename
  doesn't need a refactor.
- The branch must pass `bun run typecheck` and `bun test`.
- Commit messages: imperative subject, short body explaining the *why* rather
  than the *what*. Match the style of recent commits on `main`.
- Don't rewrite published history. Don't force-push to `main`.

## Reporting security issues

Anything that breaks isolation — one agent reading another's memory, secrets,
or skills; a way past the destructive-action confirmation gate; a memory
firewall bypass; a secret value reaching a log or the event store — please
report it **privately** first. See [`SECURITY.md`](./SECURITY.md) for how.
Asterism's whole point is to keep agents' lives separate, so finding a hole in
that is genuinely useful.

## License

Asterism is licensed under [Apache 2.0](./LICENSE). By contributing, you agree
your contributions are licensed under the same terms.
