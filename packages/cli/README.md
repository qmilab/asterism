# Asterism

### Many agents. One runtime. Separate lives.

Run distinct local AI agents from one install — each with its own **soul, memory, secrets, skills, workspace, event log, and autonomy level**. Agents run alone by default; nothing crosses between them unless you say so.

## Quickstart

```bash
bunx @qmilab/asterism init

# create two agents with distinct souls and autonomy
asterism new writer  --soul calm-editor        --trust autonomous
asterism new client  --soul careful-consultant --trust propose

# give each agent its own secrets and skills
asterism secrets add client GITHUB_TOKEN
asterism skill   add writer blog-writer.md

# put them to work
asterism run writer "update my blog draft"
asterism run client "summarize the client meeting"

# review what each agent knows and did — separately
asterism memory inspect writer
asterism events tail client
asterism reflect writer --review
```

Requires [Bun](https://bun.sh) 1.1+.

## Autonomy you can dial

Every agent gets one of three trust levels:

- **`propose`** — never acts on its own; returns a plan or diff for you to apply.
- **`notify`** — acts automatically inside its workspace, then surfaces each action prominently for after-the-fact review. It does **not** ask first.
- **`autonomous`** — acts freely inside its workspace, recording everything to its event log.

At every level, destructive actions (deleting files, force-pushes, spending money, irreversible external calls) pause for your explicit confirmation.

## Learning you can review

`asterism reflect <agent> --review` proposes typed memories from an agent's recent runs. Nothing is written until you accept it — and every memory belongs to exactly one agent.

---

Full documentation, the architecture, and the issue tracker live at [github.com/qmilab/asterism](https://github.com/qmilab/asterism).

Apache-2.0 © QMI Lab
