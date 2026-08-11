// Node-floor SqlDriver implementation over `better-sqlite3`.
// This is the driver `openDatabase` picks off Bun (Node 22+); the Bun path uses
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
import { BUSY_TIMEOUT_MS } from "./driver.js";
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from "./driver.js";

/** The slice of the better-sqlite3 surface this driver uses. */
interface NativeStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}
/**
 * better-sqlite3's transaction wrapper: itself callable (a deferred BEGIN), with
 * the transaction modes attached as methods. Only the two this driver uses are
 * declared — `immediate` for writes, `deferred` for read-only snapshots; see the
 * contracts on `SqlDriver.transaction` and `SqlDriver.readTransaction`. (The
 * binding also offers `exclusive`, which the kernel has no use for.)
 */
interface NativeTransaction<T> {
  (): T;
  immediate(): T;
  deferred(): T;
}
interface NativeDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): NativeStatement;
  /** Returns a function that runs `fn` wrapped in BEGIN/COMMIT (rolls back on throw). */
  transaction<T>(fn: () => T): NativeTransaction<T>;
  close(): void;
}
interface NativeConstructor {
  new (path: string): NativeDatabase;
}

// One message for every way better-sqlite3 can fail to load — covering both the
// "not installed at all" case (the require throws) and the more common "installed
// but its native binary was never built" case (the require succeeds, then `new
// Database` throws "Could not locate the bindings file"). The latter is what
// package managers that skip dependency build scripts by default — pnpm, Bun —
// leave behind, so the fix is named explicitly rather than left as a raw bindings
// error the user has to decode.
const BETTER_SQLITE3_LOAD_HELP =
  "Asterism's Node SQLite driver could not load the native package 'better-sqlite3' — " +
  "it is either not installed or its native binary was not built for this platform. Some " +
  "package managers (pnpm, Bun) skip dependencies' build scripts by default: approve the " +
  "build (e.g. `pnpm approve-builds`) and reinstall so the prebuilt binary is fetched. " +
  "Or run Asterism under Bun or Deno, which use a built-in SQLite and need no native build.";

/** Resolve better-sqlite3's Database constructor once, on first use (off Bun only). */
let DatabaseCtor: NativeConstructor | undefined;
function loadDatabaseCtor(): NativeConstructor {
  if (DatabaseCtor === undefined) {
    const require = createRequire(import.meta.url);
    let ctor: NativeConstructor;
    try {
      ctor = require("better-sqlite3") as NativeConstructor;
    } catch (cause) {
      throw new Error(BETTER_SQLITE3_LOAD_HELP, { cause });
    }
    // better-sqlite3 loads its native binding lazily, at the FIRST construction —
    // not at require — so a skipped/unbuilt `.node` only surfaces when a Database
    // is opened. Force that load now with an in-memory probe: a `:memory:` open
    // touches no filesystem, so a failure here can only be the binding failing to
    // load (missing/unbuilt binary, ABI mismatch), never a path/permission error.
    // That keeps the friendly message scoped to genuine load failures and lets the
    // real `new Database(path)` surface ordinary open errors (e.g. SQLITE_CANTOPEN
    // for a missing directory) unchanged.
    try {
      new ctor(":memory:").close();
    } catch (cause) {
      throw new Error(BETTER_SQLITE3_LOAD_HELP, { cause });
    }
    DatabaseCtor = ctor;
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
    // loadDatabaseCtor has already proven the native binding loads (via an
    // in-memory probe), so any throw from this open is a real database error —
    // a bad path, a missing directory, denied permissions — and must surface
    // unchanged rather than be masked as a build problem.
    const Database = loadDatabaseCtor();
    this.db = new Database(path);
    // Set through the pragma rather than better-sqlite3's `timeout` constructor
    // option, even though this is the one binding that has such an option: the
    // pragma is the only mechanism all three drivers share, and using the native
    // option here would re-create exactly the per-runtime divergence
    // BUSY_TIMEOUT_MS exists to remove. Issued FIRST for the same reason as the
    // other drivers — `journal_mode = WAL` can itself return SQLITE_BUSY.
    //
    // This is a no-op in value terms on this driver (better-sqlite3 already
    // defaults to 5000); it is written down so the value is owned by the kernel
    // and cannot drift if the binding changes its default.
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
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
    // BEGIN/COMMIT, rolling back if it throws. `.immediate()` runs it as BEGIN
    // IMMEDIATE so the write lock is taken up front rather than upgraded from a
    // read snapshot — see the contract on `SqlDriver.transaction`.
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
