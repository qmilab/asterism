#!/usr/bin/env node
// Refuse tracked SQLite artifacts.
//
// A database that gets committed is never meant to be there: it is local runtime state, it
// bloats the repo, and it leaves a stray store in every checkout. `.gitignore` covers the
// usual names (`*.db`, `*.sqlite`, and the `-wal` / `-shm` sidecars), but a name-based rule
// is only as good as the name — a debugging session that passes the wrong argument to
// `AsterismStore.open()` creates a perfectly valid database called `x`, or `--`, or whatever
// the stray token happened to be. That has happened, which is why this exists.
//
// So the check is on CONTENT, not on filename:
//
//   - a SQLite database starts with the 16-byte header `SQLite format 3\0`
//   - a write-ahead log starts with magic 0x377f0682 or 0x377f0683
//   - a shared-memory file has no magic at all, so it is caught by name — it only ever
//     appears beside a database, and the other two rules catch that database
//
// Reads only the first 16 bytes of each tracked file, so it stays cheap on a large tree.

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const WAL_MAGICS = [0x377f0682, 0x377f0683];

/** The first `n` bytes of a file, or an empty buffer if it cannot be read. */
function head(path, n = 16) {
  let fd;
  try {
    if (!statSync(path).isFile()) return Buffer.alloc(0);
    fd = openSync(path, "r");
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function classify(path) {
  const bytes = head(path);
  if (bytes.length >= 16 && bytes.subarray(0, 16).equals(SQLITE_HEADER)) {
    return "a SQLite database";
  }
  if (bytes.length >= 4 && WAL_MAGICS.includes(bytes.readUInt32BE(0))) {
    return "a SQLite write-ahead log";
  }
  if (/-shm$/.test(path)) return "a SQLite shared-memory file";
  return undefined;
}

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const offenders = tracked
  .map((path) => ({ path, kind: classify(path) }))
  .filter((f) => f.kind !== undefined);

if (offenders.length > 0) {
  console.error(`Refusing ${offenders.length} tracked database artifact(s):\n`);
  for (const { path, kind } of offenders) console.error(`  ${path} — ${kind}`);
  console.error(
    "\nThese are local runtime state, not source. Remove them from the index:\n" +
      `  git rm --cached ${offenders.map((f) => JSON.stringify(f.path)).join(" ")}\n` +
      "\nIf one was created by a script, check what path it was handed — a database named\n" +
      "after a stray argument is the usual cause.",
  );
  process.exit(1);
}

console.log(`No database artifacts among ${tracked.length} tracked files.`);
