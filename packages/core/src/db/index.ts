import type { SqlDriver } from "./driver.js";
import { BunSqlDriver } from "./bun-driver.js";
import { NodeSqlDriver } from "./node-driver.js";
import { NodeBuiltinSqlDriver } from "./node-builtin-driver.js";

export type { SqlDriver, SqlStatement, SqlRow, SqlValue } from "./driver.js";

/**
 * Open a local SQLite database. Defaults to an in-memory database.
 *
 * Runtime-neutral, picking the store each runtime can actually load:
 * - **Bun** → the built-in `bun:sqlite`.
 * - **Deno** → the built-in `node:sqlite`. Deno cannot load `better-sqlite3`
 *   (a legacy V8/nan native addon whose ABI Deno does not expose), so it gets
 *   the runtime's own SQLite instead — no native build, no install-script gate.
 * - **Node 20+** → `better-sqlite3` (a native addon with prebuilt binaries).
 *
 * All three implement the same `SqlDriver`, so nothing else in core depends on
 * which runtime opened the database. Each concrete binding is loaded lazily
 * inside its own driver, so importing this module never pulls a binding the
 * current runtime will not use.
 */
export function openDatabase(path = ":memory:"): SqlDriver {
  if (typeof Bun !== "undefined") {
    return new BunSqlDriver(path);
  }
  // `Deno` is not a typed global here (no Deno type package), so probe it off
  // globalThis rather than referencing the bare name.
  if ((globalThis as { Deno?: unknown }).Deno !== undefined) {
    return new NodeBuiltinSqlDriver(path);
  }
  return new NodeSqlDriver(path);
}
