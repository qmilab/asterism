import { expect, test } from "bun:test";

import pkg from "../package.json";
import { VERSION } from "./version.ts";

// The package entry (`index.ts`) is import-safe — the self-executing bin lives in
// bin.ts. So importing it here must not run a command or exit the process; it
// must simply expose the programmatic surface.
test("the package entry is import-safe and exposes runCli", async () => {
  const mod = await import("./index.ts");
  expect(typeof mod.runCli).toBe("function");
});

// The one invariant the bin depends on: the reported version tracks the package.
test("VERSION matches the package version", () => {
  expect(VERSION).toBe((pkg as { version: string }).version);
});
