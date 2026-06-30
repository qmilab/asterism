import { expect, test } from "bun:test";

import type { ObjectiveTransitionInput, ReflectionInput } from "@qmilab/asterism-core";

import {
  buildObjectiveReflectionUserPrompt,
  buildObjectiveTransitionUserPrompt,
  buildReflectionUserPrompt,
  DefaultReflectionProvider,
  parseObjectiveProposals,
  parseObjectiveTransitions,
  parseProposals,
} from "./provider.js";
import type { ChatModelClient, ChatRequest } from "./model.js";

const RUN_ID = "run-123";

function input(overrides: Partial<ReflectionInput> = {}): ReflectionInput {
  return {
    agentId: "agent-1",
    transcript: { runId: RUN_ID, input: "write the blog", output: "done, saved to ./drafts" },
    ...overrides,
  };
}

/** A client that returns a fixed string and records the request it was given. */
function cannedClient(response: string): ChatModelClient & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  return {
    seen,
    async complete(request) {
      seen.push(request);
      return response;
    },
  };
}

test("parses a well-formed proposal envelope and tags every proposal with the run id", () => {
  const raw = JSON.stringify({
    memories: [
      { type: "semantic", content: "the blog lives in ./drafts", confidence: 0.9 },
      { type: "convention", content: "the user likes short posts", confidence: 0.6 },
    ],
  });
  const proposals = parseProposals(raw, RUN_ID);
  expect(proposals).toHaveLength(2);
  expect(proposals[0]).toEqual({
    memoryType: "semantic",
    content: "the blog lives in ./drafts",
    confidence: 0.9,
    sourceRunId: RUN_ID,
  });
  expect(proposals.every((p) => p.sourceRunId === RUN_ID)).toBe(true);
});

test("drops episodic and unknown types but keeps the valid siblings", () => {
  const raw = JSON.stringify({
    memories: [
      { type: "episodic", content: "first I opened the file, then…", confidence: 1 },
      { type: "made-up", content: "irrelevant", confidence: 1 },
      { type: "procedural", content: "run `bun test` before committing", confidence: 0.8 },
    ],
  });
  const proposals = parseProposals(raw, RUN_ID);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]?.memoryType).toBe("procedural");
});

test("skips entries with empty content and clamps confidence into [0,1]", () => {
  const raw = JSON.stringify({
    memories: [
      { type: "semantic", content: "   ", confidence: 0.5 },
      { type: "semantic", content: "kept", confidence: 9 },
      { type: "negative", content: "also kept", confidence: -4 },
      { type: "semantic", content: "default conf" },
    ],
  });
  const proposals = parseProposals(raw, RUN_ID);
  expect(proposals.map((p) => p.content)).toEqual(["kept", "also kept", "default conf"]);
  expect(proposals[0]?.confidence).toBe(1);
  expect(proposals[1]?.confidence).toBe(0);
  expect(proposals[2]?.confidence).toBe(0.5);
});

test("tolerates a markdown code fence and surrounding prose", () => {
  const fenced = "Here is what I found:\n```json\n" +
    JSON.stringify({ memories: [{ type: "semantic", content: "fenced fact", confidence: 0.7 }] }) +
    "\n```\nHope that helps!";
  const proposals = parseProposals(fenced, RUN_ID);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]?.content).toBe("fenced fact");
});

test("accepts a bare array as well as the {memories:[…]} envelope", () => {
  const raw = JSON.stringify([{ type: "semantic", content: "bare array fact", confidence: 0.4 }]);
  expect(parseProposals(raw, RUN_ID)).toHaveLength(1);
});

test("extracts the JSON even when prose with stray braces surrounds it", () => {
  const envelope = JSON.stringify({
    memories: [{ type: "semantic", content: "the real lesson", confidence: 0.7 }],
  });
  // Stray braces both before (a {placeholder}) and after (a {0,1} range note).
  const raw = `Sure — using {placeholder}: ${envelope}. Note: confidence is in {0,1}.`;
  const proposals = parseProposals(raw, RUN_ID);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]?.content).toBe("the real lesson");
});

