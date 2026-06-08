// Bun-first SqlDriver implementation over `bun:sqlite`.
// This is the only module in core that imports a concrete SQLite binding.

import { Database } from "bun:sqlite";
import type { Statement } from "bun:sqlite";
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from "./driver";

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
  private readonly db: Database;

  constructor(path: string) {
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

  close(): void {
    this.db.close();
  }
}
