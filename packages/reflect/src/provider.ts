// The default ReflectionProvider: drive a hosted model to turn one run transcript
// into PROPOSED typed memory writes. Pure TypeScript — no Python, no embeddings,
// no local ML (Phase 0). It proposes; it never persists. The human review step
// (and the memory firewall on the write path) decide what actually becomes memory.
//
// The model is asked for strict JSON, but model output is never trusted to be
// well-formed: `parseProposals` is tolerant — it strips code fences, locates the
// JSON, drops any entry with a non-reflectable type, empty content, or an
// out-of-range confidence, and clamps what it keeps. A malformed response yields
// an empty proposal list, never a thrown error or a junk memory.

import {
  isReflectionMemoryType,
  REFLECTION_MEMORY_TYPES,
} from "@qmilab/asterism-core";
import type {
  ProposedMemory,
  ReflectionInput,
  ReflectionProvider,
} from "@qmilab/asterism-core";

import type { ChatModelClient } from "./model.js";

/** Default confidence when a proposal omits one or gives a value we can't use. */
const DEFAULT_CONFIDENCE = 0.5;

/**
 * The reflection instruction. Defines the four durable memory types, forbids
 * episodic / secrets, and pins the output to a strict JSON envelope so parsing is
 * deterministic. Kept as an exported constant so it is reviewable and testable.
 */
export const REFLECTION_SYSTEM_PROMPT = `You are the reflection step of an AI agent runtime. You are given the transcript of one task an agent just finished — the task it was asked to do and the output it produced. Your job is to extract DURABLE lessons worth remembering for future tasks, and nothing else.

Propose only memories that would genuinely help the agent next time. Be conservative: if the run taught nothing durable, propose nothing. Never invent facts that are not supported by the transcript.

Each memory has exactly one type:
- "semantic"   — a durable fact about the user, project, or world (e.g. "the blog lives in ./drafts").
- "procedural" — how to do something, a reusable method or sequence of steps.
- "convention" — a preference or rule the agent should follow (e.g. "the user prefers short commits").
- "negative"   — something to avoid, a mistake or dead end not to repeat.

Hard rules:
- NEVER propose an "episodic" memory (a play-by-play of what happened). Only the four durable types above.
- NEVER include secrets, tokens, passwords, API keys, or any credential value in a memory.
- Do not propose a memory the agent already holds (you will be shown its current memories).

Respond with STRICT JSON and nothing else, in exactly this shape:
{"memories": [{"type": "semantic", "content": "the lesson, one sentence", "confidence": 0.0}]}

"confidence" is a number from 0 to 1. If there is nothing worth remembering, respond with {"memories": []}.`;

/** Compose the user message: the run transcript plus the agent's existing memories. */
export function buildReflectionUserPrompt(input: ReflectionInput): string {
  const { transcript, knownMemories } = input;
  const sections: string[] = [
    `Task the agent was given:\n${transcript.input}`,
    `What the agent produced:\n${transcript.output}`,
  ];
  if (knownMemories && knownMemories.length > 0) {
    const lines = knownMemories.map((m) => `- ${m}`).join("\n");
    sections.push(
      `Memories the agent already holds (do not re-propose these):\n${lines}`,
    );
  }
  sections.push(
    `Propose durable memories from this run as STRICT JSON: {"memories": [{"type": ..., "content": ..., "confidence": ...}]}. Allowed types: ${REFLECTION_MEMORY_TYPES.join(", ")}. If nothing is worth remembering, return {"memories": []}.`,
  );
  return sections.join("\n\n");
}

/** Strip a Markdown code fence (```json … ``` or ``` … ```) if the text is wrapped in one. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

/**
 * The index of the bracket that closes the `{`/`[` at `start`, or -1 if none.
 * Tracks nesting of that bracket type and skips over string literals (so a brace
 * inside a JSON string never miscounts), which lets us pull a JSON value out of a
 * response even when prose around it contains stray braces.
 */
function matchingClose(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

/**
 * Parse a JSON value out of a model response, tolerant of surrounding prose. Fast
 * path: the de-fenced text is itself JSON. Otherwise, scan for the first BALANCED
 * `{…}`/`[…]` span that actually parses — so prose containing stray braces on
 * either side of the JSON (e.g. "ranges over {0,1}") does not derail extraction
 * the way a first-bracket-to-last-bracket slice would.
 */
function extractJson(raw: string): unknown {
  const text = stripCodeFence(raw);
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the balanced-span scan
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = matchingClose(text, i);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch {
      // not the JSON we want (e.g. a "{placeholder}" in prose) — keep scanning
    }
  }
  return undefined;
}

/** Pull the raw memory entries out of either `{memories: [...]}` or a bare `[...]`. */
function entriesOf(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  const memories = (parsed as { memories?: unknown } | null)?.memories;
  return Array.isArray(memories) ? memories : [];
}

/**
 * Clamp a value to a finite confidence in [0, 1], or the default if unusable.
 * Accepts a numeric string too ("0.9"), since a model may JSON-encode the number
 * as a string; a blank or non-numeric value falls back to the default.
 */
function normalizeConfidence(value: unknown): number {
  let n = NaN;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONFIDENCE;
  return Math.min(1, Math.max(0, n));
}

/**
 * Turn a model response into validated {@link ProposedMemory} objects, all tagged
 * with `sourceRunId`. Tolerant by design: entries with a non-reflectable type
 * (including "episodic"), empty content, or a non-object shape are dropped, not
 * fixed up; confidence is clamped. A response that is not usable JSON yields `[]`.
 */
export function parseProposals(
  raw: string,
  sourceRunId: string,
): ProposedMemory[] {
  const entries = entriesOf(extractJson(raw));
  const proposals: ProposedMemory[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (!isReflectionMemoryType(type)) continue;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (content.length === 0) continue;
    proposals.push({
      memoryType: type,
      content,
      confidence: normalizeConfidence(record.confidence),
      sourceRunId,
    });
  }
  return proposals;
}

/**
 * The hosted-model {@link ReflectionProvider}. Constructed with a
 * {@link ChatModelClient} (a real HTTP client in production, a fake in tests); it
 * builds the prompt, calls the model once, and parses the result into proposals.
 * It writes nothing — returning proposals is the whole of its job.
 */
export class DefaultReflectionProvider implements ReflectionProvider {
  constructor(private readonly client: ChatModelClient) {}

  async reflect(input: ReflectionInput): Promise<readonly ProposedMemory[]> {
    const raw = await this.client.complete({
      system: REFLECTION_SYSTEM_PROMPT,
      user: buildReflectionUserPrompt(input),
    });
    return parseProposals(raw, input.transcript.runId);
  }
}
