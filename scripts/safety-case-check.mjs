// Every "proven by test X" claim in the public threat model is itself a claim, and it
// goes stale silently. This checks it.
//
//   bun run check:safety-case              verify every Evidence citation in the docs
//   bun run check:safety-case:self-test    prove a zero here means something
//
// WHY THIS EXISTS. `docs/threat-model.md` says "the kernel enforces X, and here is the
// test". A citation that no longer resolves is not a formatting nit — it is the cheapest
// available signal that a claim's PROSE has gone stale. That is not hypothetical: the
// internal matrix this page was derived from carried a row asserting a limitation
// ("coexistence deferred") that had already been lifted. The behaviour changed, the test
// was renamed to match, and only the citation broke. Nobody noticed, because nothing
// checked. A reader deciding whether to trust this runtime would have spot-checked that
// row and found nothing there.
//
// WHAT IT DERIVES, AND WHY THAT WAY. The list of tests is read from the RUNNER's own
// output (`bun test --reporter=junit`), never grepped out of source. Grepping proves a
// string exists in a file. The runner proves the test RAN and PASSED — which is what the
// page actually claims. That closes the two cheap ways a citation stops meaning anything:
// the test was deleted, or the test was skipped.
//
//   ⚠ A skipped or failed <testcase> is NOT self-closing — it carries a <skipped/> or
//   <failure/> CHILD. A parser that matches the opening tag alone accepts a `test.skip` as
//   evidence, which is precisely the defect this gate exists to catch. See `parseJUnit`.
//
// WHAT IT DOES NOT PROVE, said plainly here and on the page itself: that the cited test
// would FAIL if the invariant were broken. A test can be weakened without being renamed.
// Falsifiability is established when the code changes, by breaking each load-bearing check
// and watching the test go red — not by this script. An evidence gate that overclaimed its
// own reach would fail at the thing the page exists to demonstrate.
//
// MATCHING IS EXACT, on purpose. The tempting failure mode is: a rename breaks CI, and the
// cheapest green is to edit the doc string until the checker agrees. That is how a wrong
// instrument certifies damage. Requiring an exact title and a pinned file means the only
// way to green is to open the real test.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF_TEST = process.argv.includes("--self-test");

// ------------------------------------------------------------------ the corpus

/**
 * Pages whose Evidence blocks are checked. Derived by reading the directory, not by
 * listing pages here — a hand-maintained list is a completeness claim, and this repo has
 * already paid for one of those. `SECURITY.md` is included because it is the front door
 * the threat model is linked from and may grow citations of its own.
 */
function sourcePages() {
  const docs = readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join("docs", f));
  return [...docs, "README.md", "SECURITY.md"].filter((p) => existsSync(join(ROOT, p)));
}

// --------------------------------------------------------------- citation parse

