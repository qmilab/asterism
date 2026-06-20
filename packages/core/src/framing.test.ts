import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createToolRegistry } from "./adapter";
import {
  BUILTIN_SOULS,
  buildSystemPrompt,
  frameRun,
  resolveSoul,
} from "./framing";
import { AsterismStore } from "./store";
import type { Agent, Memory, Objective, WorldFact } from "./types";

const agentFixture: Agent = {
  id: "agent-1",
  name: "personal",
  role: "keep my blog and notes tidy",
  soulRef: "casual-helper",
  workspaceDir: "/tmp/personal",
  trustLevel: "autonomous",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function memory(partial: Partial<Memory>): Memory {
  return {
    id: "m",
    agentId: agentFixture.id,
    memoryType: "semantic",
    content: "content",
    confidence: 1,
    status: "active",
    reviewState: "accepted",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function objective(partial: Partial<Objective>): Objective {
  return {
    id: "o",
    agentId: agentFixture.id,
    content: "an objective",
    status: "active",
    reviewState: "accepted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function worldFact(partial: Partial<WorldFact>): WorldFact {
  return {
    id: "w",
    agentId: agentFixture.id,
    subject: "subject",
    value: "value",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("buildSystemPrompt — identity, soul, skills, memory", () => {
  test("includes name, role, and resolved soul text", () => {
    const prompt = buildSystemPrompt({
      agent: agentFixture,
      soulText: BUILTIN_SOULS["casual-helper"],
    });
    expect(prompt).toContain("You are personal.");
    expect(prompt).toContain("keep my blog and notes tidy");
    expect(prompt).toContain(BUILTIN_SOULS["casual-helper"] as string);
  });

  test("falls back to a soul reference line when no text is resolved", () => {
    const prompt = buildSystemPrompt({ agent: agentFixture });
    expect(prompt).toContain('soul "casual-helper"');
  });

  test("lists skills, inlining bodies when provided", () => {
    const prompt = buildSystemPrompt({
      agent: agentFixture,
      skills: [
        { name: "blog-writer", content: "Write in a friendly voice." },
        { name: "note-tidier" },
      ],
    });
    expect(prompt).toContain("### blog-writer");
    expect(prompt).toContain("Write in a friendly voice.");
    expect(prompt).toContain("- note-tidier");
  });

  test("only active + accepted memories shape the prompt", () => {
    const prompt = buildSystemPrompt({
      agent: agentFixture,
      memories: [
        memory({ content: "ACCEPTED-ACTIVE" }),
        memory({ content: "PROPOSED", reviewState: "proposed" }),
        memory({ content: "REJECTED", reviewState: "rejected" }),
        memory({ content: "ARCHIVED", status: "archived" }),
      ],
    });
    expect(prompt).toContain("ACCEPTED-ACTIVE");
    expect(prompt).not.toContain("PROPOSED");
    expect(prompt).not.toContain("REJECTED");
    expect(prompt).not.toContain("ARCHIVED");
  });

  test("memory section is omitted entirely when nothing is framable", () => {
    const prompt = buildSystemPrompt({
      agent: agentFixture,
      memories: [memory({ content: "PROPOSED", reviewState: "proposed" })],
    });
    expect(prompt).not.toContain("What you remember");
  });

  test("is deterministic for the same inputs", () => {
    const ctx = {
      agent: agentFixture,
      soulText: "calm",
      skills: [{ name: "a" }, { name: "b" }],
      memories: [
        memory({ content: "one", memoryType: "semantic" as const }),
        memory({ content: "two", memoryType: "convention" as const }),
      ],
    };
    expect(buildSystemPrompt(ctx)).toBe(buildSystemPrompt(ctx));
  });
});

describe("buildSystemPrompt — standing objectives", () => {
  test("frames only active objectives, high (before skills and memory)", () => {
    const prompt = buildSystemPrompt({
      agent: agentFixture,
      objectives: [
        objective({ id: "1", content: "FINISH-MIGRATION" }),
        objective({ id: "2", content: "TIDY-NOTES" }),
      ],
      skills: [{ name: "blog-writer" }],
      memories: [memory({ content: "REMEMBERED" })],
    });
    expect(prompt).toContain("Your standing objectives:");
    expect(prompt).toContain("- FINISH-MIGRATION");
    expect(prompt).toContain("- TIDY-NOTES");
    // Placed before skills and memory.
    expect(prompt.indexOf("Your standing objectives:")).toBeLessThan(prompt.indexOf("blog-writer"));
    expect(prompt.indexOf("Your standing objectives:")).toBeLessThan(prompt.indexOf("REMEMBERED"));
  });

  test("done and dropped objectives never shape the prompt", () => {
    const prompt = buildSystemPrompt({
      agent: agentFixture,
      objectives: [
        objective({ id: "1", content: "ACTIVE-GOAL", status: "active" }),
        objective({ id: "2", content: "DONE-GOAL", status: "done" }),
        objective({ id: "3", content: "DROPPED-GOAL", status: "dropped" }),
      ],
    });
    expect(prompt).toContain("ACTIVE-GOAL");
    expect(prompt).not.toContain("DONE-GOAL");
    expect(prompt).not.toContain("DROPPED-GOAL");
  });

  test("a proposed (or rejected) objective is inert — only accepted ones frame", () => {
    const prompt = buildSystemPrompt({
      agent: agentFixture,
      objectives: [
        objective({ id: "1", content: "ACCEPTED-GOAL", reviewState: "accepted" }),
        objective({ id: "2", content: "PROPOSED-GOAL", reviewState: "proposed" }),
        objective({ id: "3", content: "REJECTED-GOAL", reviewState: "rejected" }),
      ],
    });
    expect(prompt).toContain("ACCEPTED-GOAL");
    expect(prompt).not.toContain("PROPOSED-GOAL");
    expect(prompt).not.toContain("REJECTED-GOAL");
  });

  test("the section is omitted entirely when none are active", () => {
    const prompt = buildSystemPrompt({
      agent: agentFixture,
      objectives: [objective({ status: "done" })],
    });
    expect(prompt).not.toContain("Your standing objectives:");
  });

  test("preserves input order", () => {
    const prompt = buildSystemPrompt({
      agent: agentFixture,
      objectives: [
        objective({ id: "1", content: "FIRST" }),
        objective({ id: "2", content: "SECOND" }),
      ],
    });
    expect(prompt.indexOf("FIRST")).toBeLessThan(prompt.indexOf("SECOND"));
  });
});

describe("buildSystemPrompt — working notes (world-facts)", () => {
  test("frames notes as the agent's OWN UNVERIFIED record, last (after memory)", () => {
    const prompt = buildSystemPrompt({
      agent: agentFixture,
      objectives: [objective({ id: "1", content: "A-GOAL" })],
      skills: [{ name: "blog-writer" }],
      memories: [memory({ content: "REMEMBERED" })],
      worldFacts: [
        worldFact({ id: "1", subject: "deploy version", value: "v0.2.1" }),
        worldFact({ id: "2", subject: "migration", value: "60% done" }),
      ],
    });
    expect(prompt).toContain("Your working notes");
    expect(prompt).toContain("- deploy version: v0.2.1");
    expect(prompt).toContain("- migration: 60% done");
    // The honesty constraint is load-bearing: the label must say these are the agent's
    // own, not verified facts — so a self-written note never reads as a ratified lesson.
    expect(prompt.toLowerCase()).toContain("not verified facts");
    // Placed LAST — after objectives, skills, and memory (lowest-trust block).
    expect(prompt.indexOf("Your working notes")).toBeGreaterThan(prompt.indexOf("A-GOAL"));
    expect(prompt.indexOf("Your working notes")).toBeGreaterThan(prompt.indexOf("blog-writer"));
    expect(prompt.indexOf("Your working notes")).toBeGreaterThan(prompt.indexOf("REMEMBERED"));
  });

  test("the section is omitted entirely when there are no notes", () => {
    const prompt = buildSystemPrompt({ agent: agentFixture, worldFacts: [] });
    expect(prompt).not.toContain("Your working notes");
  });

  test("preserves input order (oldest-first as the kernel frames them)", () => {
    const prompt = buildSystemPrompt({
      agent: agentFixture,
      worldFacts: [
        worldFact({ id: "1", subject: "first-subject", value: "x" }),
        worldFact({ id: "2", subject: "second-subject", value: "y" }),
      ],
    });
    expect(prompt.indexOf("first-subject")).toBeLessThan(prompt.indexOf("second-subject"));
  });
});

describe("frameRun — assembles the RunRequest", () => {
  test("carries workspace, input, tools, and the framed prompt; no store seam", () => {
    const tools = createToolRegistry([]);
    const req = frameRun({
      agent: agentFixture,
      input: "tidy the notes folder",
      tools,
      soulText: "calm",
    });
    expect(req.workspaceDir).toBe("/tmp/personal");
    expect(req.input).toBe("tidy the notes folder");
    expect(req.tools).toBe(tools);
    expect(req.systemPrompt).toContain("You are personal.");
    // exactOptionalPropertyTypes: an unset signal is absent, not undefined.
    expect("signal" in req).toBe(false);
  });

  test("threads an abort signal through when provided", () => {
    const controller = new AbortController();
    const req = frameRun({
      agent: agentFixture,
      input: "x",
      tools: createToolRegistry([]),
      signal: controller.signal,
    });
    expect(req.signal).toBe(controller.signal);
  });
});

describe("resolveSoul — built-ins, then a reader, else undefined", () => {
  test("resolves a built-in soul by name", () => {
    expect(resolveSoul("careful-consultant")).toBe(
      BUILTIN_SOULS["careful-consultant"],
    );
  });

  test("reads a path via the injected reader when not a built-in", () => {
    const text = resolveSoul("/souls/custom.md", {
      readFile: (p) => `loaded:${p}`,
    });
    expect(text).toBe("loaded:/souls/custom.md");
  });

  test("returns undefined for an unknown ref with no reader, and on read error", () => {
    expect(resolveSoul("/souls/missing.md")).toBeUndefined();
    expect(
      resolveSoul("/souls/missing.md", {
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeUndefined();
  });

  test("a ref named like an inherited property never resolves to that property", () => {
    // `BUILTIN_SOULS["toString"]` would otherwise hand back a function and crash
    // framing's `.trim()`; an own-property check keeps these as ordinary refs.
    for (const ref of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      expect(resolveSoul(ref)).toBeUndefined();
      expect(resolveSoul(ref, { readFile: (p) => `loaded:${p}` })).toBe(`loaded:${ref}`);
    }
  });
});

// The framing consumes scoped stores. Proving the scoping holds end-to-end: data
// written under one agentId, read back under the same agentId, frames only that
// agent — and the other agent's framing contains none of it.
describe("framing consumes only the agent's own scoped data", () => {
  let store: AsterismStore;
  let personal: Agent;
  let work: Agent;

  beforeEach(() => {
    store = AsterismStore.open(":memory:");
    personal = store.agents.create({
      name: "personal",
      role: "personal helper",
      soulRef: "casual-helper",
      workspaceDir: "/tmp/personal",
      trustLevel: "autonomous",
    });
    work = store.agents.create({
      name: "work",
      role: "work consultant",
      soulRef: "careful-consultant",
      workspaceDir: "/tmp/work",
      trustLevel: "propose",
    });
  });

  afterEach(() => {
    store.close();
  });

  test("personal's memory and skills never appear in work's framing", () => {
    store.memories.create(personal.id, {
      memoryType: "semantic",
      content: "PERSONAL-ONLY-MEMORY",
    });
    store.skills.create(personal.id, {
      name: "PERSONAL-ONLY-SKILL",
      path: "/tmp/personal/skill.md",
    });
    store.memories.create(work.id, {
      memoryType: "semantic",
      content: "WORK-ONLY-MEMORY",
    });

    const workPrompt = buildSystemPrompt({
      agent: work,
      soulText: resolveSoul(work.soulRef),
      skills: store.skills.list(work.id),
      memories: store.memories.list(work.id),
    });

    expect(workPrompt).toContain("WORK-ONLY-MEMORY");
    expect(workPrompt).not.toContain("PERSONAL-ONLY-MEMORY");
    expect(workPrompt).not.toContain("PERSONAL-ONLY-SKILL");
  });
});
