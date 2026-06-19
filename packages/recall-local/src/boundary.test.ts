import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The opt-in guarantee, enforced at the source level: the local-embeddings recall
// provider lives OUTSIDE the default install path. An install that never opts an
// agent in must never load this package — so nothing may import it STATICALLY at the
// top level. The CLI reaches it only through a dynamic `import()`, and only for an
// agent whose `recallProvider` setting is set. This test makes that boundary real so
// it can't erode (mirrors `adapter-pi/boundary.test.ts` for the Pi seam).
//
// Bonus property this gives for free: the package carries no ML dependency at all (it
// is a thin HTTP client), so "the default install pulls no ML" holds by construction
// — there is no heavy dependency anywhere to lazy-load.

const PACKAGES_DIR = join(import.meta.dir, "..", "..");
const PKG = "@qmilab/asterism-recall-local";
// A STATIC import of the package: `import ... from "@qmilab/asterism-recall-local"`.
// A dynamic `import("@qmilab/asterism-recall-local")` would not match (no `from`).
const STATIC_IMPORT = new RegExp(`\\bfrom\\s+["']${PKG.replace(/[/-]/g, "\\$&")}["']`);
const TS_SOURCE = /\.(ts|mts|cts|tsx)$/;

function tsSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...tsSources(full));
    else if (TS_SOURCE.test(entry)) files.push(full);
  }
  return files;
}

describe("opt-in boundary", () => {
  test("no package statically imports the recall-local package except the CLI's lazy host module", () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(PACKAGES_DIR)) {
      if (pkg === "recall-local") continue; // the package's own sources may import itself
      const pkgDir = join(PACKAGES_DIR, pkg);
      let files: string[];
      try {
        if (!statSync(pkgDir).isDirectory()) continue;
        files = tsSources(pkgDir);
      } catch {
        continue;
      }
      for (const file of files) {
        // The CLI's `recall-provider.ts` is the one permitted importer — and it is
        // itself loaded only via a dynamic import (asserted below). Tests may import
        // the package freely (they are not on the install path).
        if (file.endsWith("recall-provider.ts") || file.endsWith(".test.ts")) continue;
        if (STATIC_IMPORT.test(readFileSync(file, "utf8"))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the CLI reaches the recall provider only through a dynamic import — never statically", () => {
    const cli = readFileSync(join(PACKAGES_DIR, "cli", "src", "cli.ts"), "utf8");
    // It dynamically imports the lazy host module...
    expect(cli.includes('await import("./recall-provider.js")')).toBe(true);
    // ...and never statically imports it (which would pull the package onto every path).
    expect(/\bfrom\s+["']\.\/recall-provider\.js["']/.test(cli)).toBe(false);
  });

  test("the boundary is not vacuous — the host module does import the package", () => {
    const host = readFileSync(join(PACKAGES_DIR, "cli", "src", "recall-provider.ts"), "utf8");
    expect(STATIC_IMPORT.test(host)).toBe(true);
  });
});
