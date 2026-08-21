// The JS checkers carry a model of the documentation site: which directory it publishes,
// which pages survive `exclude_docs`, and what anchor the renderer emits for each heading.
// This asks mkdocs the same three questions and fails if the answers differ.
//
//   node scripts/mkdocs-parity-check.mjs              compare the model against mkdocs
//   node scripts/mkdocs-parity-check.mjs --self-test  prove a zero here means something
//
// WHY THIS EXISTS. `check:docs` decides which renderer serves a link — Python-Markdown for
// a published page, GitHub for everything else — and then judges the link's `#fragment` by
// that renderer's slug rule. Both halves of that are ports of somebody else's behaviour,
// and until now both were pinned by HAND: five anchor pairs copied out of a `slugify` run,
// and a `path.startsWith("docs/")` standing in for "the site publishes this". The thorough
// comparisons that justified them — 193 headings against the installed Python-Markdown,
// every pattern against what mkdocs actually excludes — ran once, in a session, and were
// never repeated. A pin is a claim about a moment; this is the check.
//
// The stake is specific. A wrong anchor port does not merely miss a defect, it MANUFACTURES
// one: an earlier version of `anchorOf` substituted whitespace singly where Python-Markdown
// collapses a run, declared four correct links dead, and the links were then "fixed" to
// agree with it — leaving CI green over pages that would 404. So the port is not verified
// against a description of the algorithm. It is verified against the renderer.
//
// WHY IT IS A SEPARATE SCRIPT. It needs Python with mkdocs installed, which `check:docs`
// deliberately does not: that check runs in the test matrix, where there is no interpreter.
// This one runs in the `docs-site` job, which already installs the exact pinned renderer
// the site is built with (`requirements-docs.txt`) — so the comparison is against the
// renderer that ships, not one resolved fresh here.
//
// WHAT IT DOES NOT COVER, said plainly rather than left to be assumed: the GitHub half.
// GitHub's slugger has no local implementation to compare against, and reading it live
// would put a network fetch inside a gate. Those ids stay hand-pinned in
// `check:docs --self-test`, from GitHub's own rendering of this repo — with the self-test
// asserting the pins COVER every heading of the file they were taken from, so a new heading
// fails rather than passing unpinned.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { anchorsOf, MKDOCS_RULE, anchorOf } from "./lib/anchors.mjs";
import {
  ROOT,
  siteDir,
  siteUrlPath,
  usesDirectoryUrls,
  publishedPages,
  readSiteConfig,
  publishedPredicate,
} from "./lib/docs-scope.mjs";

const SELF_TEST = process.argv.includes("--self-test");

/**
 * Ask mkdocs for its own model of a site: where it publishes from, which documentation
 * pages survive `exclude_docs`, and the id it emits for every heading on each of them.
 *
 * The extension list comes from `load_config`, never from reading `mkdocs.yml` here — and
 * that distinction has already cost a session once. The effective list is LONGER than the
 * file: mkdocs adds `tables` and `fenced_code` of its own, so a comparison built from the
 * config file alone renders against an extension set the site never uses.
 */
const PY_SITE_MODEL = `
import json, os, re, sys
from mkdocs.config import load_config
from mkdocs.structure.files import get_files
import markdown

config_path = sys.argv[1]
root = os.path.dirname(os.path.abspath(config_path))
cfg = load_config(config_path)
docs_dir = os.path.relpath(cfg['docs_dir'], root).replace(os.sep, '/')
pages = sorted(
    os.path.relpath(f.abs_src_path, root).replace(os.sep, '/')
    for f in get_files(cfg).documentation_pages()
)
md = markdown.Markdown(extensions=cfg['markdown_extensions'], extension_configs=cfg['mdx_configs'])
anchors = {}
for rel in pages:
    md.reset()
    with open(os.path.join(root, rel), encoding='utf-8') as fh:
        html = md.convert(fh.read())
    anchors[rel] = re.findall(r'<h[1-6][^>]*\\bid="([^"]+)"', html)
print(json.dumps({
    'docs_dir': docs_dir,
    'site_url': cfg['site_url'],
    'use_directory_urls': cfg['use_directory_urls'],
    'pages': pages,
    'anchors': anchors,
}))
`;

