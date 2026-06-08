import { expect, test } from "bun:test";

test("@qmilab/asterism-server package loads", async () => {
  const mod = await import("./index.ts");
  expect(mod).toBeDefined();
});
