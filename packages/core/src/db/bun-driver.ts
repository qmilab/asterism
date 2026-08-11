// Bun-first SqlDriver implementation over `bun:sqlite`.
// This is the only module in core that touches a concrete SQLite binding.
//
// The binding is loaded LAZILY (via `createRequire`) rather than a static
// `import … from "bun:sqlite"`. A static import of a Bun-only module makes the
// whole module graph fail to *load* under Node ESM (ERR_MODULE_NOT_FOUND) — even
// for callers that only want core's pure, importable surface (types, trust,
// firewall, the CLI's `runCli`). Deferring resolution to driver construction
// means the Bun module is required only when a Bun driver is actually built,
// which `openDatabase` only does under Bun (it guards on `typeof Bun`). The
// deferred Node-floor driver slots in at `openDatabase` without touching this.

import { createRequire } from "node:module";
import type { Database as BunDatabase, Statement } from "bun:sqlite";
import { BUSY_TIMEOUT_MS } from "./driver.js";
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from "./driver.js";

/** Resolve `bun:sqlite`'s Database constructor once, on first use (Bun only). */
let DatabaseCtor: typeof BunDatabase | undefined;
function loadDatabaseCtor(): typeof BunDatabase {
  if (DatabaseCtor === undefined) {
    const require = createRequire(import.meta.url);
    DatabaseCtor = (require("bun:sqlite") as typeof import("bun:sqlite")).Database;
  }
  return DatabaseCtor;
}

class BunStatement implements SqlStatement {
  constructor(private readonly stmt: Statement) {}

  run(params: readonly SqlValue[] = []): void {
    this.stmt.run(...(params as SqlValue[]));
  }

  get(params: readonly SqlValue[] = []): SqlRow | undefined {
    return (this.stmt.get(...(params as SqlValue[])) as SqlRow | null) ?? undefined;
  }

  all(params: readonly SqlValue[] = []): SqlRow[] {
    return this.stmt.all(...(params as SqlValue[])) as SqlRow[];
  }
}

export class BunSqlDriver implements SqlDriver {
  private readonly db: BunDatabase;

  constructor(path: string) {
    const Database = loadDatabaseCtor();
    this.db = new Database(path);
    // busy_timeout FIRST: `journal_mode = WAL` takes locks and can itself return
    // SQLITE_BUSY when another process is opening the same store, so a timeout
    // set after it would not cover the statement most likely to contend at open.
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    return new BunStatement(this.db.query(sql));
  }

  transaction<T>(fn: () => T): T {
    // `bun:sqlite` returns a function that runs `fn` wrapped in BEGIN/COMMIT,
    // rolling back if it throws. `.immediate()` runs it as BEGIN IMMEDIATE so the
    // write lock is taken up front rather than upgraded from a read snapshot —
    // see the contract on `SqlDriver.transaction`, which the seam requires of
    // every driver, not just this one.
    return this.db.transaction(fn).immediate();
  }

  readTransaction<T>(fn: () => T): T {
    // Deferred on purpose — a read-only snapshot must not take the write lock.
    return this.db.transaction(fn).deferred();
  }

  close(): void {
    this.db.close();
  }
}