/**
 * The interpreter that renders the site. `.venv/` first because that is where a contributor
 * following `requirements-docs.txt` locally puts it; the bare name second because that is
 * where CI's `pip install` puts it. Refuses rather than skipping: a parity check that
 * quietly does nothing when the renderer is absent is the vacuous green this whole file
 * exists to prevent.
 */
function findPython() {
  const candidates = [join(ROOT, ".venv", "bin", "python"), "python3", "python"];
  for (const python of candidates) {
    try {
      execFileSync(python, ["-c", "import mkdocs, markdown"], { stdio: "ignore" });
      return python;
    } catch {
      /* try the next one */
    }
  }
  console.error(
    "This check compares the checkers' model of the site against mkdocs itself, and no\n" +
      "Python with mkdocs installed was found.\n" +
      "  python -m venv .venv && .venv/bin/pip install -r requirements-docs.txt\n" +
      "(CI runs this in the `docs-site` job, which installs the same pinned renderer.)",
  );
  process.exit(2);
}

function siteModel(python, configPath) {
  let out;
  try {
    out = execFileSync(python, ["-c", PY_SITE_MODEL, configPath], { encoding: "utf8" });
  } catch (err) {
    console.error(
      `mkdocs could not load ${configPath}, so there is nothing to compare against:\n` +
        `${err.stderr || err.message}`,
    );
    process.exit(2);
  }
  return JSON.parse(out);
}

/**
 * Two ordered id lists for one page → the differences, in the words a reader needs. Order
 * is compared as well as membership, because the duplicate-heading suffix (`_1`) depends on
 * the order ids are minted in, and a port that agreed as a SET while minting them in a
 * different order would give the wrong suffix to the wrong heading.
 */
function anchorDiff(want, got) {
  // The PREDICATE is this line and only this line — agreement is exact-and-in-order.
  // Everything below it explains a disagreement it has already found. Worth saying,
  // because a mutation sweep that removes the `missing`/`extra` lists changes nothing
  // about what this reports, which reads like dead code and is not: it is the difference
  // between "these ids disagree" and a message naming which.
  if (JSON.stringify(want) === JSON.stringify(got)) return null;
  const missing = want.filter((id) => !got.includes(id));
  const extra = got.filter((id) => !want.includes(id));
  if (missing.length === 0 && extra.length === 0) return ["the same ids, minted in a different order"];
  return [
    ...missing.map((id) => `the renderer emits '${id}' and this port does not`),
    ...extra.map((id) => `this port emits '${id}' and the renderer does not`),
  ];
}

/**
 * The anchor comparison, with the slug rule passed IN so `--self-test` can run it against a
 * port that is known to be wrong. A comparison only ever run against a correct port has not
 * been shown to be able to report anything.
 */
function compareAnchors(model, root, rule) {
  const failures = [];
  let headings = 0;
  for (const rel of model.pages) {
    const want = model.anchors[rel];
    headings += want.length;
    const got = [...anchorsOf(readFileSync(join(root, rel), "utf8"), rule)];
    for (const line of anchorDiff(want, got) ?? []) failures.push(`  ${rel}: ${line}`);
  }
  return { failures, headings };
}

/** The published-set comparison, with the predicate passed in for the same reason. */
function comparePages(model, mine) {
  const missing = model.pages.filter((p) => !mine.includes(p));
  const extra = mine.filter((p) => !model.pages.includes(p));
  return [
    ...missing.map((p) => `  mkdocs publishes ${p}; this repo's rule does not call it published`),
    ...extra.map((p) => `  this repo's rule calls ${p} published; mkdocs does not build it`),
  ];
}

// --------------------------------------------------------------------- self-test

/**
 * A planted site whose config exercises every `exclude_docs` shape `patternMatcher`
 * implements, checked against what mkdocs actually excludes from the same config.
 *
 * The point is the gitignore subset. It was written from the documentation of a syntax and
 * implemented by hand; mkdocs reads these with `pathspec`. Two of the cases below are the
 * ones a reimplementation gets wrong in opposite directions: a pattern with no interior
 * separator matches at ANY depth (`internal/` is not `pages/internal/`), and a pattern with
 * one does not (`notes/scratch.md` must leave `sub/notes/scratch.md` alone).
 */
