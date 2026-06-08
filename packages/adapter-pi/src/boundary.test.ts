import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Golden rule 6: Pi is a replaceable substrate. All Pi-specific code lives in
// `adapter-pi` behind `RuntimeAdapter`; nothing outside this package may import
// Pi. This test enforces that at the source level so the boundary can't erode.

const PACKAGES_DIR = join(import.meta.dir, "..", "..");
const PI_IMPORT = /["']@earendil-works\//;

function tsSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...tsSources(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("adapter boundary", () => {
  test("no package outside adapter-pi imports Pi", () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(PACKAGES_DIR)) {
      if (pkg === "adapter-pi") continue;
      const srcDir = join(PACKAGES_DIR, pkg, "src");
      let files: string[];
      try {
        files = tsSources(srcDir);
      } catch {
        continue; // package has no src/ yet
      }
      for (const file of files) {
        if (PI_IMPORT.test(readFileSync(file, "utf8"))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("adapter-pi does import Pi — the boundary is real, not vacuous", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(PI_IMPORT.test(src)).toBe(true);
  });
});
