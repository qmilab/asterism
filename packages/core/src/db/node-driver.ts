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
    try {
      DatabaseCtor = require("better-sqlite3") as NativeConstructor;
    } catch (cause) {
      throw new Error(BETTER_SQLITE3_LOAD_HELP, { cause });
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
    // better-sqlite3 resolves its native binding HERE, not at require time, so an
    // install that fetched the JS but never built/downloaded the `.node` (a skipped
    // build script) surfaces as a raw "Could not locate the bindings file" on this
    // line. Translate it into the same actionable message as a missing package.
    try {
      this.db = new Database(path);
    } catch (cause) {
      throw new Error(BETTER_SQLITE3_LOAD_HELP, { cause });
    }
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
