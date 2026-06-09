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
    // rolling back if it throws. Invoke it immediately.
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
