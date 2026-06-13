// Deno SqlDriver implementation over the built-in `node:sqlite` module.
// This is the driver `openDatabase` picks under Deno; Node uses `better-sqlite3`
// (see node-driver.ts) and Bun uses `bun:sqlite` (see bun-driver.ts). All three
// are the only modules in core that touch a concrete SQLite binding.
//
// Why a third driver instead of reusing the Node one: `better-sqlite3` is a
// legacy V8/nan native addon, and Deno deliberately does not expose the V8
// internals that ABI needs — so it cannot load under Deno at any version (the
// runtime says as much and points at `node:sqlite`). `node:sqlite` is built into
// the runtime, needs no native build and no install-script approval, and Deno
// implements it — making it the clean, dependency-free store for the Deno path.
//
// The binding is loaded LAZILY (via `createRequire`) for the same reason the
// other drivers defer theirs: a static `import … from "node:sqlite"` would make
// the whole module graph fail to load on Node 20 (where the module does not yet
// exist) even for callers that only want core's pure, importable surface. We
// resolve it on first use, which `openDatabase` only reaches under Deno.
//
// Types are declared locally rather than pulled from a Deno/Node type package:
// the surface used is a handful of methods, and a local interface keeps the
// dependency footprint to the runtime alone.

import { createRequire } from "node:module";
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from "./driver.js";

/** The slice of the `node:sqlite` surface this driver uses. */
interface BuiltinStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}
interface BuiltinDatabase {
  exec(sql: string): void;
  prepare(sql: string): BuiltinStatement;
  close(): void;
}
interface BuiltinConstructor {
  new (path: string): BuiltinDatabase;
}

/** Resolve `node:sqlite`'s DatabaseSync constructor once, on first use (Deno only). */
let DatabaseCtor: BuiltinConstructor | undefined;
function loadDatabaseCtor(): BuiltinConstructor {
  if (DatabaseCtor === undefined) {
    const require = createRequire(import.meta.url);
    try {
      DatabaseCtor = (require("node:sqlite") as { DatabaseSync: BuiltinConstructor }).DatabaseSync;
    } catch (cause) {
      throw new Error(
        "The Deno SQLite driver needs the built-in 'node:sqlite' module, which this " +
          "runtime does not provide. Run Asterism under a current Deno (or Node 22.5+), " +
          "or run it under Node with better-sqlite3 installed, or under Bun.",
        { cause },
      );
    }
  }
  return DatabaseCtor;
}

class BuiltinSqlStatement implements SqlStatement {
  constructor(private readonly stmt: BuiltinStatement) {}

  // `node:sqlite` binds positional params from spread args and accepts a
  // Uint8Array as a blob directly (no Buffer wrap, unlike better-sqlite3), so
  // every SqlValue passes straight through.
  run(params: readonly SqlValue[] = []): void {
    this.stmt.run(...params);
  }

  get(params: readonly SqlValue[] = []): SqlRow | undefined {
    return (this.stmt.get(...params) as SqlRow | null | undefined) ?? undefined;
  }

  all(params: readonly SqlValue[] = []): SqlRow[] {
    return this.stmt.all(...params) as SqlRow[];
  }
}

export class NodeBuiltinSqlDriver implements SqlDriver {
  private readonly db: BuiltinDatabase;

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
    return new BuiltinSqlStatement(this.db.prepare(sql));
  }

  // `node:sqlite` exposes no transaction helper (unlike better-sqlite3 and
  // bun:sqlite), so drive BEGIN/COMMIT by hand and roll back on throw. The kernel
  // never nests `transaction()` calls — store methods wrap repository writes, and
  // the one repository method that opens its own transaction
  // (`EventRepository.followSnapshot`, a read for a consistent backlog+cursor) is
  // only ever called on its own — so a flat BEGIN/COMMIT, which cannot nest, is
  // sufficient here.
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