test("coerces a numeric-string confidence and clamps it", () => {
  const raw = JSON.stringify({
    memories: [
      { type: "semantic", content: "stringy conf", confidence: "0.9" },
      { type: "semantic", content: "blank conf", confidence: "" },
    ],
  });
  const proposals = parseProposals(raw, RUN_ID);
  expect(proposals[0]?.confidence).toBe(0.9); // "0.9" → 0.9
  expect(proposals[1]?.confidence).toBe(0.5); // "" → default, not 0
});

test("a non-JSON or empty response yields no proposals rather than throwing", () => {
  expect(parseProposals("I could not find anything to remember.", RUN_ID)).toEqual([]);
  expect(parseProposals("", RUN_ID)).toEqual([]);
  expect(parseProposals(JSON.stringify({ memories: [] }), RUN_ID)).toEqual([]);
});

test("the user prompt carries the task, the output, and known memories", () => {
  const prompt = buildReflectionUserPrompt(
    input({ knownMemories: ["already knows this"] }),
  );
  expect(prompt).toContain("write the blog");
  expect(prompt).toContain("done, saved to ./drafts");
  expect(prompt).toContain("already knows this");
});

test("the provider calls the model with the reflection system prompt and parses the result", async () => {
  const client = cannedClient(
    JSON.stringify({ memories: [{ type: "semantic", content: "x", confidence: 0.5 }] }),
  );
  const provider = new DefaultReflectionProvider(client);
  const proposals = await provider.reflect(input());
  expect(proposals).toHaveLength(1);
  expect(proposals[0]?.sourceRunId).toBe(RUN_ID);
  // It sent a system instruction and a user message built from the transcript.
  expect(client.seen[0]?.system).toContain("reflection step");
  expect(client.seen[0]?.user).toContain("write the blog");
});

// --- Slice 2: objective proposals ------------------------------------------

test("parseObjectiveProposals reads the {objectives:[…]} envelope and tags the run id", () => {
  const raw = JSON.stringify({
    objectives: [
      { content: "keep the notes folder tidy", confidence: 0.8 },
      { content: "   ", confidence: 0.5 }, // empty content dropped
      { content: "drive the migration to done", confidence: 9 }, // confidence clamped
    ],
  });
  const proposals = parseObjectiveProposals(raw, RUN_ID);
  expect(proposals.map((p) => p.content)).toEqual([
    "keep the notes folder tidy",
    "drive the migration to done",
  ]);
  expect(proposals[1]?.confidence).toBe(1);
  expect(proposals.every((p) => p.sourceRunId === RUN_ID)).toBe(true);
});

test("parseObjectiveProposals tolerates fences/prose and a non-JSON response yields none", () => {
  const fenced =
    "Here's one:\n```json\n" +
    JSON.stringify({ objectives: [{ content: "fenced objective", confidence: 0.7 }] }) +
    "\n```";
  expect(parseObjectiveProposals(fenced, RUN_ID).map((p) => p.content)).toEqual(["fenced objective"]);
  expect(parseObjectiveProposals("nothing worth proposing", RUN_ID)).toEqual([]);
  expect(parseObjectiveProposals(JSON.stringify({ objectives: [] }), RUN_ID)).toEqual([]);
});

test("the objective user prompt carries the task, output, and known objectives", () => {
  const prompt = buildObjectiveReflectionUserPrompt(
    input({ knownMemories: ["already drives the migration"] }),
  );
  expect(prompt).toContain("write the blog");
  expect(prompt).toContain("done, saved to ./drafts");
  // The shared `knownMemories` field carries the agent's existing OBJECTIVES for this call.
  expect(prompt).toContain("already drives the migration");
  expect(prompt).toContain("Standing objectives the agent already has");
});

test("proposeObjectives calls the model with the objective system prompt and parses the result", async () => {
  const client = cannedClient(
    JSON.stringify({ objectives: [{ content: "keep things tidy", confidence: 0.6 }] }),
  );
  const provider = new DefaultReflectionProvider(client);
  const proposals = await provider.proposeObjectives(input());
  expect(proposals).toHaveLength(1);
  expect(proposals[0]?.content).toBe("keep things tidy");
  expect(proposals[0]?.sourceRunId).toBe(RUN_ID);
  expect(client.seen[0]?.system).toContain("standing objective");
  expect(client.seen[0]?.user).toContain("write the blog");
});

