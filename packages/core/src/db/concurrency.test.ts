// Driver concurrency contract — the two settings that let two processes share one
// store, and the one place they must NOT both apply.
//
// Every test here uses a real FILE database and TWO driver instances, because that
// is the only way to get two genuine SQLite connections: `:memory:` gives each
// connection a private database, so a lock test against it proves nothing. Two
// connections in one process are still real connections — what they cannot model
// is *waiting*, since both bindings are synchronous and a blocked writer would
// deadlock the single thread. So every assertion below is arranged around a
// zero-timeout probe connection that fails instantly instead of waiting, and the
// waiting behaviour is proven cross-process in `scripts/node-acceptance.mjs` and
// `scripts/deno-acceptance.mjs` instead.
//
// Note `bun test` only ever exercises `bun:sqlite`. The Node and Deno drivers are
// covered by the acceptance scripts — which is the whole reason this gap could sit
// in two of three drivers unnoticed.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUSY_TIMEOUT_MS, openDatabase, type SqlDriver } from "./index.js";

let dir: string;
let dbPath: string;
let a: SqlDriver;
let b: SqlDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "asterism-concurrency-"));
  dbPath = join(dir, "store.db");
  a = openDatabase(dbPath);
  b = openDatabase(dbPath);
  a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
});

afterEach(() => {
  a.close();
  b.close();
  // Remove the whole temp dir, WAL and shm sidecars included — a stray database
  // file is what `scripts/no-db-artifacts.mjs` exists to catch.
  rmSync(dir, { recursive: true, force: true });
});

/** Can `driver` write right now, without waiting? Never blocks: its timeout is 0. */
function writesWithoutWaiting(driver: SqlDriver, value: string): boolean {
  driver.exec("PRAGMA busy_timeout = 0");
  try {
    driver.prepare("INSERT INTO t (v) VALUES (?)").run([value]);
    return true;
  } catch {
    return false;
  }
}

test("the busy timeout is 5000ms — the settled value, pinned as a literal", () => {
  // Deliberately NOT `toBe(BUSY_TIMEOUT_MS)`: comparing the constant to itself
  // passes for any value, so it could not notice the number changing. 5000 is a
  // settled decision (it is what better-sqlite3, and so every Node install, has
  // always used), and changing it should have to be deliberate enough to edit a
  // test.
  expect(BUSY_TIMEOUT_MS).toBe(5000);
});

test("the driver applies the kernel's busy timeout to every connection", () => {
  // Read SQLite's own state back rather than trusting that a pragma string was
  // issued — this asserts the setting took effect on the connection. Per-connection
  // is the point: the pragma is not a database-level setting, so every connection
  // the driver opens has to set it for itself.
  expect(a.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: BUSY_TIMEOUT_MS });
  expect(b.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: BUSY_TIMEOUT_MS });
});

test("adding the busy timeout left the driver's other pragmas in effect", () => {
  expect(a.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(a.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
});
// NOT asserted here: that `busy_timeout` is issued BEFORE `journal_mode`. The
// ordering only has consequences when a second process is converting the same
// database to WAL, and asserting it in-process would need a blocked writer —
// which deadlocks a single thread against a synchronous binding. Claiming it from
// a `journal_mode` read would be a test that passes with the pragmas in either
// order, i.e. one that proves nothing. It is proven cross-process in the Node and
// Deno acceptance scripts instead.

test("a write transaction holds the write lock from BEGIN, not from its first write", () => {
  // The load-bearing property. A DEFERRED transaction would let `b` commit here,
  // and `a`'s own write would then fail with SQLITE_BUSY_SNAPSHOT — which no busy
  // timeout can rescue, because SQLite does not invoke the busy handler for a
  // stale-snapshot upgrade.
  let couldInterleave: boolean | undefined;
  const returned = a.transaction(() => {
    a.prepare("SELECT count(*) AS c FROM t").get(); // read first: the upgrade shape
    couldInterleave = writesWithoutWaiting(b, "from-b");
    a.prepare("INSERT INTO t (v) VALUES (?)").run(["from-a"]);
    return "committed";
  });

  expect(couldInterleave).toBe(false);
  expect(returned).toBe("committed");
  // And the transaction really did commit — the read-then-write that used to be
  // the failure mode now completes.
  expect(a.prepare("SELECT v FROM t").all()).toEqual([{ v: "from-a" }]);
});

test("a read transaction does NOT hold the write lock", () => {
  // The counterweight, and not a nicety: `readTransaction` is what `events tail
  // --follow` polls on. Taking the write lock for a pure read lets the poller win
  // the lock fight and starve the writers it is watching.
  let writerGotThrough: boolean | undefined;
  a.readTransaction(() => {
    a.prepare("SELECT count(*) AS c FROM t").get();
    writerGotThrough = writesWithoutWaiting(b, "from-b");
  });

  expect(writerGotThrough).toBe(true);
});

test("a read transaction still sees one consistent snapshot", () => {
  // Being deferred must not cost the isolation the caller opened a transaction
  // for: a commit landing mid-read is invisible until the transaction ends.
  a.prepare("INSERT INTO t (v) VALUES (?)").run(["first"]);

  const seen: number[] = [];
  a.readTransaction(() => {
    seen.push(Number(a.prepare("SELECT count(*) AS c FROM t").get()!.c));
    writesWithoutWaiting(b, "second");
    seen.push(Number(a.prepare("SELECT count(*) AS c FROM t").get()!.c));
  });

  expect(seen).toEqual([1, 1]);
  // ...and the write was genuinely committed, so the snapshot hid it rather than
  // the insert having silently failed — otherwise this test would pass for the
  // wrong reason.
  expect(Number(a.prepare("SELECT count(*) AS c FROM t").get()!.c)).toBe(2);
});

test("a failed transaction rolls back and leaves the lock free", () => {
  expect(() =>
    a.transaction(() => {
      a.prepare("INSERT INTO t (v) VALUES (?)").run(["doomed"]);
      throw new Error("boom");
    }),
  ).toThrow("boom");

  expect(a.prepare("SELECT count(*) AS c FROM t").get()).toEqual({ c: 0 });
  // The rollback released the write lock rather than stranding it.
  expect(writesWithoutWaiting(b, "after")).toBe(true);
});
