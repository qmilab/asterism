// Every command the docs advertise is a testable claim. This extracts them all and
// runs them.
//
//   bun run build && node scripts/docs-commands-check.mjs
//   node scripts/docs-commands-check.mjs --self-test    (prove a zero means something)
//
// Two shipped defects motivated this, both found by extracting a sentence from the
// product's own copy and typing it: an error advising a recovery the code refused to
// perform, and a refusal advertising `api remove <agent> <a> <b>` when `api remove`
// takes one name. A documentation page is nothing but such sentences.
//
// It pulls every `asterism …` invocation out of the terminal blocks of every page a USER
// meets — the published site and its landing page, the repo's front page, and every package
// README npm ships — and sorts each into one of two claims, both checked against the real
// `packages/cli/dist/bin.js`:
//
//   SYNOPSIS  an unprompted line carrying placeholders (`<agent>`, `[--flag]`) claims
//             a GRAMMAR. Its command path must be one the binary accepts, and every
//             `--flag` it names must appear in that command's own `--help`. This is
//             what catches an invented subcommand or an invented flag.
//   EXAMPLE   a concrete line claims it RUNS. It is executed against a real install
//             in a temp workspace and must succeed — or fail only for a reason on the
//             narrow, named list below, which the report prints per line so that an
//             excused failure is never a silent one.
//
// Each page gets its OWN workspace, seeded with every agent the page does not create
// for itself, because that is how a reader meets it: one page, top to bottom, with the
// state its earlier commands left behind. A shared workspace made pages collide —
// `new writer` failing on the second page that teaches it, and one page's
// `config recall-provider` breaking a `run` three pages later.
//
// Nothing is dropped quietly. Every skip carries a reason, every excused failure is
// printed with its line, and the tallies at the end add up to the number extracted.
//
// A second pass checks the OTHER claim a page makes constantly and just as silently: that
// its internal links resolve. A cross-reference to a section that does not exist fails a
// reader exactly like a command that does not run.
//
// That pass has to slugify headings EXACTLY as the site does, and the first version of it
// did not: it substituted whitespace singly where Python-Markdown collapses a run, so an
// em-dash heading came out with a double hyphen. It then reported four correct links as
// dead, and they were "fixed" to match the checker — breaking them on the published site
// while CI called them green. A wrong anchor helper is worse than no anchor helper: it
// certifies the damage. So the port lives in `lib/anchors.mjs` and is verified against the
// renderer rather than pinned by eye — `check:mkdocs-parity` renders every published page
// with the site's own Python-Markdown and compares every id. `--self-test` here keeps a
// handful of pairs for the cases an eyeball gets wrong, so a local run still says
// something without an interpreter.
//
// The link pass RESOLVES targets rather than recognising them. The version before this one
// matched them with `[a-z0-9-]+\.md` and still printed "Every internal doc link resolves" —
// lower case, no directory, markdown only, `docs/` only. So it could not see an upper-case
// filename, any `./docs/…` link, any image, any raw HTML `href`, or any of the 56 internal
// links in README, and it counted a `# comment` inside a fenced block as a heading, which
// minted 25 anchors this repo's pages do not have and made links into them report as good.
// It now reads every markdown file this repo TRACKS, with each link judged by the renderer
// that serves the page making it. `mkdocs --strict` still backstops only part of that: it
// never reads README (`docs_dir: docs`), so README's links are invisible to it. Measured by
// planting one of each. What the pass claims is now what it did.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, sep } from "node:path";
import { anchorOf, githubAnchorOf, anchorsOf, anchorRuleFor, headingLines, MKDOCS_RULE } from "./lib/anchors.mjs";
import { gateOverclaims, GATE_RULE_ADVICE, TRUST_LEVEL_NAMES } from "./lib/gate-claims.mjs";
import { codeRanges } from "./lib/copy-text.mjs";
import { emit, failing, finish, isLine } from "./lib/report-passes.mjs";
import {
  vocabularyLeaks,
  isVocabularyExempt,
  VOCABULARY_WORDS,
  VOCABULARY_EXEMPT_PAGES,
} from "./lib/copy-vocabulary.mjs";
import {
  ROOT,
  siteDir,
  siteUrlPath,
  isPublished,
  trackedMarkdown,
  userFacingPages,
  publishedLandingPages,
  readLandingDir,
  publishedPages,
  publishedPredicate,
  publishedPackages,
  publishedPackageNames,
  publishedPackageDescriptions,
  siteCopyStrings,
  publishedAssets,
  landingFiles,
  readLandingRemovals,
  publishedPackagesWithoutReadme,
  readSiteConfig,
  siteUrlParts,
  usesDirectoryUrls,
} from "./lib/docs-scope.mjs";
const BIN = join(ROOT, "packages", "cli", "dist", "bin.js");
const CORE = join(ROOT, "packages", "core", "dist", "index.js");
const MODEL_CONFIG_DIST = join(ROOT, "packages", "cli", "dist", "model-config.js");
const CAPABILITIES_DIST = join(ROOT, "packages", "cli", "dist", "capabilities.js");

/**
 * This checker types commands at the BUILT CLI, so it needs `dist/` — and it reaches into
 * the store for the one fixture state no CLI verb can produce (a note awaiting review).
 * Loaded after a preflight rather than as a static import, because an unbuilt or
 * ABI-mismatched `dist` otherwise surfaces as a bare ERR_MODULE_NOT_FOUND or a native-load
 * stack trace with no hint of the cause — which is exactly the failure CLAUDE.md warns
 * reads like a regression and is not one.
 */
let AsterismStore;
/** The kernel's own connection-mode enum, so the fixture cannot fall behind it. */
let CONNECTION_MODES;
/** The shipped provider table, so the docs check derives it rather than restating it. */
let MODEL_CONFIG;
/** The shipped tool catalog, for the same reason: nine names, derived from the nine built. */
let CAPABILITIES;

function preflight() {
  const missing = [
    [BIN, "packages/cli/dist/bin.js"],
    [CORE, "packages/core/dist/index.js"],
    [MODEL_CONFIG_DIST, "packages/cli/dist/model-config.js"],
    [CAPABILITIES_DIST, "packages/cli/dist/capabilities.js"],
  ].filter(([abs]) => !existsSync(abs));
  if (missing.length) {
    console.error(
      `This check runs against the BUILT CLI, and ${missing.map(([, rel]) => rel).join(" and ")} ` +
        `${missing.length === 1 ? "is" : "are"} not there.\n` +
        `Build first:  bun run build\n` +
        `(Or run \`bun run check:docs\`, which builds for you.)`,
    );
    process.exit(2);
  }
}

const SELF_TEST = process.argv.includes("--self-test");
/**
 * Report where a page's pasted OUTPUT no longer matches what the binary prints. Not a
 * gate: a block legitimately shows a different install (other agent names, other files),
 * so this is read by a human. It is how blocks that predate a slice are found.
 */
const DIFF_OUTPUT = process.argv.includes("--diff-output");
/** Where `asterism init` puts an install's store, relative to the workspace root. */
const HOME = ".asterism";

/** Every temp install this run has made, so no exit path can leave one behind. */
const FIXTURES = new Set();
process.on("exit", () => {
  for (const dir of FIXTURES) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort on the way out: a directory already gone, or one the OS is still
      // holding, must not turn a clean exit into a stack trace.
    }
  }
});

// ---------------------------------------------------------------- extraction

/**
 * Source files whose terminal blocks are checked: every page a USER meets — the site, its
 * landing page, the repo's front page, and every package README npm publishes. Derived in
 * one place (`lib/docs-scope.mjs`) rather than spelled out here, because this was the first
 * of four hand-written answers to "which markdown counts" and the smallest of them: `docs/`
 * plus README, which left the nine commands in `packages/cli/README.md` — the page npm
 * shows for the thing people install — typed by nothing.
 *
 * The landing page is the clause that was missing after that: it is HTML, so no filter
 * built on `*.md` could reach it. Nothing typed a line of its quickstart, and it named three
 * of the nine catalog tools and misdescribed the destructive gate — eight releases after
 * both were corrected on the pages that were inside.
 */
function sourceFiles() {
  return userFacingPages();
}

/**
 * One page → the text of each block a reader is meant to read as a terminal, plus the line
 * the block starts on. Markdown fences it; the landing page is hand-written HTML and marks
 * the same thing with a class, so the two are read here and everything downstream sees one
 * shape.
 *
 * The HTML half is deliberately narrow. It looks for the class the page's own stylesheet
 * renders as a terminal, and a page whose blocks it cannot find is REPORTED (see
 * `blocklessPages`) rather than counted as a page with no commands — a reader that silently
 * finds nothing is the failure this whole file has paid for twice, and here it would read as
 * "the landing page advertises no commands", which is the opposite of true.
 */