// --- Type B: objective transition suggestions ------------------------------

function transitionInput(
  overrides: Partial<ObjectiveTransitionInput> = {},
): ObjectiveTransitionInput {
  return {
    agentId: "agent-1",
    transcripts: [
      {
        runId: RUN_ID,
        input: "run the final migration batch",
        output: "migration complete, all rows verified",
      },
    ],
    objectives: [{ id: "obj-1", content: "finish the Q3 migration" }],
    ...overrides,
  };
}

test("parseObjectiveTransitions reads the {transitions:[…]} envelope and validates id + status", () => {
  const raw = JSON.stringify({
    transitions: [
      { objectiveId: "obj-1", status: "done", confidence: 0.9 },
      { objectiveId: "obj-2", status: "DROPPED", confidence: 9 }, // status case-folded, confidence clamped
      { objectiveId: "   ", status: "done", confidence: 0.5 }, // blank id dropped
      { objectiveId: "obj-3", status: "active", confidence: 0.5 }, // not a transition status — dropped
      { objectiveId: "obj-4", status: "garbage", confidence: 0.5 }, // illegal — dropped
      { objectiveId: "obj-5", confidence: 0.5 }, // missing status — dropped
    ],
  });
  const transitions = parseObjectiveTransitions(raw);
  expect(transitions.map((t) => [t.objectiveId, t.proposedStatus])).toEqual([
    ["obj-1", "done"],
    ["obj-2", "dropped"],
  ]);
  expect(transitions[1]?.confidence).toBe(1);
});

test("parseObjectiveTransitions tolerates fences/prose and a non-JSON response yields none", () => {
  const fenced =
    "Sure:\n```json\n" +
    JSON.stringify({ transitions: [{ objectiveId: "obj-1", status: "done", confidence: 0.8 }] }) +
    "\n```";
  expect(parseObjectiveTransitions(fenced).map((t) => t.objectiveId)).toEqual(["obj-1"]);
  expect(parseObjectiveTransitions("nothing is finished")).toEqual([]);
  expect(parseObjectiveTransitions(JSON.stringify({ transitions: [] }))).toEqual([]);
});

test("the transition user prompt carries the task, output, and each objective with its id", () => {
  const prompt = buildObjectiveTransitionUserPrompt(
    transitionInput({
      objectives: [
        { id: "obj-1", content: "finish the Q3 migration" },
        { id: "obj-2", content: "keep the notes tidy" },
      ],
    }),
  );
  expect(prompt).toContain("run the final migration batch");
  expect(prompt).toContain("migration complete, all rows verified");
  expect(prompt).toContain("[obj-1] finish the Q3 migration");
  expect(prompt).toContain("[obj-2] keep the notes tidy");
});

test("the transition user prompt lists MULTIPLE recent runs when given more than one", () => {
  const prompt = buildObjectiveTransitionUserPrompt(
    transitionInput({
      transcripts: [
        { runId: "r2", input: "write a blog", output: "blog written" },
        { runId: "r1", input: "run the migration", output: "migration done" },
      ],
    }),
  );
  expect(prompt).toContain("Run 1:");
  expect(prompt).toContain("Run 2:");
  expect(prompt).toContain("write a blog");
  expect(prompt).toContain("run the migration");
});

test("proposeObjectiveTransitions calls the model with the transition system prompt and parses", async () => {
  const client = cannedClient(
    JSON.stringify({ transitions: [{ objectiveId: "obj-1", status: "done", confidence: 0.7 }] }),
  );
  const provider = new DefaultReflectionProvider(client);
  const transitions = await provider.proposeObjectiveTransitions(transitionInput());
  expect(transitions).toHaveLength(1);
  expect(transitions[0]?.objectiveId).toBe("obj-1");
  expect(transitions[0]?.proposedStatus).toBe("done");
  // The transition prompt is distinct from the memory/objective ones (its JSON envelope key).
  expect(client.seen[0]?.system).toContain("transitions");
  expect(client.seen[0]?.user).toContain("[obj-1] finish the Q3 migration");
});
