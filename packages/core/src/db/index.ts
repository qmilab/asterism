import type { SqlDriver } from "./driver.js";
import { BunSqlDriver } from "./bun-driver.js";
import { NodeSqlDriver } from "./node-driver.js";

export type { SqlDriver, SqlStatement, SqlRow, SqlValue } from "./driver.js";

/**
 * Open a local SQLite database. Defaults to an in-memory database.
 *
 * Runtime-neutral: under Bun it uses the built-in `bun:sqlite` driver; off Bun
 * (Node 20+) it uses the `better-sqlite3` driver. Both implement the same
 * `SqlDriver`, so nothing else in core depends on which runtime opened the
 * database. Each concrete binding is loaded lazily inside its own driver, so
 * importing this module never pulls a binding the current runtime will not use.
 */
export function openDatabase(path = ":memory:"): SqlDriver {
  if (typeof Bun !== "undefined") {
    return new BunSqlDriver(path);
  }
  return new NodeSqlDriver(path);
}