function terminalBlocks(text, isHtml) {
  const blocks = [];
  if (!isHtml) {
    const lines = text.split("\n");
    let open = null;
    lines.forEach((raw, i) => {
      if (!/^\s*```/.test(raw)) return;
      if (open === null) open = i + 1;
      else {
        blocks.push({ startLine: open + 1, text: lines.slice(open, i).join("\n") });
        open = null;
      }
    });
    // An UNCLOSED fence runs to the end of the file, which is what the line-at-a-time
    // reader this replaced did. Dropping it instead would silently stop checking every
    // command below a stray ``` — the reading-nothing failure, arriving as a green.
    if (open !== null) blocks.push({ startLine: open + 1, text: lines.slice(open).join("\n") });
    return blocks;
  }
  // A class token CONTAINING `terminal`, not equal to it: the page's own is
  // `asterism__terminal`, and `\bterminal\b` does not match after an underscore — which is
  // how the first version of this read the landing page as having no commands at all.
  // Both quotings. The `<a href>` reader below already does this and its comment calls the
  // single-quote miss "the mirror failure and the worse one, since an unmatched link is
  // silently unchecked rather than loudly wrong" — and then the same reasoning was not
  // applied here, one function away. A single-quoted block is worse still: `blocklessPages`
  // cannot see it, because a block WAS found, so every command in it is dropped in silence.
  for (const m of text.matchAll(/<(div|pre)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase();
    const className = attrOf(m[2], "class");
    if (className === undefined || !className.includes("terminal")) continue;
    const from = m.index + m[0].length;
    // The end is found by MATCHING tags, not by taking the first `</div>`. A non-greedy
    // `([\s\S]*?)<\/(?:div|pre)>` ends at the first close of either kind, so one nested
    // element truncates the block — and every command below the nesting then falls outside
    // every block and is dropped with no diagnostic. `blocklessPages` cannot see that: a
    // block WAS found. It is the same silent under-read this file exists to prevent,
    // arriving at partial granularity instead of whole-page.
    const nest = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    nest.lastIndex = from;
    let depth = 1;
    let end = -1;
    let hit;
    while ((hit = nest.exec(text)) !== null) {
      depth += hit[1] === "/" ? -1 : 1;
      if (depth === 0) {
        end = hit.index;
        break;
      }
    }
    if (end === -1) {
      // Unclosed. Running to the end of the file is what the markdown half does with an
      // unterminated fence, and for the same reason: dropping it stops checking every
      // command below it while the report stays green.
      end = text.length;
    }
    blocks.push({
      tag,
      className,
      // The highest-specificity source there is: an inline declaration beats every rule in
      // the stylesheet. Not read until now, so `style="white-space: normal"` on a block the
      // stylesheet preserves would have passed — the false-pass direction this check exists
      // for — and `style="white-space: pre"` on one it does not would have been reported.
      inlineStyle: attrOf(m[2], "style") ?? "",
      startLine: text.slice(0, m.index).split("\n").length,
      // Inline markup inside a terminal block is presentation (a `<span class="comment">`
      // around a shell comment); the command is what is left once it is gone.
      text: decodeEntities(stripMarkup(text.slice(from, end))),
    });
  }
  return blocks;
}

/**
 * Remove markup, keeping the line breaks that were INSIDE it.
 *
 * A plain `replace(/<[^>]+>/g, "")` eats them, because `[^>]` spans newlines — so one
 * `<span\n class="comment">` inside a terminal block shifts every command below it up a
 * line, and a tag straddling the join between two commands merges them, where the
 * trailing-comment strip can drop the second outright. A silent under-read with no
 * diagnostic, which is the failure class this file exists to prevent.
 */
function stripMarkup(text) {
  return text.replace(/<[^>]+>/g, (tag) => tag.replace(/[^\n]/g, ""));
}

/**
 * The value of one attribute of an open tag, in ANY of the three forms HTML permits it to
 * be written: double-quoted, single-quoted, or unquoted.
 *
 * ONE function, because doing it per-matcher went wrong four times in a row. Round two
 * taught `href=` single quotes; round three taught `class=` the same thing one function
 * away; round four found `id=` and `<code>` still untaught after a commit that claimed to
 * take "the third attribute form, before it is found a third time". Every miss is silent —
 * a block that is not found is a block `blocklessPages` reports nothing about — so the way
 * to stop paying for it is to have one place that knows.
 *
 * `(^|\s)` before the name is load-bearing too: `\bid=` also matches `data-id=`, because a
 * hyphen is not a word character, and that made a dead in-page link resolve.
 */
function attrOf(attrs, name) {
  const m = new RegExp(`(^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i").exec(attrs);
  return m ? decodeEntities(m[3] ?? m[4] ?? m[5] ?? "") : undefined;
}

/**
 * The five entities an HTML page must escape. Written out rather than pulled from a
 * library: a terminal block holds `>` redirections and `&&`, and getting those two back
 * wrong turns a correct command into one the checker then reports as broken.
 *
 * `&amp;` is decoded LAST and that is not a style choice: decoded first, `&amp;gt;` — the
 * escaping of the literal text `&gt;` — would become `&gt;` and then `>`, silently turning
 * text a page shows into a redirection the checker runs.
 */
function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    // NUMERIC references, decimal and hex. An editor that writes `&#x27;` or `&#62;` where
    // another writes `&apos;` or `&gt;` is producing the same page, and leaving the literal
    // entity in an extracted command means typing it at the binary and reporting a docs
    // failure on correct copy. The named list alone was narrower than this comment claimed.
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/**
 * A page in the corpus whose markup this extractor found no terminal block in at all. For
 * markdown that is ordinary — most pages have no fenced block — so only the HTML pages are
 * reported, because there the answer "none" means "the class this looks for is not the
 * class the page uses" far more often than it means "this page shows no commands".
 */
function blocklessPages() {
  const pages = publishedLandingPages();
  const withBlocks = pages.filter((rel) => terminalBlocks(readFileSync(join(ROOT, rel), "utf8"), true).length > 0);
  // A page with no commands on it is ordinary — a 404, a privacy note, a redirect stub —
  // and failing the build for one would be this check inventing work. What is NOT ordinary
  // is EVERY page losing its blocks at once, which is what a renamed class looks like and
  // what this exists to catch. So the report is about the set, not each page.
  return withBlocks.length === 0 ? pages : [];
}

/**
 * Every line inside a fenced block that invokes `asterism`. A `$ ` prompt is stripped,
 * as is a trailing ` # comment` — both are presentation, not part of the claim.
 *
 * A line already claimed as the OUTPUT of a prompted command above it is not an
 * invocation, however much it looks like one. That is not hypothetical: the CLI refuses
 * an option it does not take with `asterism <verb> does not take --x.`, which begins
 * with the word this extractor keys on — so a page showing that refusal was read as
 * documenting a synopsis, and the checker ran the error message as a command.
 */
function extract(relPath, base = ROOT) {
  const text = readFileSync(join(base, relPath), "utf8");
  const isHtml = /\.html?$/.test(relPath);
  const sectionAt = sectionIndex(text, isHtml);
  const found = [];

  for (const block of terminalBlocks(text, isHtml)) {
    const lines = block.text.split("\n");
    const items = [];
    lines.forEach((raw, i) => {
      const trimmed = raw.trim();
      // A `$ ` prompt marks a line the reader is meant to TYPE; its absence, in a block
      // that carries placeholders, marks a grammar. That distinction is the classifier.
      const prompted = /^\$\s+/.test(trimmed);
      let s = trimmed.replace(/^\$\s+/, "");
      if (!/^asterism\s/.test(s)) return;
      // A trailing comment is prose. Only strip ` #` with surrounding space, so a
      // `#fragment` inside a URL or a quoted task survives.
      s = s.replace(/\s+#\s.*$/, "").trim();
      const line = block.startLine + i;
      items.push({ file: relPath, line, command: s, prompted, shown: [], section: sectionAt(line), at: i });
    });

    // The lines a block prints beneath a prompted command are its EXPECTED OUTPUT — the
    // page's claim about what the reader will see. Attach them to the command above.
    const outputLines = new Set();
    for (const item of items) {
      if (!item.prompted) continue;
      for (let j = item.at + 1; j < lines.length; j++) {
        if (/^\s*\$\s/.test(lines[j])) break;
        item.shown.push(lines[j]);
        outputLines.add(j);
      }
      while (item.shown.length && item.shown[item.shown.length - 1].trim() === "") item.shown.pop();
    }
    for (const item of items) {
      if (item.prompted || !outputLines.has(item.at)) {
        delete item.at;
        found.push(item);
      }
    }
  }
  return found;
}

/**
 * Line number → the heading its command sits under, so a reference page's sections stay
 * independent snippets rather than one transcript. A heading inside a terminal block is
 * not a heading: `## ` is also how a shell comment starts.
 */
function sectionIndex(text, isHtml) {
  const marks = [];
  if (isHtml) {
    // `gi`, like every other HTML matcher here. Without the `i`, an `<H2>` yields no
    // section at all and every command below it collapses into one group — sharing a
    // fixture with commands the grouping exists to keep apart.
    for (const m of text.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)) {
      marks.push([text.slice(0, m.index).split("\n").length, `## ${decodeEntities(stripMarkup(m[1])).trim()}`]);
    }
  } else {
    let inFence = false;
    text.split("\n").forEach((raw, i) => {
      if (/^\s*```/.test(raw)) inFence = !inFence;
      else if (!inFence && /^##\s/.test(raw)) marks.push([i + 1, raw.trim()]);
    });
  }
  return (line) => {
    let section = "";
    for (const [at, title] of marks) {
      if (at > line) break;
      section = title;
    }
    return section;
  };
}

// ------------------------------------------------------------- classification

/** A placeholder the reader is expected to replace. */
function hasPlaceholder(command) {
  return /<[^>]+>|\[[^\]]+\]|\s·\s/.test(command);
}

/** `…` marks a value elided for the reader; the line was never meant to be typed. */
function isElided(command) {
  return command.includes("…");
}

/**
 * Commands that cannot be executed by a checker, each with the reason printed in the
 * report. This list is the harness's only discretion, so it is kept explicit and short.
 */
const UNRUNNABLE = [
  [/^asterism serve\b/, "binds a port and blocks until interrupted"],
  [/^asterism dashboard\b/, "takes over the terminal, or binds a port and blocks"],
  [/^asterism channel (telegram|discord)\b/, "connects to a third-party chat service"],
  [/^asterism service (install|uninstall)\b/, "writes a launchd/systemd unit to the host"],
  [
    /^asterism call\b/,
    "would send one agent's credential to a real third-party address",
  ],
];

/**
 * Failures excused with a named reason. Each is matched against the command's own
 * stderr, and each excused line is printed in the report — an excuse is never silent.
 * Deliberately narrow: a usage error, an unknown command, an unknown flag and an
 * unknown agent are all absent, because those are exactly the defects this exists
 * to catch.
 */
const EXCUSED = [
  [/^No model configured\./, "needs-model", "no model is configured in a checker"],
  // The CLI's own refusal, raised before a model client is built. It used to be
  // the substrate's ("Run failed: No API key for provider: x"), which arrived at
  // the first token instead; matching that string here would now excuse nothing.
  [
    /^No API key configured for /,
    "needs-model",
    "no provider API key is present in a checker",
  ],
  [
    /needs no API key when it is served from this machine/,
    "needs-model",
    "the documented endpoint is not reachable from a checker",
  ],
  [
    /^Set ASTERISM_(TELEGRAM|DISCORD)_TOKEN\b/,
    "needs-token",
    "needs a third-party chat token",
  ],
  // `secrets add` with no value asks for one, and this refusal is what it prints when
  // there is no terminal to ask at. Every command here runs with its stdin on a pipe,
  // so the prompt is the one documented value path a checker can never take. Narrow on
  // purpose: it matches only the non-interactive refusal, so a `secrets add` example
  // that is wrong for any OTHER reason still fails.
  [
    /^No value for \S+\. Pass it inline,/,
    "needs-terminal",
    "the value would be typed at a terminal, and a checker's stdin is a pipe",
  ],
  [
    /^No (run|objective) matching "/,
    "illustrative-id",
    "the id in the example is illustrative, and resolves to nothing",
  ],
  [
    /has no completed run with output to reflect on yet\.$/,
    "needs-model",
    "reflection needs a completed model-driven run",
  ],
  [
    /has not handed .* an artifact at '/,
    "needs-model",
    "fetching needs a prior artifact exchange, which needs a model",
  ],
];

// ------------------------------------------------------------------- fixture

/**
 * The environment every checked command runs in. Provider keys are stripped rather
 * than inherited: a machine that happens to export `OPENAI_API_KEY` would send real
 * traffic and give a different verdict from CI, and a check whose result depends on
 * whose laptop it runs on is not a check.
 */
function cleanEnv() {
  const env = { ...process.env, NO_COLOR: "1" };
  for (const key of Object.keys(env)) {
    if (/API_KEY$|^ASTERISM_(MODEL|RECALL|TELEGRAM|DISCORD|HTTP)_/.test(key)) delete env[key];
  }
  // …and every variable a documented example would read as its own credential value.
  // `secrets add <agent> <KEY>` with no inline value falls back to `$KEY`, so a machine
  // exporting one of these (GITHUB_TOKEN is on most machines that use `gh`) turns an
  // example that should be excused — there is no terminal here to type at — into one
  // that quietly SUCCEEDS. Both are green, so the drift is invisible, and the example
  // means something different per machine. Derived from the pages rather than named,
  // because the set that matters is exactly the keys the docs use.
  for (const key of documentedSecretKeys()) delete env[key];
  return env;
}

/** Every `<KEY>` a documented `secrets add` names, across the pages this checker reads. */
function documentedSecretKeys() {
  const keys = new Set();
  for (const rel of sourceFiles()) {
    for (const { command } of extract(rel)) {
      const m = /^asterism\s+secrets\s+add\s+\S+\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(command);
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}
const ENV = cleanEnv();

/**
 * Run one command while BUILDING a fixture, through `runBinary` so it gets the same timeout
 * and the same refusal to read a killed child. A non-zero exit throws: a fixture that
 * half-built is worse than one that stops, because every page checked against it would be
 * checked against a state the docs never describe.
 *
 * One function rather than the same eight lines in `buildFixture` and `seedRecords` — they
 * were changed identically once already, and the next change to one is where they diverge.
 */
function fixtureRunner(work) {
  return (args, input) => {
    const r = runBinary(args, { cwd: work, input: input ?? "", where: "while building a page's fixture install" });
    if (r.code !== 0) {
      throw new Error(
        `fixture command \`asterism ${args.join(" ")}\` exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`,
      );
    }
    return r.stdout;
  };
}

/**
 * A real install for one page, carrying every agent, file and record that page's
 * examples name but do not create for themselves. `skipAgents` are the ones the page
 * teaches you to create — seeding those would make the page's own `new` line fail.
 */
function buildFixture(skipAgents = new Set(), skipConnections = false) {
  const work = mkdtempSync(join(tmpdir(), "asterism-docs-"));
  // Every ordinary path removes these in a `finally`; the abort paths in `runBinary` do
  // not run one, and each install is a full `.asterism` store. Registered here so a
  // timeout, a crash or an over-long output leaves nothing behind either.
  FIXTURES.add(work);
  const q = fixtureRunner(work);

  q(["init"]);
  // Every agent name the docs use, at the trust level the page gives it.
  const agents = [
    ["writer", "casual-helper", "drafts and tightens blog posts", "autonomous"],
    ["client", "careful-consultant", "reviews client work", "propose"],
    ["work", "careful-consultant", "handles client projects", "propose"],
    ["personal", "casual-helper", "personal helper", "autonomous"],
    ["helper", "casual-helper", "tries things out", "propose"],
    ["researcher", "careful-consultant", "digs through source material", "notify"],
  ];
  const made = [];
  for (const [name, soul, role, trust] of agents) {
    if (skipAgents.has(name)) continue;
    q(["new", name, "--soul", soul, "--role", role, "--trust", trust]);
    made.push(name);
  }

  // Files the examples attach or point at.
  for (const f of ["blog-style.md", "blog-writer.md"]) {
    writeFileSync(join(work, f), "# Style\n\nShort sentences. No hype.\n");
  }
  mkdirSync(join(work, "posts"), { recursive: true });
  writeFileSync(join(work, "posts", "launch.md"), "# Launch\n\nDraft.\n");
  writeFileSync(join(work, "posts", "hello.md"), "hello\n");

  // Records the read/mutate examples expect to find, only for agents that exist here.
  for (const name of made) seedRecords(work, name, made, skipConnections);

  return work;
}

/**
 * Give one agent the records the docs' examples assume it already has. Called at
 * fixture time, and again after a page creates an agent for itself — otherwise a page
 * that teaches `asterism new writer` gets a writer with no skill, no objective and no
 * working notes, and its later examples fail on the checker's setup rather than on
 * anything the page got wrong.
 *
 * What this does NOT claim: that a page is a runnable transcript. A reference page's
 * snippets are illustrative and its output blocks show a representative session. The
 * claim under test is that every command RUNS against a realistic install.
 */
function seedRecords(work, name, present, skipConnections = false) {
  const q = fixtureRunner(work);

  if (name === "work" || name === "client") {
    q(["secrets", "add", name, "GITHUB_TOKEN"], "ghp_fixture_token");
  }
  if (name === "writer") {
    q(["skill", "add", "writer", "blog-style.md"]);
    q(["objective", "add", "writer", "keep the launch blog current and on-brand"]);
    q(["notes", "set", "writer", "house style", "sentence case in headings"]);
    q(["notes", "set", "writer", "draft status", "intro rewritten, closing needs a pass"]);
    // A note AWAITING REVIEW — the state `notes accept` / `notes reject` act on. There is
    // no CLI verb that produces one (the agent proposes it mid-run, which needs a model),
    // so it is written through the store the same way the acceptance script reaches in.
    const store = AsterismStore.open(join(work, HOME, "asterism.db"));
    try {
      const writer = store.agents.list().find((a) => a.name === "writer");
      if (writer) store.worldFacts.upsert(writer.id, "draft status", "ready for review", "proposed");
    } finally {
      store.close();
    }
  }
  // The connections the collaboration examples run over, one per shipped mode. Skipped
  // when the section opens its own — a page that teaches `connect` must be able to show
  // the refusal that precedes it, and one that teaches `disconnect` must not have a
  // later example silently rescued by a channel the checker re-opened.
  // The one thing a delegated-tool example cannot create for itself: an endpoint on the
  // CALLEE. A grant may only name a tool the callee already holds, so without this the
  // page's own `delegate` line fails on the checker's setup rather than on anything the
  // page got wrong. The channel and the grant are deliberately NOT seeded — each page
  // opens its own, and a page that teaches `delegate` must be able to show the refusal
  // that precedes it. The address is a `.test` name (RFC 6761: guaranteed not to resolve),
  // and `asterism call` is unrunnable here, so this checker never opens a socket.
  if (name === "helper" || name === "researcher") {
    q(["secrets", "add", name, "GITHUB_TOKEN"], "ghp_fixture_token");
    q(["api", "add", name, "issues", "https://api.example.test/issues?state=open", "--credential", "GITHUB_TOKEN"]);
  }

  if (skipConnections) return;
  if ((name === "writer" || name === "researcher") && present.includes("writer") && present.includes("researcher")) {
    // DERIVED from the kernel's enum, not listed. Listed, this fell one mode behind the
    // moment `delegated-tool` shipped — and the failure would have been a docs page whose
    // examples fail on the CHECKER's setup rather than on anything the page got wrong,
    // which is the least useful kind of red. A sixth mode joins the fixture by existing.
    for (const mode of CONNECTION_MODES) {
      q(["connect", "writer", "researcher", "--mode", mode]);
    }
    // A standing brief, so `unbrief` and `briefs` meet the state their examples describe.
    q(["brief", "writer", "researcher", "Q3 launch: enterprise buyers, ship by Friday"]);
  }
  // A delegated-tool channel with a tool ALREADY handed over — the state `## undelegate`
  // acts on without opening it. Sections get their own install (see `byFile`), so a
  // section that names a grant but does not make one has to meet it here; `## delegate`
  // opens its own and is skipped by the `skipConnections` guard above, exactly as
  // `## connect` is.
  if (name === "helper" && present.includes("writer") && present.includes("helper")) {
    q(["connect", "writer", "helper", "--mode", "delegated-tool"]);
    q(["delegate", "writer", "helper", "issues"]);
  }
}

/** Agent names currently in an install, read back from the binary rather than assumed. */
function liveAgents(work) {
  const out = runCommand(work, "asterism list", "while reading back which agents an install has");
  // `list` prints one bulleted row per agent: "• writer · propose".
  return [...out.stdout.matchAll(/^\s*[•*-]\s+([\w-]+)\s+·/gm)].map((m) => m[1]);
}

/** Agents a page creates for itself, which must therefore not be seeded into it. */
function agentsCreatedBy(items) {
  const names = new Set();
  for (const { command } of items) {
    const m = command.match(/^asterism\s+new\s+(\S+)/);
    if (m && !/^[<[]/.test(m[1])) names.add(m[1]);
  }
  return names;
}

// -------------------------------------------------------------------- checks

/** Split a command line into argv, honouring double quotes. */
function argvOf(command) {
  const parts = command.match(/"[^"]*"|\S+/g) ?? [];
  return parts.slice(1).map((p) => (p.startsWith('"') ? p.slice(1, -1) : p));
}

/** Collapse runs of whitespace so a synopsis aligned for the page still matches. */
const norm = (s) => s.replace(/\s+/g, " ").trim();

/**
 * The `Commands:` block of the root help — the source BOTH verb derivations read.
 *
 * Empty is refused rather than returned. Every pass built on this treats an empty block as
 * "no verbs", which is not a finding anywhere: `checkCommandCoverage` then reports that
 * every command in `asterism --help` has a reference section, over none of them, and
 * `probeSubcommandRejections` probes nothing and says every verb rejects an invented
 * subcommand. A binary that cannot print its own help is a broken checkout, and saying so
 * is the difference between that and a green.
 */
function commandsBlock(work) {
  const block = commandsBlockOf(helpFor(work, ""));
  if (!block.trim()) {
    console.error(
      "`asterism --help` printed no `Commands:` block, so this check cannot derive a single\n" +
        "verb — and every pass built on that list would report a green over nothing.\n" +
        "Rebuild with:  bun run build",
    );
    process.exit(2);
  }
  return block;
}

/**
 * The extraction itself, on the text rather than on a work directory, so the self-test can
 * hand it the shapes that matter — including the empty one.
 *
 * ⚠ Stated limit: the REFUSAL above is not exercised. It is `process.exit(2)` inside a
 * function that gets its input from the built binary, and no fixture here can make
 * `asterism --help` print nothing. What is exercised is the extraction, which is where the
 * empty string would come from; the kill that originally produced one is now stopped at
 * `runBinary`, so this refusal is a second line rather than the only one.
 */
function commandsBlockOf(helpText) {
  return helpText.split(/^Commands:$/m)[1]?.split(/^\S/m)[0] ?? "";
}

/** Every verb the root help advertises, derived from that block. */
function advertisedVerbSet(work) {
  return new Set([...commandsBlock(work).matchAll(/^\s{2}([a-z][\w-]*)/gm)].map((m) => m[1]));
}

/** `--help` for a command, cached; the top-level help under the empty key. */
const helpCache = new Map();
function helpFor(work, verb) {
  if (helpCache.has(verb)) return helpCache.get(verb);
  const args = verb ? [...verb.split(" "), "--help"] : ["--help"];
  // A non-zero exit is expected here — several verbs print their help and exit 1 — so both
  // streams are kept. A KILLED child is not: `runBinary` stops the run rather than letting
  // the empty string it left behind be cached as this verb's help.
  const r = runBinary(args, { cwd: work, where: `while reading \`asterism ${args.join(" ")}\`` });
  const text = `${r.stdout}${r.stderr}`;
  helpCache.set(verb, text);
  return text;
}

/**
 * Concrete values for the placeholders a synopsis uses, so the grammar can be TYPED at
 * the binary rather than merely compared to help text. Anything left unsubstituted is
 * reported, so the coverage of this table is visible instead of assumed.
 */
const PLACEHOLDERS = {
  "<command>": "list",
  "<agent>": "writer",
  "<from>": "writer",
  "<to>": "researcher",
  "<level>": "notify",
  "<capability>": "fs.delete",
  "<key>": "fs.read",
  "<KEY>": "GITHUB_TOKEN",
  "<file.md>": "blog-style.md",
  "<name|path>": "casual-helper",
  "<name>": "issues",
  "<text>": "x",
  "<task>": "x",
  "<brief>": "x",
  "<subject>": "house style",
  "<value>": "x",
  "<focus>": "x",
  "<n>": "5",
  "<id>": "deadbeef",
  "<run>": "deadbeef",
  "<type>": "semantic",
  "<state>": "proposed",
  "<mode>": "handoff",
  "<m>": "handoff",
  "<kind>": "serve",
  "<protocol>": "openai-completions",
  "<model-id>": "gpt-4o-mini",
  "<url>": "https://example.com/x",
  "<https-url>": "https://example.com/x",
  "<base-url>": "https://example.com/x",
  "<addr>": "127.0.0.1",
  "<token>": "deadbeef",
  "<chat-id>": "8675309",
  "<channel-id>": "8675309",
  "<args>": "--port 8080",
  "<path>": "drafts/market-section.md",
};

/**
 * A SECOND witness for a variadic placeholder (`<key>...`). A variadic synopsis claims
 * the verb takes MANY, so typing one value would not exercise the claim — and leaving
 * the literal `...` attached does not even type a valid one: `capabilities set writer
 * fs.read...` was rejected as an unknown capability, a SEMANTIC refusal that the shape
 * check correctly ignores, so every variadic form silently skipped its own check.
 */
const VARIADIC_SECOND = {
  "<key>": "fs.list",
};

/**
 * Turn a synopsis into something typable: drop the ` · ` alternatives and the `[...]`
 * optionals (a synopsis's required core is the arity claim worth checking), then swap
 * each `<placeholder>` for a real value.
 */
function concretize(command) {
  let s = command.split(" · ")[0].replace(/\[[^\]]*\]/g, " ");
  // Variadic first, so the `...` never survives into a typed argument. Expanded to two
  // distinct values where one exists, so the command actually exercises "takes many".
  s = s.replace(/(<[^<>]+>)\.\.\./g, (_m, ph) => {
    const first = PLACEHOLDERS[ph];
    if (first === undefined) return ph;
    const second = VARIADIC_SECOND[ph];
    return second === undefined ? first : `${first} ${second}`;
  });
  for (const [ph, value] of Object.entries(PLACEHOLDERS)) s = s.split(ph).join(value);
  // `<a|b|c>` enumerates the accepted values; the first is as good a witness as any.
  s = s.replace(/<([^<>|]+\|[^<>]*)>/g, (_m, alts) => alts.split("|")[0]);
  const leftover = [...s.matchAll(/<[^>]+>/g)].map((m) => m[0]);
  return { text: norm(s), leftover };
}

/**
 * Is this the binary refusing the SHAPE of a command, rather than refusing its meaning?
 *
 * The distinction is the whole synopsis check: a shape rejection means the page promised
 * a grammar the binary does not have, while a semantic refusal ("No agent named …") is
 * the checker's substituted value being unrealistic, which is not the page's fault.
 *
 * This list was wrong three times, each time by being SHORT — `takes no …`, then
 * `does not take …`, then `Unknown subcommand:`, which meant an invented subcommand
 * under a real verb (`asterism api bogus <agent>`) sailed through the gate built to
 * catch exactly that. Enumerating message prefixes by hand does not converge, so
 * `--self-test` no longer trusts this list: it derives the verbs that HAVE subcommands
 * from the docs' own synopses, types an invented one at each, and fails unless every
 * refusal lands here. See `probeSubcommandRejections`.
 */
function isShapeRejection(line) {
  return (
    /^(Usage:|Unknown (command|subcommand):)/.test(line) ||
    /\bdoes not take\b/.test(line) ||
    /\btakes no\b/.test(line)
  );
}

/**
 * Every verb the docs show with subcommands must reject an invented one, AND that
 * rejection must be recognised by `isShapeRejection`. Derived from the binary's actual
 * answers rather than from a list in this file, so the detector cannot quietly fall
 * behind the CLI's wording again.
 */
function probeSubcommandRejections(work) {
  // From the binary's own `Commands:` block, where a bare second word IS a subcommand by
  // construction (`capabilities show <agent>`), and a placeholder is not
  // (`run <agent> "<task>"`, `confirm [<agent>] <run>`). Deriving this from the DOCS
  // instead read the agent name in `asterism confirm researcher <run>` as a subcommand
  // and reported a rejection that was never a rejection.
  const block = commandsBlock(work);
  const verbs = new Set();
  for (const line of block.split("\n")) {
    const m = line.match(/^\s{2}([a-z][\w-]*)\s+([a-z][\w-]*)/);
    if (m) verbs.add(m[1]);
  }
  const missed = [];
  for (const verb of [...verbs].sort()) {
    const result = runCommand(work, `asterism ${verb} __nosuch_subcommand__`, "while probing subcommand rejections");
    const first = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
    if (result.code === 0 || !isShapeRejection(first)) {
      missed.push(`  asterism ${verb} __nosuch_subcommand__\n    → ${first || "(no output)"}`);
    }
  }
  return missed;
}

/**
 * A synopsis claims a grammar. Three things in it are checkable without demanding it be
 * byte-identical to `--help` (the docs legitimately specialize — the reference page
 * gives `channel telegram` its own line where the binary prints one for both):
 *
 *   1. the command path is real — the binary does not answer "Unknown command";
 *   2. every `--flag` it names appears in that command's own help;
 *   3. TYPED with real values, the binary does not reject its SHAPE.
 *
 * (3) is what catches arity drift — a synopsis promising `remove <agent> <name> <name>`
 * for a verb that takes one name. Only a grammar rejection fails it; every other
 * refusal (an agent that does not exist, an id that resolves to nothing) is the
 * substitution's fault, not the page's, and is excused.
 */
function checkSynopsis(work, scratch, command, where = "") {
  const { text, leftover } = concretize(command);
  const path = text
    .split(/\s+/)
    .slice(1)
    .filter((w) => !w.startsWith("-"));
  const verb = path[0] ?? "";
  if (!verb) return { ok: false, why: "no command word" };

  const rootHelp = helpFor(work, "");
  const verbHelp = helpFor(work, verb);
  if (/^Unknown command:/m.test(verbHelp)) {
    return { ok: false, why: `\`${verb}\` is not a command the binary answers to` };
  }

  // Prefer the deepest help the binary actually differentiates, so a flag documented
  // only under `service install` is found when the synopsis names that subcommand.
  let help = verbHelp;
  if (path.length > 1) {
    const deeper = helpFor(work, `${verb} ${path[1]}`);
    if (deeper && !/^Unknown/m.test(deeper)) help = `${verbHelp}\n${deeper}`;
  }
  const both = `${help}\n${rootHelp}`;

  const flags = [...command.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)].map((m) => m[0]);
  const missing = [...new Set(flags)].filter((f) => !new RegExp(`${f}(?![\\w-])`).test(both));
  if (missing.length) {
    return { ok: false, why: `flag(s) not in \`asterism ${verb} --help\`: ${missing.join(", ")}` };
  }

  // Type it — in a SCRATCH install, never the page's. Typing `new <agent>` creates an
  // agent, and `notes clear <agent> "<subject>"` deletes a note; run in the page's own
  // workspace, the grammar check silently rewrote the state its examples then met, and
  // three pages "failed" on damage the checker had done itself.
  if (!UNRUNNABLE.some(([re]) => re.test(text))) {
    const result = runCommand(scratch, text, where);
    const first = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
    if (isShapeRejection(first)) {
      return { ok: false, why: `typed as \`${text}\`, the binary rejected its shape`, detail: first };
    }
  }
  return { ok: true, exact: norm(both).includes(norm(command)), leftover };
}

const RUN_TIMEOUT_MS = 30_000;
/**
 * Explicit, and well above Node's 1 MB default, which no call here used to set. A command
 * printing past the limit has its child KILLED, which looked exactly like a timeout.
 */
const MAX_OUTPUT_BYTES = 16_000_000;

/**
 * The ONE place this file starts the built binary. Every invocation gets the timeout, and
 * a child that never exited stops the run here.
 *
 * It exists because the first version of that guard lived in `runCommand` and named "the
 * fifth caller nobody has written yet" as the reason to centralise — while a fifth caller
 * already existed and did not go through it. `helpFor` catches every throw into
 * `${stdout}${stderr}` and caches it, so a killed `--help` cached the empty string, and the
 * three passes built on that string could not tell: `checkCommandCoverage` derived ZERO
 * verbs from it and printed "Every command in `asterism --help` has a section in the command
 * reference" over none of them. Two more call sites — the fixture builders — carried no
 * timeout at all, so the loaded machine that motivated the timeout would hang them forever.
 */
function runBinary(args, { cwd, input = "", where = "" }) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: "utf8",
      input,
      env: ENV,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    }), stderr: "" };
  } catch (e) {
    if (e.code === "ENOBUFS") {
      console.error(
        `${where ? `${where}  ` : ""}\`asterism ${args.join(" ")}\` printed more than` +
          ` ${MAX_OUTPUT_BYTES / 1_000_000} MB, so its output was truncated and the child killed.\n` +
          `Nothing this check reads of it is complete. Either the command has run away, or a\n` +
          `page's example asks for far more output than a reader would ever see.`,
      );
      process.exit(2);
    }
    if (neverExited(e)) {
      const partial = (e.stderr?.toString() || e.stdout?.toString() || "").trim().split("\n")[0];
      console.error(
        `${where ? `${where}  ` : ""}\`asterism ${args.join(" ")}\` never finished: it was killed by` +
          ` ${e.signal}${e.code === "ETIMEDOUT" ? ` after ${RUN_TIMEOUT_MS / 1000}s` : ""}.\n` +
          `Nothing it printed is a result, so this check cannot say whether that command works.\n` +
          (partial ? `It had printed: ${partial}\n` : "") +
          (e.code === "ETIMEDOUT"
            ? `A machine under heavy load is the usual cause; a command that hangs is the other.`
            : `That is a crash, not a timeout — the binary died part-way through.`),
      );
      process.exit(2);
    }
    return { code: e.status ?? -1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

/**
 * Type one command at the built binary and read what it did.
 *
 * A child that NEVER EXITED stops the whole run here rather than returning. It has no exit
 * code — `status` is null and `signal` names what killed it — and the only thing it left
 * behind is however much output it managed before the kill. Folding that into `-1` is how a
 * killed command came to be reported as a PASS with the strongest classification this file
 * has: a page documenting its command's successful output ("Disconnected writer →
 * researcher") matches the partial stdout, so the run landed under "refused exactly as the
 * page documents". Seen in a real report, under load, on `docs/commands.md`'s `disconnect`.
 *
 * Stopping rather than returning a flag is deliberate, and it is the fix for the CATEGORY
 * rather than that one site. Four callers read this, and not one of them can say anything
 * true about a killed child: `checkSynopsis` would call the grammar fine, `liveAgents` would
 * silently seed a page's fixture with no agents, and `probeSubcommandRejections` would
 * report a rejection that never happened. Returning a flag makes correctness depend on every
 * caller remembering to test it, including the fifth one nobody has written yet.
 *
 * And it is honest about what it is: a killed child is a fact about the machine or about a
 * command that hangs, not about the documentation. Reporting it as a docs failure would send
 * the reader to the page.
 */
function runCommand(work, command, where = "") {
  return runBinary(argvOf(command), { cwd: work, where });
}

/**
 * Did the child never exit on its own? A process killed — by the timeout, or by a segfault
 * or the OOM killer — has no exit code at all: `status` is null and `signal` names what
 * killed it, where a process that ran and failed has a number and no signal. Its own
 * function because the whole defect was folding the two into one `-1`.
 *
 * Deliberately not narrowed to `ETIMEDOUT`. A crash is equally "nothing it printed is a
 * result"; only the sentence explaining it differs, and that is chosen at the call site.
 */
function neverExited(err) {
  // ⚠ NOT `status === null && signal != null` alone. A `maxBuffer` overflow satisfies that
  // too — Node kills the child and reports `code: "ENOBUFS", status: null, signal:
  // "SIGTERM"` — so an over-long output would have aborted the whole run under a message
  // blaming a crash. That is a result too big to read, not a child that failed to finish,
  // and it is handled where it happens.
  return err.status === null && err.signal != null && err.code !== "ENOBUFS";
}

// ---------------------------------------------------------------------- main

/**
 * `docs/commands.md` opens by claiming it documents EVERY command. That is a
 * completeness claim, and the single most repeated defect in the two slices before this
 * one was a surface stating a completeness it had not checked — so it is checked here,
 * against the binary's own command list rather than against a hand-kept copy.
 *
 * Twelve commands were missing when this was written.
 */
function checkCommandCoverage(work) {
  const verbs = advertisedVerbSet(work);
  const reference = readFileSync(join(ROOT, siteDir(), "commands.md"), "utf8");
  const documented = new Set(
    [...reference.matchAll(/^##\s+`([a-z][\w-]*)/gm)].map((m) => m[1]),
  );
  return [...verbs].filter((v) => !documented.has(v)).sort();
}

/** Anything carrying a URI scheme (or protocol-relative) is not this repo's to resolve. */
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Read one inline link destination, starting just after `](`. Returns `{ dest, end }`, or
 * null when the text is not a readable inline link — which the caller REPORTS rather than
 * skips.
 *
 * A scanner rather than a pattern, because the destination rule is not expressible as one.
 * A destination may contain parentheses when they BALANCE, and may escape them with a
 * backslash; the renderer resolves both. Checked against the site's own Python-Markdown:
 * `[a](assets/flow(2).png)` renders `href="assets/flow(2).png"`, `[c](foo\(bar\).md)`
 * renders `href="foo(bar).md"`, and `[e](unbalanced(.md)` renders as literal text and is
 * not a link at all.
 *
 * An expression that stops at the first `)` gets all three wrong in the same direction —
 * it resolves `assets/flow(2`, reports a link that is not broken, and reports a
 * non-link. That is the one failure this file must not have: it has manufactured a defect
 * once already, and four CORRECT links were edited to agree with it, breaking the
 * published page while CI stayed green. Hence a scanner, and hence the fixture controls.
 */
function readInlineLink(line, start) {
  let i = start;
  const isSpace = (ch) => ch !== undefined && /\s/.test(ch);
  while (isSpace(line[i])) i++;
  let dest = "";
  if (line[i] === "<") {
    i++;
    while (i < line.length && line[i] !== ">") {
      if (line[i] === "\\" && i + 1 < line.length) i++;
      dest += line[i++];
    }
    if (line[i] !== ">") return null;
    i++;
  } else {
    let depth = 0;
    for (; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\\" && i + 1 < line.length) {
        dest += line[++i];
        continue;
      }
      if (isSpace(ch)) break;
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
      dest += ch;
    }
    // An UNBALANCED paren is the other place the two renderers part company, measured the
    // same way: `[x](a(b "t")` links to `a(b` under Python-Markdown, while CommonMark
    // admits parentheses in a bare destination only in balanced pairs — so on GitHub it
    // is not a link at all. Declining is the only answer true of both.
    if (depth !== 0) return null;
  }
  while (isSpace(line[i])) i++;
  const opener = line[i];
  // Quoted titles only. A PARENTHESISED title is where the two renderers that see these
  // files disagree, measured not assumed: `[x](page.md (t))` is a link to `page.md` under
  // CommonMark — so on GitHub, which renders README — and a link to the whole of
  // `page.md (t)` under the Python-Markdown that builds the site. Guessing either way is
  // a defect: take CommonMark and a docs page's broken link reports as resolved; take
  // Python-Markdown and a README link reports as broken. So this returns null and the
  // caller calls it undecidable, which is the one answer that is true of both.
  if (opener === '"' || opener === "'") {
    const closer = opener;
    i++;
    while (i < line.length && line[i] !== closer) {
      if (line[i] === "\\" && i + 1 < line.length) i++;
      i++;
    }
    if (line[i] !== closer) return null;
    i++;
    while (isSpace(line[i])) i++;
  }
  if (line[i] !== ")") return null;
  return { dest, end: i + 1 };
}

/**
 * Every link a file makes, in every form these pages actually use: markdown
 * inline links AND images, reference definitions, and raw HTML `href`/`src` — README's
 * wordmark, both screenshots, and its "Watch it live" link are HTML, and the pass that
 * only understood markdown could not see any of them.
 *
 * Read by a scanner and then CLASSIFIED by the resolver, rather than recognised by a
 * pattern that enumerates the shapes we happened to remember. Enumerating shapes is the
 * mistake this whole file exists to stop making — and the first two drafts of THIS
 * function each made it again in miniature. The first took HTML attributes in all three
 * quoting forms while accepting only a double-quoted Markdown title, so
 * `[x](./missing.md 'label')` matched nothing and was dropped without a word. The second
 * fixed that with a wider expression and still stopped the destination at the first `)`,
 * which reads a VALID `[a](flow(2).png)` as a link to `flow(2` — inventing a broken link
 * rather than missing one. It also took a parenthesised title on the strength of the
 * CommonMark spec, which the site's renderer does not implement. `readInlineLink` is
 * where all of that now lives, checked case by case against the renderer itself.
 *
 * The general defence is that every `](` is accounted for: one that the scanner cannot
 * read is REPORTED as undecidable rather than skipped. A shape we do not recognise is
 * precisely the failure this pass exists to stop, and silence is how the version before
 * these hid five at once.
 *
 * A fenced block is skipped: a link inside a code listing is a sample, not a claim about
 * a file in this repo, and reporting it would manufacture a defect.
 *
 * EVERY target, external ones included, because two passes read this and they disagree
 * about which is theirs. Resolving a path on disk cannot follow `https://`; resolving a
 * link into this repo's own SITE can only follow `https://`. Filtering here would have
 * left the second pass writing its own scanner, and the shapes it forgot are what this
 * function's history is made of. Each caller says which targets are its own.
 */
function* linkTargets(text) {
  const htmlAttr =
    /<[a-zA-Z][^>]*?\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  const refDef = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/;
  let inFence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (let at = line.indexOf("]("); at !== -1; ) {
      const parsed = readInlineLink(line, at + 2);
      if (parsed === null) {
        yield { target: null, line: i + 1, raw: line.trim() };
        at = line.indexOf("](", at + 2);
        continue;
      }
      yield { target: parsed.dest, line: i + 1 };
      at = line.indexOf("](", parsed.end);
    }
    const ref = refDef.exec(line);
    const targets = [
      ...[...line.matchAll(htmlAttr)].map((m) => m[1] ?? m[2] ?? m[3]),
      ...(ref ? [ref[1]] : []),
    ];
    for (const target of targets) yield { target, line: i + 1 };
  }
}

/**
 * The subset `checkLinks` resolves on disk: everything without a URI scheme, plus the
 * unreadable shapes, which belong to whichever pass would have had to decide them.
 */
function* internalLinks(text) {
  for (const link of linkTargets(text)) {
    if (link.target === null || !EXTERNAL_TARGET.test(link.target)) yield link;
  }
}

/**
 * EVERY markdown file this repo ships, not just the published ones. A dead cross-reference
 * fails a reader wherever it is written, and the set this pass used to read — `docs/` plus
 * the repo root — left eleven tracked files out on the reasoning that their links "resolve
 * against a different base". Two of those eleven carry an internal link today
 * (`decisions/README.md`, `.github/PULL_REQUEST_TEMPLATE.md`), and both resolve on disk,
 * which is what GitHub serves them from.
 *
 * The base question is real but belongs to the ANCHOR RULE, which asks `isPublished` per
 * file rather than trimming the corpus: a page on the site is judged by mkdocs' slugs and
 * everything else by GitHub's. The one case that stays genuinely undecidable is a package
 * README's relative link as NPM renders it — npm rewrites those against the repo — and this
 * pass says what it checked rather than pretending otherwise.
 */
function linkSourceFiles() {
  return trackedMarkdown();
}

/**
 * Every internal link resolves — the file exists, and a `#fragment` names a real heading
 * on it. Targets are resolved on disk, relative to the file that makes the link, so a
 * subdirectory path and an upper-case filename are ordinary cases rather than shapes the
 * matcher forgot.
 *
 * `root`/`files` are parameters so `--self-test` can point the whole pass at a fixture of
 * known-bad links. Until this rewrite the pass had no self-test at all — the planted-
 * command run skipped it outright, so it could have been reporting nothing and the
 * harness would still have printed PASSED.
 *
 * `unchecked` is not a failure but is never silent: it is where a link this pass cannot
 * decide gets counted, so the difference between "resolved" and "not looked at" stays
 * visible in the report instead of hiding inside the word "every".
 */
function checkLinks(root = ROOT, files = linkSourceFiles()) {
  const rootAbs = resolve(root);
  const anchorCache = new Map();
  const anchorsFor = (abs, rule) => {
    const key = `${abs}\u0000${rule.name}`;
    if (!anchorCache.has(key)) {
      anchorCache.set(key, anchorsOf(readFileSync(abs, "utf8"), rule));
    }
    return anchorCache.get(key);
  };
  const broken = [];
  const unchecked = [];
  let links = 0;
  for (const rel of files) {
    const abs = join(rootAbs, rel);
    for (const { target, line, raw } of internalLinks(readFileSync(abs, "utf8"))) {
      links++;
      const where = `${rel}:${line}`;
      if (target === null) {
        unchecked.push(`${where} → could not read the link destination (${raw.slice(0, 90)})`);
        continue;
      }
      const hash = target.indexOf("#");
      const pathPart = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? "" : target.slice(hash + 1);
      const targetAbs = pathPart === "" ? abs : resolve(dirname(abs), pathPart);
      if (targetAbs !== rootAbs && !targetAbs.startsWith(rootAbs + sep)) {
        unchecked.push(`${where} → ${target} (resolves outside the repo)`);
        continue;
      }
      if (!existsSync(targetAbs)) {
        broken.push(`${where} → ${target} (no such file)`);
        continue;
      }
      if (!frag) continue;
      if (!targetAbs.endsWith(".md")) {
        unchecked.push(`${where} → ${target} (fragment into a non-markdown file)`);
        continue;
      }
      const rule = anchorRuleFor(rel, relative(rootAbs, targetAbs));
      if (!anchorsFor(targetAbs, rule).has(frag)) {
        broken.push(`${where} → ${target} (no such section under ${rule.name} anchors)`);
      }
    }
  }
  return { broken, unchecked, links, files: files.length };
}

/**
 * The report's sentence about links, derived from the result rather than written beside
 * it. The whole defect this pass is repairing was a sentence that had outgrown its check,
 * so the sentence is now a function of the numbers: a link the pass could not decide is
 * named IN it, not left for a section further down to quietly contradict.
 */
function linkSummary({ links, files, broken, unchecked }) {
  const where = `internal links in the ${files} markdown files this repo tracks`;
  if (unchecked.length === 0) {
    return `Every one of the ${links} ${where} resolves, headings included.`;
  }
  return (
    `${links - broken.length - unchecked.length} of the ${links} ${where} resolve, headings` +
    ` included; ${unchecked.length} could not be decided and are listed below.`
  );
}

/**
 * The link pass, run against a fixture of known-bad links — one per blind spot the
 * previous matcher had, plus controls it must NOT report.
 *
 * The controls are half the point. The failure this pass has already committed once was
 * not missing a defect, it was INVENTING one: a wrong anchor port declared four correct
 * links dead, and they were "fixed" to agree with it. So a checker that reports a valid
 * upper-case link, a valid image, or a link inside a code fence is as broken as one that
 * stays quiet — and only the plant-and-control pair catches both directions.
 *
 * Returns a list of failures; empty means the pass sees exactly what it should.
 */
function probeLinkFixture() {
  // The fixture's paths spell `docs/` out, because half of these cases turn on whether a
  // page is PUBLISHED and reading `${SITE}/site.md#a-b` twenty times would obscure the one
  // thing each line is about. That makes the literal a dependency, so it is stated here
  // rather than left to be discovered: move `docs_dir` and the four quadrant cases below
  // silently change quadrant, which shows up as a planted link going uncaught — a real
  // failure with a misleading explanation. Say the actual cause instead.
  if (siteDir() !== "docs") {
    return [
      `  this fixture's paths assume the site publishes 'docs/', and mkdocs.yml now says` +
        ` '${siteDir()}'. Rename the docs/ paths in PLANTED and CONTROLS to match; the cases` +
        ` that turn on published-vs-not are the four quadrant ones and the two after them.`,
    ];
  }
  // Each planted target names the blind spot it covers; every one of these was invisible
  // to the `[a-z0-9-]+\.md`, `docs/`-only matcher this replaced — except the first two,
  // which it did catch and which are here so a rewrite cannot lose them.
  const PLANTED = [
    ["nosuch.md", "lower-case missing page"],
    ["#no-such-local-section", "missing section on the page itself"],
    ["NOSUCH.md", "UPPER-CASE missing page"],
    ["sub/nosuch.md", "missing page down a subdirectory"],
    ["OTHER.md#no-such-section", "missing section on an upper-case page"],
    ["img/nosuch.png", "missing image"],
    ["nosuch-html.md", "missing target of a raw HTML href"],
    ["img/nosuch-html.png", "missing source of a raw HTML img"],
    ["nosuch-single.md", "missing target of a SINGLE-quoted HTML href"],
    ["img/nosuch-unquoted.png", "missing source of an UNQUOTED HTML src"],
    ["OTHER.md#fenced-only", "section that exists only as a # comment inside a fence"],
    ["sub/nosuch-ref.md", "missing target of a reference-style definition"],
    ["../nosuch-from-sub.md", "missing page relative to a file in a subdirectory"],
    ["nosuch-single-title.md", "missing page behind a SINGLE-quoted Markdown title"],
    ["nosuch-angle.md", "missing page given as an <angle-bracket> destination"],
    ["nosuch spaced.md", "missing page whose <angle-bracket> destination contains a space"],
    ["img/nosuch(1).png", "missing image whose destination contains BALANCED parentheses"],
    ["img/nosuch(2).png", "missing image whose parentheses are BACKSLASH-ESCAPED"],
    // The repo root is rendered only by GitHub, so the SITE's anchor forms are wrong
    // there. Both of these resolve under Python-Markdown and must not under GitHub.
    ["OTHER.md#repeat_1", "site-style duplicate suffix on a GitHub-rendered file"],
    ["OTHER.md#a-b", "site-style collapsed em-dash anchor on a GitHub-rendered file"],
    // The rule follows where the link is CLICKED. These four are the other two quadrants:
    // a root page's link is followed on GitHub even when it points into docs/, and a
    // docs page's link is followed on the published site.
    ["docs/site.md#a-b", "site-style anchor in a link followed on GitHub (root source)"],
    ["docs/site.md#same_1", "site-style duplicate suffix in a link followed on GitHub"],
    ["target.md#a--b", "GitHub-style anchor in a link followed on the published site"],
    ["target.md#same-1", "GitHub-style duplicate suffix in a link followed on the site"],
    // A docs/ page pointing OUTSIDE docs/ has left the site, so its fragment is GitHub's
    // even though the page making the link is published. Source alone does not decide it.
    ["../OTHER.md#a-b", "site-style anchor on a link that leaves the site"],
  ];
  // Every one of these is correct and must stay unreported.
  const CONTROLS = [
    "OTHER.md",
    "OTHER.md#real-heading",
    "img/real.png",
    "https://example.com/nosuch-external.md",
    "#local-heading",
    "OTHER.md#repeat-1",
    "OTHER.md#a--b",
    "sub/",
    "nosuch-in-fence.md",
    "../OTHER.md#real-heading",
    "OTHER.md#repeat",
    "sub/page.md",
    // A real file whose name contains parentheses, linked both bare and escaped. The
    // renderer resolves both to the same path; a checker that stops at the first `)`
    // calls both of them broken and invites someone to "fix" a working link.
    "img/real(1).png",
    // A `docs/` page is published by mkdocs AND browsable on GitHub, so a fragment valid
    // under either rule is genuinely reachable and neither may be reported.
    "docs/site.md#a--b",
    "docs/site.md#same-1",
    "target.md#a-b",
    "target.md#same_1",
    "../OTHER.md#a--b",
    // Resolved from a root source AND a docs source, so the two rules meet on one file:
    // an anchor cache that forgets which rule produced its answer hands the second source
    // the first one's anchors.
    "docs/target.md#a--b",
  ];
  // Not failures, but they must not be silently counted as resolved either.
  const UNDECIDABLE = ["../outside-the-fixture.md", "img/real.png#zoom"];
  // A link shape this parser cannot take apart is the case that has to stay LOUD: a
  // silent drop is how the previous matcher reported five blind spots as "every link
  // resolves". The count assertion below is what makes that general rather than a list.
  // Four are planted, each a shape where guessing would be a defect rather than a miss:
  // an unclosed `](`; an unbalanced paren the site's renderer leaves as literal text; a
  // PARENTHESISED title; and an unbalanced paren followed by a quoted title, where the
  // site links to a truncated path and GitHub links to nothing (see readInlineLink).
  const UNPARSEABLE = "could not read the link destination";
  const UNPARSEABLE_PLANTS = 4;

  const dir = mkdtempSync(join(tmpdir(), "asterism-doclinks-"));
  try {
    mkdirSync(join(dir, "sub"), { recursive: true });
    mkdirSync(join(dir, "img"), { recursive: true });
    writeFileSync(join(dir, "img", "real.png"), "");
    writeFileSync(join(dir, "img", "real(1).png"), "");
    writeFileSync(
      join(dir, "OTHER.md"),
      [
        "# Other",
        "",
        "## Real heading",
        "",
        "## Repeat",
        "",
        "## Repeat",
        "",
        "## A — B",
        "",
        "```bash",
        "# fenced only",
        "echo hi",
        "```",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "index.md"),
      [
        "# Fixture index",
        "",
        "## Local heading",
        "",
        "- [a](nosuch.md)",
        "- [b](NOSUCH.md)",
        "- [c](sub/nosuch.md)",
        "- [d](OTHER.md#no-such-section)",
        "- ![e](img/nosuch.png)",
        '- <a href="nosuch-html.md">f</a>',
        '- <img src="img/nosuch-html.png" alt="g">',
        "- <a href='nosuch-single.md'>f2</a>",
        "- <img src=img/nosuch-unquoted.png alt=g2>",
        "- [h](OTHER.md#fenced-only)",
        "- [k](#no-such-local-section)",
        "",
        "[i]: sub/nosuch-ref.md",
        "",
        "- [ok1](OTHER.md)",
        "- [ok2](OTHER.md#real-heading)",
        "- ![ok3](img/real.png)",
        '- <a href="OTHER.md">ok4</a>',
        "- [ok5](https://example.com/nosuch-external.md)",
        "- [ok6](#local-heading)",
        "- [ok9](sub/)",
        "- [ok11](OTHER.md#repeat)",
        "- [ok23](docs/target.md#a--b)",
        "- [ok17](OTHER.md#repeat-1)",
        "- [ok18](OTHER.md#a--b)",
        "- [ok19](docs/site.md#a-b)",
        "- [ok20](docs/site.md#a--b)",
        "- [ok21](docs/site.md#same_1)",
        "- [ok22](docs/site.md#same-1)",
        "- [pm1](OTHER.md#repeat_1)",
        "- [pm2](OTHER.md#a-b)",
        "- <a href='sub/page.md'>ok12</a>",
        "- [t1](nosuch-single-title.md 'label')",
        "- [t2](nosuch-paren-title.md (label))",
        "- [t3](<nosuch-angle.md>)",
        "- [t4](<nosuch spaced.md>)",
        "- [ok13](OTHER.md 'label')",
        '- [ok14](OTHER.md#real-heading "label")',
        "- [p1](img/nosuch(1).png)",
        "- [p2](img/nosuch\\(2\\).png)",
        "- [ok15](img/real(1).png)",
        "- [ok16](img/real\\(1\\).png)",
        "- [u1](../outside-the-fixture.md)",
        "- [u2](img/real.png#zoom)",
        "- [u3](this-shape-has-no-closing-paren.md",
        "- [u4](unbalanced(.md)",
        '- [u5](a(b "t")',
        "",
        "```markdown",
        "- [ok7](nosuch-in-fence.md)",
        "```",
        "",
      ].join("\n"),
    );
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "site.md"),
      [
        "# Site page",
        "",
        "## A — B",
        "",
        "## Same",
        "",
        "## Same",
        "",
        "- [d1](target.md#a-b)",
        "- [d2](target.md#a--b)",
        "- [d3](target.md#same_1)",
        "- [d4](target.md#same-1)",
        "- [d5](../OTHER.md#a--b)",
        "- [d6](../OTHER.md#a-b)",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "docs", "target.md"),
      ["# Target", "", "## A — B", "", "## Same", "", "## Same", ""].join("\n"),
    );
    writeFileSync(
      join(dir, "sub", "page.md"),
      ["# Sub page", "", "- [j](../nosuch-from-sub.md)", "- [ok10](../OTHER.md#real-heading)", ""].join(
        "\n",
      ),
    );

    const result = checkLinks(dir, ["index.md", "OTHER.md", "sub/page.md", "docs/site.md", "docs/target.md"]);
    const { broken, unchecked } = result;
    const reported = (list, target) => list.some((entry) => entry.includes(`→ ${target} (`));
    const failures = [];
    for (const [target, why] of PLANTED) {
      if (!reported(broken, target)) failures.push(`  missed: ${target} — ${why}`);
    }
    for (const target of CONTROLS) {
      if (reported(broken, target)) failures.push(`  INVENTED a defect: ${target} is correct`);
      if (reported(unchecked, target)) failures.push(`  gave up on: ${target}, which resolves`);
    }
    for (const target of UNDECIDABLE) {
      if (reported(broken, target)) failures.push(`  reported as broken, not undecidable: ${target}`);
      if (!reported(unchecked, target)) failures.push(`  silently accepted: ${target}`);
    }
    if (!unchecked.some((entry) => entry.includes(UNPARSEABLE))) {
      failures.push("  silently dropped a link shape it could not parse");
    }
    // Count checks on top of the membership checks. Anything reported that no line above
    // names is a defect the fixture did not plant — and on the `unchecked` side that is
    // the whole general defence: a link form this parser stops recognising lands here and
    // shows up as an extra, whether or not anyone thought to plant that form.
    if (broken.length !== PLANTED.length) {
      failures.push(`  reported ${broken.length} broken links, planted ${PLANTED.length}`);
    }
    if (unchecked.length !== UNDECIDABLE.length + UNPARSEABLE_PLANTS) {
      failures.push(
        `  reported ${unchecked.length} undecidable links, expected ${UNDECIDABLE.length + UNPARSEABLE_PLANTS}:` +
          `\n${unchecked.map((u) => `      ${u}`).join("\n")}`,
      );
    }
    // The sentence the report prints is part of the check, not decoration: it claimed
    // "every internal link resolves" while listing undecidable ones underneath.
    const summary = linkSummary(result);
    if (/^Every one of/.test(summary)) {
      failures.push(`  claims every link resolves with ${unchecked.length} undecided: ${summary}`);
    }
    if (!linkSummary({ links: 3, files: 1, broken: [], unchecked: [] }).startsWith("Every one of")) {
      failures.push("  will not say 'every' even when nothing is undecided");
    }
    return failures;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  // Grouped by (page, `##` section). A reference page's sections are independent
  // snippets, not one transcript: `## disconnect` withdrawing a channel must not make
  // `## handoff`, four sections later, fail on damage the previous example did.
  const byFile = new Map();
  if (SELF_TEST) byFile.set("<planted>", plantedFailures());
  else
    for (const f of sourceFiles())
      for (const item of extract(f)) {
        const key = `${f}\u0000${item.section}`;
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key).push(item);
      }

  const total = [...byFile.values()].reduce((n, items) => n + items.length, 0);
  const tally = { ran: 0, synopsis: 0, skipped: 0, excused: 0, documented: 0 };
  // One disposable install for every grammar dry-run, built once: typing a synopsis
  // must not touch a page's own state, but the scratch state itself is never asserted
  // on (only a Usage/Unknown rejection fails a synopsis), so it is safe to share.
  const scratch = buildFixture();
  const failures = [];
  const excused = [];
  const skipped = [];
  const inexact = [];
  const unsubstituted = [];
  const documented = [];
  const outputDrifts = [];

  for (const [, items] of byFile) {
    if (!items.length) continue;
    // One page, one install — seeded with everything the page does not create itself.
    const opensOwnChannels = items.some((i) => /^asterism\s+connect\s/.test(i.command));
    const work = buildFixture(agentsCreatedBy(items), opensOwnChannels);
    try {
      for (const item of items) {
        const { command, prompted } = item;

        if (isElided(command)) {
          skipped.push({ ...item, why: "a value is elided with `…` for the reader" });
          tally.skipped++;
          continue;
        }
        if (hasPlaceholder(command)) {
          if (prompted) {
            // Typed at a prompt but carrying a placeholder: an example whose value the
            // reader supplies. Not runnable, and not a grammar claim either.
            skipped.push({ ...item, why: "the example leaves a value for the reader to fill in" });
            tally.skipped++;
            continue;
          }
          const verdict = checkSynopsis(work, scratch, command, `${item.file}:${item.line}`);
          if (verdict.ok) {
            tally.synopsis++;
            if (!verdict.exact) inexact.push(item);
            if (verdict.leftover?.length)
              unsubstituted.push({ ...item, why: verdict.leftover.join(" ") });
          } else {
            failures.push({ ...item, why: verdict.why, detail: verdict.detail ?? "" });
          }
          continue;
        }

        const unrunnable = UNRUNNABLE.find(([re]) => re.test(command));
        if (unrunnable) {
          skipped.push({ ...item, why: unrunnable[1] });
          tally.skipped++;
          continue;
        }

        const result = runCommand(work, command, `${item.file}:${item.line}`);
        if (result.code === 0) {
          tally.ran++;
          if (DIFF_OUTPUT) {
            const drift = outputDrift(item, result.stdout, result.stderr);
            if (drift) outputDrifts.push({ ...item, why: drift });
          }
          // A page that creates its own agent gets that agent's assumed records now,
          // so its later examples meet the install the page describes.
          const born = command.match(/^asterism\s+new\s+([\w-]+)/);
          if (born) seedRecords(work, born[1], liveAgents(work), opensOwnChannels);
          continue;
        }
        const first = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
        // A page may DOCUMENT a refusal — "here is what happens with no connection".
        // Then the claim under test is not that the command succeeds but that it fails
        // exactly as shown, which is a stronger check than excusing it.
        const shownFirst = (item.shown ?? []).map((l) => l.trim()).filter(Boolean)[0] ?? "";
        if (shownFirst && norm(shownFirst) === norm(first)) {
          documented.push({ ...item, detail: first });
          tally.documented++;
          continue;
        }
        if (shownFirst && /^(No |Usage:|Unknown |Set ASTERISM)/.test(shownFirst)) {
          failures.push({
            ...item,
            why: "the page shows a different refusal than the binary gives",
            detail: `page: ${shownFirst}\n      →   ran: ${first}`,
          });
          continue;
        }
        const excuse = EXCUSED.find(([re]) => re.test(first));
        if (excuse) {
          excused.push({ ...item, kind: excuse[1], why: excuse[2], detail: first });
          tally.excused++;
          continue;
        }
        failures.push({ ...item, why: `exit ${result.code}`, detail: first });
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  if (DIFF_OUTPUT) {
    console.log(`\n=== pasted output that no longer matches the binary (${outputDrifts.length}) ===`);
    for (const d of outputDrifts) console.log(`\n${d.file}:${d.line}  ${d.command}\n${d.why}`);
  }
  report(total, tally, { failures, excused, skipped, inexact, unsubstituted, documented }, scratch);
}

/** Where a finding is, as `file:line` — clickable in a terminal that makes them so. */
const at = (i) => `${i.file}:${i.line}`;

/**
 * Values that legitimately differ between the page's install and the checker's are
 * masked before comparison: ids, timestamps, ports and absolute paths.
 */
function maskVolatile(line) {
  return line
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>")
    .replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, "<id>")
    .replace(/\b[0-9a-f]{8}\b/g, "<id>")
    .replace(/(^|\s)\/[^\s]+/g, "$1<path>")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first line where a page's pasted output diverges from the binary's, or null. */
function outputDrift(item, stdout, stderr) {
  const shown = (item.shown ?? []).map(maskVolatile).filter(Boolean);
  if (!shown.length) return null;
  const actual = `${stdout}${stderr}`.split("\n").map(maskVolatile).filter(Boolean);
  for (const line of shown) {
    if (!actual.includes(line)) {
      return `      page: ${line}\n      (not in what the binary printed)`;
    }
  }
  return null;
}

function report(total, tally, groups, coverageWork) {
  if (groups.skipped.length) {
    console.log(`\nSkipped — not executable by a checker (${groups.skipped.length}):`);
    for (const i of groups.skipped) console.log(`  ${at(i)}  ${i.command}\n      ${i.why}`);
  }
  if (groups.excused.length) {
    console.log(`\nRan and refused, for a named reason (${groups.excused.length}):`);
    for (const i of groups.excused)
      console.log(`  ${at(i)}  ${i.command}\n      [${i.kind}] ${i.why}\n      → ${i.detail}`);
  }
  if (groups.documented?.length) {
    console.log(`\nRefused exactly as the page documents (${groups.documented.length}):`);
    for (const i of groups.documented) console.log(`  ${at(i)}  ${i.command}\n      → ${i.detail}`);
  }
  if (groups.unsubstituted?.length) {
    console.log(
      `\nSynopsis typed with a placeholder left literal (${groups.unsubstituted.length}) —` +
        ` its shape was still checked, but with this token unresolved:`,
    );
    for (const i of groups.unsubstituted) console.log(`  ${at(i)}  ${i.command}\n      ${i.why}`);
  }
  if (groups.inexact?.length) {
    console.log(
      `\nSynopsis accepted, but not word-for-word what \`--help\` prints (${groups.inexact.length}) —` +
        ` the command path and every flag are real; the wording is the page's own:`,
    );
    for (const i of groups.inexact) console.log(`  ${at(i)}  ${i.command}`);
  }
  // Everything above is the invocation run's own accounting: printed, added up by the
  // tally below, and never a verdict on its own. From here down, every finding this file
  // reports goes through `emit`, which prints it and records it in the same call — so a
  // pass cannot report something the exit code does not see. See lib/report-passes.mjs.
  const verdicts = [];
  const [invocations, ...checks] = reportPasses({ groups, coverageWork });
  emit(verdicts, invocations);

  const accounted =
    tally.ran + tally.synopsis + tally.skipped + tally.excused + tally.documented + groups.failures.length;
  console.log(
    `\n${total} invocations in ${
      SELF_TEST
        ? "the planted fixture"
        : `the ${sourceFiles().length} pages a user meets (the site, its landing page,` +
          ` the repo's front page, every package README npm publishes)`
    } — ` +
      `${tally.ran} ran, ${tally.synopsis} synopsis matched --help, ` +
      `${tally.documented} refused exactly as documented, ` +
      `${tally.excused} refused for a named reason, ${tally.skipped} skipped, ` +
      `${groups.failures.length} failed.`,
  );
  if (accounted !== total) {
    console.log(`\nBUG IN THIS SCRIPT: ${accounted} accounted for, ${total} extracted.`);
    process.exit(2);
  }

  if (SELF_TEST) {
    // Which markdown each pass reads is a DERIVED answer now, and a derivation nothing can
    // kill is the defect this slice exists to remove: the assertion it replaces could be
    // deleted outright and leave this self-test at exit 0. So each pass's scope is asserted
    // here in terms of the thing it is derived FROM, and each assertion fails if the
    // derivation is replaced by the constant it used to be.
    const scopeFailures = [];

    // `docs_dir` is READ. A reader that returned "docs" regardless would pass every other
    // check in this file, because "docs" is the right answer for this repo.
    const plantedConfig = readSiteConfig(["site_name: X", "docs_dir: pages", "exclude_docs: |", "  internal/", ""].join("\n"));
    if (plantedConfig.docsDir !== "pages") {
      scopeFailures.push(`  a config declaring \`docs_dir: pages\` was read as '${plantedConfig.docsDir}'`);
    }
    if (JSON.stringify(plantedConfig.exclude) !== JSON.stringify(["internal/"])) {
      scopeFailures.push(`  a block-scalar \`exclude_docs\` was read as ${JSON.stringify(plantedConfig.exclude)}`);
    }
    if (readSiteConfig("site_name: X\n").docsDir !== "docs") {
      scopeFailures.push("  a config with no `docs_dir` did not fall back to mkdocs' own default");
    }
    // `site_url` is READ too — it is what the root page's absolute links are resolved
    // against, and a `siteUrlPath()` that returned this repo's answer regardless would
    // satisfy every link assertion below while being a constant.
    if (readSiteConfig("site_url: https://example.test/a/b/\n").siteUrl !== "https://example.test/a/b/") {
      scopeFailures.push("  a config declaring `site_url` was not read");
    }
    // The two readers behind the asset half. Both are consulted, not merely available: a
    // resolver reading either wrong reports a link to a real file as naming nothing, which
    // is the finding this half exists to fix, arriving from the other side.
    const assets = publishedAssets();
    if (assets.length === 0) {
      scopeFailures.push("  git tracks no non-markdown file under `docs_dir`, so the asset rule is checked against nothing");
    }
    if (assets.some((rel) => rel.endsWith(".md"))) {
      scopeFailures.push("  publishedAssets() returned a page; mkdocs renders those, it does not copy them");
    }
    if (!trackedMarkdown().some((rel) => rel.startsWith(`${siteDir()}/`))) {
      scopeFailures.push("  no markdown lives under `docs_dir`, so excluding it from the assets proves nothing");
    }
    // …and `exclude_docs` is CONSULTED. Nothing this repo excludes is a media file, so the
    // predicate is handed in and one real file withheld — otherwise a reader that dropped
    // the exclusion entirely would give the same answer and nothing could tell.
    const withheld = publishedAssets((rel) => isPublished(rel) && rel !== assets[0]);
    if (withheld.includes(assets[0]) || withheld.length !== assets.length - 1) {
      scopeFailures.push(`  publishedAssets() ignored the predicate it was handed (${withheld.length} of ${assets.length})`);
    }
    const landingRootHere = readLandingDir(readFileSync(join(ROOT, ".github", "workflows", "docs.yml"), "utf8"));
    const landing = landingFiles();
    if (landing.length === 0 || !landing.every((rel) => rel.startsWith(`${landingRootHere}/`))) {
      scopeFailures.push(`  landingFiles() does not list files under '${landingRootHere}/': ${JSON.stringify(landing)}`);
    }

    // `use_directory_urls` decides which URL SHAPE names a page, and this repo leaves it at
    // mkdocs' default — so a reader that answers `true` regardless satisfies every link
    // assertion below while being a constant. Both directions, plus the default.
    for (const [text, want, why] of [
      ["use_directory_urls: false\n", false, "a config turning directory URLs off"],
      ["use_directory_urls: true\n", true, "a config turning them on"],
      ["use_directory_urls: False  # yaml's other spelling\n", false, "`False` with a trailing comment"],
      ["site_name: X\n", true, "a config that does not mention them"],
    ]) {
      if (readSiteConfig(text).useDirectoryUrls !== want) {
        scopeFailures.push(`  ${why} was read as ${readSiteConfig(text).useDirectoryUrls}`);
      }
    }
    // The shapes this reader REFUSES, each spawned because refusing is `process.exit(2)`.
    // Every one of them makes the prefix test match nothing, which is not an error anywhere
    // downstream — it is "no page is published", and the pass goes on reporting that every
    // link resolves while judging the whole site by the wrong renderer. Refusing is only
    // worth anything if it happens, so it is run rather than read.
    //
    // ⚠ This list is the second version. The first refused a leading `/` alone, and `.`,
    // `./` and `../docs` all walked through it silently — a correction landing narrower
    // than the thing it corrected.
    const MUST_REFUSE = [
      ["docs_dir: .", "the repo root"],
      ["docs_dir: ./", "the repo root, spelled with a trailing slash"],
      ["docs_dir: ../docs", "a path above the repo"],
      ["docs_dir: /abs/docs", "an absolute path"],
      ["docs_dir: docs\ndocs_dir: pages", "two `docs_dir` keys"],
      ["site_url: https://a.test/x/\nsite_url: https://b.test/y/", "two `site_url` keys"],
      ["use_directory_urls: true\nuse_directory_urls: false", "two `use_directory_urls` keys"],
      ["use_directory_urls: maybe", "a `use_directory_urls` value that is not a boolean"],
      ["exclude_docs: [a, b]", "an inline YAML collection"],
    ];
    for (const [text, why] of MUST_REFUSE) {
      let refused = false;
      try {
        execFileSync(
          process.execPath,
          ["-e", `import(${JSON.stringify(join(ROOT, "scripts/lib/docs-scope.mjs"))}).then((m) => m.readSiteConfig(process.argv[1]))`, text],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: ROOT },
        );
      } catch (err) {
        refused = err.status === 2;
      }
      if (!refused) scopeFailures.push(`  a config naming ${why} was accepted instead of refused`);
    }
    // …and the excluder is consulted, not merely parsed. `mkdocs-parity-check --self-test`
    // is what proves this predicate agrees with the library mkdocs reads these with; this
    // only proves the wiring exists without needing a Python interpreter to say so.
    const plantedPublished = publishedPredicate(plantedConfig);
    for (const [rel, want] of [
      ["pages/index.md", true],
      ["pages/internal/note.md", false],
      ["pages/deep/internal/note.md", false],
      ["docs/index.md", false],
    ]) {
      if (plantedPublished(rel) !== want) {
        scopeFailures.push(`  under \`docs_dir: pages\` + \`internal/\`, ${rel} should be ${want ? "" : "un"}published`);
      }
    }

    // The three above are pure functions, and a caller that never asks them would pass all
    // of them. So: what this repo's checkers actually use must equal what this repo's own
    // config parses to.
    const real = readSiteConfig(readFileSync(join(ROOT, "mkdocs.yml"), "utf8"));
    if (siteDir() !== real.docsDir) {
      scopeFailures.push(`  siteDir() is '${siteDir()}' where mkdocs.yml declares '${real.docsDir}'`);
    }
    if (real.siteUrl && siteUrlPath() !== new URL(real.siteUrl).pathname.replace(/\/?$/, "/")) {
      scopeFailures.push(
        `  siteUrlPath() is '${siteUrlPath()}' where mkdocs.yml's site_url gives '${new URL(real.siteUrl).pathname}'`,
      );
    }
    // ⚠ Neither comparison above can tell a READER from a constant, and the comment here
    // used to claim otherwise: this repo declares `docs_dir: docs` and mkdocs' own default
    // is `docs`, so `siteDir() { return "docs" }` satisfies it, and the same is true of
    // `siteUrlPath()`. Only a config that is NOT this repo's separates the two — the shape
    // `publishedPredicate` has had all along, now given to both accessors.
    const elsewhere = readSiteConfig("docs_dir: pages\nsite_url: https://example.test/a/b\n");
    if (siteDir(elsewhere) !== "pages") {
      scopeFailures.push(`  siteDir() ignored the config it was handed and answered '${siteDir(elsewhere)}'`);
    }
    if (siteUrlPath(elsewhere) !== "/a/b/") {
      scopeFailures.push(`  siteUrlPath() ignored the config it was handed and answered '${siteUrlPath(elsewhere)}'`);
    }
    if (siteUrlParts(elsewhere).origin !== "https://example.test") {
      scopeFailures.push(
        `  siteUrlParts() ignored the config it was handed and answered '${siteUrlParts(elsewhere).origin}'`,
      );
    }
    if (usesDirectoryUrls(readSiteConfig("use_directory_urls: false\n")) !== false) {
      scopeFailures.push("  usesDirectoryUrls() ignored the config it was handed");
    }
    if (usesDirectoryUrls() !== real.useDirectoryUrls) {
      scopeFailures.push(
        `  usesDirectoryUrls() is ${usesDirectoryUrls()} where mkdocs.yml parses to ${real.useDirectoryUrls}`,
      );
    }
    const fromConfig = publishedPredicate(real);
    for (const rel of trackedMarkdown()) {
      if (isPublished(rel) !== fromConfig(rel)) {
        scopeFailures.push(`  isPublished(${rel}) does not agree with mkdocs.yml as parsed`);
      }
    }
    // And the ANCHOR RULE asks that question rather than matching a path prefix. The two
    // differ on exactly one shape — a page inside `docs_dir` that `exclude_docs` removes —
    // which is unpublished, so its links are followed on GitHub and nowhere else.
    const excludedPage = `${real.docsDir}/${(real.exclude[0] ?? "internal/").replace(/\/$/, "")}/page.md`;
    if (!fromConfig(excludedPage) && anchorRuleFor(excludedPage, excludedPage).name !== "github") {
      scopeFailures.push(
        `  the anchor rule judges ${excludedPage} by mkdocs' slugs, and \`exclude_docs\` keeps it off the site`,
      );
    }

    // The link pass reads EVERY tracked markdown file. Narrow it back to `docs/` and the
    // root — the set it had — and this count no longer matches.
    const tracked = trackedMarkdown();
    const readByLinkPass = checkLinks(ROOT, linkSourceFiles()).files;
    if (readByLinkPass !== tracked.length) {
      scopeFailures.push(
        `  the link pass read ${readByLinkPass} files where this repo tracks ${tracked.length} markdown files`,
      );
    }

    // The command pass reads the pages a USER meets. Restated here from the manifests
    // rather than read back from the function under test, so this is a second derivation
    // and not the same one agreeing with itself — and asserted to be NON-EMPTY, because a
    // derivation that finds nothing would otherwise satisfy every `includes` below.
    const read = sourceFiles();
    const shipsToNpm = tracked.filter((rel) => {
      if (!rel.endsWith("/README.md")) return false;
      const manifest = join(ROOT, rel.replace(/README\.md$/, "package.json"));
      return existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).private !== true;
    });
    const shouldRead = [...new Set(["README.md", ...publishedPages(), ...shipsToNpm])];
    if (shipsToNpm.length === 0) {
      scopeFailures.push("  no package README was found beside a published manifest, so this proves nothing");
    }
    for (const page of shouldRead) {
      if (!read.includes(page)) scopeFailures.push(`  the command pass does not read ${page}`);
    }

    // Which packages npm publishes is derived here from each manifest's `private` flag, and
    // it decides which READMEs the command pass reads. The only other enumeration of that
    // same set in this repo is `release.yml`, which spells it out by hand in two `for pkg
    // in …` loops — so comparing the two is both how this derivation is proved right and
    // how a package missing from the release loops (added to the workspace, never
    // published) would be noticed. Neither list is trusted; they are made to agree.
    const releaseYml = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    const loops = [...releaseYml.matchAll(/^\s*for pkg in ([^;]+); do\s*$/gm)].map((m) => m[1].trim().split(/\s+/));
    if (loops.length === 0) {
      scopeFailures.push("  release.yml no longer spells its package list out in a `for pkg in …` loop");
    }
    const derived = publishedPackages().map((d) => d.replace(/^packages\//, "")).sort();
    loops.forEach((loop, i) => {
      const listed = [...loop].sort();
      const missing = derived.filter((p) => !listed.includes(p));
      const extra = listed.filter((p) => !derived.includes(p));
      for (const p of missing) scopeFailures.push(`  release.yml loop ${i + 1} never publishes packages/${p}`);
      for (const p of extra) scopeFailures.push(`  release.yml loop ${i + 1} publishes packages/${p}, which is not a package this repo publishes`);
    });

    // The shapes `readLandingDir` REFUSES, each spawned, because refusing is
    // `process.exit(2)` and a refusal that is only read is a refusal nobody has run. Both
    // of them leave this pass with no page to check, which is not an error anywhere
    // downstream — it is a green over a page nothing looked at, the same failure the
    // `docs_dir` refusals above exist to stop.
    //
    // ⚠ The fixtures below carry the shape the workflow actually uses — a bare `cp` line
    // inside a `run: |` block. The first version wrote them as `- run: cp -r landing/. …`,
    // which the reader cannot match at all: the "two directories" case would then have been
    // refused for having ZERO, passing for the wrong reason, and the control refused
    // outright.
    const LANDING_MUST_REFUSE = [
      ["jobs:\n  build:\n    steps:\n      - run: mkdocs build --strict\n", "no copy into the artifact root at all"],
      ["      - run: |\n          cp -r landing/. _site/\n          cp -r extra/. _site/\n", "two directories copied into the artifact root"],
    ];
    for (const [text, why] of LANDING_MUST_REFUSE) {
      let refused = false;
      try {
        execFileSync(
          process.execPath,
          ["-e", `import(${JSON.stringify(join(ROOT, "scripts/lib/docs-scope.mjs"))}).then((m) => m.readLandingDir(process.argv[1]))`, text],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: ROOT },
        );
      } catch (err) {
        refused = err.status === 2;
      }
      if (!refused) scopeFailures.push(`  a workflow with ${why} was accepted instead of refused`);
    }

    // Assembling the artifact has a third step — what the workflow DELETES from it — and
    // reading only the copy makes a removed file read as one the site serves.
    for (const [text, want, why] of [
      ["      - run: |\n          cp -r landing/. _site/\n          rm -f _site/README.md\n", ["README.md"], "the shape this repo's workflow uses"],
      ["          rm -rf _site/drafts/\n", ["drafts"], "a directory, with its trailing slash"],
      ["          rm -f _site/a.html _site/b.html\n", ["a.html", "b.html"], "two operands in one command"],
      ["          rm -rf node_modules\n", [], "an `rm` that does not touch the artifact"],
      ["      - run: mkdocs build --strict\n", [], "a workflow that deletes nothing"],
    ]) {
      const got = readLandingRemovals(text);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        scopeFailures.push(`  ${why}: readLandingRemovals gave ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
      }
    }
    {
      let refused = false;
      try {
        execFileSync(
          process.execPath,
          ["-e", `import(${JSON.stringify(join(ROOT, "scripts/lib/docs-scope.mjs"))}).then((m) => m.readLandingRemovals(process.argv[1]))`, "          rm -f _site/a.html /tmp/scratch\n"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: ROOT },
        );
      } catch (err) {
        refused = err.status === 2;
      }
      if (!refused) {
        scopeFailures.push("  an `rm` mixing artifact and non-artifact paths was accepted instead of refused");
      }
    }
    // …and the real workflow must still name one, or every assertion above is about a rule
    // this repo does not exercise.
    if (readLandingRemovals(readFileSync(join(ROOT, ".github", "workflows", "docs.yml"), "utf8")).length === 0) {
      scopeFailures.push("  the real workflow deletes nothing from the artifact, so the removal rule is checked against nothing");
    }
    // …and the control: the shape this repo actually uses is READ, not merely tolerated. A
    // parser that returned "landing" regardless would satisfy every check below.
    if (readLandingDir("      - run: |\n          cp -r pages/. _site/\n") !== "pages") {
      scopeFailures.push("  a workflow copying `pages/` was not read as publishing `pages`");
    }
    // The refusal that matters most, and the one a pure helper cannot reach: a workflow
    // naming a real directory with no HTML in it — what a MOVE looks like. Left un-refused
    // this is an empty set, and an empty set here is every pass below reporting a green
    // over a page nothing read.
    //
    // The directory is CHOSEN at test time rather than hard-coded. Naming `decisions/`
    // worked until the day someone tracked an `.html` under it, and then this failed
    // saying the workflow reader had accepted something — pointing at the reader rather
    // than at the unrelated file that had just been added.
    const htmlDirs = new Set(
      execFileSync("git", ["ls-files", "-z", "--", "*.html"], { cwd: ROOT, encoding: "utf8" })
        .split("\u0000")
        .filter(Boolean)
        .map((rel) => rel.split("/")[0]),
    );
    const emptyOfHtml = [...new Set(tracked.map((rel) => rel.split("/")[0]).filter((d) => d.includes(".") === false))]
      .filter((d) => !htmlDirs.has(d))
      .sort()[0];
    if (!emptyOfHtml) {
      scopeFailures.push("  every tracked directory holds HTML, so the empty-set refusal cannot be exercised");
    }
    if (emptyOfHtml) {
      let refused = false;
      try {
        execFileSync(
          process.execPath,
          [
            "-e",
            `import(${JSON.stringify(join(ROOT, "scripts/lib/docs-scope.mjs"))}).then((m) => m.publishedLandingPages(process.argv[1]))`,
            `      - run: |\n          cp -r ${emptyOfHtml}/. _site/\n`,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: ROOT },
        );
      } catch (err) {
        refused = err.status === 2;
      }
      if (!refused) {
        scopeFailures.push(
          `  a workflow publishing \`${emptyOfHtml}/\`, which holds no tracked HTML, was accepted instead of refused`,
        );
      }
    }

    // Which page the command pass must read, RE-derived here from the workflow and from
    // git — a second derivation, the way `shouldRead` above re-derives the npm READMEs from
    // the manifests. Asking `publishedLandingPages()` and then checking `sourceFiles()`
    // contains it would be the function agreeing with itself, since `userFacingPages()` is
    // built from that very call; and `landing.length === 0` cannot happen, because the
    // function refuses on an empty set. Neither would fail if the clause were deleted.
    const copiedDir = /^\s*cp\s+-r\s+(\S+?)\/\.\s+_site\/?\s*$/m.exec(
      readFileSync(join(ROOT, ".github", "workflows", "docs.yml"), "utf8"),
    )?.[1];
    if (!copiedDir) {
      scopeFailures.push("  docs.yml no longer copies a directory into the Pages artifact root");
    }
    const shouldReadHtml = copiedDir
      ? execFileSync("git", ["ls-files", "-z", "--", `${copiedDir}/*.html`], { cwd: ROOT, encoding: "utf8" })
          .split("\u0000")
          .filter(Boolean)
      : [];
    if (shouldReadHtml.length === 0) {
      scopeFailures.push("  git tracks no HTML in the directory the site serves at its root, so this proves nothing");
    }
    for (const page of shouldReadHtml) {
      if (!read.includes(page)) scopeFailures.push(`  the command pass does not read ${page}`);
    }
    // At least one of them must yield a block. Per-page would be the wrong rule here for
    // the same reason `blocklessPages` no longer uses it: a 404 or a privacy page carries
    // no commands and is not a defect. Every page losing its blocks at once is.
    if (!shouldReadHtml.some((page) => terminalBlocks(readFileSync(join(ROOT, page), "utf8"), true).length > 0)) {
      scopeFailures.push("  not one page published at the site's root yielded a terminal block — they are checked for nothing");
    }

    if (scopeFailures.length) {
      console.log("\nSELF-TEST FAILED: a pass is no longer reading the set it says it reads:");
      for (const f of scopeFailures) console.log(f);
      process.exit(1);
    }
    console.log(
      `Both passes read a DERIVED set: ${tracked.length} tracked files for links,` +
        ` ${sourceFiles().length} user-facing pages for commands, \`docs_dir\` comes from` +
        ` mkdocs.yml, and the site's root page from the workflow that publishes it` +
        ` (${shouldReadHtml.join(", ")}).`,
    );

    // The anchor port is checked against pinned pairs taken from a real
    // Python-Markdown `slugify` run, because getting it wrong is SILENT and worse than
    // having no checker: an anchor helper that disagrees with the site reports the
    // correct links as dead, and "fixing" them to agree breaks the published page.
    // Every pair below has an em dash or punctuation — the cases an eyeball
    // reimplementation gets wrong. This is the cheap, interpreter-free half; the thorough
    // half is `check:mkdocs-parity`, which renders every published page with the site's own
    // Python-Markdown and compares every id it emits, pinning nothing.
    const ANCHOR_PAIRS = [
      ["## `handoff` — hand over a task", "handoff-hand-over-a-task"],
      ["### Earned autonomy — per-capability grants", "earned-autonomy-per-capability-grants"],
      ["## `artifact-only` — get the files, not the words", "artifact-only-get-the-files-not-the-words"],
      ["## What isolation means today", "what-isolation-means-today"],
      ["## `channel telegram`", "channel-telegram"],
    ];
    const anchorFailures = ANCHOR_PAIRS.filter(([h, want]) => anchorOf(h) !== want);
    if (anchorFailures.length) {
      console.log("\nSELF-TEST FAILED: the anchor port no longer matches Python-Markdown:");
      for (const [h, want] of anchorFailures) {
        console.log(`  ${h}\n    want: ${want}\n    got:  ${anchorOf(h)}`);
      }
      process.exit(1);
    }
    console.log(`Anchor slugify matches Python-Markdown on ${ANCHOR_PAIRS.length} pinned headings.`);

    // The landing page is HTML, so it could not be in any set built from `*.md` — which is
    // how it came to name three of the nine catalog tools and say an agent pauses "at every
    // level", eight releases after both were corrected elsewhere. Asserted from a second
    // derivation (the workflow line that publishes it) rather than read back from the
    // function under test, and asserted NON-EMPTY, because a clause that finds nothing
    // would satisfy every `includes` above without reading a page.
    // The tool-catalog rule, planted in BOTH directions. The direction that matters most is
    // the negative one: four of the nine names — `find`, `stat`, `move`, `mkdir` — are
    // ordinary English words, so a pass that counted prose instead of code spans would
    // report a defect on pages that are correct, and this check would become work to
    // suppress rather than work to do.
    const nine = catalogToolNames();
    const span = (n) => `\`${n}\``;
    const CATALOG_CASES = [
      ["names all nine", nine.map(span).join(" "), false],
      ["names all nine as HTML", nine.map((n) => `<code>${n}</code>`).join(" "), false],
      // Casing and nested markup: a page marking its catalog up either way would silently
      // drop below the two-name threshold and stop being covered at all.
      ["names all nine in UPPERCASE tags", nine.map((n) => `<CODE>${n}</CODE>`).join(" "), false],
      // ⚠ The line above passes whether nine names are found or ZERO — `< 2` short-circuits
      // to "not reported" either way. Only a PARTIAL count distinguishes them, so dropping
      // the `i` flag from `codeSpans` survived the case written to require it.
      ["names eight in UPPERCASE tags", nine.slice(0, 8).map((n) => `<CODE>${n}</CODE>`).join(" "), true],
      ["names all nine with markup inside the span", nine.map((n) => `<code><b>${n}</b></code>`).join(" "), false],
      ["names three with markup inside the span", nine.slice(0, 3).map((n) => `<code><b>${n}</b></code>`).join(" "), true],
      ["names one, in passing", `a read like ${span(nine[0])} is not an inventory`, false],
      ["names none", "no tools here at all", false],
      ["names the words in prose", `you can find and move and stat and mkdir things`, false],
      ["names three", nine.slice(0, 3).map(span).join(" "), true],
      ["names two", nine.slice(0, 2).map(span).join(" "), true],
      ["names eight", nine.slice(0, 8).map(span).join(" "), true],
      ["names eight as HTML", nine.slice(0, 8).map((n) => `<code>${n}</code>`).join(" "), true],
    ];
    const catalogFailures = [];
    for (const [why, text, shouldReport] of CATALOG_CASES) {
      const reported = checkToolCatalog([["<planted>", text]]).length > 0;
      if (reported !== shouldReport) {
        catalogFailures.push(`  a page that ${why} was ${reported ? "reported" : "passed"}, and should not have been`);
      }
    }
    if (catalogFailures.length) {
      console.log("\nSELF-TEST FAILED: the tool-catalog rule does not hold:");
      for (const f of catalogFailures) console.log(f);
      process.exit(1);
    }
    console.log(
      `The tool-catalog rule fires on a page naming 2–${nine.length - 1} of ${nine.length} tools` +
        ` in code spans, and on nothing else — prose mentions included.`,
    );

    // The destructive-action gate rule. Every case below is a real sentence this repo has
    // shipped, or the correct one it was replaced with — no invented shapes, because the
    // question is not whether a regular expression works, it is whether THIS copy is judged
    // right. The `false` rows matter more than the `true` ones: a gate that reports a
    // correct sentence gets the correct sentence "fixed" until the gate agrees, which has
    // happened in this file once already, to four working links.
    const GATE_CASES = [
      // --- must fire -------------------------------------------------------------------
      ["states the guarantee bare (README, before #177)",
        "but before anything **destructive**, even an `autonomous` agent **pauses for your confirmation**.",
        ["no-exception"]],
      ["states claim 4 bare (walkthrough, before #177)",
        "Even an `autonomous` agent **pauses for confirmation before a destructive\naction** — the gate is independent of trust level.",
        ["every-level", "no-exception"]],
      ["promises a pause at every level with no allow-list and no `propose`",
        "The gate holds at every level: a destructive action always pauses for your confirmation.",
        ["every-level", "no-exception"]],
      // The typography controls. `*every*` and `**pauses**` are the same words a reader
      // sees, and the first version of this sweep could not see them at all.
      ["hides the quantifier behind emphasis",
        "The gate pauses *every* **destructive** action, whatever the agent's trust level.",
        ["every-level", "no-exception"]],
      ["hides it behind HTML, as the landing page must",
        "<p>before anything <strong>destructive</strong>, even an <code>autonomous</code> agent pauses for your confirmation.</p>",
        ["no-exception"]],
      // A colon introduces the rest of the claim. Splitting on it put the quantifier in one
      // fragment and the promise in the other, and a live defect read as clean.
      ["wears a colon between the quantifier and the promise",
        "And the gate holds at every level: `notify` and `autonomous` stop and ask before an irreversible step.",
        ["every-level", "no-exception"]],
      // `by default` has to be anchored to the pause. Unanchored it excused four bare
      // guarantees from three pages away.
      ["has an unrelated `By default` sentence beside it",
        "Even an `autonomous` agent pauses before a **destructive** action. By default the trace records references only.",
        ["no-exception"]],
      // The topic can be set by the sentence BEFORE the promise — which is how most of this
      // copy actually reads. Requiring the word `destructive` inside the claim itself let
      // this shape through silently.
      ["names the destructive thing in the sentence before the guarantee",
        "Deleting a file is irreversible. Even an `autonomous` agent pauses for your confirmation.",
        ["no-exception"]],
      ["makes the same universal promise about something that is not the gate",
        "Every request needs an access token, at every level, and the server always asks for your confirmation of the fingerprint.",
        []],
      // `earn its way out of asking` is the OTHER way this repo denies the exception, and
      // it is the only one in range of the claim in `docs/commands.md`'s delegated-call
      // bullet — the "can never earn a standing grant" sentence two lines down is outside
      // the window. Dropping this spelling reports that bullet, which is the one capability
      // the kernel refuses to auto-approve: a red demanding the opposite of the truth.
      // Verbatim, because a paraphrase of it was inert — "always asks" is not a pause verb,
      // so the fixture never fired and the mutation survived it either way.
      ["denies the exception with `earn its way out`, the only spelling in range",
        "- **No call happens without you, and it cannot earn its way out of asking.** At\n" +
          "  `notify` and `autonomous` the run pauses and asks; a `propose` agent never calls at\n" +
          "  all, it only tells you it would. Unlike every other destructive capability, this one\n" +
          "  can never [earn](#earned-autonomy-per-capability-grants) a standing grant — sending\n" +
          "  a credential somewhere is the one thing this product will not learn to do on its own.\n",
        []],
      // Codex R4, pinned from the other side. Requiring a quantifier is a DECISION — without
      // it 43 sentences report — and these are the shapes that decision protects. Each is
      // real shipped help, and each is true whether or not the capability is allow-listed:
      // a conditional, a verb description that presupposes the pause, and a statement about
      // how bounded an approval is. If the quantifier requirement is ever dropped, these
      // three fail, and the 43-sentence cost is visible instead of argued about.
      ["mentions the gate CONDITIONALLY rather than promising it",
        "When a destructive action pauses a run, confirm it later with `asterism confirm` — the run picks up and finishes the action you approved.",
        []],
      ["describes the verb that resolves a pause that already happened",
        "Confirm the destructive action a run paused on, and let the run finish.",
        []],
      ["says how BOUNDED an approval is, which holds either way",
        "You approve only the action it paused on — nothing else is unlocked. A further destructive step pauses again for its own confirmation: the same kind of action aimed at a new target.",
        []],
      // Codex R3, pinned. Naming all three levels and then promising a confirmation puts
      // `propose` in the frame just as firmly as the words "at every level" — and there is
      // no confirmation there, there is a plan. `README.md`'s feature table did exactly this.
      ["lists all three levels and then promises a stop, saying nothing about `propose`",
        "| **Dialable trust** | `propose` / `notify` / `autonomous` — with a hard stop for your confirmation before anything irreversible, `autonomous` included, unless you have allowed that capability. |",
        ["every-level"]],
      // …and the two false reds that rule produced on its first run, both now controls.
      // A POSITIVE statement of what `propose` does qualifies as well as a negative one:
      // the quickstart note says what it does and says it the other way round.
      ["names all three but says what `propose` does instead, positively",
        "The autonomy you set governs the rest — `propose` hands you a plan, while `notify` and `autonomous` act on their own — but before anything **destructive**, even an `autonomous` agent **pauses for your confirmation**, unless you have allowed that capability for it.",
        []],
      // Saying the exception CANNOT apply is the most complete way to address it. This is
      // the delegated call — the one destructive capability the kernel refuses to
      // auto-approve — and a gate that reported it would be demanding the opposite of true.
      ["names all three and says the exception can never apply",
        "- **No call happens without you, and it cannot earn its way out of asking.** At\n  `notify` and `autonomous` the run pauses and asks; a `propose` agent never calls at\n  all, it only tells you it would. Unlike every other destructive capability, this one\n  can never earn a standing grant.\n",
        []],
      // Codex R2, pinned. A qualifier in a NEIGHBOURING block is not a qualifier: each of
      // these is a real pair this repo shipped, where the bare guarantee sat in one table
      // row or list item and the thing excusing it sat in the next.
      ["is a table row whose exception is in the row BELOW it",
        "| **Dialable trust + a destructive-action gate** | `propose` / `notify` / `autonomous` — with a hard stop for your confirmation before anything irreversible, `autonomous` included. |\n" +
          "| **Earned trust contracts** | An agent can *earn* the right to take one capability without pausing. |\n",
        ["every-level", "no-exception"]],
      ["is a numbered claim whose `propose` half is in the claim ABOVE it",
        "3. A `propose` agent **returns a plan it never runs**; an `autonomous` agent\n   **acts**.\n" +
          "4. Even an `autonomous` agent **pauses for confirmation before a destructive\n   action** — the gate is independent of trust level, and only a capability you\n   have allowed that agent skips it.\n",
        ["every-level"]],
      ["is separated from its exception by a `###` heading",
        "Only the destructive-action gate still pauses them.\n\n### Earned autonomy\n\nThe gate pauses every destructive action by default.\n",
        ["no-exception"]],
      // …and with NO blank line around the heading, which is the only case where the
      // heading rule does the work rather than the blank-line rule. An ATX heading may
      // interrupt a paragraph, so a reader sees a new section either way.
      ["is separated from its exception by a heading with no blank line",
        "Only the destructive-action gate still pauses them.\n### Earned autonomy\nThe gate pauses every destructive action by default.\n",
        ["no-exception"]],
      // The window is still a WINDOW inside a long block. Nothing else varies `NEARBY` now
      // that the block clips it — every other row's block is shorter than 150 characters,
      // so the distance could be set to the whole file and no fixture would notice.
      ["is one long paragraph with its exception far past the window",
        "Even an `autonomous` agent pauses before a **destructive** action. " +
          `${"It runs in its own workspace and keeps a reviewable record of what it did. ".repeat(4)}` +
          "That is unless you have allowed that capability for it.",
        ["no-exception"]],
      // …and the control that keeps block scoping from becoming same-sentence scoping. This
      // is `AUTONOMY_HELP` verbatim: one paragraph, guarantee and `unless` in consecutive
      // sentences. A rule that failed the site this repo holds up as the model would be
      // measuring its own preference.
      ["is one paragraph carrying the guarantee and its `unless` in consecutive sentences",
        "  A destructive action — deleting files, force-pushing, reading out a secret,\n" +
          "  spending, sending — never happens without you. At 'notify' and 'autonomous'\n" +
          "  the run stops and asks first, unless you have allowed that capability for it.\n" +
          "  A 'propose' agent does not take one at all; it hands you the plan instead.",
        []],
      // A wrapped table cell or list item is still ONE block; a splitter that treated every
      // line as a block would cut a claim in half and report neither side.
      ["wraps one list item across lines, with its exception on the second",
        "- Even an `autonomous` agent pauses before a **destructive** action,\n  unless you have allowed that capability for it.\n",
        []],
      // Codex's finding, pinned. A level-wide pause claim that DOES carry the allow-list
      // exception was silently exempt from the `propose` half, because only one of the five
      // level-wide spellings was tested for it. `docs/threat-model.md`'s own headline
      // sentence was exactly this, and it is one of the four surfaces the issue held up as
      // correct — half-right, and the half it was missing had no test.
      ["is level-wide and carries the exception, but never says what `propose` does",
        "A destructive action pauses for explicit confirmation regardless of the agent's autonomy level, unless that capability has been allow-listed for that agent.",
        ["every-level"]],
      // The SAME quantifier over the weaker promise is true at every level, because at
      // `propose` the action does not happen — it is withheld. Only the verb separates them,
      // and this row is what stops the fix above from reporting the rule box.
      ["is level-wide over `never happens without you`, which is true at `propose` too",
        "A **destructive** action never happens without you — *whatever the agent's trust level* — unless you have specifically allowed that capability for it.",
        []],
      // The quantifiers below are each the sole one in their row too, and each is a sentence
      // this repo actually shipped until #177 removed it — a regression suite of the shapes
      // that were really written, not of shapes imagined for the regex.
      ["quantifies with `no matter how` alone (the handoff sentence, before #177)",
        "a destructive action stops for your confirmation according to the **receiving** agent's autonomy, no matter how much autonomy the asking agent has.",
        ["no-exception"]],
      ["quantifies with `autonomous included` alone (README's table row)",
        "Dialable trust with a hard stop for your confirmation before anything irreversible, `autonomous` included.",
        ["no-exception"]],
      ["quantifies with `every destructive action` alone",
        "The gate pauses every destructive action.",
        ["no-exception"]],
      ["quantifies with `always pauses` alone",
        "A destructive action always pauses for your confirmation.",
        ["no-exception"]],
      ["quantifies with `gate holds` alone",
        "Whatever else changes, the gate holds — a destructive action pauses for your confirmation.",
        ["every-level", "no-exception"]],
      ["carries the exception as `earn the standing`, the only marker in the sentence",
        "A destructive action always pauses, but an agent can earn the standing to take one specific capability without that pause.",
        []],
      // Naming `propose` is not the same as saying what it does INSTEAD. A version that
      // accepted the bare word would pass this, and the sentence is still false at `propose`.
      ["lists `propose` among the levels without saying it withholds",
        "The gate holds at every level — `propose`, `notify`, `autonomous` — and a destructive action always pauses, unless you have allowed that capability.",
        ["every-level"]],
      // Presentation, pinned because it is the difference between a readable report and a
      // wall: a finding is truncated with an ellipsis rather than printed whole.
      ["is far longer than the report can show",
        `A destructive action always pauses for your confirmation, ${"and this clause runs on and on, ".repeat(12)}forever.`,
        ["no-exception"]],
      // Each quantifier below is the ONLY one in its row. Every other row that uses these
      // phrasings pairs them with a second quantifier, so dropping any one of them changed
      // no result — the rule read as covered while three of its branches were untested.
      ["quantifies with `whatever the agent's trust level` alone",
        "A destructive action stops and asks you first, whatever the agent's trust level.",
        ["every-level", "no-exception"]],
      ["quantifies with `regardless of autonomy` alone",
        "An action classified destructive pauses for explicit confirmation regardless of the agent's autonomy level.",
        ["every-level", "no-exception"]],
      ["quantifies with `independent of trust level` alone",
        "A deletion pauses for your confirmation; the gate is independent of trust level.",
        ["every-level", "no-exception"]],
      // …and each spelling of the EXCEPTION, likewise isolated. The rule box says `unless
      // you have specifically allowed`, which satisfies two branches at once; on its own
      // each of these is the only thing standing between a real sentence and a false red.
      ["carries the exception as `allow-listed`, with no `unless`",
        "A destructive action pauses regardless of the agent's autonomy level — a `propose` agent does not take one at all — and a capability allow-listed for that agent is the one thing that skips it.",
        []],
      ["carries it as `specifically allowed`, with no `unless`",
        "A destructive action pauses regardless of the agent's autonomy level — a `propose` agent does not take one at all — and a capability you specifically allowed skips it.",
        []],
      ["carries it as `unless ... granted`",
        "A destructive action pauses regardless of the agent's autonomy level — a `propose` agent does not take one at all — unless you granted that capability to the agent.",
        []],
      // `never happens without you` is the binary's front-door phrasing and the npm page's.
      // Every fixture using it was a PASSING one, so dropping that quantifier changed no
      // result and the guard for the most-read sentence in the product was untested.
      ["uses the front-door phrasing with no exception at all",
        "A **destructive** action — deleting files, force-pushing, spending, sending — never happens without you.",
        ["no-exception"]],
      // Universal AND about destruction, but promising nothing — the walkthrough's own
      // section heading. Without this row, the pause verb could stop being required and
      // every other case would still pass.
      ["is a heading that says the gate FIRES without promising a pause",
        "## Claim 4 — the destructive gate fires regardless of trust",
        []],
      // `still pauses` was the shape of nine of the nineteen sentences this slice found —
      // the passing references on the container, service, channel, serve and trace
      // surfaces. Without a row for it, dropping that quantifier survives every other case.
      ["says the gate STILL pauses on some other surface",
        "A destructive action still pauses for explicit confirmation, even for an `autonomous` agent.",
        ["no-exception"]],
      // The window has to be a window. With no row where the exception sits FAR from the
      // claim, `NEARBY` can be set to anything — including the whole file — and nothing
      // notices; a clause three paragraphs down would then excuse a bare guarantee.
      ["puts its `unless` clause a long way from the claim",
        "Even an `autonomous` agent pauses before a **destructive** action.\n\n" +
          `${"Filler about tokens, ports and workspaces. ".repeat(12)}\n\n` +
          "Unless you have allowed that capability for the agent, that is.",
        ["no-exception"]],

      // --- must NOT fire ---------------------------------------------------------------
      ["is the rule box, which carries both halves in one sentence",
        "> A **destructive** action never happens without you — *whatever the agent's\n> trust level* — unless you have specifically allowed that capability for it.",
        []],
      ["puts the guarantee and its `unless` in consecutive sentences, as AUTONOMY_HELP does",
        "A destructive action never happens without you. At 'notify' and 'autonomous'\nthe run stops and asks first, unless you have allowed that capability for it.",
        []],
      // The landing page states the exception by its CONTRAPOSITIVE. A pattern demanding
      // the positive spelling called the site's front page broken.
      ["states the exception as `a capability you have not allowed it`",
        "before anything <strong>destructive</strong>, <em>whatever</em> the agent's trust level, nothing happens without you: <code>notify</code> and <code>autonomous</code> stop and ask, <code>propose</code> does not take the action at all, and neither acts unasked on a capability you have not allowed it.",
        []],
      ["says the pause is the default and names what buys it out",
        "The gate pauses *every* destructive action by default — but an agent can **earn** the standing to take one specific capability without that pause.",
        []],
      // The shape this slice moved the passing references TO: relative, and therefore true
      // whether or not the capability is allow-listed. This row is what stops the fix for
      // one half from being pressure to paste a clause onto every mention of the gate.
      ["makes the claim relative instead of absolute",
        "A container loosens the trust model not one bit. The destructive-action gate reaches exactly the verdict it would have reached at the keyboard, for the same agent and the same action.",
        []],
      ["names `propose` alongside an every-level claim that carries the exception",
        "The gate holds at every level: `notify` and `autonomous` stop and ask — unless you have allowed that capability for the agent — and `propose` never takes one at all.",
        []],
      ["describes one recording, without claiming anything universal",
        "A terminal recording: an autonomous agent writes a file without asking, then pauses for confirmation before deleting one.",
        []],
      ["says nothing about the gate at all",
        "Every request needs an access token. On first serve a token is generated and printed once.",
        []],
      // Evidence blocks quote TEST TITLES, and `check:safety-case` requires each to match a
      // test that ran and passed. If this could fire inside one, the cheapest way to green
      // it would be to rename a kernel test until a prose gate agreed.
      ["quotes a test title inside an Evidence block",
        '> **Evidence** — `bun test packages/core/src/delegation.test.ts`\n> - "a delegated call always pauses — at notify AND at autonomous, and standing cannot buy it out"\n',
        []],
      // A multi-line comment INSIDE a citation block. Hiding it before the citations are
      // masked blanks the `>` prefixes of its continuation lines, so the citation reader sees
      // a line that no longer begins with `>`, ends the block there, and reads the quoted
      // TEST TITLES below it as public claims. Order decides it. [Codex review R4 P2.]
      ["puts a multi-line comment inside an Evidence block, above the titles",
        '> **Evidence** — `bun test x.test.ts`\n> <!-- a note\n> spanning two lines -->\n> - "an autonomous agent always pauses on a destructive action"\n',
        []],
      ["quotes one in a block whose header this reader cannot parse",
        '> **Evidence** – `bun test x.test.ts`\n> - "an autonomous agent still pauses on a destructive action"\n',
        []],
      // What the markup HIDES is not copy. The landing page is hand-written HTML with
      // thirteen comments and an inlined stylesheet; a maintainer's note in one of them is a
      // fact about the file, not a promise to a reader, and this rule reported it as an
      // unqualified guarantee. Found by auditing the identical defect Codex caught in the
      // vocabulary rule, which reads the SAME corpus — see `scripts/lib/copy-text.mjs`.
      // A sentence can END in a character reference, and the sentence splitter reads offsets,
      // so it needs the full stop to be a full stop in the place it belongs. `&#46;` is eight
      // characters to a splitter and a period to a reader: splitting before decoding merged
      // the two sentences either side and pulled a destructive-action mention into the window
      // of a claim 150 characters away from it, reporting an overclaim nobody wrote. The same
      // paragraph with a literal `.` was clean. [Codex review R3 P2.]
      ["ends a sentence with a decimal character reference, far from the claim after it",
        `<p>Deleting a file is a destructive action ${"and the prose runs on for a while so the window does not reach back ".repeat(4)}&#46; An autonomous agent always pauses.</p>`,
        [], { kind: "html" }],
      ["…and with a hexadecimal one",
        `<p>Deleting a file is a destructive action ${"and the prose runs on for a while so the window does not reach back ".repeat(4)}&#x2e; An autonomous agent always pauses.</p>`,
        [], { kind: "html" }],
      // …while the same paragraph with a LITERAL full stop must also be clean, or the two
      // rows above are explained by a window that never reached anyway rather than by the
      // boundary being found.
      ["…and the same paragraph with a literal full stop",
        `<p>Deleting a file is a destructive action ${"and the prose runs on for a while so the window does not reach back ".repeat(4)}. An autonomous agent always pauses.</p>`,
        [], { kind: "html" }],
      // …and with the destructive action NEAR the claim it must still fire, so the three rows
      // above are not explained by a rule that has stopped firing on this shape at all.
      ["puts the destructive action right beside the same claim",
        "<p>Deleting a file is a destructive action&#46; An autonomous agent always pauses.</p>",
        ["no-exception"], { kind: "html" }],
      // …and a reference is a boundary only where the RENDERER makes one. A terminal decodes
      // nothing, and `` `&#46;` `` renders as `<code>&amp;#46;</code>` — the reader is shown
      // the reference, not the stop it stands for. Splitting there invented a boundary that
      // moved the claim more than NEARBY away from the destructive action it was about, and
      // the gate stopped reporting an overclaim that IS on the page: a false negative, the
      // direction that reports a clean page forever. [Codex review R5 P2.]
      //
      // The first two rows are the defect; the third and fourth are what stop them being
      // explained by a rule that has simply stopped splitting anything.
      ["prints a character reference in a help screen, which a terminal shows literally",
        `Deleting a file is a destructive action ${"and the prose runs on for a while so the window does not reach back ".repeat(4)}&#46; An autonomous agent always pauses.`,
        ["no-exception"], { kind: "plain" }],
      ["shows one inside a code span, where the renderer shows the reference itself",
        `Deleting a file is a destructive action ${"and the prose runs on for a while so the window does not reach back ".repeat(4)}\`&#46; y\` An autonomous agent always pauses.`,
        ["no-exception"]],
      ["…while a literal full stop in a help screen IS a boundary",
        `Deleting a file is a destructive action ${"and the prose runs on for a while so the window does not reach back ".repeat(4)}. An autonomous agent always pauses.`,
        [], { kind: "plain" }],
      ["…and one in markdown PROSE is a boundary, because there the renderer decodes it",
        `Deleting a file is a destructive action ${"and the prose runs on for a while so the window does not reach back ".repeat(4)}&#46; An autonomous agent always pauses.`,
        []],
      // …and a reference inside a TAG is not a boundary either, for the same reason: nobody
      // meets it. `<span data-note="x&#46; y">` split the paragraph where a reader sees the
      // middle of a sentence, and the claim behind it stopped being reported. The second row
      // is the control — the same tag without the reference must still report, or the first
      // is explained by the tag rather than by what is inside it. [Codex review R6 P2.]
      ["hides a character reference in an attribute nobody meets",
        `<p>Deleting a file is a destructive action ${"and the prose runs on for a while so the window does not reach back ".repeat(4)}<span data-note="x&#46; y"></span> An autonomous agent always pauses.</p>`,
        ["no-exception"], { kind: "html" }],
      ["puts the same tag there with nothing hidden in it",
        `<p>Deleting a file is a destructive action ${"and the prose runs on for a while so the window does not reach back ".repeat(4)}<span data-note="x y"></span> An autonomous agent always pauses.</p>`,
        ["no-exception"], { kind: "html" }],
      ["puts a bare guarantee inside an HTML comment nobody reads",
        "<!--\n  Note: a destructive action always pauses for your confirmation.\n-->\n<p>Agents run alone.</p>",
        []],
      ["puts one inside the inlined stylesheet",
        "<style>\n  /* even an autonomous agent pauses before a destructive action */\n</style>",
        []],
      ["says it in the visible text beside both",
        "<!-- a note -->\n<style>.x{}</style>\n<p>Even an <code>autonomous</code> agent pauses before a <strong>destructive</strong> action.</p>",
        ["no-exception"]],
      // Blanking a hidden region must not turn its lines into BLANK ones: a paragraph is one
      // block, a blank line ends it, and a comment sitting between a guarantee and its
      // `unless` clause inside one `<p>` closed the claim before the qualifier and reported
      // correct copy as an unqualified promise. The browser shows one paragraph.
      // [Codex review R2 P2.]
      ["puts a multi-line comment between a guarantee and its `unless`, inside one paragraph",
        "<p>Even an <code>autonomous</code> agent pauses before a <strong>destructive</strong> action.\n<!--\n  a maintainer note about this section\n-->\nUnless you have allowed that capability for it.</p>",
        [], { kind: "html" }],
      // …EMPTY lines inside that comment included. An empty line is still inside the
      // comment, so the browser still renders one paragraph — and filling it costs a
      // character of length, which nothing here needs, where a line number is a count of
      // newlines. [Codex review R3 P2, resolved in R4 once the page's kind was known.]
      ["puts one with an EMPTY line in it between a guarantee and its `unless`",
        "<p>Even an <code>autonomous</code> agent pauses before a <strong>destructive</strong> action.\n<!--\n\n  a note\n-->\nUnless you have allowed that capability for it.</p>",
        [], { kind: "html" }],
      // …and the SAME text read as markdown must fire, because there `<!--` at the start of
      // a line opens an HTML block and the `unless` is a different paragraph. One renderer's
      // invisible comment is the other's block boundary. [Codex review R4 P2.]
      // …but a comment that starts AFTER visible text is inline, and Python-Markdown keeps the
      // paragraph whole around it. Asked directly:
      //   'claim <!--\nnote\n--> unless allowed' → <p>claim <!--\nnote\n--> unless allowed</p>
      // Blanking its continuation lines made them paragraph breaks and reported a correctly
      // qualified claim as an overclaim. [Codex review R5 P2.]
      ["puts an INLINE multi-line comment between the two, in markdown",
        "Even an `autonomous` agent pauses before a **destructive** action <!--\n  a note\n--> unless you have allowed that capability for it.",
        []],
      ["puts a comment between the two in MARKDOWN, where it ends the paragraph",
        "A destructive action never happens without you, at every trust level.\n<!--\n  a note\n-->\nUnless you have allowed that capability for it.",
        ["no-exception"]],
      // The same attribute values the vocabulary rule reads: a gate promise in an Open Graph
      // description is a promise made to everyone who sees the link previewed.
      // Backticks on an HTML page are not code spans, and taking them for some preserved the
      // tag between them — putting an `unless` from a CLASS NAME into the claim's window,
      // where it excused an unqualified promise. [Codex review R8 P2.]
      ["writes backticks around a tag whose class reads like a qualifier",
        '<p>Even an <code>autonomous</code> agent pauses before a <strong>destructive</strong> action. Type `<span class="unless you have allowed it">` to style one.</p>',
        ["no-exception"], { kind: "html" }],
      ["makes a bare guarantee in the description a social preview shows",
        "<meta property=\"og:description\" content=\"A destructive action never happens without you.\" />",
        ["no-exception"]],
      ["makes a bare guarantee in prose right AFTER an Evidence block closes",
        '> **Evidence** — `bun test x.test.ts`\n> - "a real test title"\n\nEven an `autonomous` agent pauses for your confirmation before a destructive action.',
        ["no-exception"]],
    ];
    const gateFailures = [];
    for (const [why, text, wantRules, opts] of GATE_CASES) {
      const got = gateOverclaims(text, opts ?? {}).map((f) => f.rule).sort();
      const want = [...wantRules].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        gateFailures.push(
          `  copy that ${why}\n      want: ${JSON.stringify(want)}\n      got:  ${JSON.stringify(got)}`,
        );
      }
    }
    // WHERE a finding is, not just that there is one. Nothing above could tell a correct
    // line number from one off by any amount, and the line is the whole value of the report
    // to the person fixing it. Two claims, four lines apart, with a blank line between —
    // which also pins the blank line as a claim boundary, so a paragraph cannot be swallowed
    // into its neighbour and reported at the wrong place.
    //
    // The leading COMMENT is load-bearing twice over: it carries a gate-shaped sentence, so a
    // reader that stopped blanking comments would report three findings here instead of two;
    // and it spans lines, so a mask that blanked its newlines along with everything else
    // would keep every offset and lose two LINES, reporting both real claims early.
    const twoClaims = [
      "<!-- Maintainer's note: a destructive action always pauses for your", // 1
      "     confirmation. Not copy — nobody reads this. -->",                // 2
      "",                                             // 3
      "# A page",                                     // 4
      "",                                             // 5
      "Even an `autonomous` agent pauses before a **destructive** action.", // 6
      "",                                             // 7
      "A deletion always pauses for your confirmation.", // 8
    ].join("\n");
    const twoLines = gateOverclaims(twoClaims).map((f) => f.line);
    if (JSON.stringify(twoLines) !== JSON.stringify([6, 8])) {
      gateFailures.push(`  two claims below a two-line comment were reported at ${JSON.stringify(twoLines)}, not [6,8]`);
    }
    // …and a sentence that ENDS in a character reference leaves the next one where it is.
    // The boundary is read from a decoded copy, so that copy has to be the same LENGTH as
    // the text the claim is sliced out of: decoding `&mdash;` to one character shortens
    // everything after it, and every offset then lands early. Nothing about which RULE fires
    // changes — the finding is simply reported on the wrong line, quoting a sentence that
    // starts in the middle of the one before it, which is a report a reader cannot find on
    // the page. Measured: line 1 and `"two hosts. An autonomous agent always pauses"` without
    // the padding, line 2 and the sentence itself with it. [Codex review R3 P2.]
    const afterEntity = gateOverclaims(
      "<p>The image is mirrored &mdash; and mirrored again &mdash; across two hosts&#46;\n" +
        "An autonomous agent always pauses before it deletes a file.</p>",
      { kind: "html" },
    )[0];
    if (afterEntity?.line !== 2 || afterEntity.sentence !== "An autonomous agent always pauses before it deletes a file.") {
      gateFailures.push(
        `  a claim after a sentence ending in a character reference was reported on line` +
          ` ${afterEntity?.line} as ${JSON.stringify(afterEntity?.sentence)}`,
      );
    }

    // …and the claim that ENDS in that reference is reported whole. A boundary is a POSITION,
    // and the position a reader sees the full stop at is where the entity ENDS — so the
    // decoded mark is padded onto its last character, not its first. Padded the other way the
    // splitter found whitespace INSIDE the entity, cut the sentence one character in, and
    // reported `…destructive action&`: a sentence nobody wrote and nobody can search the page
    // for. [Codex review R4 P2.]
    const endsWithEntity = gateOverclaims(
      "<p>An autonomous agent always pauses before a destructive action&#46; It waits.</p>",
      { kind: "html" },
    )[0];
    if (endsWithEntity?.sentence !== "An autonomous agent always pauses before a destructive action.") {
      gateFailures.push(
        `  a claim ending in a character reference was reported as ${JSON.stringify(endsWithEntity?.sentence)}`,
      );
    }

    // The same for the gate rule's report — it shares the masking, so it shares the filler.
    const inlineNote = gateOverclaims(
      "<p>Even an <code>autonomous</code> agent <!-- inline note --> pauses before a <strong>destructive</strong> action.</p>",
    )[0];
    if (inlineNote?.sentence !== "Even an autonomous agent pauses before a destructive action.") {
      gateFailures.push(`  a claim beside an inline comment was reported as ${JSON.stringify(inlineNote?.sentence)}`);
    }

    // …and a very long sentence is cut rather than printed whole, or one bad page fills the
    // terminal and the rest of the report scrolls away.
    const longOne = gateOverclaims(
      `A destructive action always pauses for your confirmation, ${"and on ".repeat(80)}forever.`,
    )[0];
    if (!longOne || !longOne.sentence.endsWith("...") || longOne.sentence.length > 240) {
      gateFailures.push(`  a ${longOne ? longOne.sentence.length : 0}-character finding was not truncated for the report`);
    }

    // The three level names the rule reads are hard-coded in a pure module, so the kernel
    // is what says whether they are still the three. A fourth level added to `TRUST_LEVELS`
    // would otherwise leave the enumeration rule quietly matching nothing.
    // `main` is synchronous, and core's dist is ESM, so the kernel is asked in a child
    // rather than imported here.
    const declared = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(CORE)}).then((m) => console.log(JSON.stringify(m.TRUST_LEVELS)))`],
        { encoding: "utf8", cwd: ROOT },
      ).trim(),
    );
    if (JSON.stringify([...declared].sort()) !== JSON.stringify([...TRUST_LEVEL_NAMES].sort())) {
      gateFailures.push(
        `  the gate rule reads levels ${JSON.stringify(TRUST_LEVEL_NAMES)} where the kernel declares ${JSON.stringify(declared)}`,
      );
    }

    // The rule this one grew out of, asserted as a CAPABILITY rather than trusted: the
    // sentence #139 fixed in eight places must still be caught here, or widening the corpus
    // quietly narrowed the rule. (A hand-written guard for exactly this lived in
    // `help.test.ts` until #183 measured that it caught nothing this does not and missed
    // three shapes this does — including two #177 had to fix by hand.)
    if (!gateOverclaims("A destructive action pauses for confirmation at every trust level.").some((f) => f.rule === "every-level")) {
      gateFailures.push("  the `pauses at every trust level` sentence #139 fixed in eight places is not caught here");
    }
    // The page's KIND, as the PASS reads it off a label. Without this the flag could be wired
    // to a constant — every source markdown, or every source HTML — and every row above would
    // still pass, because each of them passes its own option directly.
    //
    // ⚠ This block first sat in the vocabulary section, after the check that reads
    // `gateFailures` had already run, so it could not fail. A mutation making every source
    // markdown survived it. [Codex review R4 P2; the dead placement found by the sweep.]
    const commentBetween =
      "<p>Even an <code>autonomous</code> agent pauses before a <strong>destructive</strong> action.\n" +
      "<!--\n  a note\n-->\nUnless you have allowed that capability for it.</p>";
    for (const [label, want] of [
      // HTML: one paragraph, the comment invisible inside it.
      ["landing/index.html", 0],
      // Markdown: `<!--` opens a block, so the `unless` below is a different paragraph.
      ["docs/commands.md", 1],
      // A help screen is neither: no comments, no tags, so the whole thing is one claim and
      // the `unless` is right there in it. [Codex review R5 P2.]
      ["asterism run --help", 0],
    ]) {
      const got = checkGateClaims([[label, commentBetween]]).length;
      if (got !== want) {
        gateFailures.push(
          `  one paragraph with a comment in it reported ${got} time(s) under \`${label}\`, not ${want}`,
        );
      }
    }

    if (gateFailures.length) {
      console.log("\nSELF-TEST FAILED: the destructive-action gate rule does not hold:");
      for (const f of gateFailures) console.log(f);
      process.exit(1);
    }
    // …and it is pointed at something. A rule that is right about an empty corpus reports
    // zero forever, which is exactly how the sentence it forbids came to be live in
    // `docs/getting-started.md` while a guard for it passed in `packages/cli`.
    const gatePages = userFacingPages();
    const gateVerbs = advertisedVerbSet(coverageWork);
    const gateDescriptions = publishedPackageDescriptions();
    // The site's OWN strings — its name, its meta description, its nav labels — are published
    // by mkdocs and live in no file this otherwise reads. [Codex review R5 P2.]
    const gateSiteStrings = siteCopyStrings();
    if (
      gatePages.length === 0 ||
      gateVerbs.size === 0 ||
      gateDescriptions.length === 0 ||
      gateSiteStrings.length === 0
    ) {
      console.log(
        `\nSELF-TEST FAILED: the copy rules read ${gatePages.length} pages,` +
          ` ${gateDescriptions.length} npm descriptions, ${gateSiteStrings.length} site strings` +
          ` and ${gateVerbs.size} help screens.`,
      );
      process.exit(1);
    }
    // …and the reader really does find the three kinds in a config shaped like this one, or
    // it is a scan that returns nothing while the pass reports a green over it.
    const plantedSite = siteCopyStrings(
      'site_name: A Site\nsite_description: One line.\nnav:\n  - Home: index.md\n  - Guides:\n      - Models: models.md\n',
    );
    const wantSite = [
      ["mkdocs.yml (site_name)", "A Site"],
      ["mkdocs.yml (site_description)", "One line."],
      ["mkdocs.yml (nav)", "Home\nGuides\nModels"],
    ];
    if (JSON.stringify(plantedSite) !== JSON.stringify(wantSite)) {
      console.log(`\nSELF-TEST FAILED: the site-string reader returned ${JSON.stringify(plantedSite)}`);
      process.exit(1);
    }
    // …and the SET, asserted against the function that builds it rather than against its
    // ingredients. Both copy rules read `userFacingCopy`, and the two checks above only ever
    // saw `userFacingPages()` and `advertisedVerbSet()` — so deleting either half from the
    // assembler left every rule reading half a corpus behind a green. Driven with stubs so
    // this costs no child process; the real halves are checked non-empty above.
    const shape = userFacingCopy(null, {
      pages: ["README.md"],
      descriptions: [
        ["x/package.json (description)", "a one-line description"],
        ["mkdocs.yml (site_name)", "A Site"],
      ],
      verbs: ["run"],
      help: (verb) => `help for ${verb || "the root"}`,
    }).map(([label]) => label);
    const wantShape = [
      "README.md",
      "x/package.json (description)",
      "mkdocs.yml (site_name)",
      "asterism --help",
      "asterism run --help",
    ];
    // …and with the strings left to their DEFAULT, both sources are reached. Without this the
    // assembler could stop asking for either and the row above — which supplies its own —
    // would not notice. Driven with no verbs and a stub help, so it costs no child process.
    const defaulted = userFacingCopy(null, { pages: [], verbs: [], help: () => "" }).map(
      ([label]) => label,
    );
    for (const [what, prefix] of [
      ["an npm description", "packages/"],
      ["a string from the site's own config", "mkdocs.yml ("],
    ]) {
      if (!defaulted.some((label) => label.startsWith(prefix))) {
        console.log(`\nSELF-TEST FAILED: the copy corpus reaches for no ${what}.`);
        process.exit(1);
      }
    }
    if (JSON.stringify(shape) !== JSON.stringify(wantShape)) {
      console.log(
        `\nSELF-TEST FAILED: the copy corpus assembled ${JSON.stringify(shape)},` +
          ` not ${JSON.stringify(wantShape)} — a half of it is missing.`,
      );
      process.exit(1);
    }
    console.log(
      `The destructive-action gate rule holds on ${GATE_CASES.length} real sentences, fires inside` +
        ` emphasis, markup and colons, never inside an Evidence citation, and reads` +
        ` ${gatePages.length} pages, ${gateDescriptions.length} npm descriptions,` +
        ` ${gateSiteStrings.length} site strings and ${gateVerbs.size} help screens — every part,` +
        ` checked on the function that assembles them.`,
    );

    // --- golden rule 7: internal architecture vocabulary ------------------------------
    //
    // Every row is a REAL sentence from this repo (or the sentence a fix replaced), never a
    // paraphrase. A paraphrase of mine was inert on the gate rule two slices ago — "always
    // asks" is not a pause verb, so the mutation it was meant to kill survived the fix I had
    // just made — and the tell was that nothing changed when I "fixed" it.
    //
    // The rows that must NOT fire are the more valuable half here. A word list is one
    // sed away from firing on a container registry, on a package's own npm page, or on the
    // name the product itself uses for a feature, and a red over correct copy is the worse
    // failure of the two: a green merely misses something, while a red gets a correct
    // sentence "fixed" until the checker agrees.
    const NPM_NAMES = publishedPackageNames();
    const VOCAB_CASES = [
      // --- must fire ------------------------------------------------------------------
      ["names the kernel in the walkthrough's own claim (fixed by #183)",
        "  agent, and the kernel decides what it may actually do.",
        ["kernel"]],
      ["names it twice in one wrapped sentence",
        "[environment](./installation.md#api-keys)); the per-agent kernel settings are kept in\nthe kernel store, scoped to each agent.",
        ["kernel", "kernel"]],
      ["names it inside HTML on the site's front page (fixed by #183)",
        "              to come, and so is <strong>stronger execution isolation</strong>: today's boundary is\n              enforced by the kernel, not by the operating system, and the",
        ["kernel"]],
      ["carries the safety case's thesis on a page that is NOT the safety case",
        "**The kernel/substrate boundary** is what keeps the model loop from being the",
        ["kernel", "substrate"]],
      ["names the TOOL registry, which is the internal one",
        "filters them by trust level, and hands the substrate a finished registry. The",
        ["registry", "substrate"]],
      ["names the adapter as a component rather than as a package",
        "The adapter never holds a credential and never reaches the store.",
        ["adapter"]],
      // A token that merely BEGINS with a published name is not that package. Unbounded, the
      // real name is blanked out of the middle of this and the `adapter` in it disappears
      // with it — the exemption swallowing a leak instead of a name. [Codex review R1 P2.]
      ["names a package-ish token that only starts with a published name",
        "See @qmilab/asterism-adapter-pipeline for the experimental build.",
        ["adapter"]],
      // …and the same shape one character narrower. A dot CONTINUES the token when a name
      // character follows it, which is what makes `…-adapter-pi.next` not a published name;
      // the row below keeps a dot that ends a sentence from being read the same way.
      // [Codex review R2 P2.]
      ["extends a published name through a dot",
        "See @qmilab/asterism-adapter-pi.next for the experimental build.",
        ["adapter"]],
      // ⚠ This row was inert first time round: it wrapped the name in backticks, so the
      // character after it was a backtick and the sentence-ending DOT — the whole point of
      // the row — was never exercised. A mutation making a dot never end a name survived it.
      ["ends a sentence with a published name",
        "Install @qmilab/asterism-adapter-pi. Then point the CLI at it.",
        []],
      ["uses a plural",
        "Two kernels, two substrates, two registries, two adapters.",
        ["adapter", "kernel", "registry", "substrate"]],

      // --- must NOT fire --------------------------------------------------------------
      // `firewall` came OFF the list, and this is the sentence that decides it: the product
      // calls the feature "the memory firewall" to the reader's face, on this page and in
      // the binary, the dashboard and the HTTP endpoint. Putting the word back turns this
      // row red, which is the only reason the decision is a decision.
      ["calls the feature by the name the product uses for it",
        "a **memory firewall** that flags anything unsafe to remember before you ever see",
        []],
      ["says `the firewall` a second time, as the page does",
        "a flagged one anyway, the firewall still refuses to save it (`⛔ blocked`).",
        []],
      // A CONTAINER registry is a different thing spelled the same way.
      ["names a container registry",
        "The released image is published to the GitHub Container Registry and runs **natively on",
        []],
      // …and the same phrase after a rewrap. Without `\s+` in the sense, the orphaned half
      // is reported and `container.md` goes red on a line that is correct.
      ["names one that a rewrap split across two lines",
        "The released image is published to the GitHub Container\nRegistry and runs natively on both architectures.",
        []],
      // …and the same phrase with markup between its two words. This is why the scan runs
      // on a flattened copy rather than on the raw text: `container <em>registry</em>` is
      // one phrase to a reader and two strings to a matcher, and the site's front page is
      // hand-written HTML throughout.
      // …but ONE wrap is the whole allowance. `\s+` between the words spans a blank line too,
      // so a heading `## Container` followed by a paragraph opening `Registry …` masked a
      // real claim out of existence — the exemption swallowing a sentence rather than a
      // phrase. [Codex review R2 P2.]
      ["puts `Container` and `Registry` in two different blocks",
        "## Container\n\nRegistry controls the tool list an agent is handed.",
        ["registry"]],
      // …and not across a BLOCK. `<h2>Container</h2>` above a `<p>Registry …` is two things a
      // reader meets separately, and blanking every tag to spaces made them one phrase — the
      // exemption swallowing a heading and a claim. [Codex review R10 P2.]
      ["puts `Container` and `Registry` in two HTML blocks",
        "<h2>Container</h2>\n<p>Registry controls the tool list an agent is handed.</p>",
        ["registry"], { kind: "html" }],
      // …with the HEADING as the only tag between them, so the paragraph's own tag cannot
      // stand in for it. Every block element in the list needs a row it is alone in, or the
      // list is only as checked as its most common entry.
      ["ends a heading and carries straight on",
        "<h2>Container</h2>Registry controls the tool list an agent is handed.",
        ["registry"], { kind: "html" }],
      // …while an INLINE tag between them changes nothing a reader sees.
      ["names one with an inline tag between the two words",
        "<p>published to the GitHub <em>Container</em> Registry</p>",
        [], { kind: "html" }],
      ["names one with emphasis between the two words",
        "The released image is published to the GitHub **Container** Registry.",
        []],
      ["names one with an HTML tag between them",
        "<p>published to the GitHub Container <em>registry</em>, multi-arch</p>",
        []],
      ["names one with a non-breaking space between them",
        "<p>published to the GitHub Container&nbsp;Registry, multi-arch</p>",
        []],
      ["is the adapter package's own npm page, which opens with its published name",
        "# @qmilab/asterism-adapter-pi\n",
        []],
      ["is the other adapter package's page",
        "# @qmilab/asterism-adapter-lodestar\n",
        []],
      // A slash is not a name boundary, and this is the site that decides it: every package
      // README already links to npm this way, and the adapter's own URL is one word short of
      // the umbrella's. Nothing in today's copy would red without this — the measurement is
      // in `copy-vocabulary.mjs` — so this row is the only thing holding the decision.
      ["links to the adapter package's own npm page, where the name follows a slash",
        "Install it from [npm](https://www.npmjs.com/package/@qmilab/asterism-adapter-pi).",
        []],
      ["mentions the umbrella package beside the adapter one",
        "This is an internal building block. To use Asterism, install the umbrella package: [`@qmilab/asterism`](https://www.npmjs.com/package/@qmilab/asterism).\n",
        []],
      // What the markup HIDES. `landing/index.html` is hand-written HTML with thirteen
      // comments and an inlined stylesheet, and a design token or a CSS class is exactly
      // where one of these words turns up without anyone having said it to a reader. A gate
      // firing there would be asking someone to rename a class to satisfy a prose rule.
      // [Codex review R1 P2.]
      ["hides the word in an HTML comment, as the landing page's header comment could",
        "<!--\n  Asterism landing page — the kernel owns the /asterism/* path here.\n-->\n<p>Agents run alone.</p>",
        []],
      ["hides it in the inlined stylesheet",
        "<style>\n  /* ---- Design tokens ---- */\n  .registry-grid { --adapter-gap: 1rem; }\n</style>\n<p>Agents run alone.</p>",
        []],
      ["hides it in a script block",
        "<script>\n  const kernel = document.querySelector('.substrate');\n</script>\n<p>Agents run alone.</p>",
        []],
      // …and the visible half of the very same page still fires, or the three rows above
      // would pass just as well with the whole page thrown away.
      ["says it in the visible text beside all three",
        "<!-- a comment -->\n<style>.x{}</style>\n<p>enforced by the kernel</p>",
        ["kernel"]],
      // A tag's attribute values are copy when a reader meets them without viewing source:
      // `alt` is read aloud, a `<meta>` `content` is what a search result and a social
      // preview show. Blanking the whole tag hid all of it. [Codex review R3 P2.]
      ["hides the word in an image's alt text",
        "<img src=\"assets/img/dashboard.png\" alt=\"The dashboard, where the kernel decides.\">",
        ["kernel"], { kind: "html" }],
      // …but eleven of the landing page's sixteen meta tags hold a URL, a number or a colour,
      // and scanning those means an asset rename reds the build over a path.
      // [Codex review R6 P2.]
      ["puts an internal word in a social-card image URL",
        '<meta property="og:image" content="https://qmilab.com/adapter-card.png" />',
        [], { kind: "html" }],
      ["puts one in a page URL and a theme colour",
        '<meta property="og:url" content="https://x/registry/" />\n<meta name="theme-color" content="#1B2A4A" />',
        [], { kind: "html" }],
      // …and the social card's ALT text is still text, prefix and all.
      ["puts one in the social card's alt text",
        '<meta property="og:image:alt" content="The kernel diagram" />',
        ["kernel"], { kind: "html" }],
      // …and `content` is a meta tag's attribute. RDFa puts one on ordinary elements, where it
      // OVERRIDES the visible text for a metadata consumer rather than being shown — the
      // reader meets the element's text, which is scanned anyway.
      // A backtick in HTML is a backtick. Reading it as a code span preserved the comment
      // beside it and reported words no reader meets. [Codex review R7 P2.]
      ["writes backticks around a comment on an HTML page",
        "<p>Type `<!-- the kernel -->` to hide a note.</p>",
        [], { kind: "html" }],
      // HTML allows an unquoted attribute value, and a screen reader still reads it out.
      // [Codex review R7 P2.]
      ["writes its alt text without quotes",
        "<img src=dashboard.png alt=kernel>",
        ["kernel"], { kind: "html" }],
      // A backtick on an HTML page is a backtick, for TAGS as well as comments: the class
      // inside this one is not on the screen, and reading the backticks as a code span would
      // preserve the tag and report it.
      // …and in HTML a tag MAY span a blank line: there is no paragraph to end, so the class
      // stays inside the tag and out of sight. The markdown rule must not follow it here.
      // A numeric entity is a letter written the long way, and the browser shows the word.
      // [Codex review R8 P2.]
      // Inside a quoted attribute those characters are literal text the tokenizer never reads
      // as a comment, and a search result shows every word of them. [Codex review R9 P2.]
      ["writes comment markers inside a description attribute",
        '<meta property="og:description" content="What the <!-- kernel --> decides">',
        ["kernel"], { kind: "html" }],
      ["spells a forbidden word through a numeric entity",
        "<p>ker&#110;el decides what it may do</p>",
        ["kernel"], { kind: "html" }],
      ["spells one through a hexadecimal entity",
        "<p>ker&#x6E;el decides what it may do</p>",
        ["kernel"], { kind: "html" }],
      ["breaks a tag across a blank line on an HTML page",
        '<div\n\nclass="kernel-box">Agents run alone.</div>',
        [], { kind: "html" }],
      ["writes backticks around a tag on an HTML page",
        '<p>Type `<div class="kernel-box">` to open one.</p>',
        [], { kind: "html" }],
      // `data-name` is not `name`. The `\b` that let it through is the bug R4 fixed in the
      // attribute reader, left standing in the meta-key reader written to use it.
      // [Codex review R7 P2.]
      ["puts an asset path beside a data-name that only looks like a key",
        '<meta data-name="description" content="https://x/adapter-card.png">',
        [], { kind: "html" }],
      ["carries an RDFa `content` override on an ordinary element",
        '<span property="og:title" content="the kernel decides">Asterism</span>',
        [], { kind: "html" }],
      ["hides it in the Open Graph description a social preview shows",
        "<meta property=\"og:description\" content=\"Agents whose boundary the kernel enforces.\" />",
        ["kernel"], { kind: "html" }],
      // …but a class, an id and an href are not sentences, and must stay out.
      ["puts it in a class name and an href, which no reader meets",
        "<a class=\"registry-grid\" id=\"kernel-box\" href=\"/adapter/substrate\">Read on</a>",
        [], { kind: "html" }],
      // A fenced example is a PICTURE of markup: every character is on the screen, and the
      // word rule already treats a fence as copy. [Codex review R3 P2.]
      ["shows hidden markup inside a fenced example, where a reader reads it",
        "```html\n<!-- the kernel decides what it may do -->\n```",
        ["kernel"]],
      // …and an inline span may WRAP. Python-Markdown renders it as one `<code>` across two
      // lines, so every character is still on the screen; excluding newlines from the span
      // reader turned it back into a comment and erased it. Asked the renderer.
      // [Codex review R7 P2.]
      // A blank line ends the paragraph, and with it the span AND the comment: the renderer
      // escapes the markers and puts `kernel` on the screen. Found by chasing a surviving
      // mutation to the renderer rather than reported.
      // A stray backtick inside a fence must not start a match that swallows the opening
      // backtick of a real span below it. [Codex review R8 P2.]
      // A closing fence may be LONGER than the one that opened it; the renderer still calls
      // the contents code. [Codex review R9 P2.]
      ["closes a fence with more markers than it opened",
        "~~~html\n<!-- the kernel decides -->\n~~~~",
        ["kernel"]],
      // A span opened with two backticks closes on a run of two, and the single backticks
      // inside it are literal — that is what the form is for. [Codex review R9 P2.]
      ["shows a backtick inside a double-backtick span",
        "Write `` `<!-- the kernel decides -->` `` at the top.",
        ["kernel"]],
      // …and the comment AFTER the lone backtick, which is what tells "closes on a run of
      // the same length" apart from "closes on the first run that is not longer". Closing
      // early ends the span before the comment and masks it.
      ["puts the comment after a lone backtick inside that span",
        "Write `` a ` <!-- the kernel decides --> `` at the top.",
        ["kernel"]],
      ["opens a real code span below a fence holding one stray backtick",
        "~~~\nno closing ` here\n~~~\nWrite `<!-- the kernel decides -->` at the top.",
        ["kernel"]],
      ["puts a blank line inside what looked like a code span",
        "Write `<!-- the\n\nkernel decides -->` here.",
        ["kernel"]],
      // …while a BLOCK comment may hold a blank line and stays a comment. The renderer says
      // so; the two cases differ only in where the region starts.
      // …and the same for a TAG. The renderer escapes what a blank line leaves behind, so the
      // class is visible text. Found by chasing a surviving mutation, not reported.
      ["puts a blank line inside what looked like a tag",
        'Type `<div\n\nclass="kernel-box">` to open one.',
        ["kernel"]],
      ["puts a blank line inside a block comment, which survives it",
        "Text.\n\n<!--\nnote\n\nthe kernel decides\n-->\n\nMore text.",
        []],
      ["shows hidden markup in a code span that wraps across a line",
        "Write `<!-- the\nkernel decides -->` at the top.",
        ["kernel"]],
      ["shows it in an inline code span",
        "Write `<!-- the kernel -->` at the top of the file.",
        ["kernel"]],
      // A `<script>` whose body holds a backtick — a template literal — used to look like an
      // inline code span to the fence reader, which then preserved the whole script and
      // reported words no reader meets. Only the region's OPENER decides.
      // [Codex review R4 P2.]
      ["puts a backtick inside a script, which is not a code span",
        "<script>\n  const label = `the kernel decides`;\n</script>\n<p>Agents run alone.</p>",
        [], { kind: "html" }],
      // A tag shown INSIDE a code example is a picture of a tag: every character is on the
      // screen, the attribute a rendered page would hide included. [Codex review R4 P2.]
      ["shows a tag with an internal word in its class, inside a fence",
        "```html\n<div class=\"kernel-box\">Hello</div>\n```",
        ["kernel"]],
      ["shows one in an inline code span",
        "Write `<div class=\"registry-grid\">` at the top.",
        ["registry"]],
      // …but a real tag on a real page keeps its class hidden — and a `>` inside a quoted
      // attribute does not end the tag, which used to leave the class behind as prose.
      // [Codex review R4 P2.]
      ["hides a class behind a quoted `>` in a title",
        "<a title=\"more x > y\" class=\"kernel-box\" id=\"registry\">Read on</a>",
        [], { kind: "html" }],
      // `data-title` is implementation state. A word boundary alone matched the tail of it
      // and restored the value as copy. [Codex review R4 P2.]
      ["puts internal words in data- attributes nobody meets",
        "<div data-title=\"kernel\" data-content=\"registry\" data-alt=\"substrate\">ok</div>",
        [], { kind: "html" }],
      // The allowed sense has to cover the same inflections the word list does.
      // [Codex review R4 P2.]
      ["names container registries in the plural",
        "The image is mirrored across two container registries.",
        []],
      // A help synopsis is PLAIN text. `<adapter>` is a placeholder, not a tag, and reading it
      // as one erased the word in the corpus this rule started from. [Codex review R5 P2.]
      ["puts an internal word in a help synopsis placeholder",
        "Usage: asterism config <adapter> [options]",
        ["adapter"], { kind: "plain" }],
      ["shows comment markers as a literal string, which plain text is full of",
        "Usage: asterism note add <text>    e.g. asterism note add '<!-- the kernel -->'",
        ["kernel"], { kind: "plain" }],
      ["is an npm description, which has no markup either",
        "The engine behind Asterism: the kernel, scoped memory, and the event log.",
        ["kernel"], { kind: "plain" }],
      // A link's DESTINATION is a path this repo chose for a heading, not a sentence it wrote
      // for a reader — and the safety case really does have headings with these words in
      // them. The words the link is written ON are copy, and still fire.
      // [Codex review R5 P2.]
      ["links to a heading whose anchor names the machine",
        "See [the threat model](./threat-model.md#what-the-kernel-enforces) for the detail.",
        []],
      ["carries the word in a reference definition's URL",
        "See [the model][tm] for detail.\n\n[tm]: ./threat-model.md#the-kernel-substrate-boundary",
        []],
      // An AUTOLINK is not a tag: markdown renders `<https://…>` with the URL itself as the
      // visible link text, so every character of it is copy. A tag scan that accepted any
      // name at all swallowed it. (Added while fixing the plain-text case, not asked for —
      // and nothing exercised it until a mutation said so.)
      ["writes the URL as an autolink, which renders as its own text",
        "Read <https://example.com/the-kernel-notes> for the detail.",
        ["kernel"]],
      // …but a link's optional TITLE is not part of its destination: markdown renders it as a
      // tooltip, so a reader meets it. [Codex review R6 P2.]
      // Markdown allows balanced parentheses in a destination — the renderer takes the whole
      // thing as the URL. Stopping at the first `)` left the tail standing as prose.
      // [Codex review R7 P2.]
      ["links to a path with parentheses in it",
        "See [the detail](./foo(bar)-kernel-notes.md) for more.",
        []],
      // …and a `](` with no closing paren is not a link, so the words after it are prose.
      // `\](…)` is not a link: the bracket is escaped, so the renderer shows all of it.
      // [Codex review R8 P2.]
      // …with a REAL link earlier on the line, so the "is there a bracket at all" test cannot
      // stand in for the escape test. Without a real link before it, both refusals give the
      // same answer and neither is exercised.
      ["writes an escaped bracket after a real link on the same line",
        "See [the docs](./a.md) and \\](./the-kernel-notes) too.",
        ["kernel"]],
      // …and one whose opener has already been CLOSED by an earlier link on the same line.
      // "is there a bracket somewhere" said yes; the renderer shows the second fragment.
      // [Codex review R9 P2.]
      ["writes a literal `](` after a link that already closed",
        "See [the docs](./a.md) — prose ](the-kernel-notes) after it.",
        ["kernel"]],
      // …while a link whose TEXT wraps is still a link, and its destination is still a URL.
      // `docs/dashboard.md:44` is one; scanning only the current line read that URL as prose.
      // Found by measuring the corpus for the finding above, not by the finding.
      // …but not across a BLANK line. The renderer confirms: `See [the\n\nkernel notes](./a.md)`
      // comes back as two paragraphs with `kernel notes](./a.md)` as visible text, so the
      // destination is not a destination and its words are copy.
      // ⚠ The word has to be in the DESTINATION. A first version put it in the link TEXT,
      // which is copy either way, so both branches agreed and the mutation survived it.
      ["breaks a link's text across a blank line",
        "See [the\n\nnotes](./the-kernel-page.md) here.",
        ["kernel"]],
      ["wraps a link's text across a line break",
        "See the [configured\nmodel](./commands.md#what-the-kernel-does); the rest follows.",
        []],
      ["writes a `](` with no bracket opening it",
        "Text ](./the-kernel-notes) more prose.",
        ["kernel"]],
      // An ANGLE destination is delimited, not balanced — its parentheses are URL characters.
      // [Codex review R8 P2.]
      // A FULL reference link hides its identifier: the renderer shows only the first pair.
      // [Codex review R10 P2.]
      ["names the machine in a reference identifier",
        "See [the details][adapter] for more.\n\n[adapter]: ./runtime.md",
        []],
      // …but a SHORTCUT reference has no second pair, so its label is the visible text.
      // …but a SHORTCUT reference has no second pair, so its label IS the link text the
      // renderer shows — while the DEFINITION beneath renders nothing at all, label included.
      // One finding, not two.
      ["uses the label itself as the link text",
        "See [adapter] for more.\n\n[adapter]: ./runtime.md",
        ["adapter"]],
      // An angle destination may carry a title, exactly as a bare one may.
      // [Codex review R10 P2.]
      ["puts a title after an angle-bracket destination",
        '[the details](<https://example.test/kernel-notes> "a safe title")',
        []],
      ["uses an angle-bracket destination with a paren in the URL",
        "See [the detail](<https://example.test/foo(kernel-notes>) for more.",
        []],
      ["opens a destination it never closes",
        "See [the detail](./a.md#kernel-notes and more prose after it.",
        ["kernel"]],
      ["puts the word in a link's tooltip title",
        'See [the threat model](./threat-model.md#detail "what the kernel enforces").',
        ["kernel"]],
      ["puts it in a reference definition's title",
        'See [the model][tm].\n\n[tm]: ./threat-model.md#detail "what the kernel enforces"',
        ["kernel"]],
      ["names it in the words the link is written on",
        "See [what the kernel enforces](./threat-model.md#detail) for the detail.",
        ["kernel"]],
      ["says nothing about the machine at all",
        "Every agent starts with the standard toolkit, and staying that way is perfectly normal.",
        []],
    ];
    const vocabFailures = [];
    for (const [why, text, wantWords, opts] of VOCAB_CASES) {
      const got = vocabularyLeaks(text, { packageNames: NPM_NAMES, ...opts }).map((f) => f.word).sort();
      const want = [...wantWords].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        vocabFailures.push(
          `  copy that ${why}\n      want: ${JSON.stringify(want)}\n      got:  ${JSON.stringify(got)}`,
        );
      }
    }

    // The npm names are masked LONGEST FIRST, and this is the row that says why.
    // `@qmilab/asterism` is itself a published name and a prefix of all seven others, so a
    // reader that masked in the order git happened to list them would blank the prefix and
    // leave `-adapter-pi` standing — a red over the adapter's own npm page, the exact
    // failure the rows above exist to prevent. Passed shortest-first on purpose.
    const shortestFirst = [...NPM_NAMES].sort((a, b) => a.length - b.length);
    if (vocabularyLeaks("# @qmilab/asterism-adapter-pi\n", { packageNames: shortestFirst }).length) {
      vocabFailures.push(
        "  the adapter package's own npm page was reported when the names arrived shortest-first",
      );
    }

    // WHERE, not just whether, and in what ORDER. The line is the whole value of the report
    // to the person fixing it, and nothing else here could tell a correct line number from
    // one off by any amount.
    //
    // Two more properties ride on this one fixture, because both are invisible without it:
    //
    //   · the allowed sense is masked ACROSS a line break, so a mask that shortened the text
    //     instead of blanking it would swallow that newline and report both words one line
    //     early — every other row has its finding on line 1, where no offset can be wrong;
    //   · `substrate` is reported BEFORE `kernel` even though the word list has `kernel`
    //     first, so a report that came out in word order rather than reading order fails
    //     here. Findings are collected per word, so without the sort a page's second word is
    //     listed after every occurrence of its first.
    //   · a multi-line COMMENT above them is masked rather than deleted, so its lines still
    //     count — deleting it would keep every finding and move both of them up by three.
    const vocabLines = vocabularyLeaks(
      [
        "<!-- a maintainer note",                         // 1
        "     spanning three lines",                      // 2
        "     about this page -->",                       // 3
        "The image is published to the GitHub Container", // 4
        "Registry, multi-arch.",                          // 5
        "",                                               // 6
        "The substrate is swappable.",                    // 7
        "",                                               // 8
        "The kernel decides.",                            // 9
      ].join("\n"),
    ).map((f) => `${f.line}:${f.word}`);
    if (JSON.stringify(vocabLines) !== JSON.stringify(["7:substrate", "9:kernel"])) {
      vocabFailures.push(
        `  two words below a comment and a wrapped container-registry mention were reported at` +
          ` ${JSON.stringify(vocabLines)}, not ["7:substrate","9:kernel"]`,
      );
    }

    // …and WHAT it prints. A finding on the site's front page comes out of hand-written HTML,
    // so a report quoting the raw line hands the reader a mouthful of tags to search for —
    // and an entity has to keep its character rather than become a hole, because the landing
    // page writes its dashes as `&mdash;` and the reader searches the page for the sentence
    // this quotes.
    const htmlFinding = vocabularyLeaks(
      "<p>enforced by the <strong>kernel</strong>,   not the OS &mdash; see the threat model</p>",
    )[0];
    if (htmlFinding?.sentence !== "enforced by the kernel, not the OS — see the threat model") {
      vocabFailures.push(`  an HTML finding was reported as ${JSON.stringify(htmlFinding?.sentence)}`);
    }

    // The code-span reader itself, because everything downstream now keeps the same blank-line
    // rule and no page-level input can tell the two apart. A span may WRAP and may not span a
    // BLANK line — the renderer escapes the backticks there and puts the text on the screen.
    for (const [why, text, want] of [
      ["a span that wraps once", "Write `<!-- the\nkernel -->` here.", 1],
      ["a span split by a blank line", "Write `<!-- the\n\nkernel -->` here.", 0],
      ["a span on one line", "Write `<!-- kernel -->` here.", 1],
    ]) {
      const got = codeRanges(text).length;
      if (got !== want) vocabFailures.push(`  ${why} gave ${got} code range(s), not ${want}`);
    }

    // An attribute value is put back at ITS offset inside the blanked tag, not at the offset
    // of the attribute NAME. The two differ by five characters and nothing notices — until a
    // tag wraps and the value sits on the next line, when the difference is the line number
    // the report sends the reader to. Every other fixture here has a one-line tag.
    for (const [why, lines] of [
      ["quoted", ["<img", '  src="dashboard.png"', "  alt=", '       "The dashboard, where the kernel decides.">']],
      // …and UNQUOTED, where the value has no closing quote to count back from and the
      // arithmetic is one character different. [Codex review R7 P2.]
      // …at COLUMN 0, where being one character out writes over the newline itself and the
      // finding moves to the line above. Indented, the same error is invisible.
      ["unquoted", ["<img", "  src=dashboard.png", "  alt=", "kernel>"]],
    ]) {
      const wrappedTag = vocabularyLeaks(lines.join("\n"), { kind: "html" }).map(
        (f) => `${f.line}:${f.word}`,
      );
      if (JSON.stringify(wrappedTag) !== JSON.stringify(["4:kernel"])) {
        vocabFailures.push(
          `  a word in a wrapped tag's ${why} alt text was reported at ${JSON.stringify(wrappedTag)}, not ["4:kernel"]`,
        );
      }
    }

    // The filler a hidden region leaves behind must never reach a REPORT. It exists only so
    // that blanking a comment cannot split a visible paragraph; a reader searching the page
    // for the sentence this quotes would not find it with a NUL in the middle.
    const inlineComment = vocabularyLeaks("<p>enforced by the kernel</p> <!-- maintainer note -->")[0];
    if (inlineComment?.sentence !== "enforced by the kernel") {
      vocabFailures.push(`  a finding beside an inline comment was reported as ${JSON.stringify(inlineComment?.sentence)}`);
    }

    // A package name is matched LITERALLY. Every name this repo publishes today is free of
    // regex metacharacters, so nothing real can tell an escaped name from an unescaped one —
    // and an unescaped `.` in some later name would blank a DIFFERENT string and exempt a
    // real leak. Driven with a synthetic name for exactly that reason.
    if (!vocabularyLeaks("the aXb-adapter runs the turn", { packageNames: ["a.b-adapter"] }).some(
      (f) => f.word === "adapter",
    )) {
      vocabFailures.push("  a package name was matched as a pattern rather than literally");
    }

    // …and a very long line is cut rather than printed whole.
    const longLine = vocabularyLeaks(`The kernel ${"and on ".repeat(80)}forever.`)[0];
    if (!longLine || !longLine.sentence.endsWith("...") || longLine.sentence.length > 200) {
      vocabFailures.push(
        `  a ${longLine ? longLine.sentence.length : 0}-character finding was not truncated for the report`,
      );
    }

    // The rule this one replaced, asserted as a CAPABILITY rather than trusted: the words
    // `help.test.ts` refused before #183 must still be caught, or widening the corpus
    // quietly narrowed the rule.
    for (const word of ["kernel", "adapter", "registry", "substrate"]) {
      if (!vocabularyLeaks(`This is handled by the ${word}.`).some((f) => f.word === word)) {
        vocabFailures.push(`  \`${word}\`, refused in the CLI help since the CLI existed, is not caught here`);
      }
    }

    // The exemption as the PASS applies it, not just as the list declares it. Without this,
    // `isVocabularyExempt` could be made to return true for everything — every page exempt,
    // the real corpus reporting nothing, the build green — and the rows above would not
    // notice, because they call the predicate directly and never go through the pass.
    const exemptLabel = VOCABULARY_EXEMPT_PAGES[0];
    const sameSentence = "The kernel decides what it may actually do.";
    const throughThePass = checkCopyVocabulary(
      [
        [exemptLabel, sameSentence],
        ["docs/commands.md", sameSentence],
        ["asterism run --help", sameSentence],
      ],
      NPM_NAMES,
    );
    if (throughThePass.length !== 2 || throughThePass.some((f) => f.startsWith(`${exemptLabel}:`))) {
      vocabFailures.push(
        `  one sentence in three sources — one of them exempt — was reported ${throughThePass.length} time(s):` +
          `\n      ${JSON.stringify(throughThePass)}`,
      );
    }

    // …and the pass itself hides one, whichever page it is on. The vocabulary rule takes no
    // page kind: that flag decides whether a hidden region is a block BOUNDARY, and a rule
    // about single words has no blocks. Threading it here changed no answer any fixture could
    // vary — a parameter nothing can vary is a claim, not a check — so it was removed.
    const inHiddenComment = "<p>Agents run alone.</p>\n<!--\n  the kernel decides\n-->";
    for (const label of ["landing/index.html", "docs/commands.md"]) {
      const got = checkCopyVocabulary([[label, inHiddenComment]], NPM_NAMES).length;
      if (got !== 0) {
        vocabFailures.push(`  a word inside a comment reported ${got} time(s) under \`${label}\``);
      }
    }
    // …and the pass hands the rule the source's KIND. Every row above passes its own, so a
    // pass that dropped the argument would leave a help screen read as markdown — and its
    // `<placeholder>` erased as if it were a tag — with all of them still green.
    const helpPlaceholder = checkCopyVocabulary(
      [["asterism config --help", "Usage: asterism config <adapter> [options]"]],
      NPM_NAMES,
    );
    if (helpPlaceholder.length !== 1) {
      vocabFailures.push(
        `  a help synopsis naming <adapter> reported ${helpPlaceholder.length} time(s), not 1`,
      );
    }

    // …and the LINE the pass reports is the line in the file, which is only true while the
    // comment above it is masked rather than removed. Asserted through the pass, because
    // everything above calls the rule directly and a pass that mangled its input first would
    // pass all of it.
    const belowComment = checkCopyVocabulary(
      [["docs/commands.md", "<!-- a note\n     over two lines -->\n\nThe kernel decides."]],
      NPM_NAMES,
    );
    if (!belowComment[0]?.startsWith("docs/commands.md:4 [kernel]")) {
      vocabFailures.push(`  a word below a two-line comment was reported as ${JSON.stringify(belowComment[0])}`);
    }

    // THE EXEMPTION, in both directions.
    //
    // `docs/threat-model.md` is exempt by name because naming the enforcing component is
    // the point of a safety case. An exemption is only honest if it is still needed and
    // still narrow, so both halves are checked: the page must really carry the vocabulary
    // (an exemption for a page that no longer does is dead and should be deleted), and it
    // must be a page this corpus actually reads (one naming a path nothing reads exempts
    // nothing and hides the fact).
    const vocabPages = userFacingPages();
    for (const rel of VOCABULARY_EXEMPT_PAGES) {
      if (!vocabPages.includes(rel)) {
        vocabFailures.push(`  \`${rel}\` is exempt from the vocabulary rule but is not a page this reads`);
        continue;
      }
      const leaks = vocabularyLeaks(readFileSync(join(ROOT, rel), "utf8"), { packageNames: NPM_NAMES });
      if (leaks.length === 0) {
        vocabFailures.push(
          `  \`${rel}\` is exempt from the vocabulary rule and no longer needs to be — delete the exemption`,
        );
      }
    }
    if (vocabFailures.length) {
      console.log("\nSELF-TEST FAILED: the internal-vocabulary rule does not hold:");
      for (const f of vocabFailures) console.log(f);
      process.exit(1);
    }
    console.log(
      `Golden rule 7 holds on ${VOCAB_CASES.length} real sentences — it fires on the ${VOCABULARY_WORDS.join(", ")}` +
        ` through emphasis and markup, and never on a container registry, a published package's own` +
        ` name, or the memory firewall the product names out loud; ${VOCABULARY_EXEMPT_PAGES.length} page is` +
        ` exempt and still needs to be.`,
    );

    // The `Commands:` extraction, on the shapes that decide whether a derived verb list is
    // trustworthy. An empty answer is what a killed `--help` used to produce, and every
    // pass built on it reads "no verbs" as "nothing to report" — so the empty case is
    // asserted here even though the refusal it feeds cannot be run from a fixture.
    const blockCases = [
      ["an empty help", "", ""],
      ["a help with no `Commands:` heading at all", "Usage: asterism <command>\n  --version\n", ""],
      // The split keeps the newline that ended the `Commands:` line, which is why the
      // consumers match on `^\s{2}` per line rather than trimming.
      ["a real-shaped help", "Usage: asterism <command>\n\nCommands:\n  new <agent>   create\n  run <agent>   work\n\nOptions:\n  -v\n", "\n  new <agent>   create\n  run <agent>   work\n\n"],
    ];
    for (const [why, help, want] of blockCases) {
      if (commandsBlockOf(help) !== want) {
        console.log(`\nSELF-TEST FAILED: the \`Commands:\` extraction on ${why}:`);
        console.log(`  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(commandsBlockOf(help))}`);
        process.exit(1);
      }
    }
    // …and it is non-empty for the binary this run actually uses, or every verb-derived
    // check below is checking nothing.
    if (advertisedVerbSet(coverageWork).size === 0) {
      console.log("\nSELF-TEST FAILED: the binary's own `Commands:` block yielded no verbs.");
      process.exit(1);
    }
    console.log(
      `The root help's \`Commands:\` block yields ${advertisedVerbSet(coverageWork).size} verbs, and an` +
        ` empty help yields none rather than an empty list nothing questions.`,
    );

    // A child that never exited must be told apart from one that ran and failed, and the
    // whole run must STOP rather than read what the kill left behind. Folding both into
    // `-1` is how a killed `disconnect` came to be filed under "refused exactly as the page
    // documents" — the strongest classification here — because its partial stdout was the
    // success line the page shows.
    //
    // Proved against a REAL killed child rather than a hand-made error object, because the
    // fragile half is Node's contract, not the comparison. No `asterism` verb serves as the
    // fixture: `runCommand` closes stdin, and both blocking verbs (`serve`,
    // `events tail --follow`) shut down cleanly on EOF, so a slow machine — not a hung
    // command — is what reaches the timeout.
    const killShapes = [];
    const spin = 'const t = Date.now(); while (Date.now() - t < 5000) {}';
    try {
      execFileSync(process.execPath, ["-e", `console.log("partial output"); ${spin}`], {
        encoding: "utf8",
        timeout: 300,
        stdio: ["pipe", "pipe", "pipe"],
      });
      killShapes.push("  a child killed at its timeout did not throw at all");
    } catch (e) {
      if (!neverExited(e)) {
        killShapes.push(`  a child killed at its timeout was not recognised (status ${JSON.stringify(e.status)}, signal ${JSON.stringify(e.signal)})`);
      }
      if (!String(e.stdout ?? "").includes("partial output")) {
        killShapes.push("  the fixture printed nothing before being killed, so it does not exercise the case at all");
      }
    }
    // A crash is the same fact — nothing it printed is a result — and must be caught by the
    // same predicate, or a segfaulting binary is read as a command that failed cleanly.
    try {
      execFileSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGSEGV')"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      killShapes.push("  a child that killed itself with SIGSEGV did not throw");
    } catch (e) {
      if (!neverExited(e)) killShapes.push("  a child killed by SIGSEGV was read as one that exited");
    }
    // The control, and the direction that matters more: a child that RAN and failed must
    // never be called killed, or every documented refusal in the corpus becomes a failure.
    try {
      execFileSync(process.execPath, ["-e", "process.exit(3)"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      killShapes.push("  a child exiting 3 did not throw");
    } catch (e) {
      if (neverExited(e)) killShapes.push("  a child that exited 3 on its own was reported as killed");
    }
    if (killShapes.length) {
      console.log("\nSELF-TEST FAILED: a killed command is not told apart from one that exited:");
      for (const f of killShapes) console.log(f);
      process.exit(1);
    }
    console.log("A command killed — by the timeout or by a crash — is told apart from one that exited and failed.");

    // The root page's links, planted in both directions. It found nothing wrong on the real
    // page, so the only evidence it works at all is here — and the negative cases matter as
    // much: a pass that reported the org site's own links would be unfixable from this repo.
    const linkFixture = [
      ['<a href="/asterism/docs/walkthrough/">a</a>', "a page mkdocs builds", 0, 0],
      ['<a href="/asterism/docs/">a</a>', "the docs index", 0, 0],
      ['<a href="/asterism/">a</a>', "the root page itself", 0, 0],
      // A self-link resolves nothing, so it must not satisfy `checked` — that count is the
      // only tripwire for a moved site.
      ['<a href="/asterism/">a</a><a href="/asterism/index.html">b</a>', "only self-links", 0, 0, 0],
      ['<a href="/asterism/#quickstart">a</a><h2 id="quickstart">q</h2>', "a self-link to an id the page has", 0, 0],
      ['<a href="/asterism/#nowhere">a</a><h2 id="quickstart">q</h2>', "a self-link to an id the page has not", 1, 0],
      ['<a href="/asterism/#quickstart">a</a><h2 id=quickstart>q</h2>', "a self-link to an UNQUOTED id", 0, 0],
      ['<a href="/asterism/#quickstart">a</a><div data-id="quickstart">q</div>', "a `data-id`, which is not an id", 1, 0],
      ['<a href="/asterism/docs/nosuchpage/">a</a>', "a page nothing builds", 1, 0],
      ['<a href="/asterism/docs/assets/img/dashboard.png">a</a>', "a file the site serves", 0, 0, 1],
      ['<a href="/asterism/docs/assets/img/nosuch.png">a</a>', "a file it does not", 1, 0, 1],
      ['<a href="/asterism/docs/walkthrough/#claim-1-separate-memory">a</a>', "a heading that exists", 0, 0],
      ['<a href="/asterism/docs/walkthrough/#no-such-heading">a</a>', "a heading that does not", 1, 0],
      ['<a href="/manifesto">a</a>', "a page on the org site", 0, 1],
      ['<a href="https://github.com/qmilab/asterism">a</a>', "an external link", 0, 0],
      ['<a href="https://qmilab.com/asterism/docs/walkthrough/">a</a>', "a whole URL naming a page this site builds", 0, 0, 1],
      ['<a href="https://qmilab.com/asterism/docs/nosuchpage/">a</a>', "a whole URL naming one it does not", 1, 0, 1],
      ['<a href="https://qmilab.com/asterism/docs/walkthrough/#no-such-heading">a</a>', "a whole URL at a heading it does not have", 1, 0, 1],
      ['<a href="https://qmilab.com/manifesto">a</a>', "a whole URL on the org site", 0, 1, 0],
      ['<a href="https://qmilab.com/asterism/">a</a><a href="/asterism/">b</a>', "a whole URL naming this page itself", 0, 0, 0],
      ['<a href="logo.png">a</a>', "a relative asset", 0, 0],
      ['<a href="#top">a</a>', "an in-page anchor", 0, 0],
      ["<a href='/asterism/docs/nosuchpage/'>a</a>", "a SINGLE-quoted href at a URL nothing builds", 1, 0],
      ["<a href=/asterism/docs/nosuchpage/>a</a>", "an UNQUOTED href at a URL nothing builds", 1, 0],
      ['<a HREF="/asterism/docs/nosuchpage/">a</a>', "an UPPERCASE attribute name", 1, 0],
      ['<a data-href="/asterism/docs/nosuchpage/">a</a>', "a `data-href` alone, which is not a link", 0, 0],
      ["<a href='/asterism/docs/walkthrough/'>a</a>", "a single-quoted href that resolves", 0, 0],
      ['<a data-href="/asterism/docs/nosuchpage/" href="/asterism/docs/walkthrough/">a</a>', "a `data-href` beside a real one — only the real one is a link", 0, 0],
      ['<link rel="icon" href="/favicon.svg" />', "a favicon, which is an asset and not a link", 0, 0],
      ['<link rel="stylesheet" href="/asterism/docs/nosuchpage/" />', "a stylesheet at a URL no page builds", 0, 0],
    ];
    const linkFailures = [];
    for (const [html, why, wantBroken, wantOffSite, wantChecked] of linkFixture) {
      // Named as the real index would be: with `<planted>` the basename lookups below can
      // never match, which is exactly why the self-link case passed while the code counted
      // it. A fixture whose name makes the branch unreachable proves nothing about it.
      const got = checkLandingLinks([["landing/index.html", html]], undefined, undefined, "landing");
      if (wantChecked !== undefined && got.checked !== wantChecked) {
        linkFailures.push(`  ${why}: counted ${got.checked} links checked, wanted ${wantChecked}`);
      }
      if (got.broken.length !== wantBroken || got.offSite.length !== wantOffSite) {
        linkFailures.push(
          `  ${why}: ${got.broken.length} broken / ${got.offSite.length} undecidable,` +
            ` wanted ${wantBroken} / ${wantOffSite}`,
        );
      }
    }
    // The prefixes are DERIVED, and the self-test proves it by pointing a wrong one at the
    // REAL page: every link then falls to the undecidable pile, which is printed but does
    // not fail the build — so without the zero-report below, a moved site is a green over
    // links nothing looked at.
    const realPages = publishedLandingPages().map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")]);
    const realPublished = new Set(publishedPages());
    const right = checkLandingLinks(realPages, realPublished);
    if (right.checked === 0) {
      linkFailures.push("  the real root page resolved zero links against its own derived prefix");
    }
    // A landing directory with more than one page, and two of them sharing a basename —
    // reachable because git's `landing/*.html` pathspec matches NESTED paths. Basename
    // matching resolved `/asterism/` to whichever sorted first and reported a correct
    // `/asterism/blog/post.html` as broken.
    // In git's order, which sorts a nested page BEFORE the root one — so the first entry is
    // not the directory every page shares, and taking it whole gets the root wrong.
    const nested = [
      ["landing/blog/index.html", "<h2 id=y>y</h2>"],
      ["landing/blog/post.html", "<h2 id=x>x</h2>"],
      ["landing/index.html", '<a href="/asterism/blog/post.html">a</a><a href="/asterism/blog/">b</a>'],
    ];
    // A corpus with no page at the declared root at all. Inferring the directory from the
    // pages gives `landing/en`, and every URL then resolves one level too deep.
    const deepOnly = checkLandingLinks(
      [
        ["landing/en/about.html", "<h2 id=a>a</h2>"],
        ["landing/en/index.html", '<a href="/asterism/en/about.html">a</a>'],
      ],
      realPublished,
      undefined,
      "landing",
    );
    if (deepOnly.broken.length !== 0 || deepOnly.checked !== 1) {
      linkFailures.push(
        `  a corpus with no page at the declared root: ${deepOnly.broken.length} broken /` +
          ` ${deepOnly.checked} checked, wanted 0 / 1 — ${JSON.stringify(deepOnly.broken)}`,
      );
    }

    const nestedResult = checkLandingLinks(nested, realPublished, undefined, "landing");
    if (nestedResult.broken.length !== 0 || nestedResult.checked !== 2) {
      linkFailures.push(
        `  a nested landing page: ${nestedResult.broken.length} broken / ${nestedResult.checked} checked,` +
          ` wanted 0 / 2 — ${JSON.stringify(nestedResult.broken)}`,
      );
    }
    // …and a fragment must be read from the page the URL names, not from one that merely
    // shares its filename.
    const wrongPage = checkLandingLinks(
      [["landing/index.html", '<a href="/asterism/blog/#x">a</a>'], ["landing/blog/index.html", "<h2 id=y>y</h2>"]],
      realPublished,
      undefined,
      "landing",
    );
    if (wrongPage.broken.length !== 1) {
      linkFailures.push("  a fragment was resolved against the wrong landing page");
    }

    const wrong = checkLandingLinks(realPages, realPublished, { docsPrefix: "/elsewhere/docs/", siteRoot: "/elsewhere/" });
    if (wrong.checked !== 0) {
      linkFailures.push(`  a wrong prefix over the real page still checked ${wrong.checked} links`);
    }
    // …and everything it could not check is ACCOUNTED FOR rather than dropped, which is
    // what makes `checked === 0` at the call site a reliable signal that the prefix moved.
    // Everything the wrong prefix could not check must be ACCOUNTED FOR, which is what
    // makes `checked === 0` a reliable signal. Stated as "no fewer than", because a
    // self-link lands in neither pile under the right prefix and would otherwise make this
    // fail — with a message about a moved prefix — the day the page gains a `back to top`.
    if (wrong.offSite.length < right.checked + right.offSite.length) {
      linkFailures.push(
        `  under a wrong prefix only ${wrong.offSite.length} links were set aside, where the page` +
          ` resolved ${right.checked} and set aside ${right.offSite.length} under the right one`,
      );
    }

    // …and the anchor half must be judged by the SITE's renderer. `## Claim 1 — separate
    // memory` slugs differently under GitHub's rule (which keeps no em dash and joins with
    // `-`), so a pass using the wrong one would pass the fixture above and fail the site.
    if (!anchorsOf("## Claim 1 — separate memory\n", MKDOCS_RULE).has("claim-1-separate-memory")) {
      linkFailures.push("  the fixture's own anchor is not what the site's renderer emits — it proves nothing");
    }
    if (linkFailures.length) {
      console.log("\nSELF-TEST FAILED: the root page's link rule does not hold:");
      for (const f of linkFailures) console.log(f);
      process.exit(1);
    }
    console.log(
      "A link from the root page into this site is resolved against the pages mkdocs builds;" +
        " one into the org site is named undecidable rather than guessed at.",
    );

    // The same rule for the same URLs written the OTHER way — whole, by a markdown page
    // that cannot write a host-relative one because it is also read on npm and on GitHub.
    // Driven against a fixture site so nothing here depends on this repo's own `site_url`,
    // and every case names what it plants.
    const SITE = { origin: "https://example.test", path: "/proj/docs/" };
    const sitePublished = new Set(["docs/index.md", "docs/concepts.md"]);
    const siteLanding = ["site/index.html"];
    const siteBodies = {
      "docs/index.md": "# Docs\n",
      // An em dash, because that is where the two renderers DISAGREE: mkdocs collapses the
      // whitespace run around it to one hyphen, GitHub's rule leaves two. A fixture heading
      // both agree on cannot tell whether this pass asks the renderer that serves the page.
      "docs/concepts.md": "# Concepts\n\n## Claim 1 \u2014 separate memory\n",
      "site/index.html": '<h2 id="quickstart">q</h2><h2 id="caf\u00e9">c</h2>',
    };
    // Keyed by the path a URL asks for, at the two different roots the two halves are
    // served from: the docs one under `site_url`, the landing one above it.
    const siteAssets = new Map([
      ["docs/img/shot.png", "docs/img/shot.png"],
      ["logo.png", "site/logo.png"],
    ]);
    const readFixture = (rel) => {
      if (!(rel in siteBodies)) throw new Error(`the fixture has no ${rel}`);
      return siteBodies[rel];
    };
    // [markdown, why, wantBroken, wantOffSite, wantChecked]
    const siteFixture = [
      ["[a](https://example.test/proj/docs/concepts/)", "a published page", 0, 0, 1],
      ["[a](https://example.test/proj/docs/)", "the docs index", 0, 0, 1],
      // The docs root with no trailing slash — the shape `site_url` itself is often written
      // in, and the one the prefix test has to special-case rather than fall through.
      ["[a](https://example.test/proj/docs)", "the docs root with no trailing slash", 0, 0, 1],
      ["[a](https://example.test/proj/docs/concepts/#claim-1-separate-memory)", "a heading the site emits", 0, 0, 1],
      ["[a](https://example.test/proj/docs/concepts/#claim-1--separate-memory)", "the same heading under GitHub's rule, which does not serve this URL", 1, 0, 1],
      ["[a](https://example.test/proj/docs/concepts/#no-such-heading)", "a heading it does not", 1, 0, 1],
      ["[a](https://example.test/proj/docs/nosuchpage/)", "a page nothing builds", 1, 0, 1],
      // A file the site serves is not a page and cannot be found by asking which markdown
      // builds a URL — before this, an absolute link to a real screenshot was reported
      // BROKEN, which is a red over a live link and the worse of the two failures.
      ["![a](https://example.test/proj/docs/img/shot.png)", "an image the site serves", 0, 0, 1],
      ["[a](https://example.test/proj/logo.png)", "a file served at the site's ROOT, above the docs", 0, 0, 1],
      ["![a](https://example.test/proj/docs/img/nosuch.png)", "an image it does not serve", 1, 0, 1],
      ["[a](https://example.test/proj/docs/img/shot.png#page=2)", "a fragment into a file, which nothing here can adjudicate", 0, 1, 1],
      // Inside the site, ABOVE the docs it serves. Without the prefix test this resolves to
      // `docs/concepts.md` — the page is real, the URL is not, and the checker says fine.
      ["[a](https://example.test/proj/concepts/)", "a real page named without the docs segment", 1, 0, 1],
      // The site serves `concepts/`, so `concepts.html` is a 404 even though the source
      // page it names is right there. A resolver that strips `.html` calls it fine.
      ["[a](https://example.test/proj/docs/concepts.html)", "a real page at a URL directory URLs do not serve", 1, 0, 1],
      // …and its MIRROR, which refusing `.html` outright got wrong: mkdocs builds
      // `index.md` at `index.html` under BOTH settings, so this one is live.
      ["[a](https://example.test/proj/docs/index.html)", "the docs index by its file name", 0, 0, 1],
      // Under directory URLs `concepts.md` is built at `concepts/index.html`, so naming
      // that file is naming a page the site really serves.
      ["[a](https://example.test/proj/docs/concepts/index.html)", "a page by the index file directory URLs build it at", 0, 0, 1],
      ["[a](https://example.test/proj/docs/concepts)", "a page by its bare path, which a host redirects", 0, 0, 1],
      ["[a](https://example.test/proj/)", "the site's root page", 0, 0, 1],
      // A bare root must resolve, not fall out of the site: `[qmilab.com/asterism](…)` is
      // how the changelog writes it, and reading that as the ORG site is a wrong answer
      // wearing the shape of a deliberate one.
      ["[a](https://example.test/proj)", "the site's root with no trailing slash", 0, 0, 1],
      ["[a](https://example.test/proj/#quickstart)", "an id the root page has", 0, 0, 1],
      ["[a](https://example.test/proj/#nowhere)", "an id it has not", 1, 0, 1],
      // A browser decodes a fragment before matching an id, and `new URL` hands it back
      // encoded. Only a landing page can have a non-ASCII id — the site's slug rule folds
      // everything to ASCII — so this is the only shape that can tell the two apart.
      ["[a](https://example.test/proj/#caf%C3%A9)", "a percent-encoded id the root page has", 0, 0, 1],
      ["[a](https://example.test/manifesto)", "a page on the org site", 0, 1, 0],
      ["[a](https://elsewhere.test/proj/docs/nosuchpage/)", "another host entirely", 0, 0, 0],
      ["[a](./docs/nosuch.md)", "a relative link, which the other pass resolves", 0, 0, 0],
      ["[a](mailto:x@example.test)", "a `mailto:`, which is not a URL to resolve", 0, 0, 0],
      ['<a href="https://example.test/proj/docs/nosuchpage/">a</a>', "a raw HTML href", 1, 0, 1],
      ["[a]: https://example.test/proj/docs/nosuchpage/", "a reference definition", 1, 0, 1],
      // A URL inside a listing is a sample, and the day this reports one it starts
      // manufacturing defects out of documentation.
      ["```\n[a](https://example.test/proj/docs/nosuchpage/)\n```", "a link inside a fence", 0, 0, 0],
    ];
    const siteFailures = [];
    for (const [md, why, wantBroken, wantOffSite, wantChecked] of siteFixture) {
      const got = checkSiteLinks(
        [["PAGE.md", md]],
        sitePublished,
        SITE,
        siteLanding,
        "site",
        readFixture,
        "docs",
        true,
        siteAssets,
      );
      if (got.checked !== wantChecked) {
        siteFailures.push(`  ${why}: counted ${got.checked} links checked, wanted ${wantChecked}`);
      }
      if (got.broken.length !== wantBroken || got.offSite.length !== wantOffSite) {
        siteFailures.push(
          `  ${why}: ${got.broken.length} broken / ${got.offSite.length} undecidable,` +
            ` wanted ${wantBroken} / ${wantOffSite} — ${JSON.stringify([...got.broken, ...got.offSite])}`,
        );
      }
    }
    // A site whose served segment is NOT its source directory — the case the translation in
    // `publishedPageFor` exists for, and the only shape that can kill it. This repo
    // publishes `docs/` at `…/docs/`, so both names are the same word here and the rule is
    // invisible to every other fixture.
    const renamed = checkSiteLinks(
      [["PAGE.md", "[a](https://example.test/proj/pages/deep/x/)[b](https://example.test/proj/pages/)"]],
      new Set(["content/index.md", "content/deep/x.md"]),
      { origin: "https://example.test", path: "/proj/pages/" },
      [],
      "site",
      () => "# x\n",
      "content",
      undefined,
      new Map(),
    );
    if (renamed.broken.length !== 0 || renamed.checked !== 2) {
      siteFailures.push(
        `  a site whose \`docs_dir\` is not its URL segment: ${renamed.broken.length} broken /` +
          ` ${renamed.checked} checked, wanted 0 / 2 — ${JSON.stringify(renamed.broken)}`,
      );
    }
    // `archive/x.md` is the control for the boundary itself: it is not under `content/`, and
    // it is the SAME LENGTH, so a resolver that slices the directory's length off every path
    // instead of testing where it ends reads it as `x.md` and answers `…/pages/x/` with a
    // page that exists at a URL that does not.
    const outside = checkSiteLinks(
      [["PAGE.md", "[a](https://example.test/proj/pages/x/)"]],
      new Set(["content/index.md", "archive/x.md"]),
      { origin: "https://example.test", path: "/proj/pages/" },
      [],
      "site",
      () => "# x\n",
      "content",
      undefined,
      new Map(),
    );
    if (outside.broken.length !== 1) {
      siteFailures.push(
        "  a page OUTSIDE `docs_dir` was resolved as if it were inside it: " +
          JSON.stringify(outside),
      );
    }

    // …and with directory URLs OFF every one of those answers flips, which is the only way
    // to tell a derived `use_directory_urls` from a constant `true`. The expectations here
    // are what `mkdocs build` actually writes under each setting, checked by building a
    // fixture site both ways: on → `concepts/index.html`; off → `concepts.html`, and no
    // `concepts/` for a trailing slash to reach.
    const flatPublished = new Set(["docs/index.md", "docs/concepts.md", "docs/sub/index.md"]);
    for (const [md, why, wantBroken] of [
      ["[a](https://example.test/proj/docs/concepts.html)", "the URL a flat site serves", 0],
      ["[a](https://example.test/proj/docs/concepts/)", "the directory URL a flat site does NOT serve", 1],
      // Built as `index.html` under either setting, so it is live under both.
      ["[a](https://example.test/proj/docs/)", "the docs index", 0],
      ["[a](https://example.test/proj/docs/sub/)", "a subdirectory index", 0],
      ["[a](https://example.test/proj/docs/sub/index.html)", "that index by its file name", 0],
      // A bare path is answered either way by a static host, so it needs BOTH readings —
      // and under a flat site only the second one finds anything.
      ["[a](https://example.test/proj/docs/concepts)", "a page by its bare path", 0],
    ]) {
      const flat = checkSiteLinks(
        [["PAGE.md", md]],
        flatPublished,
        SITE,
        siteLanding,
        "site",
        () => "# x\n",
        "docs",
        false,
        siteAssets,
      );
      if (flat.broken.length !== wantBroken || flat.checked !== 1) {
        siteFailures.push(
          `  \`use_directory_urls: false\`, ${why}: ${flat.broken.length} broken /` +
            ` ${flat.checked} checked, wanted ${wantBroken} / 1 — ${JSON.stringify(flat.broken)}`,
        );
      }
    }
    // …and the same URLs under directory URLs give the opposite verdicts.
    for (const [md, why, wantBroken] of [
      ["[a](https://example.test/proj/docs/concepts.html)", "the flat URL a directory site does NOT serve", 1],
      ["[a](https://example.test/proj/docs/concepts/)", "the directory URL it does", 0],
      ["[a](https://example.test/proj/docs/sub/)", "a subdirectory index", 0],
    ]) {
      const dirs = checkSiteLinks(
        [["PAGE.md", md]],
        flatPublished,
        SITE,
        siteLanding,
        "site",
        () => "# x\n",
        "docs",
        true,
        siteAssets,
      );
      if (dirs.broken.length !== wantBroken || dirs.checked !== 1) {
        siteFailures.push(
          `  \`use_directory_urls: true\`, ${why}: ${dirs.broken.length} broken /` +
            ` ${dirs.checked} checked, wanted ${wantBroken} / 1 — ${JSON.stringify(dirs.broken)}`,
        );
      }
    }

    // `servedAssets` maps its two halves at DIFFERENT roots — the docs one under
    // `site_url`, the landing one above it — and mapping either at the other is silent: the
    // link just reports as naming nothing, which is where this whole finding came from.
    const mapped = servedAssets(
      { docsPrefix: "/proj/pages/", siteRoot: "/proj/" },
      "content",
      ["content/img/x.png", "content/deep/theme.css"],
      "site",
      ["site/logo.png", "site/index.html"],
    );
    for (const [url, want] of [
      ["pages/img/x.png", "content/img/x.png"],
      ["pages/deep/theme.css", "content/deep/theme.css"],
      ["logo.png", "site/logo.png"],
      ["index.html", "site/index.html"],
    ]) {
      if (mapped.get(url) !== want) {
        siteFailures.push(`  servedAssets maps '${url}' to '${mapped.get(url)}', not '${want}'`);
      }
    }
    if (mapped.size !== 4) {
      siteFailures.push(`  servedAssets built ${mapped.size} entries from 4 files`);
    }
    // …and what the workflow removes comes back OUT, a removed directory taking everything
    // beneath it. Without this a maintainer note the workflow drops by name reads as a file
    // the site serves — a false green over a 404, which is what this lookup exists to stop.
    const afterRemoval = servedAssets(
      { docsPrefix: "/proj/pages/", siteRoot: "/proj/" },
      "content",
      ["content/img/x.png", "content/deep/theme.css"],
      "site",
      // `site/draftsX.html` is the control for the boundary: a removed DIRECTORY takes what
      // is beneath it and nothing that merely starts with its name. Dropping it would be a
      // live file quietly missing from the map, which surfaces as a red over a link that
      // works — the same prefix-without-a-separator mistake the `docs_dir` boundary made.
      ["site/logo.png", "site/README.md", "site/drafts/note.html", "site/draftsX.html"],
      ["README.md", "drafts"],
    );
    for (const gone of ["README.md", "drafts/note.html"]) {
      if (afterRemoval.has(gone)) siteFailures.push(`  servedAssets serves '${gone}', which the workflow deletes`);
    }
    for (const kept of ["logo.png", "pages/img/x.png", "draftsX.html"]) {
      if (!afterRemoval.has(kept)) siteFailures.push(`  servedAssets dropped '${kept}', which nothing deletes`);
    }

    // Both halves of `site_url` are DERIVED, and each fails SILENTLY on its own: a wrong
    // ORIGIN sends every link to another host and reports nothing at all, a wrong PATH
    // sends every link to the org site and reports them undecidable. Proven by pointing
    // each wrong one at the REAL corpus and watching `checked` go to zero — which is the
    // signal `main` fails on.
    const realMd = linkSourceFiles().map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")]);
    const realPub = new Set(publishedPages());
    const rightSite = checkSiteLinks(realMd, realPub);
    if (rightSite.checked === 0) {
      siteFailures.push("  this repo's own pages resolved zero links into this repo's own site");
    }
    for (const [parts, why] of [
      [{ origin: "https://elsewhere.test", path: siteUrlPath() }, "a wrong origin"],
      [{ origin: siteUrlParts().origin, path: "/elsewhere/docs/" }, "a wrong path"],
    ]) {
      const wrongSite = checkSiteLinks(realMd, realPub, parts);
      if (wrongSite.checked !== 0) {
        siteFailures.push(`  ${why} over the real pages still checked ${wrongSite.checked} links`);
      }
    }
    if (siteFailures.length) {
      console.log("\nSELF-TEST FAILED: the whole-URL link rule does not hold:");
      for (const f of siteFailures) console.log(f);
      process.exit(1);
    }
    console.log(
      "A markdown page's absolute link into this site is resolved against the pages the site" +
        " serves; one to the same host outside it is named undecidable rather than guessed at.",
    );

    // The rendering rule, planted in both directions. The defect it exists to catch was
    // published and survived every text-level check, so the negative direction — a block
    // that DOES declare a preserving `white-space` must not be reported — is what keeps it
    // from becoming noise the next person suppresses.
    // The class must satisfy `terminalBlocks`' own rule, or the block is never found and
    // every case below passes for the wrong reason — which is what the first version of
    // this fixture did, using a class named `t`.
    const styled = (ws) => `<style>.x__terminal { ${ws ? `white-space: ${ws};` : ""} color: red; }</style>`;
    const twoLine = '<div class="x__terminal">asterism new writer\nasterism run writer "x"</div>';
    const oneLine = '<div class="x__terminal">asterism new writer</div>';
    const RENDER_CASES = [
      ["a multi-line block with no white-space rule", styled(null) + twoLine, true],
      ["a multi-line block set to `normal`", styled("normal") + twoLine, true],
      ["a multi-line block set to `pre-line`, which eats the column alignment", styled("pre-line") + twoLine, true],
      ["a multi-line block set to `pre`", styled("pre") + twoLine, false],
      // `<pre>` needs no declaration — the browser gives it `white-space: pre`. Without
      // this case the rule reports the first `<pre class="…terminal…">` anyone adds, for a
      // block that renders correctly, which is how a gate becomes work to suppress.
      ["a multi-line <pre> with no white-space rule at all", styled(null) + '<pre class="x__terminal">a\nb</pre>', false],
      // …but the browser's default for `<pre>` is only a default. Exempting the tag
      // outright would let this check pass the exact defect it exists for.
      ["a <pre> the page's own CSS collapses by class", styled("normal") + '<pre class="x__terminal">a\nb</pre>', true],
      // …and by ELEMENT, which is the form that actually reads naturally and which the
      // first version of this missed: a compound naming no class was rejected outright.
      ["a <pre> collapsed by a bare `pre` rule", "<style>pre { white-space: normal; }</style>" + '<pre class="x__terminal">a\nb</pre>', true],
      ["a <div> collapsed by a bare `*` rule", "<style>* { white-space: normal; }</style>" + twoLine, true],
      ["a <div> rescued by a bare `div` rule", "<style>div { white-space: pre; }</style>" + twoLine, false],
      // An element name that is not this element's must still not apply.
      ["a `span` rule that cannot reach a <div>", "<style>span { white-space: pre; }</style>" + twoLine, true],
      // SPECIFICITY, not document order. A class outranks a type, so a later `pre`/`div`
      // rule does not undo an earlier class rule — resolving by order alone got this wrong
      // in BOTH directions, and only became reachable once element selectors were
      // evaluated at all.
      [
        "a class rule for `pre` followed by a bare `pre` rule that would undo it",
        "<style>.x__terminal { white-space: pre; } pre { white-space: normal; }</style>" +
          '<pre class="x__terminal">a\nb</pre>',
        false,
      ],
      [
        "a class rule for `normal` that a later bare `div` rule cannot override",
        "<style>.x__terminal { white-space: normal; } div { white-space: pre; }</style>" + twoLine,
        true,
      ],
      // A type selector is case-insensitive in HTML; a class selector is not.
      [
        "an UPPERCASE type selector that collapses the block",
        "<style>PRE { white-space: normal; }</style>" + '<pre class="x__terminal">a\nb</pre>',
        true,
      ],
      // An ancestor constraint cannot be evaluated from the block alone, and treating the
      // rightmost compound as the whole selector said it applied.
      [
        "a rule constrained by an ancestor this cannot see",
        "<style>.wrapper .x__terminal { white-space: pre; }</style>" + twoLine,
        true,
      ],
      // …and the same shape spelled with a child combinator.
      [
        "a rule constrained by a parent this cannot see",
        "<style>.wrapper > .x__terminal { white-space: pre; }</style>" + twoLine,
        true,
      ],
      // Two rules at the SAME specificity: the later one renders.
      // An INLINE declaration outranks the whole stylesheet, in both directions.
      [
        "an inline `normal` on a block the stylesheet preserves",
        styled("pre") + '<div class="x__terminal" style="white-space: normal">a\nb</div>',
        true,
      ],
      [
        "an inline `pre` on a block the stylesheet collapses",
        styled("normal") + '<div class="x__terminal" style="white-space: pre">a\nb</div>',
        false,
      ],
      [
        "an inline style that says nothing about white-space",
        styled("normal") + '<div class="x__terminal" style="color: red">a\nb</div>',
        true,
      ],
      // `!important` outranks specificity outright.
      [
        "a `*` rule with !important collapsing what a class rule preserves",
        "<style>.x__terminal { white-space: pre; } * { white-space: normal !important; }</style>" + twoLine,
        true,
      ],
      [
        "an !important `pre` rescuing what a class rule collapses",
        "<style>.x__terminal { white-space: normal; } div { white-space: pre !important; }</style>" + twoLine,
        false,
      ],
      // CSS NESTING: a nested rule's declaration belongs to the nested selector, not the
      // outer one. Read whole, the last match in the body wins and it is the wrong one.
      [
        "a nested `& .comment` rule that must not be read as the block's own",
        "<style>.x__terminal { white-space: pre; & .comment { white-space: normal; } }</style>" + twoLine,
        false,
      ],
      [
        "a nested rule that must not rescue a collapsing outer one",
        "<style>.x__terminal { white-space: normal; & .comment { white-space: pre; } }</style>" + twoLine,
        true,
      ],
      // A `<pre>`'s exemption rests on the browser's default APPLYING. A rule this cannot
      // evaluate is not the same as no rule, and treating it as one left the exemption over
      // a block that renders as one paragraph.
      [
        "a <pre> collapsed by an ancestor rule this cannot evaluate",
        '<style>.wrapper .x__terminal { white-space: normal; }</style><pre class="x__terminal">a\nb</pre>',
        true,
      ],
      [
        "a <pre> under a rule that declares no white-space at all",
        styled(null) + '<pre class="x__terminal">a\nb</pre>',
        false,
      ],
      [
        "two class rules at equal specificity, the later collapsing",
        "<style>.x__terminal { white-space: pre; } .x__terminal { white-space: normal; }</style>" + twoLine,
        true,
      ],
      ["a <pre> the page re-declares as `pre`", styled("pre") + '<pre class="x__terminal">a\nb</pre>', false],
      // A statement at-rule ends in `;` and has no block. Read as a rule it swallows the
      // NEXT selector, so one `@import` at the top of a stylesheet hid everything below it.
      [
        "a rule sitting below an @import statement",
        '<style>@import url("fonts.css");\n.x__terminal { white-space: pre; }</style>' + twoLine,
        false,
      ],
      [
        "a collapsing rule below an @charset statement",
        '<style>@charset "utf-8";\n.x__terminal { white-space: normal; }</style>' + twoLine,
        true,
      ],
      // The three FALSE PASSES the first version of this had, each of which reported a
      // collapsing page as fine. The first is not hypothetical: `landing/index.html` carries
      // `.asterism__terminal .comment` and `… .keyword`, so a `white-space` in either would
      // have satisfied the gate while the block it styles ran together.
      [
        "a `white-space` on a DESCENDANT of the block's class",
        "<style>.x__terminal .comment { white-space: pre; } .x__terminal { color: red; }</style>" + twoLine,
        true,
      ],
      [
        "a `white-space` on a class that merely starts the same way",
        "<style>.x__terminal-wrap { white-space: pre; } .x__terminal { color: red; }</style>" + twoLine,
        true,
      ],
      [
        "a `white-space` only inside an @media block, which is not the default rendering",
        "<style>@media print { .x__terminal { white-space: pre; } } .x__terminal { color: red; }</style>" + twoLine,
        true,
      ],
      // The same, but with the at-rule holding TWO rules — which is what makes the
      // brace-matching load-bearing rather than incidental. A reader that stopped at the
      // first `}` would resume mid-block and read the second rule as a top-level one.
      [
        "a `white-space` inside an @media block that holds more than one rule",
        "<style>@media print { .other { color: blue; } .x__terminal { white-space: pre; } }</style>" + twoLine,
        true,
      ],
      [
        "a compound demanding a second class the block does not carry",
        "<style>.x__terminal.wide { white-space: pre; }</style>" + twoLine,
        true,
      ],
      // …and the cascade, in both directions: the LAST applicable declaration is the one
      // that renders, so a later `normal` undoes an earlier `pre` and vice versa.
      [
        "`pre` undone by a later `normal`",
        "<style>.x__terminal { white-space: pre; } .x__terminal { white-space: normal; }</style>" + twoLine,
        true,
      ],
      [
        "`normal` overridden by a later `pre`",
        "<style>.x__terminal { white-space: normal; } .x__terminal { white-space: pre; }</style>" + twoLine,
        false,
      ],
      // A selector list is not one selector: the block's class may be any member of it.
      [
        "the block's class as the second member of a selector list",
        "<style>.other, .x__terminal { white-space: pre; }</style>" + twoLine,
        false,
      ],
      ["a multi-line block set to `pre-wrap`", styled("pre-wrap") + twoLine, false],
      ["a multi-line block set to `break-spaces`", styled("break-spaces") + twoLine, false],
      ["a ONE-line block with no white-space rule, which cannot lose a break", styled(null) + oneLine, false],
    ];
    const renderFailures = [];
    for (const [why, html, shouldReport] of RENDER_CASES) {
      const reported = checkTerminalRendering([["<planted>", html]]).length > 0;
      if (reported !== shouldReport) {
        renderFailures.push(`  ${why} was ${reported ? "reported" : "passed"}, and should not have been`);
      }
    }
    if (renderFailures.length) {
      console.log("\nSELF-TEST FAILED: the terminal-rendering rule does not hold:");
      for (const f of renderFailures) console.log(f);
      process.exit(1);
    }
    console.log(
      "A multi-line terminal block is reported unless its class is given a `white-space`" +
        " that keeps both the lines and the column alignment.",
    );

    // The extractor's own classifier, on the one page shape where the two classes are
    // indistinguishable by their first word: the CLI refuses an unknown option with
    // `asterism <verb> does not take --x.`, so a page showing that refusal has an OUTPUT
    // line that opens exactly like a synopsis. Read as a synopsis it is run as a command,
    // and the checker fails a page that is correct. Both a planted case and a control —
    // an unprompted line in a block with no prompt at all is still a synopsis.
    const exDir = mkdtempSync(join(tmpdir(), "asterism-extract-"));
    try {
      writeFileSync(
        join(exDir, "page.md"),
        [
          "```console",
          "$ asterism new writer --trsut autonomous",
          "asterism new does not take --trsut.",
          "Usage: asterism new <agent> [--soul <name|path>]",
          "```",
          "",
          "```",
          "asterism connections <agent>",
          "```",
          "",
        ].join("\n"),
      );
      const got = extract("page.md", exDir).map((i) => i.command);
      const want = ["asterism new writer --trsut autonomous", "asterism connections <agent>"];
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        console.log("\nSELF-TEST FAILED: the extractor no longer tells output from an invocation:");
        console.log(`  want: ${JSON.stringify(want)}`);
        console.log(`  got:  ${JSON.stringify(got)}`);
        process.exit(1);
      }
      // ...and the refusal is still ATTACHED to the command above it, which is what
      // lets a documented refusal be checked byte for byte rather than merely excused.
      const shown = extract("page.md", exDir)[0].shown.map((l) => l.trim());
      if (shown[0] !== "asterism new does not take --trsut.") {
        console.log(`\nSELF-TEST FAILED: the refusal was dropped instead of attached: ${JSON.stringify(shown)}`);
        process.exit(1);
      }
      console.log("A shown refusal is read as output, not as a command, and a bare synopsis still is one.");

      // The HTML half of the extractor, on the shapes that made it wrong once and would
      // make it wrong silently again. Entities matter as much as the class: a terminal
      // block holds `>` redirections and quoted tasks, so decoding them wrong turns a
      // correct command into one this then reports as broken.
      writeFileSync(
        join(exDir, "page.html"),
        [
          "<h2>Quickstart</h2>",
          '<div class="asterism__terminal">asterism new writer --trust autonomous',
          '<span class="comment"># a comment is presentation</span>',
          "asterism run writer &quot;tidy posts/&quot; &gt; out.txt",
          // `&amp;gt;` is the escaping of the literal TEXT `&gt;`, and it is the one shape
          // that tells the decoding order apart: decode `&amp;` first and this becomes
          // `&gt;` and then `>`, turning text a page displays into a redirection the
          // checker runs. Without this line the ordering comment above `decodeEntities`
          // was a claim nothing could kill.
          "asterism notes set writer sigil &quot;&amp;gt; means redirect&quot;",
          // NUMERIC references, decimal and hex — the same page, written by a different
          // editor. Left undecoded these reach the binary as literal `&#62;` text and are
          // reported as a docs failure on correct copy.
          "asterism run writer &#x27;tidy&#x27; &#62; out.txt",
          // An inline tag broken across LINES. Stripping markup with `<[^>]+>` eats the
          // newline inside it, shifting every command below and, when the tag straddles a
          // join, merging two commands into one — where the trailing-comment strip drops
          // the second outright.
          '<span',
          ' class="comment"># a wrapped comment</span>',
          "asterism events tail writer</div>",
          "<h2>Later</h2>",
          '<pre class="terminal">$ asterism memory inspect writer</pre>',
          "",
        ].join("\n"),
      );
      // A block containing a NESTED element of the same tag. The first version of the
      // reader was non-greedy to the first `</div>`, so everything below the nesting fell
      // outside every block and was dropped with no diagnostic — invisible to
      // `blocklessPages`, because a block was found.
      writeFileSync(
        join(exDir, "nested.html"),
        [
          '<div class="x__terminal">asterism new writer',
          '<div class="note">a note in the middle</div>',
          "asterism run writer &quot;after the nesting&quot;",
          "asterism memory inspect writer</div>",
          "",
        ].join("\n"),
      );
      const nested = extract("nested.html", exDir).map((i) => i.command);
      const nestedWant = [
        "asterism new writer",
        'asterism run writer "after the nesting"',
        "asterism memory inspect writer",
      ];
      if (JSON.stringify(nested) !== JSON.stringify(nestedWant)) {
        console.log("\nSELF-TEST FAILED: a nested element truncated the terminal block:");
        console.log(`  want: ${JSON.stringify(nestedWant)}`);
        console.log(`  got:  ${JSON.stringify(nested)}`);
        process.exit(1);
      }

      // Attribute quoting and heading case: HTML permits both, and every matcher here has
      // to agree about that. A single-quoted class made `terminalBlocks` find nothing while
      // `blocklessPages` stayed quiet (a block was found elsewhere on the page), and an
      // `<H2>` yielded no section at all, collapsing a page's groups into one shared
      // fixture. Both survived their mutation until this fixture existed.
      writeFileSync(
        join(exDir, "quoting.html"),
        [
          "<H2>Shouting</H2>",
          "<div class='x__terminal'>asterism new writer",
          "asterism memory inspect writer</div>",
          "<div class=x__terminal>asterism events tail writer</div>",
          "",
        ].join("\n"),
      );
      const quoted = extract("quoting.html", exDir).map((i) => ({ command: i.command, section: i.section }));
      const quotedWant = [
        { command: "asterism new writer", section: "## Shouting" },
        { command: "asterism memory inspect writer", section: "## Shouting" },
        { command: "asterism events tail writer", section: "## Shouting" },
      ];
      if (JSON.stringify(quoted) !== JSON.stringify(quotedWant)) {
        console.log("\nSELF-TEST FAILED: a single-quoted class or an uppercase heading was not read:");
        console.log(`  want: ${JSON.stringify(quotedWant)}`);
        console.log(`  got:  ${JSON.stringify(quoted)}`);
        process.exit(1);
      }

      const html = extract("page.html", exDir);
      const htmlWant = [
        // The opening tag shares its line with the first command, which is exactly the
        // shape that makes line numbers easy to get wrong by one.
        { line: 2, command: "asterism new writer --trust autonomous", section: "## Quickstart" },
        { line: 4, command: 'asterism run writer "tidy posts/" > out.txt', section: "## Quickstart" },
        { line: 5, command: 'asterism notes set writer sigil "&gt; means redirect"', section: "## Quickstart" },
        { line: 6, command: "asterism run writer 'tidy' > out.txt", section: "## Quickstart" },
        { line: 9, command: "asterism events tail writer", section: "## Quickstart" },
        { line: 11, command: "asterism memory inspect writer", section: "## Later" },
      ];
      const htmlGot = html.map((i) => ({ line: i.line, command: i.command, section: i.section }));
      if (JSON.stringify(htmlGot) !== JSON.stringify(htmlWant)) {
        console.log("\nSELF-TEST FAILED: the HTML extractor does not read a terminal block as one:");
        console.log(`  want: ${JSON.stringify(htmlWant, null, 2)}`);
        console.log(`  got:  ${JSON.stringify(htmlGot, null, 2)}`);
        process.exit(1);
      }
      // …and the same page with the class renamed yields NOTHING, which is the state
      // `blocklessPages` exists to report rather than count as "this page has no commands".
      writeFileSync(
        join(exDir, "moved.html"),
        '<div class="asterism__console">asterism new writer --trust autonomous</div>\n',
      );
      if (extract("moved.html", exDir).length !== 0) {
        console.log("\nSELF-TEST FAILED: a block whose class names no terminal was read as one anyway.");
        process.exit(1);
      }
      if (terminalBlocks(readFileSync(join(exDir, "moved.html"), "utf8"), true).length !== 0) {
        console.log("\nSELF-TEST FAILED: terminalBlocks found a block where the class does not name a terminal.");
        process.exit(1);
      }
      console.log(
        "The HTML extractor reads a terminal block, decodes its entities, keeps its line" +
          " numbers, and finds nothing when the class it keys on is gone.",
      );
    } finally {
      rmSync(exDir, { recursive: true, force: true });
    }

    // The other renderer, pinned the same way and for the same reason. These are not a
    // description of GitHub's algorithm — they are every heading in README.md paired with
    // the id GitHub actually emitted for it, read off the rendered repo page. The pair
    // that matters is the last: dropping the `&` leaves TWO spaces, and GitHub replaces
    // each one, where Python-Markdown collapses the run. Getting that backwards is how
    // this pass would report a correct link dead on the one file it cannot preview.
    const GITHUB_ANCHOR_PAIRS = [
      ["### Many agents. One runtime. Separate lives.", "many-agents-one-runtime-separate-lives"],
      ["## Why", "why"],
      ["## Quickstart", "quickstart"],
      ["## What you get", "what-you-get"],
      ["## Documentation", "documentation"],
      ["## Continuous, reviewable learning", "continuous-reviewable-learning"],
      ["## Pairs with Lodestar", "pairs-with-lodestar"],
      ["## Status", "status"],
      ["## Contributing & security", "contributing--security"],
      ["## License", "license"],
    ];
    const ghFailures = GITHUB_ANCHOR_PAIRS.filter(([h, want]) => githubAnchorOf(h) !== want);
    if (ghFailures.length) {
      console.log("\nSELF-TEST FAILED: the GitHub anchor port no longer matches GitHub:");
      for (const [h, want] of ghFailures) {
        console.log(`  ${h}\n    want: ${want}\n    got:  ${githubAnchorOf(h)}`);
      }
      process.exit(1);
    }
    // "Every id GitHub emits for README" was a completeness claim about a list of ten,
    // true only for as long as README had ten headings. The pins cannot be re-derived here
    // — GitHub's slugger has no local implementation and fetching it would put the network
    // inside a gate — so the claim is made checkable the other way: a heading with no pin
    // fails, and whoever adds one re-reads the id off GitHub's own rendering with
    // `curl https://github.com/qmilab/asterism | grep 'id="user-content-'`.
    const pinned = new Set(GITHUB_ANCHOR_PAIRS.map(([h]) => h));
    const unpinned = [...headingLines(readFileSync(join(ROOT, "README.md"), "utf8"))].filter(
      (h) => !pinned.has(h.trimEnd()),
    );
    if (unpinned.length) {
      console.log(
        `\nSELF-TEST FAILED: ${unpinned.length} README heading(s) the GitHub anchor port is not` +
          ` pinned against. These ids cannot be derived locally — read each one off GitHub's own` +
          ` rendering (\`curl https://github.com/qmilab/asterism | grep 'id="user-content-'\`) and` +
          ` add the pair:`,
      );
      for (const h of unpinned) console.log(`  ${h.trim()}   → githubAnchorOf gives '${githubAnchorOf(h)}'`);
      process.exit(1);
    }
    console.log(
      `GitHub anchor slugify matches all ${GITHUB_ANCHOR_PAIRS.length} ids GitHub emits for README,` +
        ` which is every heading it has. Pinned by hand, not derived — see the note above.`,
    );

    // Pinning the slugify is not the same as exercising the pass that uses it, and until
    // now only the former existed: `--self-test` skipped the link pass entirely, so it
    // could have been reporting nothing at all and this harness would still say PASSED.
    const linkFixtureFailures = probeLinkFixture();
    if (linkFixtureFailures.length) {
      console.log("\nSELF-TEST FAILED: the link pass does not see what it claims to see:");
      for (const f of linkFixtureFailures) console.log(f);
      process.exit(1);
    }
    console.log(
      "Every planted broken link is caught, every correct one is left alone, and every" +
        " undecidable one is counted rather than assumed.",
    );

    // Derived from the binary, not from a list here: every verb the docs give
    // subcommands must reject an invented one in a way `isShapeRejection` recognises.
    const missedRejections = probeSubcommandRejections(coverageWork);
    if (missedRejections.length) {
      console.log(
        `\nSELF-TEST FAILED: ${missedRejections.length} subcommand rejection(s) the shape` +
          ` check would not notice:`,
      );
      for (const m of missedRejections) console.log(m);
      process.exit(1);
    }
    console.log("Every verb with subcommands rejects an invented one, recognisably.");

    // --- a pass that reports something must STOP THE BUILD -----------------------------
    // The verdict at the end of this report used to be a hand-written chain, one
    // `x.length ||` term per pass, sitting two hundred lines from the pass it belonged to.
    // Nothing proved a term was in it: the corpus is clean, so deleting one changed no
    // verdict. It took planting a defect AND deleting its term to see anything — and then
    // the finding printed, in full, above a passing build (#186; reproduced for a second
    // pass, so it was the file's shape and not one check's).
    //
    // `emit` prints a pass and records it in the same call, so there is no chain to leave a
    // term out of. What is asserted here is the derivation that replaced it, over the REAL
    // registration list rather than over an example — so a pass added tomorrow is covered
    // the day it is written, not the day someone remembers to add a row here.
    const verdictFailures = [];
    const registered = reportPasses({ groups, coverageWork });
    if (registered.length !== REPORT_PASSES) {
      verdictFailures.push(
        `  reportPasses() returned ${registered.length} passes, not the ${REPORT_PASSES} declared —` +
          ` one was added without saying so, or one was taken out`,
      );
    }
    for (const [i, pass] of registered.entries()) {
      // One pass finds something and every other reports clean. The verdict must fail, and
      // must name THIS one — a derivation reading only the first entry, or only the last,
      // satisfies an assertion made with a single pass.
      const failed = failing(registered.map((p, j) => ({ id: p.id, count: j === i ? 1 : 0 })));
      if (failed.length !== 1 || failed[0].id !== pass.id) {
        verdictFailures.push(`  a finding in '${pass.id}' alone was judged ${JSON.stringify(failed.map((f) => f.id))}`);
      }
      // Shape, because `emit` refuses these at exit 2 and a check that refuses to run is a
      // docs check nobody gets an answer from. `find` and `green` are NOT called: they read
      // the real corpus, which is the one thing `--self-test` exists in order not to do.
      if (!isLine(pass.id)) verdictFailures.push(`  pass ${i} carries no id`);
      if (registered.filter((p) => p.id === pass.id).length !== 1) {
        verdictFailures.push(`  '${pass.id}' is registered more than once`);
      }
      if (typeof pass.find !== "function") verdictFailures.push(`  '${pass.id}' has no find()`);
      if (!isLine(pass.heading(1))) verdictFailures.push(`  '${pass.id}' heading() prints nothing over one finding`);
      if (pass.green !== null && typeof pass.green !== "function") {
        verdictFailures.push(`  '${pass.id}' declares neither \`green: null\` nor a function`);
      }
      if (pass.advisories != null && typeof pass.advisories !== "function") {
        verdictFailures.push(`  '${pass.id}' declares advisories that are not a function`);
      }
    }
    // …and the other direction, which is half the assertion: a verdict that fails whatever
    // it is handed proves nothing by failing, and the loop above passes just as happily
    // against a derivation hard-wired to `true`.
    if (failing(registered.map((p) => ({ id: p.id, count: 0 }))).length) {
      verdictFailures.push("  a report in which every pass found nothing was judged failing");
    }
    // The exit CODE and what was PRINTED, in a child, because running `process.exit` is the
    // only way to observe it — the same reason the config refusals above are spawned rather
    // than read. Both halves are asserted in the same case on purpose: "printing is
    // registering" is the claim this whole shape rests on, and a mechanism that counted
    // correctly while printing nothing would satisfy the exit code alone.
    const PASS_LIB = join(ROOT, "scripts/lib/report-passes.mjs");
    // The green sentence here is a string NOTHING ELSE prints. It was "clean" first, which
    // `finish`'s own "All N checks … are clean." also satisfies — so silencing the green
    // sentence altogether left the case below passing. A fixture written to kill a bug has
    // to be watched killing it.
    const CLEAN = `{ id: "a", find: () => [], heading: (n) => "A (" + n + ")", green: () => "A FOUND NOTHING" }`;
    const VERDICT_CASES = [
      [
        "a pass that found something prints it and stops the build",
        `emit(v, { ...${CLEAN}, find: () => ["a finding"] });`,
        1,
        ["A (1)", "  a finding", "1 of 1 checks failed: a (1)."],
        [],
      ],
      [
        "a pass that found nothing says so and does not",
        `emit(v, ${CLEAN});`,
        0,
        ["A FOUND NOTHING", "All 1 checks in this report are clean."],
        ["checks failed"],
      ],
      [
        "one pass finding something among others that did not",
        `emit(v, ${CLEAN}); emit(v, { ...${CLEAN}, id: "b", find: () => ["x"] }); emit(v, { ...${CLEAN}, id: "c" });`,
        1,
        ["1 of 3 checks failed: b (1)."],
        [],
      ],
      [
        "an advisory prints beside a pass that found nothing, and does not fail it",
        `emit(v, { ...${CLEAN}, advisories: () => [["UNDECIDED (1):", ["a line"]]] });`,
        0,
        ["A FOUND NOTHING", "UNDECIDED (1):", "  a line", "All 1 checks in this report are clean."],
        ["checks failed"],
      ],
      [
        "an advisory with nothing in it prints no heading",
        `emit(v, { ...${CLEAN}, advisories: () => [["UNDECIDED (0):", []]] });`,
        0,
        [],
        ["UNDECIDED"],
      ],
      [
        "a find() returning a result OBJECT is refused, not read as empty",
        `emit(v, { ...${CLEAN}, find: () => ({ broken: [], checked: 0 }) });`,
        2,
        ["BUG IN THIS CHECKER"],
        [],
      ],
      ["a pass registered twice under one id is refused", `emit(v, ${CLEAN}); emit(v, ${CLEAN});`, 2, ["BUG IN THIS CHECKER"], []],
      [
        "a pass carrying no id is refused",
        `emit(v, { find: () => [], heading: () => "A", green: null });`,
        2,
        ["BUG IN THIS CHECKER"],
        [],
      ],
      [
        "a pass that never declared a green sentence is refused",
        `emit(v, { id: "a", find: () => [], heading: () => "A" });`,
        2,
        ["BUG IN THIS CHECKER"],
        [],
      ],
      [
        "an advisories() that produced nothing is refused, not read as no advisories",
        `emit(v, { ...${CLEAN}, advisories: () => undefined });`,
        2,
        ["BUG IN THIS CHECKER"],
        [],
      ],
      [
        "an advisories() returning a non-iterable is refused, not thrown at exit 1",
        `emit(v, { ...${CLEAN}, advisories: () => 3 });`,
        2,
        ["BUG IN THIS CHECKER"],
        ["TypeError"],
      ],
      [
        "an advisory carrying more than a [heading, lines] pair is refused",
        `emit(v, { ...${CLEAN}, advisories: () => [["H (1):", ["x"], "extra"]] });`,
        2,
        ["not a [heading, lines] pair"],
        [],
      ],
      [
        "an advisory whose lines are not a list is refused",
        `emit(v, { ...${CLEAN}, advisories: () => [["H (1):", "x"]] });`,
        2,
        ["advisory whose lines are"],
        [],
      ],
      // These two call `finish` themselves; the template's own call is never reached.
      ["finish() handed a non-iterable is refused, not thrown at exit 1", `finish(3, "green");`, 2, ["BUG IN THIS CHECKER"], ["TypeError"]],
      ["finish() handed a string is refused too", `finish("not a list", "green");`, 2, ["BUG IN THIS CHECKER"], []],
      ["a verdict with no count is refused, not read as clean", `finish([{ id: "a" }], "green");`, 2, ["where { id, count } was expected"], []],
      ["finish() with no closing sentence is refused", `finish(v, "");`, 2, ["BUG IN THIS CHECKER"], []],
    ];
    for (const [why, body, want, mustPrint, mustNotPrint] of VERDICT_CASES) {
      const source =
        `import(${JSON.stringify(PASS_LIB)}).then(({ emit, finish }) => { const v = []; ${body} finish(v, "green"); });`;
      let code = 0;
      let printed = "";
      try {
        printed = execFileSync(process.execPath, ["-e", source], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          cwd: ROOT,
        });
      } catch (err) {
        code = err.status;
        printed = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      }
      if (code !== want) verdictFailures.push(`  ${why}: exit ${code}, wanted ${want}`);
      for (const expected of mustPrint) {
        if (!printed.includes(expected)) {
          verdictFailures.push(`  ${why}: printed nothing matching ${JSON.stringify(expected)}`);
        }
      }
      for (const unwanted of mustNotPrint) {
        if (printed.includes(unwanted)) verdictFailures.push(`  ${why}: printed ${JSON.stringify(unwanted)}, which it should not`);
      }
    }
    if (verdictFailures.length) {
      console.log("\nSELF-TEST FAILED: a pass can report a finding without stopping the build:");
      for (const f of verdictFailures) console.log(f);
      process.exit(1);
    }
    console.log(
      `Each of the ${registered.length} passes this report makes stops the build on its own, a report` +
        ` that found nothing does not, what \`emit\` prints is what it counts, and a registration that` +
        ` could not report is refused rather than read as clean.`,
    );

    // The planted lines are the point: every one must be reported as a failure. If
    // the harness excuses or skips any of them, its zero is worth nothing.
    const planted = total;
    if (groups.failures.length !== planted) {
      console.log(
        `\nSELF-TEST FAILED: planted ${planted} bad commands, ` +
          `the harness caught ${groups.failures.length}.`,
      );
      process.exit(1);
    }
    console.log(`\nSELF-TEST PASSED: all ${planted} planted defects were caught.`);
    return;
  }

  for (const pass of checks) emit(verdicts, pass);

  rmSync(coverageWork, { recursive: true, force: true });
  finish(
    verdicts,
    `Every command those ${sourceFiles().length} pages advertise runs, or matches the binary's own help.`,
  );
}

