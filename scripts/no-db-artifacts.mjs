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

/** Tracked paths this run could not read, and so could not vouch for. */
const unchecked = [];

/**
 * The first `n` bytes of a file. Returns an empty buffer for something that is not a
 * regular file (a submodule directory, say), and records anything it could not READ.
 *
 * The distinction matters: a guard that cannot see a file must not report "all clear" for
 * it. Silently skipping an unreadable path is how a check like this quietly stops checking.
 * A fresh checkout has every tracked file readable, so an unreadable one is itself the
 * anomaly — it is reported and fails the run rather than being waved through.
 */
function head(path, n = 16) {
  let fd;
  try {
    if (!statSync(path).isFile()) return Buffer.alloc(0);
    fd = openSync(path, "r");
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } catch (err) {
    // ENOENT on a tracked path means the working tree is mid-operation, not that the file
    // is suspicious; anything else (EACCES, EISDIR, EIO) means we genuinely could not look.
    if (err?.code !== "ENOENT") unchecked.push(`${path} (${err?.code ?? "unreadable"})`);
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

if (unchecked.length > 0) {
  console.error(`Could not read ${unchecked.length} tracked file(s), so this run vouches for nothing:\n`);
  for (const entry of unchecked) console.error(`  ${entry}`);
  console.error("\nEvery tracked file is readable in a fresh checkout. Fix the permissions,\nor remove the file from the index if it does not belong there.");
  process.exit(1);
}

/**
 * Quote a path for a POSIX shell. Single quotes suppress every expansion, with `'` itself
 * escaped by closing, emitting a literal, and reopening.
 *
 * `JSON.stringify` is NOT good enough here even though it looks like quoting: it produces
 * DOUBLE quotes, inside which a shell still performs command substitution. A tracked file
 * named `$(id -u).db` — git permits nearly any byte in a filename — would print as
 * `git rm --cached "$(id -u).db"`, and a maintainer copying that line out of a CI log would
 * execute the substitution. The offending paths are untrusted input, and this line exists to
 * be pasted, so it has to be safe to paste. [Codex review P2.]
 */
function shellQuote(path) {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

if (offenders.length > 0) {
  console.error(`Refusing ${offenders.length} tracked database artifact(s):\n`);
  for (const { path, kind } of offenders) console.error(`  ${path} — ${kind}`);
  console.error(
    "\nThese are local runtime state, not source. Remove them from the index:\n" +
      // `--` ends option parsing, so a path beginning with `-` is treated as a path.
      `  git rm --cached -- ${offenders.map((f) => shellQuote(f.path)).join(" ")}\n` +
      "\nIf one was created by a script, check what path it was handed — a database named\n" +
      "after a stray argument is the usual cause.",
  );
  process.exit(1);
}

console.log(`No database artifacts among ${tracked.length} tracked files.`);
