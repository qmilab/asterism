// Heading → anchor, for the two renderers that serve this repo's markdown.
//
// Lifted out of `docs-commands-check.mjs` when a second checker needed the same answer.
// They were always a PORT of somebody else's slugifier rather than a helper of ours, which
// is why the comments below are so insistent about where each rule came from: this file has
// already shipped a wrong one once, and a wrong anchor helper does not merely miss a defect,
// it MANUFACTURES one — it reported four correct links dead, they were "fixed" to agree with
// it, and CI went green on pages that would 404.
//
// Which is why neither port is trusted on its own reading:
//
//   Python-Markdown   `scripts/mkdocs-parity-check.mjs` renders every published page with
//                     the site's own interpreter and compares the ids it emits against
//                     `anchorsOf(page, MKDOCS_RULE)`. Nothing here is pinned by hand.
//   GitHub            pinned by hand, from ids read off GitHub's rendering of this repo,
//                     because checking it live would mean a network fetch in a gate. The
//                     self-test asserts the pins COVER every heading of the file they were
//                     taken from, so a new heading is a failure rather than a silent gap.

import { isPublished } from "./docs-scope.mjs";

/**
 * The two rules, named once. `joiner` is the suffix each renderer appends to a duplicate
 * heading's id — `_1` under Python-Markdown, `-1` under GitHub.
 */
export const MKDOCS_RULE = { slug: anchorOf, joiner: "_", name: "mkdocs" };
export const GITHUB_RULE = { slug: githubAnchorOf, joiner: "-", name: "github" };

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
export function anchorOf(heading) {
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
export function* headingLines(text) {
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
export function githubAnchorOf(heading) {
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
 * A published page is served by mkdocs, so a published → published fragment must be the
 * anchor mkdocs emits: a GitHub-only form is dead for every reader of the site, and
 * `mkdocs --strict` used to not say so either, because it logged a missing anchor at INFO
 * (`mkdocs.yml` now raises that to a warning). Every other combination is only ever
 * followed on GitHub — the repo root is not on the site at all, and a published page
 * pointing outside the site has already left it.
 *
 * "Published" is asked of the site's own config rather than answered by a path prefix
 * here. The prefix version was right about this repo and silent about any change to it:
 * move `docs_dir`, or exclude a page from the build, and every affected page goes on being
 * judged by a renderer that does not serve it — while the pass keeps reporting that every
 * link resolves.
 *
 * The first version of this keyed on the TARGET and accepted EITHER rule for a `docs/`
 * page, reasoning that both renderers serve it. Both do render it — but a link is
 * followed in one place, and accepting the union let a fragment that is dead on the
 * published site pass as resolved. Reachable somewhere is not the same as reachable from
 * the page that makes the claim.
 */
export function anchorRuleFor(sourceRel, targetRel) {
  return isPublished(sourceRel) && isPublished(targetRel) ? MKDOCS_RULE : GITHUB_RULE;
}

/**
 * A page's anchors under one rule. Each renderer also guarantees ids are UNIQUE — a
 * repeated heading gets a suffix, `_1`/`_2` under Python-Markdown and `-1`/`-2` under
 * GitHub. Verified against both renderers, not assumed. This repo has no duplicate
 * heading today, which is exactly why it is worth handling now: the first one added would
 * otherwise have its correct link reported dead, and this pass has already taught us once
 * that a link declared dead gets "fixed" to agree with the checker.
 */
export function anchorsOf(text, { slug, joiner }) {
  const ids = new Set();
  for (const line of headingLines(text)) {
    const base = slug(line);
    let id = base;
    for (let n = 1; ids.has(id); n++) id = `${base}${joiner}${n}`;
    ids.add(id);
  }
  return ids;
}