/**
 * How many passes `reportPasses` returns. Raise it when you add one.
 *
 * A number kept in step by hand is what this slice removed everywhere else, and it earns its
 * place here for one reason: once the chain was gone, DELETING a registration became the
 * last way left to take a check out silently. The pass stops printing, its findings stop
 * counting, and the report is one line shorter. This is compared against the real list on
 * every `--self-test` run, so it cannot drift out of true — it can only be changed
 * deliberately, which is the point.
 */
const REPORT_PASSES = 14;

/**
 * Every pass this report makes, in the order it prints them, as one list.
 *
 * Each entry says three things at once — what it found, what it prints when it found
 * something, and what it prints when it did not — and `emit` derives the fourth, whether
 * the build stops, from the first. Those four used to be four separate statements, and the
 * fourth was a term in a hand-written `a.length || b.length || …` chain two hundred lines
 * below the pass it belonged to. Deleting a term left the pass printing its findings above
 * a green build, and nothing noticed: measured on #186 with a compound mutation, because a
 * single one cannot show it — the corpus is clean, so the term is dead weight until the day
 * it matters. `--self-test` now asserts this list, so a pass added tomorrow is covered the
 * day it is written.
 *
 * The first entry is the invocation run itself, which is why the caller destructures it: it
 * prints where it always has, above the tally that counts it, and the checks that follow
 * print after.
 *
 * Results shared by two passes are read through `once`, so the work still happens in report
 * order (each pass's cost lands where its output does) and happens once.
 */
