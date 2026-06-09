## What & why

<!-- One concept per PR. What does this change, and why? Link any issue. -->

## Checklist

- [ ] `bun run typecheck` and `bun test` pass
- [ ] New behavior has tests. Anything touching isolation — memory / secret / skill scoping, the trust gate, the memory firewall — has a test proving cross-agent access fails
- [ ] User-facing copy (CLI help, README) sells the behavior, not internal architecture
- [ ] I read the relevant parts of [`CLAUDE.md`](../CLAUDE.md) and didn't break any of the five canonical-demo claims

## Notes

<!-- Trade-offs, follow-ups, screenshots — anything a reviewer should know. -->