const FIXTURE_EXCLUDES = ["internal/", "/root-only.md", "drafts/**", "*.draft.md", "notes/scratch.md"];
const FIXTURE_PAGES = [
  ["index.md", "published"],
  ["internal/secret.md", "a directory pattern, at the site root"],
  ["deep/internal/x.md", "the same directory pattern, further down"],
  ["root-only.md", "a pattern anchored with a leading slash"],
  ["sub/root-only.md", "the same name, where the anchored pattern must NOT reach"],
  ["drafts/a.md", "a `**` pattern"],
  ["drafts/b/c.md", "the same `**`, across a separator"],
  ["x.draft.md", "a basename glob"],
  ["sub/y.draft.md", "the same glob, at depth"],
  ["notes/scratch.md", "a pattern with an interior separator"],
  ["sub/notes/scratch.md", "the same path, where an interior separator must NOT reach"],
];

function selfTest(python) {
  const dir = mkdtempSync(join(tmpdir(), "asterism-mkdocs-parity-"));
  const failures = [];
  try {
    const configText = [
      "site_name: Parity fixture",
      "docs_dir: pages",
      "use_directory_urls: false",
      "exclude_docs: |",
      ...FIXTURE_EXCLUDES.map((p) => `  ${p}`),
      "",
    ].join("\n");
    writeFileSync(join(dir, "mkdocs.yml"), configText);
    for (const [rel] of FIXTURE_PAGES) {
      const abs = join(dir, "pages", rel);
      mkdirSync(dirname(abs), { recursive: true });
      // Two headings whose ids only agree if the space RUN left by the dropped em dash
      // collapses — the historical bug, planted on every fixture page so the deliberately
      // broken port below has something to disagree about wherever it looks.
      writeFileSync(abs, ["# A — B", "", "## Plain heading", ""].join("\n"));
    }

    const model = siteModel(python, join(dir, "mkdocs.yml"));

    // `docs_dir` is read, not assumed: a reader that ignored it would say `docs`.
    const parsed = readSiteConfig(configText);
    if (parsed.docsDir !== model.docs_dir) {
      failures.push(`  docs_dir: mkdocs says '${model.docs_dir}', this reader says '${parsed.docsDir}'`);
    }
    // The fixture config declares `use_directory_urls: false`, which is NOT mkdocs' default
    // — so this compares two readers rather than two copies of the same constant, which is
    // the whole reason the value is planted at the non-default.
    if (parsed.useDirectoryUrls !== model.use_directory_urls) {
      failures.push(
        `  use_directory_urls: mkdocs says ${model.use_directory_urls}, this reader says` +
          ` ${parsed.useDirectoryUrls}`,
      );
    }

    const published = publishedPredicate(parsed);
    const mine = FIXTURE_PAGES.map(([rel]) => `pages/${rel}`).filter(published).sort();
    const pageFailures = comparePages(model, mine);
    for (const line of pageFailures) failures.push(line);
    if (pageFailures.length === 0) {
      console.log(
        `The \`exclude_docs\` reader agrees with mkdocs on all ${FIXTURE_PAGES.length} planted paths,` +
          ` across ${FIXTURE_EXCLUDES.length} pattern shapes.`,
      );
    }

    // Now prove each comparison can REPORT. A check only ever run against a correct input
    // has not been shown to be able to fail — which is the defect this repo has shipped
    // before, in a guard no test could kill.
    const blindToExcludes = publishedPredicate({ docsDir: parsed.docsDir, exclude: [] });
    const blindPages = FIXTURE_PAGES.map(([rel]) => `pages/${rel}`).filter(blindToExcludes).sort();
    if (comparePages(model, blindPages).length === 0) {
      failures.push("  a published set that ignores `exclude_docs` entirely was reported as agreeing");
    } else {
      console.log("A published set that ignores `exclude_docs` is reported, not passed.");
    }

    // The historical anchor bug: substitute each whitespace character rather than collapsing
    // the run. `# A — B` becomes `a--b` instead of `a-b`.
    const brokenRule = {
      slug: (heading) =>
        heading
          .replace(/^#+\s*/, "")
          .normalize("NFKD")
          // eslint-disable-next-line no-control-regex
          .replace(/[^\x00-\x7F]/g, "")
          .replace(/[^\w\s-]/g, "")
          .trim()
          .toLowerCase()
          .replace(/\s/g, "-"),
      joiner: "_",
      name: "broken",
    };
    if (compareAnchors(model, dir, brokenRule).failures.length === 0) {
      failures.push("  an anchor port carrying the historical space-run bug was reported as agreeing");
    } else {
      console.log("An anchor port carrying the historical space-run bug is reported, not passed.");
    }

    // ...and the real port must still agree with the renderer on the same fixture, so the
    // two results above are not both explained by a comparison that reports everything.
    const real = compareAnchors(model, dir, MKDOCS_RULE);
    for (const line of real.failures) failures.push(line);
    if (real.failures.length === 0) {
      console.log(`The real anchor port agrees with the renderer on the fixture's ${real.headings} headings.`);
    }

    // One direct pin, so a reader can see the case in the failure above without running it.
    if (anchorOf("# A — B") !== "a-b") {
      failures.push(`  anchorOf('# A — B') is '${anchorOf("# A — B")}', and the renderer emits 'a-b'`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.log("\nSELF-TEST FAILED:");
    for (const f of failures) console.log(f);
    process.exit(1);
  }
  console.log("\nSELF-TEST PASSED: the comparison agrees where it should and reports where it should.");
}

// --------------------------------------------------------------------------- run

const python = findPython();
if (SELF_TEST) {
  selfTest(python);
} else {
  const model = siteModel(python, join(ROOT, "mkdocs.yml"));
  const failures = [];

  // `site_url` decides which absolute links on the site's ROOT page belong to this repo,
  // and its reader is the one this codebase repeatedly calls out as failing SILENTLY when
  // wrong — every link falling through to "not ours" while the pass reports that all zero
  // of them resolve. It was also the one derived value with no parity check here, under a
  // module header claiming everything derived is cross-checked against mkdocs itself.
  // mkdocs normalizes (`!ENV` resolution, a trailing slash); this compares against that.
  if (model.site_url) {
    const fromMkdocs = new URL(model.site_url).pathname.replace(/\/?$/, "/");
    if (siteUrlPath() !== fromMkdocs) {
      failures.push(
        `  siteUrlPath() is '${siteUrlPath()}' where mkdocs resolves site_url to '${fromMkdocs}'`,
      );
    }
  } else {
    failures.push("  mkdocs reports no site_url, so the site's root page has no prefix to resolve links against");
  }

  if (siteDir() !== model.docs_dir) {
    failures.push(
      `  docs_dir: mkdocs publishes '${model.docs_dir}', and the checkers read '${siteDir()}'.` +
        ` Every anchor rule turns on this.`,
    );
  }

  // `use_directory_urls` decides which URL SHAPE names a page — `x/` or `x.html` — and a
  // resolver reading it wrong accepts a URL the site answers with a 404. Same silent
  // failure as `site_url`, one level down, and this repo leaves it at mkdocs' default,
  // which is exactly the condition under which a constant and a reader look identical.
  if (usesDirectoryUrls() !== model.use_directory_urls) {
    failures.push(
      `  use_directory_urls: mkdocs serves with ${model.use_directory_urls}, and the checkers` +
        ` read ${usesDirectoryUrls()}.`,
    );
  }

  const pageFailures = comparePages(model, publishedPages());
  for (const line of pageFailures) failures.push(line);

  const { failures: anchorFailures, headings } = compareAnchors(model, ROOT, MKDOCS_RULE);
  for (const line of anchorFailures) failures.push(line);

  if (failures.length) {
    console.log(`The checkers' model of the site disagrees with mkdocs (${failures.length}):`);
    for (const f of failures) console.log(f);
    console.log(
      "\nThis is not a formatting nit. `check:docs` judges a published page's links by the" +
        "\nrule above; where the two disagree it will either miss a dead link or, worse," +
        "\nreport a live one as dead — which is how a correct link gets 'fixed' into a 404.",
    );
    process.exit(1);
  }

  console.log(`docs_dir agrees with mkdocs: ${model.docs_dir}`);
  console.log(`site_url agrees with mkdocs: ${siteUrlPath()}`);
  console.log(`use_directory_urls agrees with mkdocs: ${usesDirectoryUrls()}`);
  console.log(
    `The ${model.pages.length} pages this repo calls published are exactly the ${model.pages.length}` +
      ` mkdocs builds, \`exclude_docs\` included.`,
  );
  console.log(
    `The anchor port agrees with the site's own renderer on all ${headings} headings across` +
      ` those pages — nothing pinned by hand.`,
  );
}
