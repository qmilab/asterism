import { expect, test } from "bun:test";

import pkg from "../package.json";
import { VERSION } from "./version.ts";

// The bin (`index.ts`) self-executes and calls process.exit, so it must not be
// imported here. Command behaviour is covered in cli.test.ts; this guards the one
// invariant the bin depends on: the reported version tracks the package version.
test("VERSION matches the package version", () => {
  expect(VERSION).toBe((pkg as { version: string }).version);
});
