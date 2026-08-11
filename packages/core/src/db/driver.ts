// Minimal SQLite driver seam.
//
// Repositories depend only on this interface — never on a concrete binding —
// so the SQLite implementation is swappable. Phase 0 ships a `bun:sqlite`
// driver (Bun-first); a Node driver (node:sqlite / better-sqlite3) implementing
// the same interface is the Node-floor fallback and slots in at `openDatabase`.

/**
 * How long a connection waits for a contended database lock before giving up,
 * in milliseconds. Every driver applies this, so the store behaves the same
 * whichever runtime opened it.
 *
 * It has to be set explicitly because the bindings do NOT agree on a default:
 * better-sqlite3 applies its own 5000 ms at construction, while `bun:sqlite` and
 * `node:sqlite` leave SQLite's default of 0 — a writer that finds the database
 * locked fails instantly instead of waiting. That divergence meant identical
 * kernel code had materially different concurrency behaviour per runtime. 5000
 * is better-sqlite3's value, chosen so the runtime that has been shipping it is
 * the one that does not change.
 *
 * The ceiling is safe because no transaction in the kernel can span an unbounded
 * wait: `SqlDriver.transaction` is synchronous by signature, every binding is
 * synchronous, and no call site passes an async callback — so a transaction can
 * never be held across a model call or a network round-trip. Anything that does
 * exhaust 5 s is a genuine pathology and still fails, just later.
 */
export const BUSY_TIMEOUT_MS = 5000;

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
  /**
   * Run `fn` inside a single transaction: its writes commit together on success
   * and roll back together if `fn` throws. The kernel uses this to keep paired
   * tables consistent (e.g. a credential row and its secret row), so a delete can
   * never leave one half behind.
   *
   * **IMMEDIATE, not deferred — this is part of the contract, not an
   * implementation detail.** A deferred transaction takes a READ snapshot at its
   * first statement and only tries to become a writer at the first write. In WAL
   * mode, if another connection committed in between, SQLite fails that upgrade
   * with `SQLITE_BUSY_SNAPSHOT` and **does not invoke the busy handler** — waiting
   * cannot help, because the snapshot is already stale. So {@link BUSY_TIMEOUT_MS}
   * does not cover that case and cannot be made to.
   *
   * Nearly every store method reads before it writes (a `findActive` guard, a
   * uniqueness check, a CAS precondition), which is exactly the shape that
   * upgrades. Taking the write lock up front at BEGIN removes the upgrade
   * entirely: contention becomes an ordinary lock wait, which the busy timeout
   * DOES cover. The two settings are halves of one fix — a busy timeout without
   * IMMEDIATE leaves the read-then-write races, and IMMEDIATE without a busy
   * timeout is far worse than either, because every transaction then contends up
   * front with nothing to wait on.
   */
  transaction<T>(fn: () => T): T;
  /**
   * Run `fn` inside a DEFERRED, read-only transaction: several reads see one
   * consistent snapshot of the database. For reads only — a write inside `fn` is
   * the read-then-write upgrade {@link transaction} exists to avoid, and will
   * fail under concurrency with `SQLITE_BUSY_SNAPSHOT`.
   *
   * Deliberately NOT `IMMEDIATE`, and the difference is not academic. A WAL
   * reader blocks nobody, so a deferred read transaction costs a concurrent
   * writer nothing; an IMMEDIATE one takes the write lock and makes every reader
   * compete with every writer for it. Measured on the `events tail --follow`
   * poll loop (its only caller): with this transaction IMMEDIATE, a concurrent
   * writer managed 246 writes in four seconds; deferred, it managed 30,227. The
   * poller wins the lock fight and starves the thing it is watching.
   */
  readTransaction<T>(fn: () => T): T;
  close(): void;
}
