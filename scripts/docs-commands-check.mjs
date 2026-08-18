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
// It pulls every fenced `asterism …` invocation out of docs/ and README.md and sorts
// each into one of two claims, both checked against the real `packages/cli/dist/bin.js`:
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
// while CI called them green. `--self-test` now pins the port against known-good pairs,
// because a wrong anchor helper is worse than no anchor helper: it certifies the damage.
//
// The link pass RESOLVES targets rather than recognising them. The version before this one
// matched them with `[a-z0-9-]+\.md` and still printed "Every internal doc link resolves" —
// lower case, no directory, markdown only, `docs/` only. So it could not see an upper-case
// filename, any `./docs/…` link, any image, any raw HTML `href`, or any of the 56 internal
// links in README, and it counted a `# comment` inside a fenced block as a heading, which
// minted 25 anchors this repo's pages do not have and made links into them report as good.
// `mkdocs --strict` backstops only part of that: it never reads README (`docs_dir: docs`),
// and it logs a MISSING ANCHOR at INFO, so a dead `#fragment` does not fail the build.
// Measured, both of them, by planting one of each. What the pass claims is now what it did.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "packages", "cli", "dist", "bin.js");
const CORE = join(ROOT, "packages", "core", "dist", "index.js");
const MODEL_CONFIG_DIST = join(ROOT, "packages", "cli", "dist", "model-config.js");

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

