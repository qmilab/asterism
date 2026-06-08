import { expect, test } from "bun:test";

test("@qmilab/asterism-reflect package loads", async () => {
  const mod = await import("./index.ts");
  expect(mod).toBeDefined();
});
