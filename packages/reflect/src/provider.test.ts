import { expect, test } from "bun:test";

import type { ReflectionInput } from "@qmilab/asterism-core";

import {
  buildReflectionUserPrompt,
  DefaultReflectionProvider,
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
