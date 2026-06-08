import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createToolRegistry } from "./adapter";
import {
  BUILTIN_SOULS,
  buildSystemPrompt,
  frameRun,
  resolveSoul,
} from "./framing";
import { AsterismStore } from "./store";
import type { Agent, Memory } from "./types";

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
