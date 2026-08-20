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
  publishedPackagesWithoutReadme,
  readSiteConfig,
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
  const open = /<(div|pre)\b[^>]*class="([^"]*terminal[^"]*)"[^>]*>/gi;
  for (const m of text.matchAll(open)) {
    const tag = m[1].toLowerCase();
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
      className: m[2],
      startLine: text.slice(0, m.index).split("\n").length,
      // Inline markup inside a terminal block is presentation (a `<span class="comment">`
      // around a shell comment); the command is what is left once it is gone.
      text: decodeEntities(text.slice(from, end).replace(/<[^>]+>/g, "")),
    });
  }
  return blocks;
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
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * A page in the corpus whose markup this extractor found no terminal block in at all. For
 * markdown that is ordinary — most pages have no fenced block — so only the HTML pages are
 * reported, because there the answer "none" means "the class this looks for is not the
 * class the page uses" far more often than it means "this page shows no commands".
 */
function blocklessPages() {
  return publishedLandingPages().filter(
    (rel) => terminalBlocks(readFileSync(join(ROOT, rel), "utf8"), true).length === 0,
  );
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
    for (const m of text.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)) {
      marks.push([text.slice(0, m.index).split("\n").length, `## ${decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim()}`]);
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
 * A real install for one page, carrying every agent, file and record that page's
 * examples name but do not create for themselves. `skipAgents` are the ones the page
 * teaches you to create — seeding those would make the page's own `new` line fail.
 */
function buildFixture(skipAgents = new Set(), skipConnections = false) {
  const work = mkdtempSync(join(tmpdir(), "asterism-docs-"));
  // Through `runBinary`, so a fixture command gets the same timeout and the same refusal to
  // read a killed child. A non-zero exit still throws: a fixture that half-built is worse
  // than one that stops, because every page checked against it would be checked against a
  // state the docs never describe.
  const q = (args, input) => {
    const r = runBinary(args, { cwd: work, input: input ?? "", where: "while building a page's fixture install" });
    if (r.code !== 0) {
      throw new Error(`fixture command \`asterism ${args.join(" ")}\` exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
    }
    return r.stdout;
  };

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
  // Through `runBinary`, so a fixture command gets the same timeout and the same refusal to
  // read a killed child. A non-zero exit still throws: a fixture that half-built is worse
  // than one that stops, because every page checked against it would be checked against a
  // state the docs never describe.
  const q = (args, input) => {
    const r = runBinary(args, { cwd: work, input: input ?? "", where: "while building a page's fixture install" });
    if (r.code !== 0) {
      throw new Error(`fixture command \`asterism ${args.join(" ")}\` exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
    }
    return r.stdout;
  };

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
    }), stderr: "" };
  } catch (e) {
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
  return err.status === null && err.signal != null;
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
 * Every internal link a file makes, in every form these pages actually use: markdown
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
 */
function* internalLinks(text) {
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
      if (!EXTERNAL_TARGET.test(parsed.dest)) yield { target: parsed.dest, line: i + 1 };
      at = line.indexOf("](", parsed.end);
    }
    const ref = refDef.exec(line);
    const targets = [
      ...[...line.matchAll(htmlAttr)].map((m) => m[1] ?? m[2] ?? m[3]),
      ...(ref ? [ref[1]] : []),
    ];
    for (const target of targets) if (!EXTERNAL_TARGET.test(target)) yield { target, line: i + 1 };
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
  const at = (i) => `${i.file}:${i.line}`;

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
  if (groups.failures.length) {
    console.log(`\nFAILED (${groups.failures.length}):`);
    for (const i of groups.failures)
      console.log(`  ${at(i)}  ${i.command}\n      ${i.why}${i.detail ? `\n      → ${i.detail}` : ""}`);
  }

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
      if (terminalBlocks(readFileSync(join(ROOT, page), "utf8"), true).length === 0) {
        scopeFailures.push(`  ${page} is read, but no terminal block was found in it — it is checked for nothing`);
      }
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
      ['<a href="/asterism/docs/nosuchpage/">a</a>', "a page nothing builds", 1, 0],
      ['<a href="/asterism/docs/walkthrough/#claim-1-separate-memory">a</a>', "a heading that exists", 0, 0],
      ['<a href="/asterism/docs/walkthrough/#no-such-heading">a</a>', "a heading that does not", 1, 0],
      ['<a href="/manifesto">a</a>', "a page on the org site", 0, 1],
      ['<a href="https://github.com/qmilab/asterism">a</a>', "an external link", 0, 0],
      ['<a href="logo.png">a</a>', "a relative asset", 0, 0],
      ['<a href="#top">a</a>', "an in-page anchor", 0, 0],
      ["<a href='/asterism/docs/nosuchpage/'>a</a>", "a SINGLE-quoted href at a URL nothing builds", 1, 0],
      ["<a href='/asterism/docs/walkthrough/'>a</a>", "a single-quoted href that resolves", 0, 0],
      ['<a data-href="/asterism/docs/nosuchpage/" href="/asterism/docs/walkthrough/">a</a>', "a `data-href` beside a real one — only the real one is a link", 0, 0],
      ['<link rel="icon" href="/favicon.svg" />', "a favicon, which is an asset and not a link", 0, 0],
      ['<link rel="stylesheet" href="/asterism/docs/nosuchpage/" />', "a stylesheet at a URL no page builds", 0, 0],
    ];
    const linkFailures = [];
    for (const [html, why, wantBroken, wantOffSite] of linkFixture) {
      const got = checkLandingLinks([["<planted>", html]]);
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
    const wrong = checkLandingLinks(realPages, realPublished, { docsPrefix: "/elsewhere/docs/", siteRoot: "/elsewhere/" });
    if (wrong.checked !== 0) {
      linkFailures.push(`  a wrong prefix over the real page still checked ${wrong.checked} links`);
    }
    // …and everything it could not check is ACCOUNTED FOR rather than dropped, which is
    // what makes `checked === 0` at the call site a reliable signal that the prefix moved.
    if (wrong.offSite.length !== right.checked + right.offSite.length) {
      linkFailures.push(
        `  under a wrong prefix ${wrong.offSite.length} links were set aside, where the page has` +
          ` ${right.checked + right.offSite.length} absolute links in all`,
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
          "asterism notes set writer sigil &quot;&amp;gt; means redirect&quot;</div>",
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

      const html = extract("page.html", exDir);
      const htmlWant = [
        // The opening tag shares its line with the first command, which is exactly the
        // shape that makes line numbers easy to get wrong by one.
        { line: 2, command: "asterism new writer --trust autonomous", section: "## Quickstart" },
        { line: 4, command: 'asterism run writer "tidy posts/" > out.txt', section: "## Quickstart" },
        { line: 5, command: 'asterism notes set writer sigil "&gt; means redirect"', section: "## Quickstart" },
        { line: 7, command: "asterism memory inspect writer", section: "## Later" },
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

  const undocumented = SELF_TEST ? [] : checkCommandCoverage(coverageWork);
  if (undocumented.length) {
    console.log(
      `\nUNDOCUMENTED COMMANDS (${undocumented.length}) — \`${join(siteDir(), "commands.md")}\` claims` +
        ` to document every command, and has no section for:`,
    );
    for (const v of undocumented) console.log(`  asterism ${v}`);
  } else if (!SELF_TEST) {
    console.log("Every command in `asterism --help` has a section in the command reference.");
  }

  const links = SELF_TEST ? { broken: [], unchecked: [], links: 0, files: 0 } : checkLinks();
  if (links.broken.length) {
    console.log(`\nBROKEN INTERNAL LINKS (${links.broken.length}):`);
    for (const b of links.broken) console.log(`  ${b}`);
  } else if (!SELF_TEST) {
    // The numbers are the point. "Every internal doc link resolves" was true of a pass
    // that had looked at a fraction of them; saying how many were read, and out of what,
    // is what stops the sentence from outgrowing the check again.
    console.log(linkSummary(links));
  }
  if (links.unchecked.length) {
    console.log(`\nINTERNAL LINKS THIS PASS CANNOT DECIDE (${links.unchecked.length}):`);
    for (const u of links.unchecked) console.log(`  ${u}`);
  }

  // A published package with NO README is the one gap the scope rule above cannot see: a
  // set built from the files that exist can never notice a file that does not, so a blank
  // npm page for something people install would just be one fewer page to check.
  const readmeless = SELF_TEST ? [] : publishedPackagesWithoutReadme();
  if (readmeless.length) {
    console.log(
      `\nPUBLISHED PACKAGES WITH NO README (${readmeless.length}) — npm renders a package's page` +
        ` from its README, and shows only the one-line description without one:`,
    );
    for (const dir of readmeless) console.log(`  ${dir}`);
  } else if (!SELF_TEST) {
    console.log("Every package this repo publishes to npm has a README, and it is checked above.");
  }

  const providerGaps = SELF_TEST ? [] : checkProviderCoverage();
  if (providerGaps.length) {
    console.log(
      `\nPROVIDER TABLE OUT OF DATE (${providerGaps.length}) — \`${join(siteDir(), "models.md")}\` claims` +
        ` to list every built-in provider and the variable it reads:`,
    );
    for (const g of providerGaps) console.log(`  ${g}`);
  } else if (!SELF_TEST) {
    console.log("Every built-in provider appears in the models page, with the key it reads.");
  }

  const catalogGaps = SELF_TEST ? [] : checkToolCatalog();
  if (catalogGaps.length) {
    console.log(
      `\nPARTIAL TOOL CATALOG (${catalogGaps.length}) — a page presenting the tools an agent is` +
        ` given names some of them and not the rest:`,
    );
    for (const g of catalogGaps) console.log(`  ${g}`);
  } else if (!SELF_TEST) {
    console.log(
      `Every page naming a catalog tool names all ${catalogToolNames().length} the CLI ships.`,
    );
  }

  // A page in the corpus whose terminal blocks this could not find at all. Reported rather
  // than counted as zero: for the HTML half the answer "no commands" is far more often "the
  // markup changed" than it is true, and a checker reading nothing while printing a green
  // total is the exact failure this file has now paid for twice.
  const landingLinks = SELF_TEST ? { broken: [], offSite: [], checked: 1 } : checkLandingLinks();
  if (landingLinks.checked === 0) {
    // Zero over the REAL root page, which is full of absolute links, means they no longer
    // begin with the prefix `site_url` derives — so every one went to the undecidable pile,
    // which is printed but does not fail the build. The self-test proves this is reachable
    // by pointing a wrong prefix at the real page and watching `checked` go to zero.
    console.log(
      `\nNOT ONE LINK ON THE SITE'S ROOT PAGE WAS CHECKED — none of them begins with` +
        ` \`${landingLinks.siteRoot}\`, the path derived from \`site_url\`. Either the site moved` +
        ` or the page's links did; nothing here was looked at.`,
    );
  }
  if (landingLinks.broken.length) {
    console.log(`\nBROKEN LINKS ON THE SITE'S ROOT PAGE (${landingLinks.broken.length}):`);
    for (const b of landingLinks.broken) console.log(`  ${b}`);
  } else if (!SELF_TEST) {
    console.log(
      `All ${landingLinks.checked} links from the site's root page into this site resolve to a` +
        ` page mkdocs builds, headings included.`,
    );
  }
  if (landingLinks.offSite.length) {
    console.log(
      `\nLINKS FROM THE ROOT PAGE THIS PASS CANNOT DECIDE (${landingLinks.offSite.length}):`,
    );
    for (const u of landingLinks.offSite) console.log(`  ${u}`);
  }

  const renderGaps = SELF_TEST ? [] : checkTerminalRendering();
  if (renderGaps.length) {
    console.log(
      `\nTERMINAL BLOCK RENDERS AS ONE PARAGRAPH (${renderGaps.length}) — its lines are` +
        ` correct and its markup collapses them:`,
    );
    for (const g of renderGaps) console.log(`  ${g}`);
  } else if (!SELF_TEST) {
    console.log("Every multi-line terminal block on the site's root page keeps its line breaks.");
  }

  const blockless = SELF_TEST ? [] : blocklessPages();
  if (blockless.length) {
    console.log(
      `\nNO TERMINAL BLOCK FOUND (${blockless.length}) — this page is published at the site's root` +
        ` and its commands are read from an element whose class names a terminal; nothing here` +
        ` matched, so this page is being checked for nothing:`,
    );
    for (const rel of blockless) console.log(`  ${rel}`);
  }

  rmSync(coverageWork, { recursive: true, force: true });
  if (
    groups.failures.length ||
    links.broken.length ||
    undocumented.length ||
    readmeless.length ||
    providerGaps.length ||
    catalogGaps.length ||
    landingLinks.broken.length ||
    landingLinks.checked === 0 ||
    renderGaps.length ||
    blockless.length
  ) {
    process.exit(1);
  }
  console.log(
    `Every command those ${sourceFiles().length} pages advertise runs, or matches the binary's own help.`,
  );
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
  for (const m of text.matchAll(/<code[^>]*>([^<]+)<\/code>/g)) spans.add(decodeEntities(m[1]).trim());
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

/** `site_url` → the two prefixes the root page's links are read against. */
function landingPrefixes() {
  const docsPrefix = siteUrlPath();
  return { docsPrefix, siteRoot: docsPrefix.replace(/[^/]+\/$/, "") };
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
  { docsPrefix, siteRoot } = landingPrefixes(),
) {
  const broken = [];
  const offSite = [];
  let checked = 0;

  for (const [rel, text] of pages) {
    // `<a href>` only. A `<link rel="icon" href="/favicon.svg">` is an ASSET request, served
    // by whoever owns the apex, and listing eleven of those as links-we-cannot-decide buries
    // the eight navigation links that genuinely are.
    // Both quotings, and `href` only as its OWN attribute: `\bhref=` also matches
    // `data-href=`, because `-` is not a word character — which would report an author's
    // private attribute as a page link. A single-quoted `href` is the mirror failure and
    // the worse one, since an unmatched link is silently unchecked rather than loudly wrong.
    for (const m of text.matchAll(/<a\b[^>]*?[\s"']href=("([^"]*)"|'([^']*)')/gi)) {
      const href = decodeEntities(m[2] ?? m[3] ?? "");
      if (EXTERNAL_TARGET.test(href) || href.startsWith("mailto:") || href.startsWith("#")) continue;
      if (!href.startsWith("/")) continue; // a relative asset (logo.png) — not a page link
      const line = text.slice(0, m.index).split("\n").length;
      const at = `${rel}:${line}`;
      if (!href.startsWith(siteRoot)) {
        offSite.push(`${at}  ${href} — served by the org site, which is not in this repo`);
        continue;
      }
      const [pathPart, fragment] = href.slice(siteRoot.length).split("#");
      const bare = pathPart.replace(/\/$/, "").replace(/\.html$/, "");
      checked++;
      if (bare === "" || bare === "index") continue; // this page itself
      // mkdocs' directory URLs: `<site_url>x/` is built from `<docs_dir>/x.md`, and
      // `<site_url>` itself from `<docs_dir>/index.md`. The URL segment and the source
      // directory are two different names, so the served path is translated rather than
      // assumed to match: a `docs_dir` rename must not silently stop resolving anything.
      const served = docsPrefix.slice(siteRoot.length).replace(/\/$/, "");
      const rel2 = bare === served ? siteDir() : bare.startsWith(`${served}/`) ? `${siteDir()}/${bare.slice(served.length + 1)}` : bare;
      const candidates = [`${rel2}.md`, `${rel2}/index.md`];
      const target = candidates.find((c) => published.has(c));
      if (!target) {
        broken.push(`${at}  ${href} — no published page builds that URL`);
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
  let value = "";
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
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
    if (!selectorList.startsWith("@") && selectorApplies(selectorList, classes, tag)) {
      // Last declaration wins, which is what the cascade does among rules of equal
      // specificity — so a later `white-space: normal` correctly undoes an earlier `pre`.
      for (const m of text.slice(open + 1, j - 1).matchAll(/white-space:\s*([a-z-]+)/g)) value = m[1];
    }
    i = j;
  }
  return value;
}

/** Does any selector in this list apply to an element with these classes and this tag? */
function selectorApplies(selectorList, classes, tag) {
  return selectorList.split(",").some((selector) => {
    const compounds = selector.trim().split(/[\s>+~]+/).filter(Boolean);
    const last = compounds[compounds.length - 1] ?? "";
    if (!last || /[:[#]/.test(last)) return false; // a condition this cannot evaluate
    const named = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    if (named.length === 0) return false;
    const element = last.replace(/\.[\w-]+/g, "").trim();
    if (element && element !== "*" && element !== tag) return false;
    // Every class the compound demands must be on the element — `.a.b` does not apply to
    // an element carrying only `a`.
    return named.every((name) => classes.includes(name));
  });
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
      // `<pre>` gets `white-space: pre` from the browser's own stylesheet, so it needs no
      // declaration and reporting one would be a defect this manufactures. Only `<div>`,
      // which is what the page uses and what silently collapsed, has to say so.
      if (block.tag !== "div") continue;
      const classes = block.className.trim().split(/\s+/).filter(Boolean);
      const preserved = PRESERVING.has(whiteSpaceFor(styles, classes, block.tag));
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