const EVIDENCE_HEADER = /^>\s*\*\*Evidence\*\*\s*[—-]\s*`bun test ([^`]+)`\s*$/;
const EVIDENCE_ITEM = /^>\s*-\s*"(.+)"\s*$/;
const BLOCKQUOTE = /^>/;

/**
 * Pull every Evidence block out of one page.
 *
 * A line inside an Evidence block that parses as NEITHER the header nor a citation is a
 * hard error, never a silent skip. A typo that quietly removed a citation from checking
 * would leave the page asserting a completeness this script had not checked — the exact
 * shape of defect the gate is for.
 */
function extractCitations(relPath) {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  const lines = text.split("\n");
  const citations = [];
  const malformed = [];
  let current = null; // { file, line, count }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = EVIDENCE_HEADER.exec(line);
    if (header) {
      if (current && current.count === 0)
        malformed.push({ page: relPath, line: current.line, text: "Evidence block cites no tests" });
      current = { file: header[1].trim(), line: i + 1, count: 0 };
      continue;
    }
    if (!current) continue;
    if (!BLOCKQUOTE.test(line)) {
      // The block ended. An empty `>` line is a spacer, handled above by the regexes.
      if (current.count === 0)
        malformed.push({ page: relPath, line: current.line, text: "Evidence block cites no tests" });
      current = null;
      continue;
    }
    const item = EVIDENCE_ITEM.exec(line);
    if (item) {
      citations.push({ page: relPath, line: i + 1, file: current.file, title: item[1] });
      current.count++;
      continue;
    }
    if (/^>\s*$/.test(line)) continue; // blank spacer line inside the block
    malformed.push({ page: relPath, line: i + 1, text: `unparseable line in an Evidence block: ${line.trim()}` });
  }
  if (current && current.count === 0)
    malformed.push({ page: relPath, line: current.line, text: "Evidence block cites no tests" });
  return { citations, malformed };
}

// ------------------------------------------------------------------ junit parse

const ENTITIES = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };
const unescape = (s) => s.replace(/&(quot|amp|lt|gt|apos);/g, (_, n) => ENTITIES[n]);

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? unescape(m[1]) : undefined;
}

/** Repo-relative, forward-slashed, so an absolute `file=` and a relative one compare equal. */
function normalize(file) {
  const rel = isAbsolute(file) ? relative(ROOT, file) : file;
  return rel.split("\\").join("/");
}

/**
 * Map file → Set(titles of tests that RAN AND PASSED), plus the run's own totals.
 *
 * The tag shapes bun emits, verified against a real run rather than assumed:
 *   <testcase … />                          passed
 *   <testcase …> <skipped />   </testcase>  skipped (`test.skip`) or todo
 *   <testcase …> <failure … /> </testcase>  failed
 * Only the first is evidence. Matching the opening tag alone would accept all three.
 */
function parseJUnit(xml) {
  const passed = new Map();
  let total = 0;
  let excluded = 0;
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1];
    const selfClosing = m[2] === "/>";
    const body = selfClosing ? "" : m[3];
    const name = attr(attrs, "name");
    const file = attr(attrs, "file");
    if (name === undefined || file === undefined) continue;
    total++;
    if (!selfClosing && /<\s*(skipped|failure|error)\b/.test(body)) {
      excluded++;
      continue;
    }
    const key = normalize(file);
    if (!passed.has(key)) passed.set(key, new Set());
    passed.get(key).add(name);
  }
  const suites = /<testsuites\b([^>]*)>/.exec(xml);
  const failures = suites ? Number(attr(suites[1], "failures") ?? "0") : 0;
  return { passed, total, excluded, failures };
}

/** Run the suite and return its JUnit XML. */
function runSuite() {
  const dir = mkdtempSync(join(tmpdir(), "asterism-safety-"));
  const out = join(dir, "junit.xml");
  const res = spawnSync("bun", ["test", "--reporter=junit", `--reporter-outfile=${out}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!existsSync(out)) {
    console.error(
      `The test suite produced no JUnit report, so there is nothing to check citations against.\n` +
        `Command: bun test --reporter=junit\n\n${res.stderr || res.stdout || ""}`,
    );
    process.exit(2);
  }
  const xml = readFileSync(out, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return xml;
}

// ----------------------------------------------------------------- the check

/**
 * Check citations against the executed-and-passed set. Returns findings; empty is a pass.
 *
 * `NO SUCH FILE` and `NO SUCH TEST` are reported differently on purpose: the first says the
 * path is wrong, the second says the path is right and the title is not — and the second is
 * where a rename lands, so it prints the nearest real titles to make the fix obvious without
 * making it thoughtless.
 */
function check(citations, corpus) {
  const findings = [];
  for (const c of citations) {
    const titles = corpus.passed.get(normalize(c.file));
    if (!titles) {
      findings.push({ ...c, kind: "NO SUCH FILE", detail: "no test in this file ran and passed" });
      continue;
    }
    if (titles.has(c.title)) continue;
    findings.push({ ...c, kind: "NO SUCH TEST", detail: nearest(c.title, titles) });
  }
  return findings;
}

