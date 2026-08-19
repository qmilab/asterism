#!/usr/bin/env node
// Refuse tracked artifacts — files that are output, never source.
//
// Two kinds, and they arrive by different accidents.
//
// A DATABASE that gets committed is never meant to be there: it is local runtime state, it
// bloats the repo, and it leaves a stray store in every checkout. `.gitignore` covers the
// usual names (`*.db`, `*.sqlite`, and the `-wal` / `-shm` sidecars), but a name-based rule
// is only as good as the name — a debugging session that passes the wrong argument to
// `AsterismStore.open()` creates a perfectly valid database called `x`, or `--`, or whatever
// the stray token happened to be. That has happened, which is why this exists.
//
// A PACKED TARBALL arrives the other way round: from a step the release checklist asks for.
// `bun pm pack` against `packages/cli` is how a release cut confirms every `workspace:*`
// dependency resolved to a concrete version, and it drops a ~220 KB
// `qmilab-asterism-<version>.tgz` into the package directory. `.gitignore` now has a `*.tgz`
// rule, so it no longer shows up as untracked — but an ignore rule is a declaration, and a
// `git add -f` or a future edit to that rule is all it takes for one to land in a release
// commit. This is the half that is enforced. (CI never produces one in the tree:
// `release.yml` packs with `--destination` into a scratch directory.)
//
// So the check is on CONTENT, not on filename:
//
//   - a SQLite database starts with the 16-byte header `SQLite format 3\0`
//   - a write-ahead log starts with magic 0x377f0682 or 0x377f0683
//   - a shared-memory file has no magic at all, so it is caught by name — it only ever
//     appears beside a database, and the other two rules catch that database
//   - a packed npm tarball is gzip (`1f 8b`) wrapping a tar whose first entry is
//     `package/…` — which is what `npm pack` and `bun pm pack` both write, and what a
//     `.tgz` extension alone does not tell you
//
// Reads the first 16 bytes of each tracked file — and, only for the ones that start with the
// gzip magic, a further 4 KB to inflate the tar header out of. So it stays cheap on a large
// tree: the expensive path is taken by compressed files alone.
//
// `--self-test` proves it can still refuse and still clear: it plants one fixture of each
// kind in a throwaway git repo, RUNS this script there as a child process, and checks the
// exit code both ways. A guard that reports nothing and a guard that reports everything look
// identical from a single green run.

import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const WAL_MAGICS = [0x377f0682, 0x377f0683];
// A rollback journal's header magic. Present only SOMETIMES — see the note in `classify`.
const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
// gzip's two-byte magic, and the two things a tar header carries at fixed offsets: the
// entry name at 0, and the `ustar` format marker at 257.
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const TAR_NAME = { offset: 0, length: 100 };
const TAR_USTAR = { offset: 257, value: "ustar" };

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

/**
 * Whether a gzip file is an npm package tarball, rather than any other compressed thing.
 *
 * The extension does not answer this — that is the whole reason the database rules read
 * content — so it inflates the head of the stream and reads the first tar header. Both
 * `npm pack` and `bun pm pack` write every entry under a `package/` prefix, and a tar
 * header carries the `ustar` marker at a fixed offset, so the pair identifies the format
 * without unpacking anything.
 *
 * 4 KB of compressed input inflates to more than the 512 bytes a tar header occupies for
 * any real tarball (a 512-byte read already yields ~1 KB), and `Z_SYNC_FLUSH` is what makes
 * inflating a deliberately truncated stream return what it has instead of throwing. Any
 * failure — not gzip after all, corrupt, or too small to see a header in — answers "no":
 * this rule exists to name a specific artifact, and something it cannot identify is left to
 * the rules above rather than guessed at.
 */
