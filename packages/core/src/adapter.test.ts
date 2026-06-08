import { describe, expect, test } from "bun:test";
import { createToolRegistry } from "./adapter";
import type { ScopedTool } from "./adapter";

describe("createToolRegistry — frozen, independent capability", () => {
  test("the snapshot is deeply frozen and independent of the caller's tools", () => {
    const tool: ScopedTool = {
      name: "fs",
      description: "files",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: () => ({ output: "ok" }),
    };
    const registry = createToolRegistry([tool]);
    const listed = registry.list();

    expect(Object.isFrozen(registry)).toBe(true); // list() cannot be swapped out
    expect(Object.isFrozen(listed)).toBe(true); // array cannot be grown
    expect(Object.isFrozen(listed[0])).toBe(true); // descriptor cannot be retargeted
    expect(Object.isFrozen(listed[0]!.inputSchema)).toBe(true); // schema cannot be widened

    // Mutating the caller's original tool must not bleed into the registry.
    tool.name = "mutated";
    (tool.inputSchema as Record<string, unknown>).properties = { evil: {} };
    expect(registry.list()[0]!.name).toBe("fs");
    expect(
      (registry.list()[0]!.inputSchema as { properties: unknown }).properties,
    ).toEqual({ path: { type: "string" } });
  });

  test("the frozen array rejects attempts to grow the capability set", () => {
    const registry = createToolRegistry([]);
    expect(() => {
      (registry.list() as ScopedTool[]).push({
        name: "x",
        description: "",
        inputSchema: {},
        execute: () => ({ output: "" }),
      });
    }).toThrow();
  });
});
