import { afterEach, expect, test } from "bun:test";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseConfig, saveConfig } from "./config.ts";
import { configPath } from "./paths.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "asterism-config-"));
  tempDirs.push(dir);
  return dir;
}

test("a missing config file is an empty config, not an error", () => {
  expect(loadConfig(tempHome())).toEqual({});
});

test("save then load round-trips the config", () => {
  const home = tempHome();
  const config = {
    model: { id: "gpt-4o", provider: "openai" },
    agents: { work: { model: { id: "claude-opus-4-8", provider: "anthropic" } } },
  };
  saveConfig(home, config);
  expect(loadConfig(home)).toEqual(config);
});

test("the saved file is pretty-printed JSON with a trailing newline", () => {
  const home = tempHome();
  saveConfig(home, { model: { id: "gpt-4o" } });
  const text = readFileSync(configPath(home), "utf8");
  expect(text).toContain("\n  ");
  expect(text.endsWith("}\n")).toBe(true);
});

test("a malformed config file is rejected with its path, not silently ignored", () => {
  const home = tempHome();
  writeFileSync(configPath(home), "{ not valid json");
  expect(() => loadConfig(home)).toThrow(/not valid JSON/);
});

test("parseConfig rejects a model that is not an object", () => {
  expect(() => parseConfig({ model: "gpt-4o" })).toThrow(/model must be an object/);
});

test("parseConfig rejects a non-string field", () => {
  expect(() => parseConfig({ model: { id: 42 } })).toThrow(/model.id must be a string/);
});

test("parseConfig ignores unknown keys but keeps the known ones", () => {
  const config = parseConfig({ model: { id: "gpt-4o", nonsense: true }, extra: 1 });
  expect(config).toEqual({ model: { id: "gpt-4o" } });
});

test("parseConfig rejects a non-object agents entry", () => {
  expect(() => parseConfig({ agents: { work: "claude" } })).toThrow(/agents.work must be an object/);
});