function isPackedTarball(path) {
  const compressed = head(path, 4096);
  let tar;
  try {
    tar = gunzipSync(compressed, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
  } catch {
    return false;
  }
  if (tar.length < TAR_USTAR.offset + TAR_USTAR.value.length) return false;
  const ustar = tar
    .subarray(TAR_USTAR.offset, TAR_USTAR.offset + TAR_USTAR.value.length)
    .toString("latin1");
  if (ustar !== TAR_USTAR.value) return false;
  const name = tar
    .subarray(TAR_NAME.offset, TAR_NAME.offset + TAR_NAME.length)
    .toString("latin1")
    .replace(/\0+$/, "");
  return name.startsWith("package/");
}

function classify(path) {
  const bytes = head(path);
  if (bytes.length >= 16 && bytes.subarray(0, 16).equals(SQLITE_HEADER)) {
    return "a SQLite database";
  }
  if (bytes.length >= 4 && WAL_MAGICS.includes(bytes.readUInt32BE(0))) {
    return "a SQLite write-ahead log";
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(JOURNAL_MAGIC)) {
    return "a SQLite rollback journal";
  }
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(GZIP_MAGIC) && isPackedTarball(path)) {
    return "a packed npm tarball (`bun pm pack` output)";
  }
  // Name rules, for the two sidecars whose CONTENT cannot be relied on.
  //
  // A shared-memory file has no magic at all. A rollback journal has one — but only
  // sometimes, which is worth stating because it is not what the file-format docs imply.
  // Captured from real journals held open mid-transaction:
  //
  //     synchronous = OFF    → d9 d5 05 f9 20 a1 63 d7   (the documented magic)
  //     synchronous = FULL   → 00 00 00 00 00 00 00 00   (zeroed)
  //
  // SQLite zeroes the header at points where a journal must not be replayed, so a
  // content-only check would miss exactly the journals a durable configuration produces.
  // Both sidecars only ever appear beside a database, which the rules above catch.
  if (/-shm$/.test(path)) return "a SQLite shared-memory file";
  if (/-journal$/.test(path)) return "a SQLite rollback journal";
  return undefined;
}