function preflight() {
  const missing = [
    [BIN, "packages/cli/dist/bin.js"],
    [CORE, "packages/core/dist/index.js"],
    [MODEL_CONFIG_DIST, "packages/cli/dist/model-config.js"],
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

/** The directory this checker assumes mkdocs publishes. Asserted below, not guessed. */
const SITE_DIR = "docs";

/**
 * Three separate things here read `docs/` as "the pages mkdocs publishes": which files
 * the command pass extracts from, which files the link pass reads, and — since anchors
 * are resolved by the renderer that serves the page — WHICH ANCHOR RULE a link gets.
 *
 * None of them asks `mkdocs.yml`. If `docs_dir` ever moves, all three go on being sure
 * about a directory that is no longer the site, and the anchor rule is the one that goes
 * wrong quietly: every published page would be judged by GitHub's slug rule instead of
 * mkdocs', and the pass would keep reporting that every link resolves.
 *
 * Deriving the value into all three is a bigger change than this is worth while the
 * answer is `docs`. Making the assumption LOUD is not: an assumption a checker cannot
 * state is the same defect as a claim it cannot check, which is the whole subject of
 * this file.
 */
function assertSiteDir() {
  const config = readFileSync(join(ROOT, "mkdocs.yml"), "utf8");
  const declared = /^docs_dir:\s*(\S+)\s*$/m.exec(config)?.[1]?.replace(/^["']|["']$/g, "");
  // Absent is not a mismatch: mkdocs defaults `docs_dir` to `docs`, which is what we assume.
  if (declared !== undefined && declared !== SITE_DIR) {
    console.error(
      `mkdocs.yml publishes '${declared}', and this checker assumes '${SITE_DIR}'.\n` +
        `Three things depend on it: which files the command pass extracts from, which\n` +
        `files the link pass reads, and which anchor rule each link is judged by — a\n` +
        `page on the site uses mkdocs' slugs, anything else uses GitHub's.\n` +
        `Point SITE_DIR at '${declared}' (and re-check anchorRuleFor) before this can run.`,
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

/** Source files whose fenced blocks are checked. */
function sourceFiles() {
  const docs = readdirSync(join(ROOT, SITE_DIR))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(SITE_DIR, f));
  return [...docs, "README.md"];
}

/**
 * Every line inside a fenced block that invokes `asterism`. A `$ ` prompt is stripped,
 * as is a trailing ` # comment` — both are presentation, not part of the claim.
 */
function extract(relPath) {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  const found = [];
  let inFence = false;
  let section = "";
  text.split("\n").forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (!inFence && /^##\s/.test(raw)) section = raw.trim();
    if (!inFence) return;
    const trimmed = raw.trim();
    // A `$ ` prompt marks a line the reader is meant to TYPE; its absence, in a block
    // that carries placeholders, marks a grammar. That distinction is the classifier.
    const prompted = /^\$\s+/.test(trimmed);
    let s = trimmed.replace(/^\$\s+/, "");
    if (!/^asterism\s/.test(s)) return;
    // A trailing comment is prose. Only strip ` #` with surrounding space, so a
    // `#fragment` inside a URL or a quoted task survives.
    s = s.replace(/\s+#\s.*$/, "").trim();
    found.push({ file: relPath, line: i + 1, command: s, prompted, shown: [], section });
  });
  // The lines a block prints beneath a prompted command are its EXPECTED OUTPUT — the
  // page's claim about what the reader will see. Attach them to the command above.
  const lines = text.split("\n");
  for (const item of found) {
    if (!item.prompted) continue;
    for (let j = item.line; j < lines.length; j++) {
      const l = lines[j];
      if (l === undefined || /^\s*```/.test(l) || /^\s*\$\s/.test(l)) break;
      item.shown.push(l);
    }
    while (item.shown.length && item.shown[item.shown.length - 1].trim() === "") item.shown.pop();
  }
  return found;
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
  return env;
}
const ENV = cleanEnv();

/**
 * A real install for one page, carrying every agent, file and record that page's
 * examples name but do not create for themselves. `skipAgents` are the ones the page
 * teaches you to create — seeding those would make the page's own `new` line fail.
 */
function buildFixture(skipAgents = new Set(), skipConnections = false) {
  const work = mkdtempSync(join(tmpdir(), "asterism-docs-"));
  const q = (args, input) =>
    execFileSync(process.execPath, [BIN, ...args], {
      cwd: work,
      encoding: "utf8",
      input: input ?? "",
      env: ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });

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
  const q = (args, input) =>
    execFileSync(process.execPath, [BIN, ...args], {
      cwd: work,
      encoding: "utf8",
      input: input ?? "",
      env: ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });

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
  const out = runCommand(work, "asterism list");
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

/** `--help` for a command, cached; the top-level help under the empty key. */
const helpCache = new Map();
function helpFor(work, verb) {
  if (helpCache.has(verb)) return helpCache.get(verb);
  const args = verb ? [...verb.split(" "), "--help"] : ["--help"];
  let text = "";
  try {
    text = execFileSync(process.execPath, [BIN, ...args], {
      cwd: work,
      encoding: "utf8",
      input: "",
      env: ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    text = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
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
  const block = helpFor(work, "").split(/^Commands:$/m)[1]?.split(/^\S/m)[0] ?? "";
  const verbs = new Set();
  for (const line of block.split("\n")) {
    const m = line.match(/^\s{2}([a-z][\w-]*)\s+([a-z][\w-]*)/);
    if (m) verbs.add(m[1]);
  }
  const missed = [];
  for (const verb of [...verbs].sort()) {
    const result = runCommand(work, `asterism ${verb} __nosuch_subcommand__`);
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
function checkSynopsis(work, scratch, command) {
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
    const result = runCommand(scratch, text);
    const first = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
    if (isShapeRejection(first)) {
      return { ok: false, why: `typed as \`${text}\`, the binary rejected its shape`, detail: first };
    }
  }
  return { ok: true, exact: norm(both).includes(norm(command)), leftover };
}

function runCommand(work, command) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...argvOf(command)], {
      cwd: work,
      encoding: "utf8",
      input: "",
      env: ENV,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? -1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
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
  const help = helpFor(work, "");
  const block = help.split(/^Commands:$/m)[1]?.split(/^\S/m)[0] ?? "";
  const verbs = new Set(
    [...block.matchAll(/^\s{2}([a-z][\w-]*)/gm)].map((m) => m[1]),
  );
  const reference = readFileSync(join(ROOT, "docs", "commands.md"), "utf8");
  const documented = new Set(
    [...reference.matchAll(/^##\s+`([a-z][\w-]*)/gm)].map((m) => m[1]),
  );
  return [...verbs].filter((v) => !documented.has(v)).sort();
}

/**
 * Heading → anchor, mirroring Python-Markdown's `toc` slugify, which is what builds the
 * published site (`mkdocs.yml` configures no other). Ported line for line:
 *
 *   value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode()
 *   value = re.sub(r'[^\w\s-]', '', value).strip().lower()
 *   return re.sub(r'[-\s]+', '-', value)
 *
 * The last line is the one that matters and the one an eyeball reimplementation gets
 * wrong: `+` COLLAPSES a run. `## handoff — hand over a task` drops the em dash, leaving
 * two spaces, which collapse to ONE hyphen — `#handoff-hand-over-a-task`. A version of
 * this that substituted `\s` singly produced a double hyphen, declared the correct links
 * dead, and the links were then "fixed" to match the checker. An anchor checker that
 * disagrees with the site is worse than none: it certifies the breakage.
 */
function anchorOf(heading) {
  const text = heading
    .replace(/^#+\s*/, "")
    .replace(/`/g, "")
    .normalize("NFKD")
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\x7F]/g, "");
  return text
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-");
}

/**
 * The lines of a page that become anchors on the site — which is NOT every line starting
 * with `#`. A `# comment` inside a fenced block is shell, and the renderer emits no id for
 * it: checked against Python-Markdown with `pymdownx.superfences` loaded, the extension
 * `mkdocs.yml` actually configures, where the same input yields ids with the fence
 * extension absent and none with it present. Counting them minted 25 anchors this repo's
 * pages do not have (`#on-the-host`, `#openai_api_key`, …), each of which would have let a
 * link to a section that does not exist report as resolved.
 */
function* headingLines(text) {
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#{1,6}\s/.test(line)) yield line;
  }
}

/**
 * Heading → anchor the way GITHUB does it, which is not the way the site does it.
 *
 * The difference is the one this file has been burned by before, in the other direction:
 * Python-Markdown collapses a run of spaces to a single hyphen, GitHub replaces each
 * space one for one. So `## Contributing & security` is `#contributing-security` on the
 * site and `#contributing--security` on GitHub, because dropping the `&` leaves two
 * spaces. Thirteen headings in this repo's root markdown differ between the two rules.
 *
 * Taken from GitHub's own rendering of this repo rather than from a description of the
 * algorithm — see GITHUB_ANCHOR_PAIRS in the self-test, which pins every anchor GitHub
 * emits for README. Duplicates get `-1`, `-2` here, not the `_1` Python-Markdown uses.
 */
function githubAnchorOf(heading) {
  return heading
    .replace(/^#+\s*/, "")
    .replace(/`/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * Which anchor rule serves a link — decided by where the link is CLICKED, which is where
 * the page MAKING it is published, not by the page it points at.
 *
 * A `docs/` page is published on the site, so a `docs/` → `docs/` fragment must be the
 * anchor mkdocs emits: a GitHub-only form is dead for every reader of the published page,
 * and `mkdocs --strict` will not say so, because it logs a missing anchor at INFO. Every
 * other combination is only ever followed on GitHub — the repo root is not on the site at
 * all (`docs_dir: docs`), and a `docs/` page pointing outside `docs/` has already left it.
 *
 * The first version of this keyed on the TARGET and accepted EITHER rule for a `docs/`
 * page, reasoning that both renderers serve it. Both do render it — but a link is
 * followed in one place, and accepting the union let a fragment that is dead on the
 * published site pass as resolved. Reachable somewhere is not the same as reachable from
 * the page that makes the claim.
 */
function anchorRuleFor(sourceRel, targetRel) {
  const inDocs = (p) => p.startsWith(`${SITE_DIR}/`) || p.startsWith(`${SITE_DIR}${sep}`);
  return inDocs(sourceRel) && inDocs(targetRel)
    ? { slug: anchorOf, joiner: "_", name: "mkdocs" }
    : { slug: githubAnchorOf, joiner: "-", name: "github" };
}

/**
 * A page's anchors under one rule. Each renderer also guarantees ids are UNIQUE — a
 * repeated heading gets a suffix, `_1`/`_2` under Python-Markdown and `-1`/`-2` under
 * GitHub. Verified against both renderers, not assumed. This repo has no duplicate
 * heading today, which is exactly why it is worth handling now: the first one added would
 * otherwise have its correct link reported dead, and this pass has already taught us once
 * that a link declared dead gets "fixed" to agree with the checker.
 */
function anchorsOf(text, { slug, joiner }) {
  const ids = new Set();
  for (const line of headingLines(text)) {
    const base = slug(line);
    let id = base;
    for (let n = 1; ids.has(id); n++) id = `${base}${joiner}${n}`;
    ids.add(id);
  }
  return ids;
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
 * The markdown this repo publishes: `docs/` and the repo root. Derived from git rather
 * than a readdir, because the root also holds a contributor's PRIVATE notes — `ROADMAP.md`
 * and friends are gitignored — and a gate that fails on files the repo does not ship is a
 * gate people learn to skip.
 *
 * Deliberately not a package's own README, nor `decisions/`: their relative links resolve
 * against a different base (npm renders the package README against GitHub), and a claim
 * this pass cannot check is a claim it must not make. The report names the set it read.
 */
function linkSourceFiles() {
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch (err) {
    // Not a fallback — a readdir here would gate on a contributor's private notes, and
    // an empty list would let this pass report a green zero over nothing at all. Say why
    // it stopped, because `spawnSync git ENOENT` reads like a broken checkout.
    console.error(
      "The link pass lists the markdown this repo ships by asking git, and git did not" +
        ` answer here (${err.message}). Run this from a git checkout with git available.`,
    );
    process.exit(2);
  }
  return tracked
    .split("\0")
    .filter(Boolean)
    .filter((p) => p.startsWith(`${SITE_DIR}/`) || !p.includes("/"))
    .sort();
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
  const where = `internal links in the ${files} docs/ and root markdown files`;
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
          const verdict = checkSynopsis(work, scratch, command);
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

        const result = runCommand(work, command);
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
    `\n${total} invocations in docs/ and README.md — ` +
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
    // The anchor port is checked against pinned pairs taken from a real
    // Python-Markdown `slugify` run, because getting it wrong is SILENT and worse than
    // having no checker: an anchor helper that disagrees with the site reports the
    // correct links as dead, and "fixing" them to agree breaks the published page.
    // Every pair below has an em dash or punctuation — the cases an eyeball
    // reimplementation gets wrong.
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
    console.log(
      `GitHub anchor slugify matches every id GitHub emits for README` +
        ` (${GITHUB_ANCHOR_PAIRS.length} headings).`,
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
      `\nUNDOCUMENTED COMMANDS (${undocumented.length}) — \`docs/commands.md\` claims to` +
        ` document every command, and has no section for:`,
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

  const providerGaps = SELF_TEST ? [] : checkProviderCoverage();
  if (providerGaps.length) {
    console.log(
      `\nPROVIDER TABLE OUT OF DATE (${providerGaps.length}) — \`docs/models.md\` claims to list` +
        " every built-in provider and the variable it reads:",
    );
    for (const g of providerGaps) console.log(`  ${g}`);
  } else if (!SELF_TEST) {
    console.log("Every built-in provider appears in the models page, with the key it reads.");
  }

  rmSync(coverageWork, { recursive: true, force: true });
  if (
    groups.failures.length ||
    links.broken.length ||
    undocumented.length ||
    providerGaps.length
  ) {
    process.exit(1);
  }
  console.log("Every command the docs advertise runs, or matches the binary's own help.");
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
  const page = join(ROOT, "docs", "models.md");
  if (!existsSync(page)) return ["docs/models.md is missing"];
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
assertSiteDir();
try {
  ({ AsterismStore, CONNECTION_MODES } = await import(CORE));
  MODEL_CONFIG = await import(MODEL_CONFIG_DIST);
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
