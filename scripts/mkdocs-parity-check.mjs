// The JS checkers carry a model of the documentation site: which directory it publishes,
// which pages survive `exclude_docs`, what anchor the renderer emits for each heading, and
// what TEXT of a page a reader actually meets. This asks mkdocs the same four questions and
// fails if the answers differ.
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
// THE FOURTH QUESTION is the same treatment applied to the repo's OTHER port of this
// renderer. `scripts/lib/copy-text.mjs` decides what a reader meets — fences, spans,
// comments, `<style>`, tags, attributes, character references, link destinations, and where
// a block ends — for the two rules that read what the copy SAYS. Nothing asked the renderer
// whether it was right, and it drew 26 review findings across ten rounds of inspection while
// the last five of those rounds found no live instance at all. Replaying thirteen of its
// historical bugs: EIGHT are now reported here, five only by `check:docs --self-test`, none
// by neither.
//
// WHY IT IS A SEPARATE SCRIPT. It needs Python with mkdocs installed, which `check:docs`
// deliberately does not: that check runs in the test matrix, where there is no interpreter.
// This one runs in the `docs-site` job, which already installs the exact pinned renderer
// the site is built with (`requirements-docs.txt`) — so the comparison is against the
// renderer that ships, not one resolved fresh here.
//
// WHAT IT DOES NOT COVER, said plainly rather than left to be assumed.
//
//   · The GitHub half of the ANCHOR rule. GitHub's slugger has no local implementation to
//     compare against, and reading it live would put a network fetch inside a gate. Those
//     ids stay hand-pinned in `check:docs --self-test`, from GitHub's own rendering of this
//     repo — with the self-test asserting the pins COVER every heading of the file they were
//     taken from, so a new heading fails rather than passing unpinned.
//   · The GitHub half of the COPY rule, for the same reason and with a measurement: 9 of the
//     24 pages a user meets are `README.md` and the eight package READMEs, and rendering
//     README.md with Python-Markdown disagrees with the masking in 41 places — all of them
//     one construct GitHub renders and Python-Markdown does not. A proxy renderer that is
//     measurably not the renderer would red a correct page.
//   · The 47 sources of that corpus that are not pages at all — help screens, npm
//     descriptions, `mkdocs.yml` strings. Nothing renders them; a terminal prints them.
//     Their masking is checked by `check:docs --self-test`, where a plain-text row's answer
//     can only be written by hand because there is no renderer to ask.
//   · Text the masking KEEPS and the renderer does not show. That direction is not an
//     equality and never will be: `alt`, `title`, `aria-label` and a `<meta>` description
//     are kept on purpose, because a screen reader reads the first and a search result
//     prints the last. Five of the thirteen replayed bugs are of that kind, and all five
//     are caught by `check:docs --self-test` instead.
//   · Which KIND a page is read as. Sending `landing/index.html` through the markdown
//     renderer instead of taking it as HTML changes none of its visible words — measured —
//     so nothing here would notice that distinction going wrong. `check:docs --self-test`
//     carries rows for all three kinds and does notice.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { anchorsOf, MKDOCS_RULE, anchorOf } from "./lib/anchors.mjs";
import { blank, readerText } from "./lib/copy-text.mjs";
import {
  ROOT,
  siteDir,
  siteUrlPath,
  usesDirectoryUrls,
  publishedPages,
  publishedLandingPages,
  userFacingPages,
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

// ------------------------------------------------------- what a reader actually meets

/**
 * The visible text of a page, from the renderer that serves it.
 *
 * `scripts/lib/copy-text.mjs` answers one question for two rules — *would a reader meet
 * these characters?* — and it answers it by hand: fenced blocks, inline spans, HTML
 * comments, `<style>`, `<script>`, tags, quoted and unquoted attributes, character
 * references, markdown link destinations, and the block/inline distinction that decides
 * whether a blank line ends a paragraph. It is a port of the same renderer `anchors.mjs`
 * ports, and until now nothing asked the renderer whether it was right: it drew 26 review
 * findings across ten rounds of INSPECTION, the last five of which found no live instance
 * at all, while the two real defects of that stretch came from counting the corpus.
 *
 * So this is the anchor rule's treatment applied to the other port. Python renders the
 * source and `html.parser` — standard library, no dependency — reads the text back out.
 * The parser is the point: it already knows that a comment is invisible, that a `<script>`
 * body is not copy, that `>` inside a quoted attribute does not end a tag, that an
 * unquoted attribute is still an attribute, and that `&#110;` is the letter `n`. Every one
 * of those is a branch the JS implements by hand, and each is a branch that has been wrong.
 *
 * It renders TEXT rather than reading paths, so a construct fixture goes through exactly
 * the path a page does.
 */
const PY_VISIBLE_TEXT = `
import json, sys
from html.parser import HTMLParser
from mkdocs.config import load_config
import markdown

class Visible(HTMLParser):
    """Every character a reader meets, and nothing else.

    Comments, doctypes and processing instructions are dropped by not handling them.
    A <script> or <style> body arrives through handle_data like any other text — the
    tokenizer switches to CDATA mode, it does not hide it — so it is skipped by hand.
    Attributes never reach handle_data at all, which is why this is one direction only:
    the JS deliberately keeps alt, title, aria-label and a <meta> description, and a
    reader meets those without viewing source.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ('script', 'style') and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


cfg = load_config(sys.argv[1])
md = markdown.Markdown(extensions=cfg['markdown_extensions'], extension_configs=cfg['mdx_configs'])
out = {}
for source in json.load(sys.stdin):
    if source['kind'] == 'html':
        html = source['text']
    else:
        md.reset()
        html = md.convert(source['text'])
    parser = Visible()
    parser.feed(html)
    parser.close()
    out[source['label']] = ''.join(parser.parts)
print(json.dumps(out))
`;

/**
 * `{label, kind, text}[]` → `{label: visible text}`, straight from the renderer.
 *
 * The label is the key on the way back, so two sources sharing one would quietly become a
 * single entry — and the second would then be compared against the first's rendering. A
 * missing key throws on the next line; a merged one does not, which is why only this
 * direction needs saying out loud.
 */
function renderedText(python, configPath, sources) {
  const labels = new Set(sources.map(({ label }) => label));
  if (labels.size !== sources.length) {
    console.error(
      `Two of the ${sources.length} sources handed to the renderer share a label, so one` +
        ` would be compared against the other's rendering.`,
    );
    process.exit(2);
  }
  let out;
  try {
    out = execFileSync(python, ["-c", PY_VISIBLE_TEXT, configPath], {
      input: JSON.stringify(sources),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(
      `The renderer could not be asked what these pages show, so there is nothing to compare` +
        ` the masking against:\n${err.stderr || err.message}`,
    );
    process.exit(2);
  }
  return JSON.parse(out);
}

/**
 * Every word a piece of text contains, COUNTED.
 *
 * Counted rather than merely collected, and the difference is most of the sensitivity: a
 * word that a page uses in prose AND inside a fence is still present as a set when the
 * masking stops reading fences. Measured, on a masking that has stopped reading fences: 68
 * words fall short across the real pages, and only 12 of them are missing outright. A set
 * comparison would report those 12 and pass the other 56.
 *
 * A word is a run of letters or digits, so `kernel-box`, `snake_case` and `22.19` are read
 * the same way on both sides. That is what lets the two be compared at all: the rules
 * downstream substitute markup for spaces, and a comparison over raw strings would report
 * every emphasis mark as a difference.
 */
function wordCounts(text) {
  const counts = new Map();
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0].toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/**
 * The comparison: every word the renderer SHOWS, the masking must KEEP.
 *
 * One direction, deliberately. The other is not an equality and never will be — the JS
 * keeps `alt`, `title`, `aria-label` and a `<meta>` description on purpose, because a
 * screen reader reads the first and a search result prints the last, and none of them is
 * text `html.parser` returns. What this direction catches is the failure that has actually
 * happened: the port erasing words a reader meets, which is a rule reporting a clean page
 * forever.
 *
 * The masking is passed IN, for the reason `compareAnchors` takes its slug rule: a
 * comparison only ever run against a correct port has not been shown to be able to report
 * anything.
 */
function compareCopy(sources, rendered, mask) {
  const failures = [];
  let words = 0;
  for (const { label, kind, text } of sources) {
    const shown = wordCounts(rendered[label]);
    const kept = wordCounts(mask(text, kind));
    for (const [word, n] of shown) {
      words += n;
      const have = kept.get(word) ?? 0;
      if (have >= n) continue;
      failures.push(
        `  ${label}: the renderer shows '${word}' ${n}\u00d7 and the masking keeps ${have}\u00d7` +
          `\n      around it: ${excerpt(rendered[label], word)}`,
      );
    }
  }
  return { failures, words };
}

/** The rendered text around a word, so a report says where to look rather than only what. */
function excerpt(text, word, width = 48) {
  const flat = text.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(word);
  if (at < 0) return JSON.stringify(flat.slice(0, width * 2));
  const from = Math.max(0, at - width);
  const to = Math.min(flat.length, at + word.length + width);
  return `${from > 0 ? "…" : ""}${JSON.stringify(flat.slice(from, to))}${to < flat.length ? "…" : ""}`;
}

/**
 * Constructs the corpus does not contain, so the comparison is not limited to what someone
 * has already written.
 *
 * This is the half the corpus cannot do, and the split was measured rather than assumed.
 * Replaying thirteen of the masking's historical bugs as mutations, the 15 real pages report
 * TWO on their own — a fence that stops being a fence, and a code span that closes at the
 * first backtick it meets. The rows below take that to EIGHT. The remaining five are of a
 * kind this comparison cannot see at all, and the module header says which.
 *
 * That is the measurement the issue behind this pass carried, from the other side: the last
 * five review rounds hardened this parser against inputs the corpus does not contain, and
 * each new branch was itself new surface.
 *
 * The rows are INPUTS, not expectations. Nothing here says what the answer should be; the
 * renderer says, the same renderer that serves the site. So a row can be incomplete but it
 * cannot be wrong — which is the whole difference between this table and the 81 vocabulary
 * rows in `check:docs --self-test`, where a hand-written expectation pins what the RULE
 * decides.
 *
 * Every row is a construct where the renderer SHOWS something. A construct where it hides
 * text cannot fail this direction, and a row that cannot fail is a row that proves nothing —
 * so the pairs are not here: the inline comment across a blank line is, its ordinary
 * block-level twin is not. `--self-test` asserts that each of these really can be reported.
 *
 * `plain` sources — a help screen, an npm description — have no row and can have none: no
 * renderer stands between them and the reader, so there is nothing to ask.
 */
const COPY_FIXTURES = [
  ["an inline comment that spans a blank line, where the markers stop being markers",
    "markdown", "A claim <!--\nnote\n\nzebra\n--> unless allowed."],
  ["a tag split by a blank line, inside a code span",
    "markdown", 'Type `<div\n\nclass="zebra-box">` here.'],
  ["a fenced block showing a tag and a comment",
    "markdown", '```html\n<div class="zebra-box"><!-- quokka --></div>\n```'],
  ["a tilde fence, which is a fence too",
    "markdown", '~~~html\n<div class="zebra-box"></div>\n~~~'],
  ["an inline code span that wraps across a line",
    "markdown", "Write `<!-- the\nzebra -->` at the top."],
  // Two rows, because a double-backtick span has been got wrong in two ways and each shape
  // survives the other's fixture. Measured, not assumed: a matcher that closes at the FIRST
  // backtick it meets leaves the first row's comment bare and pairs the second row's inner
  // backticks correctly; one that closes at the next run of ANY length does the reverse.
  ["a double-backtick span with no backtick inside it",
    "markdown", "Write ``the <!-- zebra --> marker`` here."],
  ["a double-backtick span whose inner backticks are literal",
    "markdown", "Write ``a `x<!-- zebra -->` c`` here."],
  ["an autolink, whose URL is its own visible text",
    "markdown", "See <https://example.test/zebra-path> for detail."],
  ["an escaped bracket, which is not a link",
    "markdown", "A \\[zebra](./quokka.md) stays on the page."],
  ["a `](` with no bracket opening it",
    "markdown", "[first](./a.md) then ](./zebra.md) literally."],
  ["a reference link whose label is its visible text, and one with no definition",
    "markdown", "See [zebra][] and [quokka] here.\n\n[zebra]: ./a.md"],
  ["a decimal character reference inside a word",
    "markdown", "The ze&#98;ra decides."],
  ["a hexadecimal character reference inside a word",
    "markdown", "The ze&#x62;ra decides."],
  ["a link destination shown inside a fence",
    "markdown", "```\n[x](./zebra.md)\n```"],
  ["a reference link shown inside a code span",
    "markdown", "Write `[x][zebra]` to reuse it."],
  ["a stylesheet shown inside a fence",
    "markdown", "```html\n<style>.zebra { color: red }</style>\n```"],
  ["a script holding a backtick, then prose, on the hand-written page",
    "html", "<script>const label = `zebra`;</script>\n<p>Quokka runs alone.</p>"],
  ["prose after an inlined stylesheet, on the hand-written page",
    "html", "<style>.zebra-box { color: red }</style>\n<p>Quokka runs alone.</p>"],
];

/** The fixtures as sources, labelled so a failure quotes the construct rather than an index. */
function fixtureSources() {
  return COPY_FIXTURES.map(([what, kind, text]) => ({ label: `a fixture that is ${what}`, kind, text }));
}

/**
 * The pages whose renderer this repo can actually ask: the ones mkdocs builds, and the
 * hand-written HTML the site serves at its root.
 *
 * Derived from both sides — mkdocs' own page list and the workflow's landing directory —
 * intersected with the copy corpus, so neither half can drift.
 *
 * The rest of that corpus is NOT covered here, and the reason is the one this file's header
 * already gives for GitHub's slugger: `README.md` and the eight package READMEs are rendered
 * by GitHub and npm, which have no local implementation to compare against. That is not a
 * guess about how different they are — rendering README.md with Python-Markdown disagrees
 * with the masking in 41 places, every one of them from a single construct GitHub renders
 * and Python-Markdown does not (markdown inside a raw `<div>` block, which is how the badges
 * and the wordmark are laid out). A proxy renderer that is measurably not the renderer would
 * red a correct page, which this repo has already paid for once.
 */
function copySources(model, pages = userFacingPages(), landing = publishedLandingPages()) {
  const served = pages.filter((rel) => model.pages.includes(rel) || landing.includes(rel));
  if (served.length === 0) {
    // Not "nothing to check". Every page falling out of this set is what a `docs_dir` move
    // looks like, and a pass reading no pages reports a zero forever — the failure this
    // whole file exists to make impossible.
    console.error(
      "None of the pages a user meets is served by a renderer this check can ask, so the\n" +
        "comparison below would pass by reading nothing. Either mkdocs builds no page in the\n" +
        "copy corpus, or the site's root directory moved.",
    );
    process.exit(2);
  }
  return served.map((rel) => ({
    label: rel,
    kind: rel.endsWith(".html") ? "html" : "markdown",
    text: readFileSync(join(ROOT, rel), "utf8"),
  }));
}

/** The masking as it ships — the composition both rules call, not one assembled here. */
const REAL_MASK = (text, kind) => readerText(text, { kind });

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

/**
 * Ports that are wrong in the ways a port of this renderer gets wrong, so that a zero from
 * `compareCopy` means the comparison looked rather than that it cannot see.
 *
 * Each is the real masking with ONE belief taken away, and each belief is one the JS holds
 * by hand and has held wrongly at some point: that a fence is a picture of markup rather
 * than markup, that a comment stops being a comment when a blank line lands inside it, that
 * `<` only ever opens a tag, that `[` only ever opens a link, that `&#98;` is a letter, and
 * that a `<script>` ends where its closing tag says it does.
 */
const BROKEN_MASKS = [
  ["reads a fenced block and a code span as markup rather than as a picture of it",
    (text, kind) => readerText(text.replace(/`+/g, blank), { kind })],
  ["blanks every comment, whether or not the renderer still reads it as one",
    (text, kind) => readerText(text, { kind }).replace(/<!--[\s\S]*?-->/g, blank)],
  ["blanks every angle-bracketed run, whether or not it is a tag",
    (text, kind) => readerText(text, { kind }).replace(/<[^>]*>/g, blank)],
  ["blanks every bracketed label and every `](…)` payload, whether or not it is a link",
    (text, kind) =>
      readerText(text, { kind })
        .replace(/\[[^\]\n]*\]/g, blank)
        .replace(/\]\([^)\n]*\)/g, blank)],
  ["blanks a character reference instead of decoding it to the letter it stands for",
    (text, kind) => readerText(text.replace(/&#?\w+;/g, blank), { kind })],
  ["lets a `<script>` or a `<style>` swallow everything after it",
    (text, kind) => readerText(text.replace(/<(?:script|style)\b[\s\S]*$/i, blank), { kind })],
];

/**
 * The copy comparison's own falsification, in three parts, because a green from it can be
 * vacuous in three different ways.
 *
 * 1. Every broken port above must be REPORTED by the fixtures. A comparison that cannot
 *    report a class of defect is not checking that class.
 * 2. No fixture may be INERT. A row that no broken port trips is a row that proves nothing,
 *    and this repo has shipped two of them — both times the tell was a mutation surviving a
 *    fixture written to kill it.
 * 3. The REAL masking must still agree on the same fixtures, so the two results above are
 *    not both explained by a comparison that reports everything.
 *
 * …and then the same broken ports are run over the REAL pages, because the corpus half can
 * be vacuous on its own: a pass that reads no page reports a zero forever, which is the
 * defect this repo has now shipped in four different checkers. What that prints is the
 * measurement the whole pass exists for — how much of this a corpus can catch, and how much
 * only a fixture can.
 */
function selfTestCopy(python) {
  const failures = [];
  const fixtures = fixtureSources();
  const model = siteModel(python, join(ROOT, "mkdocs.yml"));
  const corpus = copySources(model);
  const rendered = renderedText(python, join(ROOT, "mkdocs.yml"), [...fixtures, ...corpus]);

  // Everything the site itself serves has to be IN that corpus, stated from the site's side
  // rather than from the filter's. `copySources` intersects the copy corpus with what the
  // renderers serve, and an intersection can go quietly narrow from either end — a page that
  // stops being counted as user-facing, a stray `slice`. Asked the other way round: mkdocs
  // built this page, and the landing directory ships that one, so a reader meets both, so
  // both are compared. Measured by narrowing the corpus to a single page, which this
  // reports and nothing else did.
  const readIt = new Set(corpus.map(({ label }) => label));
  for (const rel of [...model.pages, ...publishedLandingPages()]) {
    if (!readIt.has(rel)) {
      failures.push(`  the site serves ${rel} and the copy comparison does not read it`);
    }
  }
  if (failures.length === 0) {
    console.log(`All ${readIt.size} pages the site's own renderers serve are read by the copy comparison.`);
  }

  const killed = new Set();
  for (const [what, mask] of BROKEN_MASKS) {
    const reported = compareCopy(fixtures, rendered, mask);
    if (reported.failures.length === 0) {
      failures.push(`  a port that ${what} was reported as agreeing with the renderer`);
      continue;
    }
    for (const line of reported.failures) killed.add(line.slice(0, line.indexOf(":")).trim());
  }
  if (failures.length === 0) {
    console.log(`All ${BROKEN_MASKS.length} deliberately broken ports are reported, not passed.`);
  }

  const inert = fixtures.filter(({ label }) => !killed.has(label));
  for (const { label } of inert) {
    failures.push(`  ${label} is not reported by any broken port, so it proves nothing`);
  }
  if (inert.length === 0) {
    console.log(`Each of the ${fixtures.length} construct fixtures is reported by at least one of them.`);
  }

  const real = compareCopy(fixtures, rendered, REAL_MASK);
  for (const line of real.failures) failures.push(line);
  if (real.failures.length === 0) {
    console.log(`The real masking keeps all ${real.words} words the renderer shows across those fixtures.`);
  }

  const overCorpus = BROKEN_MASKS.filter(([, mask]) => compareCopy(corpus, rendered, mask).failures.length > 0);
  if (overCorpus.length === 0) {
    failures.push(
      `  none of the ${BROKEN_MASKS.length} broken ports is reported over the ${corpus.length} real pages,` +
        ` so the corpus half of this comparison is reading nothing`,
    );
  } else {
    console.log(
      `${overCorpus.length} of the ${BROKEN_MASKS.length} are reported by the ${corpus.length} real pages on` +
        ` their own; the rest are constructs no page contains yet, which is what the fixtures are for.`,
    );
  }
  return failures;
}

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

    // ...and the same treatment for the OTHER port of this renderer — the one that decides
    // what a reader meets. Its fixtures need no planted site: they are text, and the
    // renderer reads text.
    for (const line of selfTestCopy(python)) failures.push(line);
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

  // The second port of the same renderer: what a reader MEETS, which is what the two rules
  // about the copy read. Pages and fixtures go through one render, because a fixture is a
  // page as far as the renderer is concerned.
  const copyPages = copySources(model);
  const copyFixtures = fixtureSources();
  const copyAll = [...copyPages, ...copyFixtures];
  const copy = compareCopy(copyAll, renderedText(python, join(ROOT, "mkdocs.yml"), copyAll), REAL_MASK);
  for (const line of copy.failures) failures.push(line);

  if (failures.length) {
    console.log(`The checkers' model of the site disagrees with mkdocs (${failures.length}):`);
    for (const f of failures) console.log(f);
    console.log(
      "\nThis is not a formatting nit. `check:docs` judges a published page's links by the" +
        "\nrule above; where the two disagree it will either miss a dead link or, worse," +
        "\nreport a live one as dead — which is how a correct link gets 'fixed' into a 404.",
    );
    if (copy.failures.length) {
      console.log(
        "\nA word the masking hides is not cosmetic either. The two rules that read what the" +
          "\ncopy SAYS — the destructive-action gate and golden rule 7's vocabulary — can only" +
          "\nreport words the masking keeps, so a word it erases is a claim nothing checks, on a" +
          "\npage that reads as clean. Fix `scripts/lib/copy-text.mjs`, not the page: the lines" +
          "\nabove quote the RENDERED text, which is what a reader is looking at.",
      );
    }
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
  const unasked = userFacingPages().length - copyPages.length;
  console.log(
    `The copy masking keeps every one of the ${copy.words} words the renderer shows across those` +
      ` ${copyPages.length} pages and the ${copyFixtures.length} construct fixtures beside them.`,
  );
  console.log(
    `  (${unasked} of the ${userFacingPages().length} pages a user meets are rendered by GitHub and` +
      ` npm, which have no local renderer to ask — the same boundary this file draws for anchors.)`,
  );
}
