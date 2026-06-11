// Pure formatting tests for the run-streaming views: the live activity line and
// the post-run action summary. Both are reference-only renders — capability keys,
// tool names, effect classes — and never carry a value.

import { expect, test } from "bun:test";

import type { ActionRecord, RunEvent } from "@qmilab/asterism-core";

import { formatActionSummary, formatRunActivity } from "./format.ts";

test("formatRunActivity renders tool executions and skips bookkeeping events", () => {
  expect(
    formatRunActivity({ type: "tool_execution_start", payload: { tool: "fs.write" } }),
  ).toBe("  → fs.write");
  expect(
    formatRunActivity({ type: "tool_execution_end", payload: { tool: "fs.write", isError: false } }),
  ).toBe("  ✓ fs.write");
  // A failed/withheld tool result shows the error glyph.
  expect(
    formatRunActivity({ type: "tool_execution_end", payload: { tool: "fs.delete", isError: true } }),
  ).toBe("  ✗ fs.delete");
  // Turn/message bookkeeping is not surfaced live.
  expect(formatRunActivity({ type: "agent_start", payload: {} })).toBeUndefined();
  expect(formatRunActivity({ type: "turn_end", payload: { chars: 42 } })).toBeUndefined();
});

test("formatRunActivity tolerates a missing tool name", () => {
  expect(formatRunActivity({ type: "tool_execution_start", payload: {} })).toBe("  → tool");
});

test("formatActionSummary tallies and lists each decision in order", () => {
  const actions: ActionRecord[] = [
    { capability: "fs.write", effect: "write", decision: "executed" },
    { capability: "fs.delete", effect: "destructive", decision: "paused" },
  ];
  const lines = formatActionSummary(actions);
  expect(lines[0]).toBe("Actions (1 executed, 1 paused):");
  expect(lines[1]).toBe("  ✓ executed fs.write (write)");
  expect(lines[2]).toBe("  ⏸ paused   fs.delete (destructive)");
});

test("formatActionSummary returns nothing for a run that took no actions", () => {
  expect(formatActionSummary([])).toEqual([]);
});