/**
 * Plant one fixture of every kind in a throwaway git repo and RUN this script there.
 *
 * Two directions, because a guard that reports nothing and a guard that reports everything
 * look identical from a single green run. First every offender is tracked and the run must
 * exit 1 naming each one and none of the controls; then only the controls are tracked and
 * the same run must exit 0. `process.exit(1)` is invisible to an in-process call, so this
 * spawns a child and reads the code.
 *
 * The tarball fixture is BUILT here rather than packed, so the self-test needs no package
 * manager: a valid 512-byte ustar header for `package/package.json`, checksum included,
 * gzipped. Building it from the format is also what keeps the fixture honest — it is a real
 * tarball head, not a string shaped to satisfy the rule.
 */
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "asterism-artifacts-selftest-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "self-test@example.invalid");
  git("config", "user.name", "self-test");

  const write = (name, bytes) => writeFileSync(join(dir, name), bytes);
  const offenders = {
    // Named `x` on purpose: the case the content rules exist for.
    x: Buffer.concat([SQLITE_HEADER, Buffer.alloc(64)]),
    "store.log": Buffer.concat([Buffer.from([0x37, 0x7f, 0x06, 0x82]), Buffer.alloc(64)]),
    "store.db-shm": Buffer.alloc(64),
    // Zeroed header — what a durable configuration writes, and what a content-only rule
    // would miss.
    "store.db-journal": Buffer.alloc(64),
    // No `.tgz` extension, so only the content can identify it.
    "packed-artifact": tarballFixture("package/package.json"),
  };
  const controls = {
    "README.md": Buffer.from("# not an artifact\n"),
    // Compressed, but not a tar at all.
    "notes.gz": gzipSync(Buffer.from("hello world")),
    // Named like one, but text — the name alone must not fire.
    "looks-like.tgz": Buffer.from("this is not a tarball\n"),
    // The control that makes the `package/` prefix load-bearing: a real gzipped tar, with a
    // real ustar header, that is simply not an npm package. Without it, widening the rule to
    // "any gzip" passes the self-test, because the other two controls never reach that far —
    // one is not gzip and the other inflates to 11 bytes, short of a tar header.
    "source-archive.tgz": tarballFixture("docs/readme.md"),
    // And the control that makes the `ustar` half load-bearing: text that begins with the
    // very prefix the name rule looks for, compressed. Without it, dropping the format
    // check leaves the prefix answering for both halves.
    "paths.gz": gzipSync(Buffer.from(`package/package.json\n`.repeat(64))),
  };
  for (const [name, bytes] of Object.entries({ ...offenders, ...controls })) write(name, bytes);
  git("add", "-A");

  const failures = [];
  const runHere = () =>
    spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: dir, encoding: "utf8" });

  const refused = runHere();
  if (refused.status !== 1) {
    failures.push(`expected exit 1 with every offender tracked, got ${refused.status}`);
  }
  // The paths this run actually listed, read out of the report's own `  <path> — <kind>`
  // lines rather than searched for as substrings. Substring matching cannot check the
  // fixture that matters most: the database named `x`, whose name appears in almost any
  // English output, so `stderr.includes("x")` held with the SQLite rule switched off
  // entirely — the self-test passed while vouching for a rule it was not exercising.
  const listed = new Set(
    refused.stderr
      .split("\n")
      .map((line) => /^ {2}(.*?) — /.exec(line)?.[1])
      .filter((path) => path !== undefined),
  );
  for (const name of Object.keys(offenders)) {
    if (!listed.has(name)) failures.push(`not refused: ${name}`);
  }
  for (const name of Object.keys(controls)) {
    if (listed.has(name)) failures.push(`refused a control: ${name}`);
  }

  git("rm", "-q", "--cached", "--", ...Object.keys(offenders));
  const cleared = runHere();
  if (cleared.status !== 0) {
    failures.push(
      `expected exit 0 with only controls tracked, got ${cleared.status}: ${cleared.stderr}`,
    );
  }

  rmSync(dir, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error("Self-test failed:\n");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  // Counted from what the report listed, not from the fixture table — a summary that
  // recites its own input says nothing about the run it is summarising.
  console.log(
    `Self-test passed: ${listed.size} planted artifacts refused by name, ` +
      `${Object.keys(controls).length} controls cleared, both exit codes as expected.`,
  );
}

/** A gzipped tar whose first entry is `entryName`, header checksum and all. */
function tarballFixture(entryName) {
  const header = Buffer.alloc(512, 0);
  header.write(entryName, TAR_NAME.offset, "latin1");
  header.write("0000644\0", 100, "latin1"); // mode
  header.write("0000000\0", 108, "latin1"); // uid
  header.write("0000000\0", 116, "latin1"); // gid
  header.write("00000000002\0", 124, "latin1"); // size, octal
  header.write("00000000000\0", 136, "latin1"); // mtime, octal
  header.write("0", 156, "latin1"); // typeflag: a regular file
  header.write(`${TAR_USTAR.value}\0`, TAR_USTAR.offset, "latin1");
  header.write("00", 263, "latin1"); // ustar version
  // The checksum is computed with its own field read as spaces, then written back as octal.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  // One content block, then the two zero blocks that end a tar.
  return gzipSync(Buffer.concat([header, Buffer.alloc(512), Buffer.alloc(1024)]));
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
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
  console.error(`Refusing ${offenders.length} tracked artifact(s):\n`);
  for (const { path, kind } of offenders) console.error(`  ${path} — ${kind}`);
  console.error(
    "\nThese are output, not source. Remove them from the index:\n" +
      // `--` ends option parsing, so a path beginning with `-` is treated as a path.
      `  git rm --cached -- ${offenders.map((f) => shellQuote(f.path)).join(" ")}\n` +
      "\nIf one was created by a script, check what path it was handed — a database named\n" +
      "after a stray argument is the usual cause, and a tarball is `bun pm pack` run without\n" +
      "`--destination`.",
  );
  process.exit(1);
}

console.log(`No artifacts among ${tracked.length} tracked files.`);