function reportPasses({ groups, coverageWork }) {
  const links = once(() => checkLinks());
  const landing = once(() => checkLandingLinks());
  const site = once(() => checkSiteLinks());
  const copySources = once(() => userFacingCopy(coverageWork));

  return [
    {
      id: "invocations",
      find: () =>
        groups.failures.map(
          (i) => `${at(i)}  ${i.command}\n      ${i.why}${i.detail ? `\n      → ${i.detail}` : ""}`,
        ),
      heading: (n) => `FAILED (${n}):`,
      // The sentence `finish` prints is this pass's green, and it is deliberately last:
      // "every command those pages advertise runs" is only worth saying once everything
      // below has also been looked at.
      green: null,
    },
    {
      id: "undocumented-commands",
      find: () => checkCommandCoverage(coverageWork).map((v) => `asterism ${v}`),
      heading: (n) =>
        `UNDOCUMENTED COMMANDS (${n}) — \`${join(siteDir(), "commands.md")}\` claims` +
        ` to document every command, and has no section for:`,
      green: () => "Every command in `asterism --help` has a section in the command reference.",
    },
    {
      id: "internal-links",
      find: () => links().broken,
      heading: (n) => `BROKEN INTERNAL LINKS (${n}):`,
      // The numbers are the point. "Every internal doc link resolves" was true of a pass
      // that had looked at a fraction of them; saying how many were read, and out of what,
      // is what stops the sentence from outgrowing the check again.
      green: () => linkSummary(links()),
      advisories: () => [
        [`INTERNAL LINKS THIS PASS CANNOT DECIDE (${links().unchecked.length}):`, links().unchecked],
      ],
    },
    {
      // A published package with NO README is the one gap the scope rule cannot see: a set
      // built from the files that exist can never notice a file that does not, so a blank
      // npm page for something people install would just be one fewer page to check.
      id: "package-readmes",
      find: () => publishedPackagesWithoutReadme(),
      heading: (n) =>
        `PUBLISHED PACKAGES WITH NO README (${n}) — npm renders a package's page` +
        ` from its README, and shows only the one-line description without one:`,
      green: () => "Every package this repo publishes to npm has a README, and it is checked above.",
    },
    {
      id: "provider-table",
      find: () => checkProviderCoverage(),
      heading: (n) =>
        `PROVIDER TABLE OUT OF DATE (${n}) — \`${join(siteDir(), "models.md")}\` claims` +
        ` to list every built-in provider and the variable it reads:`,
      green: () => "Every built-in provider appears in the models page, with the key it reads.",
    },
    {
      id: "tool-catalog",
      find: () => checkToolCatalog(),
      heading: (n) =>
        `PARTIAL TOOL CATALOG (${n}) — a page presenting the tools an agent is` +
        ` given names some of them and not the rest:`,
      green: () => `Every page naming a catalog tool names all ${catalogToolNames().length} the CLI ships.`,
    },
    {
      id: "gate-claims",
      find: () => checkGateClaims(copySources()),
      heading: (n) =>
        `THE DESTRUCTIVE-ACTION GATE, PROMISED WIDER THAN IT FIRES (${n}) —` +
        ` a sentence stating the gate as a guarantee has to carry what the kernel actually does:`,
      green: () =>
        `Every guarantee about the destructive-action gate across ${copySources().length} pages, npm` +
        ` descriptions, site strings and help screens names its exception.`,
    },
    {
      id: "copy-vocabulary",
      find: () => checkCopyVocabulary(copySources()),
      heading: (n) =>
        `INTERNAL ARCHITECTURE VOCABULARY IN PUBLIC COPY (${n}) — a page or a help` +
        ` screen names a part of the machine where it could name what the product does.` +
        `\n  If the word means something ELSE here — a container registry, a package's published` +
        ` name — add the sense to scripts/lib/copy-vocabulary.mjs rather than rewording copy` +
        ` that is already right:`,
      green: () => {
        const exempt = copySources().filter(([label]) => isVocabularyExempt(label)).length;
        return (
          `No page, npm description, site string or help screen a user meets names an internal part` +
          ` (${VOCABULARY_WORDS.join(", ")}) — ${copySources().length - exempt} read, ${exempt} exempt` +
          ` (the safety case, where naming the part that enforces a guarantee IS the document).`
        );
      },
    },
    {
      // A page in the corpus whose links this could not find at all. A separate pass from
      // the broken ones, and a separate verdict, because it is a different claim: not "the
      // links resolve" but "links were looked at". Zero over the REAL root page, which is
      // full of absolute links, means none of them begins with the prefix `site_url`
      // derives — so every one went to the undecidable pile, which is printed and does not
      // fail. The self-test proves this is reachable by pointing a wrong prefix at the real
      // page and watching `checked` go to zero.
      id: "root-page-links-looked-at",
      find: () =>
        landing().checked === 0
          ? [
              `none of them begins with \`${landing().siteRoot}\`, the path derived from` +
                ` \`site_url\`. Either the site moved or the page's links did; nothing here` +
                ` was looked at.`,
            ]
          : [],
      heading: () => "NOT ONE LINK ON THE SITE'S ROOT PAGE WAS CHECKED —",
      // Silence is this pass's green: the pass below reports the count it looked at.
      green: null,
    },
    {
      id: "root-page-links",
      find: () => landing().broken,
      heading: (n) => `BROKEN LINKS ON THE SITE'S ROOT PAGE (${n}):`,
      green: () =>
        `All ${landing().checked} links from the site's root page into this site resolve to a` +
        ` page mkdocs builds, headings included.`,
      advisories: () => [
        [`LINKS FROM THE ROOT PAGE THIS PASS CANNOT DECIDE (${landing().offSite.length}):`, landing().offSite],
      ],
    },
    {
      // The same tripwire the root page has, for the same reason: only the code looking at
      // the REAL corpus knows that this repo's pages do link into this repo's site. They do
      // — the npm page's every link is one of these — so a zero means the prefix `site_url`
      // derives no longer matches what the pages write, and every one of them went
      // unlooked-at behind a green.
      id: "site-links-looked-at",
      find: () =>
        site().checked === 0
          ? [
              `no markdown page links to a URL under` +
                ` \`${siteUrlParts().origin}${siteUrlPath().replace(/[^/]+\/$/, "")}\`, derived from` +
                ` \`site_url\`. Either the site moved or the pages' links did.`,
            ]
          : [],
      heading: () => "NOT ONE ABSOLUTE LINK INTO THIS SITE WAS CHECKED —",
      green: null,
    },
    {
      id: "site-links",
      find: () => site().broken,
      heading: (n) => `BROKEN LINKS INTO THIS SITE (${n}):`,
      green: () =>
        `All ${site().checked} links from a markdown page into this site resolve to a page the` +
        ` site serves, headings included.`,
      advisories: () => [
        [`LINKS TO THIS HOST THIS PASS CANNOT DECIDE (${site().offSite.length}):`, site().offSite],
      ],
    },
    {
      id: "terminal-rendering",
      find: () => checkTerminalRendering(),
      heading: (n) =>
        `TERMINAL BLOCK RENDERS AS ONE PARAGRAPH (${n}) — its lines are` +
        ` correct and its markup collapses them:`,
      green: () => "Every multi-line terminal block on the site's root page keeps its line breaks.",
    },
    {
      // Reported rather than counted as zero: for the HTML half the answer "no commands" is
      // far more often "the markup changed" than it is true, and a checker reading nothing
      // while printing a green total is the exact failure this file has now paid for twice.
      id: "terminal-blocks-found",
      find: () => blocklessPages(),
      heading: (n) =>
        `NO TERMINAL BLOCK FOUND ON ANY PAGE (${n}) — commands are read from an` +
        ` element whose class names a terminal, and not one page published at the site's root has` +
        ` one. A renamed class looks exactly like this, and so does a checker reading nothing:`,
      // Every page's blocks are already reported on by the invocation counts above; this
      // pass only speaks when the set is empty.
      green: null,
    },
  ];
}

