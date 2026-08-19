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

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, siteDir, trackedMarkdown } from "./lib/docs-scope.mjs";

const SELF_TEST = process.argv.includes("--self-test");

// ------------------------------------------------------------------ the corpus

/**
 * Pages whose Evidence blocks are checked: every markdown file this repo ships.
 *
 * This used to be `readdir("docs")` plus README and SECURITY — derived for the directory
 * part, but still a hand-maintained list of two for the rest, and a third answer to "which
 * markdown counts" alongside the two in `docs-commands-check`. An Evidence block is a
 * citation wherever it is written, and this check costs one pass over a file that has none,
 * so there is no set of files worth carving out. `decisions/`, the CHANGELOG and the
 * contributor docs carry no citations today; if one grows a claim, it is checked the day
 * it is written rather than the day someone remembers to widen a list.
 */
function sourcePages() {
  return trackedMarkdown();
}

// --------------------------------------------------------------- citation parse

const EVIDENCE_HEADER = /^>\s*\*\*Evidence\*\*\s*[—-]\s*`bun test ([^`]+)`\s*$/;
const EVIDENCE_ITEM = /^>\s*-\s*"(.+)"\s*$/;
const BLOCKQUOTE = /^>/;
/**
 * A line OPENING with the bold `Evidence` marker is trying to be a header, whether or not
 * this check can read it. Without this, a header the pattern does not match is not an
 * error — it simply never opens a block, so every citation under it is skipped in silence
 * and the page still reports "all resolve". Measured: a real block appended to
 * `docs/threat-model.md` with an EN dash instead of an em dash, citing a test that does
 * not exist, left the count at 44 and the exit status at 0.
 *
 * The check already refuses to skip an unreadable line INSIDE a block. This is the same
 * refusal one level up, at the only other place a citation can go missing.
 *
 * It matches on the OPENING because the page also discusses Evidence blocks in prose
 * ("Every claim below carries an **Evidence** block naming the test file…"), and a
 * sentence that mentions one is not a malformed one.
 */
const LOOKS_LIKE_HEADER = /^>?\s*\*\*Evidence\b/;

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
    const unreadableHeader = !header && LOOKS_LIKE_HEADER.test(line);
    if (header || unreadableHeader) {
      if (current && current.count === 0)
        malformed.push({ page: relPath, line: current.line, text: "Evidence block cites no tests" });
      if (unreadableHeader) {
        malformed.push({
          page: relPath,
          line: i + 1,
          text: `Evidence header this check cannot read: ${line.trim()}`,
        });
        // Opened nothing, so nothing below it may be attributed to the previous block.
        current = null;
        continue;
      }
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
 * Which source file a `<testcase>` belongs to.
 *
 * Bun puts `file` on the testcase itself AND on every enclosing `<testsuite>`, and the
 * outermost suite's `name` is the path too. We read them in that order and stop at the
 * first that answers, so the check does not rest on one optional attribute surviving a
 * runner upgrade — CI installs `bun-version: latest`, so the report shape is not pinned.
 *
 * ⚠ `classname` is NOT a path. Bun sets it to the enclosing `describe` title
 * ("secret store — issue / read round-trip"), so treating it as a filename would attribute
 * every test to a file that does not exist. Verified against a real report; do not "fix"
 * this by reaching for classname.
 */
function fileOf(attrs, suiteStack) {
  const own = attr(attrs, "file");
  if (own !== undefined) return own;
  for (let i = suiteStack.length - 1; i >= 0; i--) {
    if (suiteStack[i].file !== undefined) return suiteStack[i].file;
  }
  // Last resort: the OUTERMOST suite's name, which in bun's report is the file path. An
  // inner suite's name is a describe title, so only the outermost one is safe here.
  return suiteStack[0]?.name;
}

/**
 * Map file → Set(titles of tests that RAN AND PASSED), plus the run's own totals.
 *
 * The tag shapes bun emits, verified against a real run rather than assumed:
 *   <testcase … />                          passed
 *   <testcase …> <skipped />   </testcase>  skipped (`test.skip`) or todo
 *   <testcase …> <failure … /> </testcase>  failed
 * Only the first is evidence. Matching the opening tag alone would accept all three.
 *
 * `unattributed` counts passing tests we could not tie to a file. It is reported as the
 * PARSER's failure, never as the document's — see {@link corpusProblem}.
 */
function parseJUnit(xml) {
  const passed = new Map();
  let total = 0;
  let excluded = 0;
  let unattributed = 0;
  const suites = [];
  // One linear pass so a testcase can see the suites enclosing it. `<testsuite\b` does not
  // match `<testsuites` — there is no word boundary between "testsuite" and "s".
  const TAG = /<testsuite\b([^>]*?)(\/?)>|<\/testsuite\s*>|<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g;
  for (const m of xml.matchAll(TAG)) {
    if (m[0].startsWith("</testsuite")) {
      suites.pop();
      continue;
    }
    if (m[0].startsWith("<testsuite")) {
      if (m[2] !== "/") suites.push({ file: attr(m[1], "file"), name: attr(m[1], "name") });
      continue;
    }
    const attrs = m[3];
    const hasBody = m[4] !== undefined;
    const name = attr(attrs, "name");
    if (name === undefined) continue;
    total++;
    if (hasBody && /<\s*(skipped|failure|error)\b/.test(m[4])) {
      excluded++;
      continue;
    }
    const file = fileOf(attrs, suites);
    if (file === undefined) {
      unattributed++;
      continue;
    }
    const key = normalize(file);
    if (!passed.has(key)) passed.set(key, new Set());
    passed.get(key).add(name);
  }
  const root = /<testsuites\b([^>]*)>/.exec(xml);
  const failures = root ? Number(attr(root[1], "failures") ?? "0") : 0;
  return { passed, total, excluded, failures, unattributed };
}

/**
 * Can this corpus be trusted to judge citations at all? Returns a message if not.
 *
 * Without this, a report the parser cannot read produces the WORST possible output: every
 * citation reported as "NO SUCH FILE", i.e. the instrument blaming the document for its own
 * breakage. Someone would then "fix" 44 correct citations to satisfy a broken checker. The
 * parser must be able to say "this is me, not you".
 */
function corpusProblem(corpus) {
  if (corpus.total === 0) return "the test report contained no test cases at all";
  if (corpus.passed.size === 0)
    return `parsed ${corpus.total} test case(s) but could not attribute ANY of them to a source file`;
  if (corpus.unattributed > 0)
    return `parsed ${corpus.total} test case(s) but could not attribute ${corpus.unattributed} of them to a source file`;
  return undefined;
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
  // Two numbers, because they answer different questions and the old sentence conflated
  // them: how many pages CARRY a citation, and how many were READ looking for one. A
  // single count reads as the first while being the second, which is how a page nobody
  // scanned looks identical to a page with nothing to prove.
  const carrying = new Set(citations.map((c) => c.page)).size;
  const summary =
    `${citations.length} citation${citations.length === 1 ? "" : "s"} on ${carrying} of the ` +
    `${pages.length} markdown file${pages.length === 1 ? "" : "s"} this repo tracks, checked against ` +
    `${corpus.total} executed test` +
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
    // A header this check cannot read opens no block, so everything under it is skipped
    // in silence — the one place left where a citation could go missing while the page
    // reported "all resolve". Every case below cites a REAL passing test, so the header
    // is the only thing that can make it fail.
    [
      "an Evidence header with an EN dash is caught, not skipped",
      '> **Evidence** – `bun test pkg/a.test.ts`\n> - "a real passing test"\n',
      1,
    ],
    [
      "an Evidence header with the dash inside the bold is caught",
      '> **Evidence —** `bun test pkg/a.test.ts`\n> - "a real passing test"\n',
      1,
    ],
    [
      "an Evidence header with a colon is caught",
      '> **Evidence**: `bun test pkg/a.test.ts`\n> - "a real passing test"\n',
      1,
    ],
    [
      "an Evidence header missing its blockquote marker is caught",
      '**Evidence** — `bun test pkg/a.test.ts`\n> - "a real passing test"\n',
      1,
    ],
    // The controls, taken VERBATIM from the shipped page: the check must not mistake a
    // sentence that discusses Evidence blocks for a malformed one.
    [
      "prose naming an Evidence block is not mistaken for a header",
      "Every claim below carries an **Evidence** block naming the test file and the\n" +
        "Every **Evidence** citation on this page is checked in CI, on both supported\n",
      0,
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

  // --- where the file path is read from. Bun puts it on the testcase AND every enclosing
  // suite; a runner upgrade could move it. Each of these must still attribute correctly,
  // and the one that CANNOT must indict the parser rather than the docs.
  const cite1 = [{ page: "x", line: 1, file: "pkg/a.test.ts", title: "t" }];
  const shapes = [
    ["file on the testcase", `<testsuites tests="1"><testsuite name="s" file="pkg/a.test.ts"><testcase name="t" file="pkg/a.test.ts" /></testsuite></testsuites>`, true],
    ["file only on the enclosing suite", `<testsuites tests="1"><testsuite name="pkg/a.test.ts" file="pkg/a.test.ts"><testcase name="t" classname="a describe title" /></testsuite></testsuites>`, true],
    ["file only on an OUTER suite, nested describe inside", `<testsuites tests="1"><testsuite name="pkg/a.test.ts" file="pkg/a.test.ts"><testsuite name="a describe title"><testcase name="t" classname="a describe title" /></testsuite></testsuite></testsuites>`, true],
    ["no file anywhere — outermost suite NAME is the path", `<testsuites tests="1"><testsuite name="pkg/a.test.ts"><testcase name="t" /></testsuite></testsuites>`, true],
  ];
  for (const [label, xml, shouldResolve] of shapes) {
    const c = parseJUnit(xml);
    const ok = corpusProblem(c) === undefined && (check(cite1, c).length === 0) === shouldResolve;
    if (!ok) failed++;
    console.log(`  ${ok ? "✓" : "✗"} path read from: ${label}`);
  }

  // classname is a describe TITLE, not a path. If it were ever used as one, this resolves
  // against "a describe title" and the real file goes missing.
  const cnCorpus = parseJUnit(`<testsuites tests="1"><testsuite name="pkg/a.test.ts" file="pkg/a.test.ts"><testcase name="t" classname="a describe title" file="pkg/a.test.ts" /></testsuite></testsuites>`);
  const cnOk = check(cite1, cnCorpus).length === 0 && !cnCorpus.passed.has("a describe title");
  if (!cnOk) failed++;
  console.log(`  ${cnOk ? "✓" : "✗"} classname is never mistaken for a file path`);

  // The one that matters most: a report this parser cannot read must say so, not accuse the
  // docs of 44 bad citations.
  const brokenCorpus = parseJUnit(`<testsuites tests="1"><testcase name="t" classname="a describe title" /></testsuites>`);
  const brokenSaysSo = corpusProblem(brokenCorpus) !== undefined;
  if (!brokenSaysSo) failed++;
  console.log(`  ${brokenSaysSo ? "✓" : "✗"} an unreadable report indicts the PARSER, not the citations`);

  // --- half 2: the real page, really parsed, with a real defect planted in a copy.
  const realPage = join(siteDir(), "threat-model.md");
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
  const problem = corpusProblem(corpus);
  if (problem !== undefined) {
    console.error(
      `Could not read the test report: ${problem}.\n\n` +
        `This is a failure of THIS SCRIPT, not of the citations in the docs. Do not "fix" the\n` +
        `Evidence blocks to satisfy it. The likely cause is a change in the test runner's JUnit\n` +
        `output — see \`fileOf\` for the attributes it reads and in what order.`,
    );
    process.exit(2);
  }
  if (corpus.failures > 0) {
    console.error(
      `The test suite reports ${corpus.failures} failure(s). Citations claim a test "ran and passed",\n` +
        `so that claim cannot be checked until the suite is green.`,
    );
    process.exit(1);
  }
  process.exit(report(pages, citations, check(citations, corpus), malformed, corpus) ? 1 : 0);
}