/** The closest real titles in the cited file, to name what the citation probably meant. */
function nearest(title, titles) {
  const words = (s) => new Set(s.toLowerCase().match(/[a-z_]{4,}/g) ?? []);
  const want = words(title);
  const scored = [...titles]
    .map((t) => {
      const have = words(t);
      let hit = 0;
      for (const w of want) if (have.has(w)) hit++;
      return [hit / Math.max(1, want.size), t];
    })
    .sort((a, b) => b[0] - a[0])
    .slice(0, 2)
    .filter(([s]) => s > 0.3);
  if (!scored.length) return "no similar title in this file — is the file wrong?";
  return `nearest in this file:\n${scored.map(([s, t]) => `        ${(s * 100).toFixed(0)}%  "${t}"`).join("\n")}`;
}

function report(pages, citations, findings, malformed, corpus) {
  for (const m of malformed) console.error(`  ✗ ${m.page}:${m.line}  ${m.text}`);
  for (const f of findings) {
    console.error(`  ✗ ${f.page}:${f.line}  ${f.kind}`);
    console.error(`      file:  ${f.file}`);
    console.error(`      test:  "${f.title}"`);
    console.error(`      ${f.detail}`);
  }
  const bad = findings.length + malformed.length;
  const summary =
    `${citations.length} citation${citations.length === 1 ? "" : "s"} across ${pages.length} page` +
    `${pages.length === 1 ? "" : "s"}, checked against ${corpus.total} executed test` +
    `${corpus.total === 1 ? "" : "s"}` +
    (corpus.excluded ? ` (${corpus.excluded} skipped or failed, not usable as evidence)` : "");
  if (bad) {
    console.error(`\n${summary} — ${bad} problem${bad === 1 ? "" : "s"}.`);
    console.error(
      `\nA citation that does not resolve usually means a test was renamed. Before editing the\n` +
        `citation to match, read the test: if its NAME changed because its BEHAVIOUR changed, the\n` +
        `claim above it is what needs fixing.`,
    );
  } else {
    console.log(`${summary} — all resolve.`);
  }
  return bad;
}

// ------------------------------------------------------------------ self-test

/**
 * Prove a green run means something. Two halves, deliberately:
 *
 *   1. SYNTHETIC — hand-built XML + hand-built pages, one per defect class, including the
 *      cases the real suite cannot currently produce (a skipped test, a failed one).
 *   2. REAL CORPUS — plant a defect into a byte COPY of the shipped page and run the real
 *      pipeline over it. A checker that only ever passes its own fixtures is the failure
 *      mode this repo has already hit: falsify against the real artifact, not the mock.
 *
 * The copy is never the repo file. Nothing here mutates a tracked path, so a failure
 * halfway through cannot leave the tree dirty.
 */
