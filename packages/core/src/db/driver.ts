// Minimal SQLite driver seam.
//
// Repositories depend only on this interface — never on a concrete binding —
// so the SQLite implementation is swappable. Phase 0 ships a `bun:sqlite`
// driver (Bun-first); a Node driver (node:sqlite / better-sqlite3) implementing
// the same interface is the Node-floor fallback and slots in at `openDatabase`.

export type SqlValue = string | number | bigint | null | Uint8Array;

export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
  run(params?: readonly SqlValue[]): void;
  get(params?: readonly SqlValue[]): SqlRow | undefined;
  all(params?: readonly SqlValue[]): SqlRow[];
}

export interface SqlDriver {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}