/** Run `fn` at most once, at the moment the first pass that needs its result prints. */
function once(fn) {
  let called = false;
  let value;
  return () => {
    if (!called) {
      value = fn();
      called = true;
    }
    return value;
  };
}

/**
 * `docs/models.md` says "Naming any of these is enough" and tabulates every built-in
 * provider against the variable it reads. That is a completeness claim about a table
 * in the code, and nothing else checks it: the command checker types VERBS, so a
 * provider added to PROVIDER_DEFAULTS and left out of the page works but is invisible,
 * and one removed leaves copy advertising an endpoint nobody has.
 *
 * Derived from the shipped module rather than from a list kept here — a second
 * hand-maintained list would just move the staleness.
 */
function checkProviderCoverage() {
  const rel = join(siteDir(), "models.md");
  const page = join(ROOT, rel);
  if (!existsSync(page)) return [`${rel} is missing`];
  const text = readFileSync(page, "utf8");
  const { PROVIDER_DEFAULTS, providerKeyEnvVar } = MODEL_CONFIG;

  const gaps = [];
  // Only the provider table's own rows, so a provider merely mentioned in prose
  // (`--provider ollama` in an example) does not count as documented.
  const rows = text.match(/^\| *`[a-z0-9-]+` *\|.*$/gm) ?? [];
  const documented = new Map(
    rows.map((row) => {
      const cells = row.split("|").map((c) => c.trim());
      return [cells[1]?.replace(/`/g, "") ?? "", cells[2] ?? ""];
    }),
  );

  for (const [name, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    const cell = documented.get(name);
    if (cell === undefined) {
      gaps.push(`${name} — built in, but absent from the provider table`);
      continue;
    }
    // A keyless provider must be shown as reading nothing; a keyed one must name
    // the variable that actually works, not a plausible-looking neighbour.
    if (defaults.needsNoKey === true) {
      if (/_API_KEY/.test(cell)) {
        gaps.push(`${name} — needs no key, but the table names one (${cell})`);
      }
    } else if (!cell.includes(providerKeyEnvVar(name))) {
      gaps.push(`${name} — table says ${cell || "(nothing)"}, code reads ${providerKeyEnvVar(name)}`);
    }
  }
  for (const name of documented.keys()) {
    if (!(name in PROVIDER_DEFAULTS)) {
      gaps.push(`${name} — listed as built in, but there is no such provider`);
    }
  }
  return gaps;
}

/**
 * The shipped tool catalog, as names — the nine tools the CLI registers behind the gate.
 * Derived from the module that builds them, so a tool added or removed moves this set
 * without anyone remembering to.
 */
function catalogToolNames() {
  // The workspace path is closed over, never read, at build time; any path gives the same
  // nine names, which is the whole reason this is a safe thing to ask at check time.
  return CAPABILITIES.workspaceCapabilities(ROOT).map((c) => c.tool.name);
}

/**
 * The names a page presents as CODE — backticks in markdown, `<code>` in HTML.
 *
 * Code spans, not prose, and that is the load-bearing half. Four of the nine catalog tools
 * — `find`, `stat`, `move` and `mkdir` — are ordinary English words, and `list_dir` sits a
 * hyphen away from ordinary phrasing. A pass that counted the word "find" would report a
 * defect on every page that says "find your agent's memory", which is a checker that
 * manufactures work. A page naming a tool as a tool marks it up as one.
 */
function codeSpans(text) {
  const spans = new Set();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) spans.add(m[1]);
  // `gi` like every other HTML matcher here, and tolerant of markup nested inside — a name
  // wrapped in `<code><b>read_file</b></code>` is still the page naming that tool. Without
  // either, a page marking its catalog up that way silently drops below the two-name
  // threshold and stops being covered at all.
  for (const m of text.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)) {
    spans.add(decodeEntities(stripMarkup(m[1])).trim());
  }
  return spans;
}

/**
 * `README.md`, the npm page and three doc pages each present the catalog as the set of
 * tools an agent is given — "a default catalog of workspace-scoped file tools" followed by
 * a list. That is a completeness claim about a table in the code, and it is the claim the
 * npm README got wrong in #164 by naming three of nine.
 *
 * The rule is membership, not prose shape: a page naming TWO or more catalog tools must
 * name all of them. Two is not arbitrary — it is where the measurement puts the line. Every
 * user-facing page today names either nine or none, and the one page that named a strict
 * subset named three; nothing anywhere in the repo sits between two and eight. So the rule
 * fires on nothing that is correct, and a page that drifts to a subset is caught at the
 * first tool it drops.
 *
 * A single mention is left alone deliberately: `decisions/0001-execution-isolation.md` names
 * `stat` once, in passing, as an example of a read — that is a reference to one tool, not an
 * inventory of the catalog. (It is outside this corpus anyway; the threshold is what makes
 * the rule honest rather than the scope.)
 *
 * The CHANGELOG names all nine and must never be retro-edited, so it would eventually be
 * forced out of compliance as the catalog grows. It is excluded by the SCOPE rule — it is
 * not a page a user meets — rather than by an exception written here, which is the point of
 * the scope rule existing.
 */
function checkToolCatalog(pages = userFacingPages().map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")])) {
  const names = catalogToolNames();
  const gaps = [];
  for (const [rel, text] of pages) {
    const spans = codeSpans(text);
    const named = names.filter((n) => spans.has(n));
    if (named.length < 2 || named.length === names.length) continue;
    gaps.push(
      `${rel} — names ${named.length} of the ${names.length} tools the CLI ships, missing: ` +
        names.filter((n) => !named.includes(n)).join(", "),
    );
  }
  return gaps;
}

/**
 * The destructive-action gate is the product's headline safety claim, and it is stated in
 * prose on nearly every page. `scripts/lib/gate-claims.mjs` holds the rule and the reasons;
 * this is the corpus.
 *
 * The corpus is the point. A guard for exactly this already existed — `help.test.ts` forbids
 * "pauses at every trust level", which is false at `propose` — and it read the binary's help
 * CONSTANTS and nothing else. So the very sentence it forbids was live in
 * `docs/getting-started.md`, where it could not see it, and the same page's neighbours had
 * drifted the other way. A rule that is right about a corpus that is wrong reports zero
 * forever. Here it reads every page a user meets AND the help the binary actually prints —
 * rendered, per verb, not the constants it is built from.
 *
 * Both directions are checked at once because this defect has now been shipped in both, the
 * second one written by the fix for the first (#139 → #176 → #177). Two guards in two files
 * would let that happen a third time; one predicate over one corpus cannot.
 */
function checkGateClaims(sources) {
  const found = [];
  for (const [label, text] of sources) {
    for (const claim of gateOverclaims(text, { kind: sourceKind(label) })) {
      found.push(`${label}:${claim.line} [${claim.rule}] ${claim.sentence}\n      → ${GATE_RULE_ADVICE[claim.rule]}`);
    }
  }
  return found;
}

/**
 * How is this source RENDERED — as HTML, as markdown, or not at all?
 *
 * It decides two things a text rule cannot guess: whether an HTML comment is a block boundary
 * (invisible in a browser, a paragraph break in markdown), and whether angle brackets are
 * markup at all. A help screen and an npm description are PLAIN: `asterism config <adapter>`
 * is a synopsis, not a tag, and reading it as one erased a word this rule exists to find.
 * See `scripts/lib/copy-text.mjs`. [Codex review R4, R5 P2.]
 */
function sourceKind(label) {
  if (label.endsWith(".html")) return "html";
  if (label.endsWith(".md")) return "markdown";
  return "plain";
}

/**
 * THE CORPUS: every page a user meets, plus the rendered help of every verb the root help
 * advertises (and the root help itself). Labelled by the path or the command that produced
 * it, so a finding says where to go.
 *
 * Derived from `advertisedVerbSet` — the same list the command-coverage pass uses — rather
 * than from a list of the verbs that happen to say the thing today. Eleven verbs mention the
 * gate now; a twelfth that starts to is exactly the case a hand-kept list misses.
 *
 * ONE corpus, shared by every pass that asks what the copy SAYS, because the corpus is where
 * both of those rules have been wrong. The destructive-gate rule was right about the binary's
 * help and blind to the pages (#177); the internal-vocabulary rule was right about the same
 * help and blind to the same pages, front page included (#183) — the second found by
 * auditing the first as a category. Two rules, one blind spot: the set is named once and read
 * by both, and a pass that wants a different one has to say so out loud.
 */
function userFacingCopy(work, { pages = null, descriptions = null, verbs = null, help = null } = {}) {
  // The three sources are injectable so the self-test can assert the SHAPE of what this
  // assembles without spawning thirty-six help screens. That is not a convenience: the
  // corpus check that existed before this read `userFacingPages()` and `advertisedVerbSet()`
  // — the INGREDIENTS — and a sweep that deleted either half from this function left both
  // rules reading half a corpus with every fixture still green. A guarantee about a set has
  // to be asserted against the thing that builds the set.
  const readPage = (rel) => readFileSync(join(ROOT, rel), "utf8");
  const readHelp = help ?? ((verb) => helpFor(work, verb));
  const sources = (pages ?? userFacingPages()).map((rel) => [rel, readPage(rel)]);
  // npm's one-line description, which is what SEARCH shows and what the sidebar of every
  // dependent package shows — copy a reader meets before opening the README that is already
  // here. A set built from files could never notice a string that is not one.
  // [Codex review R3 P2.]
  sources.push(...(descriptions ?? [...publishedPackageDescriptions(), ...siteCopyStrings()]));
  sources.push(["asterism --help", readHelp("")]);
  for (const verb of verbs ?? [...advertisedVerbSet(work)].sort()) {
    sources.push([`asterism ${verb} --help`, readHelp(verb)]);
  }
  return sources;
}

/**
 * Golden rule 7: public copy sells the behavioural outcome, not the architecture.
 * `scripts/lib/copy-vocabulary.mjs` holds the word list, the senses each word is still
 * allowed in, and the reasons; this is the corpus and the exemption.
 *
 * The corpus is the point here for the second time. A guard for exactly this already existed
 * and was already named "public copy" — `help.test.ts` refused five words in `USAGE`,
 * `AUTONOMY_HELP` and `COMMAND_HELP`, and read nothing else — so `kernel` sat in eight
 * passages of published copy, including the site's own front page, where it could not see
 * them.
 *
 * The safety case is exempt BY NAME rather than by the corpus stopping short of it, which is
 * the difference between a decision and an accident; see `VOCABULARY_EXEMPT_PAGES`.
 */
function checkCopyVocabulary(sources, packageNames = publishedPackageNames()) {
  const found = [];
  for (const [label, text] of sources) {
    if (isVocabularyExempt(label)) continue;
    for (const leak of vocabularyLeaks(text, { packageNames, kind: sourceKind(label) })) {
      found.push(`${label}:${leak.line} [${leak.word}] ${leak.sentence}\n      → ${leak.instead}`);
    }
  }
  return found;
}

/**
 * A URL path under the site's root → the landing page that serves it, or undefined.
 *
 * `<root>/x/` is served by `<dir>/x/index.html`, `<root>/x.html` by `<dir>/x.html`, and
 * `<root>/` by `<dir>/index.html` — the same directory-URL shapes mkdocs uses, applied to
 * a directory copied verbatim rather than rendered.
 */
/**
 * Every path under the site's root that serves a FILE rather than a page — the screenshots,
 * the stylesheet, the logo.
 *
 * A link into this site can name one of these, and until it could the answer was "no
 * published page builds that URL": an absolute link to a screenshot the site really serves
 * was reported BROKEN. That is the failure this file's header calls the worse one, because
 * a green over a dead link merely misses something, while a red over a live one gets the
 * live one "fixed". It is also the shape most likely to arrive next — the npm page can only
 * write an image as a whole URL, for exactly the reason its text links are whole URLs.
 *
 * Both halves are DERIVED and served at different roots: mkdocs copies `docs_dir` under
 * `site_url`, the workflow copies the landing directory into the artifact root one level
 * above it. Keyed by the path a URL asks for, so a lookup is an exact mapping rather than
 * a name match.
 *
 * …and then what the workflow DELETES is taken back out. Assembling the artifact has three
 * steps, not two, and reading only the first two makes `/asterism/README.md` — a maintainer
 * note the workflow removes by name — read as a file the site serves. A false green over a
 * 404 is precisely what this lookup was added to stop producing, arriving one step later.
 * Applied HERE rather than in either half's reader because a removal is written in artifact
 * paths, which is what these keys already are, and can name either half.
 */
function servedAssets(
  { docsPrefix, siteRoot } = landingPrefixes(),
  dir = siteDir(),
  docsAssets = publishedAssets(),
  landingRoot = readLandingDir(readFileSync(join(ROOT, ".github", "workflows", "docs.yml"), "utf8")),
  landingAssets = landingFiles(),
  removed = readLandingRemovals(readFileSync(join(ROOT, ".github", "workflows", "docs.yml"), "utf8")),
) {
  const served = new Map();
  const under = docsPrefix.slice(siteRoot.length);
  for (const rel of docsAssets) served.set(`${under}${rel.slice(`${dir}/`.length)}`, rel);
  for (const rel of landingAssets) served.set(rel.slice(`${landingRoot}/`.length), rel);
  // A removed DIRECTORY takes everything beneath it, so this is a path-prefix test and not
  // a set difference: `rm -rf _site/drafts` deletes every file under it, and each one would
  // otherwise stay in this map on its own name.
  for (const key of [...served.keys()]) {
    if (removed.some((gone) => key === gone || key.startsWith(`${gone}/`))) served.delete(key);
  }
  return served;
}

/**
 * A path under the site's root → the published markdown page mkdocs builds into it, or
 * undefined.
 *
 * The URL segment and the source directory are two different names, so the served path is
 * TRANSLATED rather than assumed to match: a `docs_dir` rename must not silently stop
 * resolving anything.
 *
 * Shared by the two passes that resolve a site URL — the root page's host-relative links
 * and a markdown page's absolute ones. They were one rule written twice for about ten
 * minutes, which is how long it took to notice that a second copy of this is a second
 * place for a `docs_dir` rename to be missed.
 *
 * `dir` and `directoryUrls` are parameters and not just `siteDir()`/`usesDirectoryUrls()`
 * because each was UNKILLABLE otherwise: this repo publishes `docs/` at `…/docs/` with
 * mkdocs' default URL shape, so a reader and a constant give the same answer and no fixture
 * built on this repo could tell them apart. A comment claiming a rename is handled, over a
 * line no test can break, is the shape this file has already paid for more than once.
 */
function publishedPageFor(
  pathPart,
  published,
  { docsPrefix, siteRoot, dir = siteDir(), directoryUrls = usesDirectoryUrls() },
) {
  // Resolved through the tree mkdocs BUILDS, rather than by stripping whichever suffix a
  // URL happens to carry. Both halves of that stripping were wrong, in opposite
  // directions, and each wrong one reports a dead link as resolving — the single failure
  // mode this pass exists to remove. MEASURED by building a fixture site both ways:
  //
  //   use_directory_urls: true    concepts.md → concepts/index.html   (concepts.html 404s)
  //   use_directory_urls: false   concepts.md → concepts.html         (concepts/ 404s)
  //   either                      index.md    → index.html
  //
  // So the question is not "which suffix does this URL have" but "does the file this URL
  // asks for exist in that tree" — one comparison that cannot be right in one direction
  // and backwards in the other.
  const served = docsPrefix.slice(siteRoot.length);
  const within = pathPart.startsWith(served)
    ? pathPart.slice(served.length)
    : `${pathPart}/` === served
      ? ""
      : undefined;
  if (within === undefined) return undefined;
  // What the request asks a static host for. A bare path gets both readings because a host
  // answers it either way — a redirect to the directory, or the flat file beside it.
  const wanted =
    within === "" || within.endsWith("/")
      ? [`${within}index.html`]
      : /\.html$/.test(within)
        ? [within]
        : [`${within}/index.html`, `${within}.html`];
  // One `prefix` for both the boundary test and the slice. Written as `startsWith(dir + "/")`
  // beside `slice(dir.length + 1)` they are two spellings of one number, which is a thing to
  // keep in agreement rather than a thing that cannot disagree.
  const prefix = `${dir}/`;
  for (const rel of published) {
    if (!rel.startsWith(prefix)) continue;
    const stem = rel.slice(prefix.length).replace(/\.md$/, "");
    // An index page is built at its own name under either setting; every other page is
    // built at whichever name this site serves.
    const built =
      stem === "index" || stem.endsWith("/index")
        ? `${stem}.html`
        : directoryUrls
          ? `${stem}/index.html`
          : `${stem}.html`;
    if (wanted.includes(built)) return rel;
  }
  return undefined;
}

function landingPageFor(dir, pages, pathPart) {
  const rel = pathPart.replace(/^\/+/, "").replace(/\/$/, "");
  const candidates = rel === "" ? ["index.html"] : [rel, `${rel}/index.html`, `${rel}.html`];
  return candidates.map((c) => `${dir}/${c}`).find((c) => pages.includes(c));
}

/** Every `id` an HTML page gives an element, for resolving a link's `#fragment`. */
function idsIn(text) {
  return new Set(
    [...text.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => attrOf(m[0], "id")).filter((v) => v !== undefined),
  );
}

/** `site_url` → the origin and the two prefixes the root page's links are read against. */
function landingPrefixes() {
  const { origin, path: docsPrefix } = siteUrlParts();
  return { origin, docsPrefix, siteRoot: docsPrefix.replace(/[^/]+\/$/, "") };
}

/**
 * Every link on the site's root page that points INTO this site, resolved against the pages
 * mkdocs actually builds.
 *
 * The markdown link pass cannot see these: they are `href` attributes, and they are absolute
 * SITE paths (`/asterism/docs/walkthrough/`) rather than the repo-relative `./x.md` a
 * markdown page uses. Same failure if one goes wrong — a 404 — on the page that gets there
 * first.
 *
 * Three destinations, told apart rather than lumped together:
 *
 *   - `/asterism/docs/<page>/` — this repo's. Resolved to a published page, and its `#anchor`
 *     is judged by the site's own renderer, because that is what serves it.
 *   - `/asterism/` and `/asterism/index.html` — this page itself.
 *   - anything else beginning `/` — the ORG site (`/`, `/manifesto`, `/lodestar/`), which
 *     lives in another repo. Counted and named as undecidable rather than guessed at, the
 *     way the markdown pass already treats a link it cannot follow. Guessing here would
 *     either invent failures or, worse, report a green over links nothing looked at.
 */
function checkLandingLinks(
  pages = publishedLandingPages().map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")]),
  published = new Set(publishedPages()),
  // Both prefixes are DERIVED. `site_url` says where the built docs are served
  // (`/asterism/docs/`); the workflow puts the landing page in the artifact ROOT, one level
  // above the directory mkdocs builds into — so the site's root is that path with its last
  // segment dropped. A hard-coded `/asterism/` would be the one undeclared constant in a
  // module built on derivation, and wrong it fails SILENTLY: every link falls through to
  // "not ours", and this reports that all zero of them resolve. A parameter so the
  // self-test can point a deliberately wrong prefix at the real page and see that happen.
  { origin, docsPrefix, siteRoot } = landingPrefixes(),
  // The directory the workflow DECLARES, not one inferred from the corpus. Inferring it as
  // the deepest shared directory is only right when some page sits at its top level: a site
  // whose pages all live under `landing/en/` infers `landing/en`, and then
  // `/asterism/en/about.html` maps to `landing/en/en/about.html` and is reported broken —
  // the same failure the commit before this one fixed, re-introduced one level up, with the
  // authoritative answer already in hand.
  landingRoot = readLandingDir(readFileSync(join(ROOT, ".github", "workflows", "docs.yml"), "utf8")),
  assets = servedAssets({ docsPrefix, siteRoot }, siteDir(), undefined, landingRoot),
) {
  const broken = [];
  const offSite = [];
  let checked = 0;
  const landingPages = pages.map(([rel]) => rel);
  const bodyOf = new Map(pages);
  const landingIndex = `${landingRoot}/index.html`;

  for (const [rel, text] of pages) {
    // `<a href>` only. A `<link rel="icon" href="/favicon.svg">` is an ASSET request, served
    // by whoever owns the apex, and listing eleven of those as links-we-cannot-decide buries
    // the eight navigation links that genuinely are.
    // Both quotings, and `href` only as its OWN attribute: `\bhref=` also matches
    // `data-href=`, because `-` is not a word character — which would report an author's
    // private attribute as a page link. A single-quoted `href` is the mirror failure and
    // the worse one, since an unmatched link is silently unchecked rather than loudly wrong.
    for (const m of text.matchAll(/<a\b([^>]*)>/gi)) {
      let href = attrOf(m[1], "href");
      if (href === undefined) continue;
      // A whole URL naming THIS site is the same link written the long way, and it went
      // unchecked by BOTH passes: this one skips anything with a scheme, and the markdown
      // pass never reads HTML on a page it does not consider markdown. Found by asking
      // where else the shape the npm page needed could hide — this page already writes its
      // own `canonical` and `og:url` that way. Normalized to the path so one rule decides.
      if (origin && (href === origin || href.startsWith(`${origin}/`))) {
        href = href.slice(origin.length) || "/";
      }
      if (EXTERNAL_TARGET.test(href) || href.startsWith("mailto:") || href.startsWith("#")) continue;
      if (!href.startsWith("/")) continue; // a relative asset (logo.png) — not a page link
      const line = text.slice(0, m.index).split("\n").length;
      const at = `${rel}:${line}`;
      if (!href.startsWith(siteRoot)) {
        offSite.push(`${at}  ${href} — served by the org site, which is not in this repo`);
        continue;
      }
      const [pathPart, fragment] = href.slice(siteRoot.length).split("#");
      // Which landing page does this URL name? The directory is copied into the artifact
      // ROOT, so a path under the site's root IS the path under that directory — an exact
      // mapping, not a name match.
      //
      // ⚠ Matching on BASENAME was wrong, and quietly: git's `landing/*.html` pathspec
      // matches nested paths (measured), so `landing/blog/index.html` can exist alongside
      // `landing/index.html`. `/asterism/` would then have resolved to whichever sorted
      // first — checking a fragment against the wrong page's ids — and
      // `/asterism/blog/post.html` would have matched no basename at all and been reported
      // broken on a correct link.
      const landingTarget = landingPageFor(landingRoot, landingPages, pathPart);
      if (landingTarget) {
        // ⚠ A link to THIS page resolves nothing and must not be counted: `checked === 0`
        // is the only tripwire for a moved site, and a page whose in-site links are all
        // `/asterism/` would otherwise satisfy it while resolving nothing. An earlier
        // version counted it, and the fixture that claimed otherwise was vacuous — it
        // planted a page named `<planted>`, which no URL can name.
        if (landingTarget !== rel) checked++;
        if (fragment) {
          // From the CORPUS, not from disk: `pages` already holds every landing page's
          // text, and re-reading meant this could only ever run against files that exist —
          // so a planted fixture could not exercise it at all.
          const body = bodyOf.get(landingTarget) ?? "";
          const where = landingTarget === rel ? "this page" : landingTarget;
          if (!idsIn(body).has(fragment)) broken.push(`${at}  ${href} — ${where} has no element with that id`);
        }
        continue;
      }
      checked++;
      const target = publishedPageFor(pathPart, published, { docsPrefix, siteRoot });
      if (!target) {
        const asset = assets.get(pathPart);
        if (asset) {
          if (fragment) offSite.push(`${at}  ${href} — a fragment into ${asset}, which is not a page`);
          continue;
        }
        broken.push(`${at}  ${href} — the site serves no page or file at that URL`);
        continue;
      }
      if (fragment) {
        // Judged by the site's renderer, because a site URL is only ever served by it.
        const ids = anchorsOf(readFileSync(join(ROOT, target), "utf8"), MKDOCS_RULE);
        if (!ids.has(fragment)) broken.push(`${at}  ${href} — ${target} has no heading with that id`);
      }
    }
  }
  // `checked` is reported rather than judged here: a page whose only links go to the org
  // site legitimately checks zero, and that is a real shape (the self-test plants it). It
  // is the REAL root page reaching zero that means the prefix is wrong, so the caller — the
  // one that knows it is looking at the real site — makes that call.
  return { broken, offSite, checked, siteRoot };
}

/**
 * Every link a markdown page makes into this repo's OWN site, written as a whole URL.
 *
 * The markdown link pass cannot decide these and does not try: anything carrying a URI
 * scheme is somebody else's to serve. But `https://qmilab.com/asterism/docs/concepts/` is
 * not somebody else's — it is `docs/concepts.md` in this repo, reached the long way round,
 * and it goes stale exactly like a relative link does. A renamed page or a reworded
 * heading 404s a reader who arrived through it.
 *
 * These are written the long way for a reason, so this is not a shape to discourage. The
 * page npm shows for `@qmilab/asterism` is read on npm, where a relative `./docs/x.md`
 * resolves against the REPOSITORY rather than the site — the one case the markdown pass
 * calls genuinely undecidable. Writing the whole URL is the fix for that, and it moved
 * every one of that page's links out of reach of every check at once. Hence this pass.
 *
 * Three destinations, told apart the way the root page's pass tells them apart:
 *
 *   - under `<site_url>` — a published page, its `#anchor` judged by the site's renderer.
 *   - under the site's root but above the docs — the hand-written landing page, its
 *     `#anchor` judged against the ids in its HTML.
 *   - the same host, outside this site (`/manifesto`, `/lodestar/`) — the org site, which
 *     lives in another repo. Named as undecidable rather than guessed at.
 *
 * A different host is not reported at all: nodejs.org is not a claim this repo can check,
 * and listing every one of them would bury the ones that are.
 */
function checkSiteLinks(
  pages = linkSourceFiles().map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")]),
  published = new Set(publishedPages()),
  // DERIVED from `site_url`, both halves, for the reason `siteUrlParts` gives: a wrong
  // prefix here fails silently, sending every link to "not ours" and reporting a green
  // over nothing. A parameter so the self-test can drive a fixture site.
  { origin, path: docsPrefix } = siteUrlParts(),
  landingPages = publishedLandingPages(),
  landingRoot = readLandingDir(readFileSync(join(ROOT, ".github", "workflows", "docs.yml"), "utf8")),
  readPage = (rel) => readFileSync(join(ROOT, rel), "utf8"),
  dir = siteDir(),
  directoryUrls = usesDirectoryUrls(),
  assets = servedAssets({ docsPrefix, siteRoot: docsPrefix.replace(/[^/]+\/$/, "") }, dir),
) {
  const siteRoot = docsPrefix.replace(/[^/]+\/$/, "");
  const broken = [];
  const offSite = [];
  let checked = 0;

  for (const [rel, text] of pages) {
    for (const { target, line } of linkTargets(text)) {
      if (target === null) continue;
      let url;
      // Which targets are this pass's own is decided by the PARSE, not by a second copy of
      // the other pass's filter: only an absolute URL parses with no base, so a relative
      // path, an in-page `#anchor` and a `mailto:` all fall out here, and a scheme this is
      // not a resolver for falls out on the origin below.
      try {
        url = new URL(target);
      } catch {
        // Not an absolute URL, so it cannot name this site: a relative path, an in-page
        // `#anchor`, a `mailto:`, a protocol-relative `//host/x`. The first two belong to
        // the markdown pass; the rest name a host, and nothing here can resolve a host.
        continue;
      }
      if (url.origin !== origin) continue;
      const at = `${rel}:${line}`;
      // `https://host/asterism` and `https://host/asterism/` name the same page. Without
      // this the bare form falls out of the site entirely and is reported as the ORG
      // site's — a wrong answer that reads like a deliberate one.
      const path = `${url.pathname}/` === siteRoot ? siteRoot : url.pathname;
      if (!path.startsWith(siteRoot)) {
        offSite.push(`${at}  ${target} — served by the org site, which is not in this repo`);
        continue;
      }
      const pathPart = path.slice(siteRoot.length);
      const fragment = decodeURIComponent(url.hash.slice(1));
      checked++;
      const landingTarget = landingPageFor(landingRoot, landingPages, pathPart);
      if (landingTarget) {
        if (fragment && !idsIn(readPage(landingTarget)).has(fragment)) {
          broken.push(`${at}  ${target} — ${landingTarget} has no element with that id`);
        }
        continue;
      }
      const page = publishedPageFor(pathPart, published, { docsPrefix, siteRoot, dir, directoryUrls });
      if (!page) {
        const asset = assets.get(pathPart);
        if (asset) {
          // The file resolving IS the claim. A `#fragment` into one is a viewer's business
          // — `#page=2` in a PDF — and nothing here can adjudicate it, so it is named as
          // undecidable rather than passed over, the same treatment the markdown pass gives
          // a fragment into a file it cannot read headings out of.
          if (fragment) offSite.push(`${at}  ${target} — a fragment into ${asset}, which is not a page`);
          continue;
        }
        broken.push(`${at}  ${target} — the site serves no page or file at that URL`);
        continue;
      }
      if (fragment && !anchorsOf(readPage(page), MKDOCS_RULE).has(fragment)) {
        // The site's renderer, because a site URL is only ever served by it — even when
        // the page WRITING the link is one GitHub renders.
        broken.push(`${at}  ${target} — ${page} has no heading with that id`);
      }
    }
  }
  return { broken, offSite, checked };
}

/** The `white-space` values that keep BOTH the line breaks and the column alignment. */
const PRESERVING = new Set(["pre", "pre-wrap", "break-spaces"]);

/**
 * The `white-space` an element ends up with, from a page's own inline stylesheet.
 *
 * "Does the stylesheet mention this class near a `white-space`" is not the question, and
 * answering that one was wrong in three ways at once — every one of them a FALSE PASS, so
 * the check reported a page as fine while it rendered as a run-on paragraph:
 *
 *   - `.terminal .comment { white-space: pre }` — a rule for a DESCENDANT. This page already
 *     has two such rules (`.asterism__terminal .comment`, `… .keyword`), so putting a
 *     `white-space` in either would have satisfied the gate outright.
 *   - `.terminal-wrap { … }` — a different class that merely starts with the same letters,
 *     because `\b` matches before a hyphen.
 *   - `@media print { .terminal { white-space: pre } }` — conditional, and not what the page
 *     renders as by default.
 *
 * So this reads rules rather than text: top-level rules only, in document order, and one
 * applies when the RIGHTMOST compound of one of its selectors is satisfied by this element.
 * A compound carrying anything this cannot evaluate — a pseudo-class, an attribute, an id —
 * is skipped rather than guessed at, which keeps the failure on the side of reporting.
 */
function whiteSpaceFor(css, classes, tag) {
  let winner = null; // { important, spec: [classes, types], order, value }
  let skipped = false;
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  let order = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
    // A STATEMENT at-rule (`@import url(…);`, `@charset "utf-8";`) ends in a semicolon and
    // has no block. Read naively it becomes part of the NEXT rule's selector text, which
    // then starts with `@` and is skipped — so one `@import` at the top of a stylesheet
    // silently hid the rule below it and this reported a correctly-rendering block.
    const semi = text.indexOf(";", i);
    if (semi !== -1 && semi < open && text.slice(i, semi).trim().startsWith("@")) {
      i = semi + 1;
      continue;
    }
    const selectorList = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    // An at-rule's whole block is skipped: `@media`/`@supports` declarations are
    // conditional, and the question here is what the page renders as by default.
    if (!selectorList.startsWith("@")) {
      // TOP-LEVEL declarations only. CSS nesting puts a whole rule inside a rule, and
      // reading the brace-matched body whole attributed a nested `& .comment { white-space:
      // normal }` to the outer selector — failing a page that renders correctly, or, with
      // the declarations the other way round, passing one that does not.
      let declared = "";
      let important = false;
      for (const m of topLevelOf(text.slice(open + 1, j - 1)).matchAll(/white-space:\s*([a-z-]+)\s*(!\s*important)?/gi)) {
        declared = m[1].toLowerCase();
        important = Boolean(m[2]);
      }
      if (declared) {
        order++;
        const applicable = applicableSpecificities(selectorList, classes, tag);
        for (const spec of applicable) {
          if (!winner || beats({ important, spec, order }, winner)) winner = { important, spec, order, value: declared };
        }
        // A `white-space` on a selector that NAMES this element but that this deliberately
        // does not evaluate — an ancestor constraint, a pseudo-class, an attribute. Not the
        // same as no rule at all; see `preserved` at the call site. A rule declaring no
        // `white-space` is not this case, which is why the test sits inside `if (declared)`.
        if (applicable.length === 0 && mentions(selectorList, classes, tag)) skipped = true;
      }
    }
    i = j;
  }
  return { value: winner ? winner.value : "", skipped };
}

/** The declarations at a rule's own level, with any nested rule's body removed. */
function topLevelOf(body) {
  let out = "";
  let depth = 0;
  for (const ch of body) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/**
 * Does this selector list SAY something about an element with these classes and this tag,
 * whether or not the rule could be evaluated?
 *
 * Only used to tell "no rule found" from "a rule was skipped". The difference matters for a
 * `<pre>`, whose exemption rests on the browser's default applying — and a
 * `.wrapper .terminal { white-space: normal }` that this deliberately does not evaluate
 * would otherwise leave the exemption in place over a block that renders as one paragraph.
 */
function mentions(selectorList, classes, tag) {
  return selectorList.split(",").some((selector) => {
    const named = [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    if (named.some((name) => classes.includes(name))) return true;
    return selector.trim().split(/[\s>+~]+/).some((c) => c && c.replace(/\.[\w-]+/g, "").trim().toLowerCase() === tag);
  });
}

/**
 * Does this declaration win over the current best? `!important` first — it outranks every
 * ordinary declaration whatever its specificity, which is exactly how a `* { white-space:
 * normal !important }` collapses a block a class rule says to preserve — then specificity,
 * then position in the file.
 */
function beats({ important, spec: [classesA, typesA], order }, { important: impB, spec: [classesB, typesB], order: orderB }) {
  if (important !== impB) return important;
  if (classesA !== classesB) return classesA > classesB;
  if (typesA !== typesB) return typesA > typesB;
  return order >= orderB;
}

/**
 * Every specificity at which this selector list applies to an element with these classes
 * and this tag — empty when it does not apply at all.
 *
 * Specificity is why this returns a weight rather than a boolean. The cascade is not
 * document order: `.terminal { white-space: pre }` beats a later `pre { white-space:
 * normal }`, because a class outranks a type. Resolving by order alone got both directions
 * wrong — reporting a page that renders correctly, and passing one the browser collapses,
 * which is the shipped defect this check exists for. It only became reachable when
 * element-only selectors started being evaluated, one commit earlier.
 *
 * Only a SINGLE compound is evaluated. `.wrapper .terminal { … }` applies to this block
 * only if an ancestor carries `.wrapper`, which nothing here can know — and treating the
 * rightmost compound as the whole selector said it applies. Anything with a combinator is
 * therefore not evaluated, which keeps the failure on the side of reporting, the same
 * stance taken for a pseudo-class, an attribute or an id.
 */
function applicableSpecificities(selectorList, classes, tag) {
  const out = [];
  for (const selector of selectorList.split(",")) {
    const compound = selector.trim();
    if (!compound || /[\s>+~]/.test(compound)) continue; // an ancestor constraint this cannot evaluate
    if (/[:[#]/.test(compound)) continue; // a condition this cannot evaluate
    const named = [...compound.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    const element = compound.replace(/\.[\w-]+/g, "").trim();
    // A type selector is case-INSENSITIVE in HTML, where a class selector is not.
    if (element && element !== "*" && element.toLowerCase() !== tag) continue;
    if (named.length === 0 && !element) continue; // an empty compound constrains nothing
    if (!named.every((name) => classes.includes(name))) continue;
    out.push([named.length, element && element !== "*" ? 1 : 0]);
  }
  return out;
}

/**
 * A multi-line terminal block whose class does not preserve newlines.
 *
 * This is the one defect on the site's root page that no check of its CONTENT could ever
 * see, and it is the one that shipped: `.asterism__terminal` is a `<div>` and carried
 * `overflow-x: auto` but no `white-space`, so every newline in the quickstart collapsed to
 * a space and eleven commands rendered as a single run-on paragraph. Every text-level
 * check read the page as correct — the commands were all there, in order, and the new
 * command pass typed all nine of them at the binary and they all ran. What the reader met
 * was unreadable and uncopyable.
 *
 * So the check is structural rather than visual: a block this file has already decided is a
 * terminal, whose text spans more than one line, must be given a `white-space` that keeps
 * those lines apart. `pre-line` is not enough — it preserves newlines but collapses runs of
 * spaces, and these blocks align flags in columns.
 *
 * It reads the page's own inline `<style>`, which is where the CSS is by design: the landing
 * page is deliberately self-contained (see `landing/README.md` — linking the apex's
 * hash-named stylesheet would break on every org-site rebuild). If that ever stops being
 * true this stops being able to answer, so it says which rule it could not find rather than
 * passing quietly.
 */
function checkTerminalRendering(
  pages = publishedLandingPages().map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")]),
) {
  const gaps = [];
  for (const [rel, text] of pages) {
    const styles = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
    for (const block of terminalBlocks(text, true)) {
      if (!block.text.includes("\n")) continue; // a one-line block cannot lose a line break
      const classes = block.className.trim().split(/\s+/).filter(Boolean);
      const inline = [...block.inlineStyle.matchAll(/white-space:\s*([a-z-]+)/gi)].pop()?.[1]?.toLowerCase();
      const sheet = whiteSpaceFor(styles, classes, block.tag);
      const declared = inline ?? sheet.value;
      // Declaring nothing is fine for a `<pre>` and only for a `<pre>`: it gets
      // `white-space: pre` from the browser's own stylesheet, where a `<div>` gets
      // `normal` and collapses. But that default is only a default — `pre { white-space:
      // normal }` collapses a `<pre>` exactly as the published `<div>` collapsed, so the
      // exemption is "nothing overrides it", not "it is a `<pre>`". Exempting the tag
      // outright would have let this check pass the very defect it exists for.
      // "No rule found" and "a rule was skipped" are not the same thing, and only the first
      // justifies leaning on the browser's default for a `<pre>`. A
      // `.wrapper .terminal { white-space: normal }` is deliberately not evaluated — this
      // cannot see ancestors — and treating that as "nothing declared" left the `<pre>`
      // exempt over a block that renders as one paragraph, which is the false pass the
      // exemption's own comment says it must not create.
      const preserved = declared === "" ? block.tag === "pre" && !(inline === undefined && sheet.skipped) : PRESERVING.has(declared);
      if (!preserved) {
        gaps.push(
          `${rel}:${block.startLine} — a ${block.text.split("\n").length}-line terminal block in` +
            ` \`${block.className}\`, and nothing in the page's CSS gives that class a` +
            ` \`white-space\` that keeps the lines apart. It renders as one paragraph.`,
        );
      }
    }
  }
  return gaps;
}

/**
 * The falsification. One planted line per defect class this exists to catch — if a
 * clean run cannot be told apart from a broken one, the clean run proves nothing.
 */
function plantedFailures() {
  return [
    { file: "<planted>", line: 1, command: "asterism bogusverb writer" },
    { file: "<planted>", line: 2, command: "asterism api remove writer issues orders" },
    { file: "<planted>", line: 3, command: "asterism connections nosuchagent" },
    { file: "<planted>", line: 4, command: "asterism capabilities show writer --nosuchflag" },
    { file: "<planted>", line: 5, command: "asterism api remove <agent> <name> <name>..." },
    {
      file: "<planted>",
      line: 7,
      // A variadic synopsis for a verb that accepts no list. Typed with real witnesses
      // this is refused; typed with the literal `...` left on, it used to slip through
      // as a merely-semantic error.
      command: "asterism capabilities unset <agent> <key>...",
    },
    {
      file: "<planted>",
      line: 6,
      command: "asterism handoff writer nosuchagent x",
      prompted: true,
      // The page claims one refusal; the binary gives another. This is the shape that
      // ships advice for a recovery the code will not perform.
      shown: ["No active handoff connection from writer to nosuchagent. Open one first: asterism connect writer nosuchagent --mode handoff"],
    },
  ];
}

preflight();
try {
  ({ AsterismStore, CONNECTION_MODES } = await import(CORE));
  MODEL_CONFIG = await import(MODEL_CONFIG_DIST);
  CAPABILITIES = await import(CAPABILITIES_DIST);
} catch (err) {
  // Present but unloadable — the classic case is a `better-sqlite3` built for a different
  // Node ABI. Name the cause; the raw error alone sends people hunting a code regression.
  console.error(
    `packages/core/dist/index.js is present but could not be loaded.\n` +
      `The usual cause is a native module built for a different runtime — rebuild with:\n` +
      `  bun install --force && bun run build\n\n${err}`,
  );
  process.exit(2);
}
main();
