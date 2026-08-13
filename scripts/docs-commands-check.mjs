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

import { execFileSync } from "node:child_process";
import { AsterismStore } from "../packages/core/dist/index.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "packages", "cli", "dist", "bin.js");
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
  const docs = readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join("docs", f));
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
  [
    /^Run failed: No API key for provider:/,
    "needs-model",
    "no provider API key is present in a checker",
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
  if (skipConnections) return;
  if ((name === "writer" || name === "researcher") && present.includes("writer") && present.includes("researcher")) {
    for (const mode of ["handoff", "artifact-only", "read-summary", "shared-brief"]) {
      q(["connect", "writer", "researcher", "--mode", mode]);
    }
    // A standing brief, so `unbrief` and `briefs` meet the state their examples describe.
    q(["brief", "writer", "researcher", "Q3 launch: enterprise buyers, ship by Friday"]);
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
 * Every internal link in docs/ resolves — the page exists, and the `#fragment` matches a
 * heading on it. Returns a list of broken ones.
 */
function checkLinks() {
  const pages = readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md"));
  const anchors = new Map();
  const bodies = new Map();
  for (const page of pages) {
    const text = readFileSync(join(ROOT, "docs", page), "utf8");
    bodies.set(page, text);
    anchors.set(
      page,
      new Set(text.split("\n").filter((l) => /^#{1,6}\s/.test(l)).map(anchorOf)),
    );
  }
  const broken = [];
  for (const [page, text] of bodies) {
    for (const m of text.matchAll(/\]\((\.\/)?([a-z0-9-]+\.md)?(#[^)\s]+)?\)/g)) {
      const target = m[2] ?? page;
      const frag = m[3];
      if (!frag) {
        if (m[2] && !pages.includes(m[2])) broken.push(`docs/${page} → ${m[2]} (no such page)`);
        continue;
      }
      if (!anchors.has(target)) broken.push(`docs/${page} → ${target}${frag} (no such page)`);
      else if (!anchors.get(target).has(frag.slice(1)))
        broken.push(`docs/${page} → ${target}${frag} (no such section)`);
    }
  }
  return broken;
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

  const broken = SELF_TEST ? [] : checkLinks();
  if (broken.length) {
    console.log(`\nBROKEN INTERNAL LINKS (${broken.length}):`);
    for (const b of broken) console.log(`  ${b}`);
  } else if (!SELF_TEST) {
    console.log("Every internal doc link resolves.");
  }

  rmSync(coverageWork, { recursive: true, force: true });
  if (groups.failures.length || broken.length || undocumented.length) process.exit(1);
  console.log("Every command the docs advertise runs, or matches the binary's own help.");
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

main();
