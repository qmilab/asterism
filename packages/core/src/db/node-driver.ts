// Node-floor SqlDriver implementation over `better-sqlite3`.
// This is the driver `openDatabase` picks off Bun (Node 20+); the Bun path uses
// `bun:sqlite` (see bun-driver.ts). Both are the only modules in core that touch
// a concrete SQLite binding.
//
// The binding is loaded LAZILY (via `createRequire`) for the same reason the Bun
// driver defers `bun:sqlite`: a static import of the native module would force
// every consumer of core's pure, importable surface (types, trust, firewall, the
// CLI's `runCli`) to have better-sqlite3 installed and built — including Bun runs
// that never touch it. Deferring resolution to driver construction means the
// native module is required only when a Node driver is actually built, which
// `openDatabase` only does off Bun.
//
// Types are declared locally rather than pulled from `@types/better-sqlite3`: the
// surface used is four methods, and a local interface keeps the dependency to the
// runtime package alone (no extra dev type package, no `export =` interop quirk).

import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from "./driver.js";

/** The slice of the better-sqlite3 surface this driver uses. */
interface NativeStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}
interface NativeDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): NativeStatement;
  /** Returns a function that runs `fn` wrapped in BEGIN/COMMIT (rolls back on throw). */
  transaction<T>(fn: () => T): () => T;
  close(): void;
}
interface NativeConstructor {
  new (path: string): NativeDatabase;
}

/** Resolve better-sqlite3's Database constructor once, on first use (off Bun only). */
let DatabaseCtor: NativeConstructor | undefined;
function loadDatabaseCtor(): NativeConstructor {
  if (DatabaseCtor === undefined) {
    const require = createRequire(import.meta.url);
    try {
      DatabaseCtor = require("better-sqlite3") as NativeConstructor;
    } catch (cause) {
      throw new Error(
        "The Node SQLite driver needs the native package 'better-sqlite3', which is " +
          "not installed or failed to build for this platform. Reinstall dependencies, " +
          "or run Asterism under Bun (which uses the built-in bun:sqlite driver).",
        { cause },
      );
    }
  }
  return DatabaseCtor;
}

// Map driver params to bindings the native module accepts: it takes a Buffer for
// blob values, so a plain Uint8Array must be wrapped. Buffer extends Uint8Array,
// so a value that is already a Buffer passes straight through; everything else
// (string, number, bigint, null) binds as-is.
function bindings(params: readonly SqlValue[]): SqlValue[] {
  return params.map((p) => (p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p) : p));
}

class NodeStatement implements SqlStatement {
  constructor(private readonly stmt: NativeStatement) {}

  run(params: readonly SqlValue[] = []): void {
    this.stmt.run(...bindings(params));
  }

  get(params: readonly SqlValue[] = []): SqlRow | undefined {
    return (this.stmt.get(...bindings(params)) as SqlRow | null) ?? undefined;
  }

  all(params: readonly SqlValue[] = []): SqlRow[] {
    return this.stmt.all(...bindings(params)) as SqlRow[];
  }
}

export class NodeSqlDriver implements SqlDriver {
  private readonly db: NativeDatabase;

  constructor(path: string) {
    const Database = loadDatabaseCtor();
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    return new NodeStatement(this.db.prepare(sql));
  }

  transaction<T>(fn: () => T): T {
    // better-sqlite3, like bun:sqlite, returns a function that runs `fn` inside a
    // BEGIN/COMMIT, rolling back if it throws. Invoke it immediately.
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
