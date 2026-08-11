// Cross-process concurrency checks, shared by node-acceptance.mjs and
// deno-acceptance.mjs.
//
// This lives here, and not in `bun test`, because it is the only place the
// property can honestly be proven. Two reasons:
//
//   1. `bun test` only ever opens `bun:sqlite`. The Node driver (better-sqlite3)
//      and the Deno driver (node:sqlite) are never exercised by it — which is
//      exactly how a missing `busy_timeout` sat in two of three drivers unnoticed
//      (issue #119).
//   2. WAITING for a lock cannot be tested in-process. Every binding is
//      synchronous, so a blocked writer blocks the only thread it could be
//      released from. An in-process test can prove a lock is HELD (by probing
//      with a zero timeout that fails instantly); only a second process can prove
//      a blocked writer eventually gets through.
//
// The bug that prompted all this was found by a cross-process harness and was
// invisible to the in-process suite, so this is the check that would have caught
// it.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The worker, written to the temp dir so both runtimes can run the same file. */
function workerSource(coreDist) {
  return `
import { existsSync, writeFileSync } from "node:fs";
import { AsterismStore, openDatabase, BUSY_TIMEOUT_MS } from ${JSON.stringify(coreDist)};

const [role, dbPath, agentId, signal] = process.argv.slice(2);
const out = (o) => console.log(JSON.stringify(o));

if (role === "pragma") {
  const d = openDatabase(dbPath);
  out({ busyTimeout: d.prepare("PRAGMA busy_timeout").get(), expected: BUSY_TIMEOUT_MS,
        journalMode: d.prepare("PRAGMA journal_mode").get() });
  d.close();
} else if (role === "hammer") {
  // Both hammers race on the same read-then-write store path.
  const store = AsterismStore.open(dbPath);
  let ok = 0; const failures = [];
  for (let i = 0; i < 400; i++) {
    try { store.recordWorldFact(agentId, "subject-" + (i % 25), "value-" + i); ok++; }
    catch (e) { failures.push(String(e && e.code) + ":" + String(e && e.message)); }
  }
  store.close();
  out({ ok, failed: failures.length, sample: failures.slice(0, 3) });
} else if (role === "holder") {
  // Take the write lock and HOLD it, so the waiter has something real to wait on.
  const store = AsterismStore.open(dbPath);
  const driver = store.driver ?? store["driver"];
  driver.transaction(() => {
    store.events.append(agentId, { type: "holder.locked", payload: {} });
    writeFileSync(signal, "held");           // tell the waiter the lock is taken
    const until = Date.now() + 900;
    while (Date.now() < until) { /* hold it across real time */ }
  });
  store.close();
  out({ held: true });
} else if (role === "waiter") {
  while (!existsSync(signal)) { /* wait until the holder actually has the lock */ }
  // Opening runs SCHEMA + migrate() — writes — so this contends before any
  // application code runs. It is also why the busy pragma is issued before
  // journal_mode inside the driver constructor.
  const t0 = Date.now();
  let opened = false, wrote = false, error = null;
  try {
    const store = AsterismStore.open(dbPath);
    opened = true;
    store.events.append(agentId, { type: "waiter.wrote", payload: {} });
    wrote = true;
    store.close();
  } catch (e) { error = String(e && e.code) + ":" + String(e && e.message); }
  out({ opened, wrote, error, elapsedMs: Date.now() - t0 });
}
`;
}

/**
 * @param check   the acceptance script's assertion helper
 * @param spawnArgv (workerPath, args) => [command, argv] for THIS runtime
 * @param coreDist absolute path to packages/core/dist/index.js
 */
export async function concurrencyChecks({ check, spawnArgv, coreDist }) {
  const dir = mkdtempSync(join(tmpdir(), "asterism-concurrency-"));
  const worker = join(dir, "worker.mjs");
  const dbPath = join(dir, "store.db");
  writeFileSync(worker, workerSource(coreDist));

  const run = (args) =>
    new Promise((resolve, reject) => {
      const [cmd, argv] = spawnArgv(worker, args);
      const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", () => {
        const line = stdout.trim().split("\n").filter(Boolean).pop();
        if (!line) return reject(new Error(`worker produced no output: ${stderr.slice(-400)}`));
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`worker output was not JSON: ${line} / ${stderr.slice(-400)}`));
        }
      });
    });

  try {
    const { AsterismStore } = await import(coreDist);
    const seed = AsterismStore.open(dbPath);
    const agent = seed.createAgent({
      name: "concurrent",
      role: "r",
      soulRef: "s",
      workspaceDir: dir,
      trustLevel: "propose",
    });
    seed.close();

    // 1. The pragma is in effect on THIS runtime's driver — read back out of
    //    SQLite, not inferred from the source.
    const pragma = await run(["pragma", dbPath, agent.id, ""]);
    check(
      `this runtime's driver applies busy_timeout = ${pragma.expected}ms`,
      pragma.busyTimeout?.timeout === pragma.expected && pragma.expected === 5000,
    );
    check("WAL is still the journal mode", pragma.journalMode?.journal_mode === "wal");

    // 2. Two processes writing the same store concurrently, on the read-then-write
    //    path. This is the shape that failed before the fix: a deferred
    //    transaction's read→write upgrade returns SQLITE_BUSY_SNAPSHOT, which no
    //    busy timeout can rescue because SQLite skips the busy handler for it.
    const [left, right] = await Promise.all([
      run(["hammer", dbPath, agent.id, ""]),
      run(["hammer", dbPath, agent.id, ""]),
    ]);
    check(
      `two processes wrote concurrently with zero lock failures (${left.ok} + ${right.ok})`,
      left.failed === 0 && right.failed === 0 && left.ok === 400 && right.ok === 400,
    );

    // 3. A blocked writer WAITS instead of failing — the property no in-process
    //    test can show, and the one the busy timeout actually buys. The waiter
    //    both OPENS the store (SCHEMA + migrate, itself a write) and appends,
    //    while the holder sits on the write lock.
    const signal = join(dir, "held.signal");
    const [, waiter] = await Promise.all([
      run(["holder", dbPath, agent.id, signal]),
      run(["waiter", dbPath, agent.id, signal]),
    ]);
    check(
      `a writer blocked by another process still opened the store (waited ${waiter.elapsedMs}ms)`,
      waiter.opened === true,
    );
    check("...and completed its write rather than failing", waiter.wrote === true && !waiter.error);
    check(
      "...and got there by WAITING, not by finding the lock free",
      waiter.elapsedMs >= 150,
    );
    check("the holder's signal file was consumed", existsSync(signal));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