function selfTest() {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" failures="1" skipped="2">
  <testsuite name="pkg/a.test.ts" file="pkg/a.test.ts">
    <testcase name="a real passing test" file="pkg/a.test.ts" line="1" />
    <testcase name="a skipped test" file="pkg/a.test.ts" line="2"><skipped /></testcase>
    <testcase name="a failing test" file="pkg/a.test.ts" line="3"><failure type="AssertionError" /></testcase>
    <testcase name="a title with &quot;quotes&quot; &amp; an ampersand" file="pkg/a.test.ts" line="4" />
  </testsuite>
</testsuites>`;
  const corpus = parseJUnit(XML);
  const page = (body) => {
    const dir = mkdtempSync(join(tmpdir(), "asterism-safety-st-"));
    writeFileSync(join(dir, "p.md"), body);
    return dir;
  };
  const cite = (file, title) => `> **Evidence** — \`bun test ${file}\`\n> - "${title}"\n`;

  const cases = [
    ["a clean citation passes", cite("pkg/a.test.ts", "a real passing test"), 0],
    ["entity-escaped titles round-trip", cite("pkg/a.test.ts", 'a title with "quotes" & an ampersand'), 0],
    ["a renamed test is caught", cite("pkg/a.test.ts", "a real passing tset"), 1],
    ["a wrong file is caught", cite("pkg/b.test.ts", "a real passing test"), 1],
    ["a PARAPHRASE is caught (prefixes are not citations)", cite("pkg/a.test.ts", "a real passing"), 1],
    ["a title with an extra clause is caught", cite("pkg/a.test.ts", "a real passing test (extra)"), 1],
    ["a SKIPPED test is not evidence", cite("pkg/a.test.ts", "a skipped test"), 1],
    ["a FAILED test is not evidence", cite("pkg/a.test.ts", "a failing test"), 1],
    ["an Evidence block citing nothing is caught", "> **Evidence** — `bun test pkg/a.test.ts`\n\ntext\n", 1],
    [
      "an unparseable line inside a block is caught, not skipped",
      "> **Evidence** — `bun test pkg/a.test.ts`\n> - a citation missing its quotes\n",
      1,
    ],
    [
      "two blocks are both checked (a good one does not cover a bad one)",
      cite("pkg/a.test.ts", "a real passing test") + "\ntext\n\n" + cite("pkg/a.test.ts", "nope"),
      1,
    ],
  ];

  let failed = 0;
  for (const [label, body, want] of cases) {
    const dir = page(body);
    const { citations, malformed } = extractCitations(relative(ROOT, join(dir, "p.md")));
    const got = check(citations, corpus).length + malformed.length;
    rmSync(dir, { recursive: true, force: true });
    const ok = want === 0 ? got === 0 : got >= 1;
    if (!ok) failed++;
    console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  (expected ${want ? "≥1" : "0"} findings, got ${got})`}`);
  }

  // An empty corpus must never read as "everything resolves".
  const emptyOk = check([{ page: "x", line: 1, file: "pkg/a.test.ts", title: "a real passing test" }], parseJUnit("<testsuites></testsuites>")).length === 1;
  if (!emptyOk) failed++;
  console.log(`  ${emptyOk ? "✓" : "✗"} an empty test corpus fails every citation (a zero cannot be vacuous)`);

  // --- half 2: the real page, really parsed, with a real defect planted in a copy.
  const realPage = join("docs", "threat-model.md");
  if (existsSync(join(ROOT, realPage))) {
    const original = readFileSync(join(ROOT, realPage), "utf8");
    const first = EVIDENCE_ITEM.exec(original.split("\n").find((l) => EVIDENCE_ITEM.test(l)) ?? "");
    const dir = mkdtempSync(join(tmpdir(), "asterism-safety-real-"));
    const planted = join(dir, "planted.md");
    writeFileSync(planted, original.replace(`- "${first[1]}"`, `- "${first[1]} — but renamed"`));
    const real = parseJUnit(runSuite());
    const clean = check(extractCitations(realPage).citations, real);
    const dirty = check(extractCitations(relative(ROOT, planted)).citations, real);
    rmSync(dir, { recursive: true, force: true });
    const ok = clean.length === 0 && dirty.length === 1;
    if (!ok) failed++;
    console.log(
      `  ${ok ? "✓" : "✗"} the SHIPPED page resolves clean, and one planted rename in a copy of it fails` +
        (ok ? "" : `  (clean=${clean.length} findings, planted=${dirty.length})`),
    );
  }

  if (failed) {
    console.error(`\n${failed} self-test case(s) failed — this checker cannot be trusted until they pass.`);
    process.exit(1);
  }
  console.log(`\nSelf-test passed: every planted defect was caught, and the shipped page is clean.`);
}

// ---------------------------------------------------------------------- main

if (SELF_TEST) {
  selfTest();
} else {
  const pages = sourcePages();
  const citations = [];
  const malformed = [];
  for (const p of pages) {
    const r = extractCitations(p);
    citations.push(...r.citations);
    malformed.push(...r.malformed);
  }
  if (citations.length === 0 && malformed.length === 0) {
    console.error(
      `No Evidence citations found in ${pages.length} pages. The threat model is supposed to carry\n` +
        `them, so this is far more likely to be a broken parser than a page with nothing to prove.`,
    );
    process.exit(1);
  }
  const corpus = parseJUnit(runSuite());
  if (corpus.failures > 0) {
    console.error(
      `The test suite reports ${corpus.failures} failure(s). Citations claim a test "ran and passed",\n` +
        `so that claim cannot be checked until the suite is green.`,
    );
    process.exit(1);
  }
  process.exit(report(pages, citations, check(citations, corpus), malformed, corpus) ? 1 : 0);
}
