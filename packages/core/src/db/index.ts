import type { SqlDriver } from "./driver";
import { BunSqlDriver } from "./bun-driver";

export type { SqlDriver, SqlStatement, SqlRow, SqlValue } from "./driver";

/**
 * Open a local SQLite database. Defaults to an in-memory database.
 *
 * Bun-first: Phase 0 uses the `bun:sqlite` driver. A Node-floor driver
 * (node:sqlite / better-sqlite3) implementing the same `SqlDriver` interface
 * slots in here; nothing else in core touches a concrete binding.
 */
export function openDatabase(path = ":memory:"): SqlDriver {
  if (typeof Bun === "undefined") {
    throw new Error(
      "No SQLite driver available for this runtime. Phase 0 ships the bun:sqlite " +
        "driver; run under Bun, or provide a Node SqlDriver implementation.",
    );
  }
  return new BunSqlDriver(path);
}
