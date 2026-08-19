// Which markdown this repo has, and which of it the site publishes.
//
// Four filters used to answer those two questions, each hand-written where it stood and
// none of them asking `mkdocs.yml`:
//
//   docs-commands-check   extraction    `readdir("docs")` + README.md
//   docs-commands-check   link pass     tracked `*.md` under `docs/`, or in the root
//   docs-commands-check   anchor rule   `path.startsWith("docs/")`
//   safety-case-check     evidence      `readdir("docs")` + README.md + SECURITY.md
//
// Three different sets, one directory name repeated in all of them, and the same decision
// — "which markdown counts" — made four times. The anchor rule is the one that goes wrong
// QUIETLY if the site ever moves: a page judged by the wrong renderer keeps reporting that
// every link resolves while the published ones 404, and this repo has already paid once
// for an anchor helper that disagreed with the site (see `anchors.mjs`).
//
// So the shared thing is the RULE, not a list. A checker still chooses its own scope — the
// evidence pass and the command pass legitimately want different sets — but it chooses in
// terms of a rule derived here from `mkdocs.yml` and `git ls-files`, and names the set it
// read in its report.
//
// The derivation is CROSS-CHECKED against mkdocs itself: `scripts/mkdocs-parity-check.mjs`
// asks `mkdocs.config.load_config()` for the same answers and fails if they differ. That is
// what makes this a port rather than a guess — the same discipline the anchor helpers are
// held to, for the same reason.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Stop with an explanation rather than a stack trace. Every caller here is a gate, and a
 * gate that dies on a bare `ENOENT` teaches people the gate is flaky; one that says what it
 * could not read gets fixed.
 */
function refuse(message) {
  console.error(message);
  process.exit(2);
}

/**
 * `mkdocs.yml`, read for the two keys that decide what the site contains.
 *
 * Deliberately not a YAML parser: the config carries a `!!python/name:` tag that only
 * mkdocs' own loader resolves, so a general parser here would be a second thing to keep
 * correct. This reads the two keys it needs and REFUSES any shape it has not been shown to
 * handle, which is the difference between a port and a guess. `--self-test` runs it against
 * planted configs, including the shapes it must refuse.
 */
export function readSiteConfig(configText) {
  const lines = configText.split("\n");
  let docsDir;
  let exclude = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dir = /^docs_dir:\s*(.*)$/.exec(line);
    if (dir) {
      if (docsDir !== undefined) {
        refuse("mkdocs.yml declares `docs_dir` twice; this reader cannot say which one the site uses.");
      }
      const raw = dir[1].trim().replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
      if (!raw) refuse("mkdocs.yml declares `docs_dir` with no value.");
      docsDir = raw.replace(/^\.\//, "").replace(/\/+$/, "");
      // `docs_dir` must name a SUBDIRECTORY of the repo, because everything here compares
      // paths that came from `git ls-files` and are repo-relative. mkdocs accepts more than
      // that — an absolute path, `.` for the repo root, a `..` escape — and every one of
      // those makes the prefix test below match NOTHING. That is not an error anywhere
      // downstream: it is "no page is published", which reads as every link on the site
      // being judged by GitHub's slug rule while the pass goes on reporting that they all
      // resolve. A silent wrong answer is the failure mode this module exists to remove, so
      // the shapes this reader cannot compare are refused by name.
      //
      // ⚠ The first version of this refused only a leading `/`, which is how three of the
      // four shapes got through: `.`, `./` (which the trailing-slash strip turns into an
      // empty string), and `../docs` all produced "nothing is published", silently.
      const bad =
        docsDir === "" || docsDir === "." ? "the repo root" : docsDir.split("/").includes("..") ? "a path with a `..` segment" : raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) ? "an absolute path" : "";
      if (bad) {
        refuse(
          `mkdocs.yml gives \`docs_dir: ${raw}\` — ${bad}. Everything here compares repo-relative\n` +
            `paths from git, so this reader can only handle a subdirectory of the repo; anything\n` +
            `else silently makes every page unpublished, which is worse than stopping.\n` +
            `Teach scripts/lib/docs-scope.mjs before using one.`,
        );
      }
      continue;
    }
    const ex = /^exclude_docs:\s*(.*)$/.exec(line);
    if (!ex) continue;
    if (exclude !== null) {
      refuse("mkdocs.yml declares `exclude_docs` twice; this reader cannot say which one the site uses.");
    }
    const head = ex[1].trim();
    if (/^[|>][-+]?$/.test(head)) {
      // A block scalar: every following line indented under the key belongs to it, and the
      // first line that is not indented ends it.
      exclude = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") continue;
        if (!/^\s/.test(l)) break;
        exclude.push(l.trim());
      }
    } else if (head === "") {
      exclude = [];
    } else if (head.startsWith("[") || head.startsWith("{")) {
      // A YAML flow collection is a shape this reader has never been shown, so it says so
      // rather than splitting on a comma and hoping.
      refuse(
        `mkdocs.yml gives \`exclude_docs\` as an inline collection (${head}); this reader handles` +
          ` a block scalar or one plain pattern. Teach scripts/lib/docs-scope.mjs before using one.`,
      );
    } else {
      exclude = [head.replace(/^["']|["']$/g, "")];
    }
  }

  // Absent is not a mismatch: mkdocs defaults `docs_dir` to `docs`, which is what this repo
  // declares anyway.
  return { docsDir: docsDir ?? "docs", exclude: exclude ?? [] };
}

let CACHED;
function config() {
  if (!CACHED) {
    let text;
    try {
      text = readFileSync(join(ROOT, "mkdocs.yml"), "utf8");
    } catch (err) {
      refuse(
        `The site's own config decides which pages are published, and mkdocs.yml could not be` +
          ` read (${err.message}).`,
      );
    }
    CACHED = readSiteConfig(text);
  }
  return CACHED;
}

/** The directory mkdocs publishes, as `mkdocs.yml` declares it. */
export function siteDir() {
  return config().docsDir;
}

/**
 * One `exclude_docs` pattern → a predicate on a path relative to `docs_dir`.
 *
 * mkdocs reads these with gitignore semantics, which is why this repo's `internal/` means
 * "any directory called internal", not "docs/internal": a pattern with no separator except
 * a trailing one matches at any depth. Implemented here are the shapes gitignore defines
 * for a single pattern; refused are the two whose PRECEDENCE this would have to guess at —
 * `!` negation, where last match wins and the order of the list starts to matter, and a
 * character class. A refusal names the pattern, so extending this stays a deliberate act
 * rather than something a contributor discovers by watching an excluded page get checked.
 */
export function patternMatcher(pattern) {
  if (pattern.startsWith("!")) {
    refuse(
      `mkdocs.yml excludes with a negated pattern (\`${pattern}\`); this reader does not implement` +
        ` gitignore's last-match-wins precedence. Teach scripts/lib/docs-scope.mjs before using one.`,
    );
  }
  if (/[[\]\\]/.test(pattern)) {
    refuse(
      `mkdocs.yml excludes with a pattern this reader does not implement (\`${pattern}\`):` +
        ` character classes and escapes are not handled. Teach scripts/lib/docs-scope.mjs first.`,
    );
  }
  const dirOnly = pattern.endsWith("/");
  const body = dirOnly ? pattern.slice(0, -1) : pattern;
  // A separator at the START or the MIDDLE anchors the pattern to `docs_dir`; a trailing
  // one does not, which is why this is read after the trailing slash is stripped.
  const anchored = body.startsWith("/") || body.includes("/");
  const source =
    (anchored ? "" : "(?:.*/)?") +
    body
      .replace(/^\//, "")
      .split("/")
      .map((seg) =>
        seg === "**"
          ? "**"
          : seg.replace(/[.+^${}()|]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"),
      )
      .join("/")
      // `**` spans separators, so it is expanded after the join, where it can eat one.
      .replace(/\*\*\//g, "(?:.*/)?")
      .replace(/\/\*\*/g, "(?:/.*)?")
      .replace(/\*\*/g, ".*");
  const rx = new RegExp(`^${source}$`);
  return (rel) => {
    // A matched DIRECTORY excludes everything beneath it, so every directory prefix of the
    // path is tested, not just the path itself.
    const segs = rel.split("/");
    for (let k = 1; k < segs.length; k++) if (rx.test(segs.slice(0, k).join("/"))) return true;
    return !dirOnly && rx.test(rel);
  };
}

/**
 * A site config → the predicate "does the site publish this repo-relative path".
 *
 * Separate from `isPublished` so it can be pointed at a config that is not this repo's:
 * `mkdocs-parity-check.mjs --self-test` builds one from a planted config and compares it,
 * pattern by pattern, against what mkdocs' own loader says about the same config. A
 * gitignore subset written from the documentation and never run against the library that
 * implements it would be one more instrument nobody has falsified.
 */
export function publishedPredicate({ docsDir, exclude }) {
  const matchers = exclude.filter((p) => p !== "" && !p.startsWith("#")).map(patternMatcher);
  const prefix = `${docsDir}/`;
  return (rel) => {
    const normalized = rel.split(/[\\/]/).join("/");
    if (!normalized.startsWith(prefix)) return false;
    return !matchers.some((matches) => matches(normalized.slice(prefix.length)));
  };
}

let PREDICATE;
/**
 * Does the site publish this file? Repo-relative path in, boolean out.
 *
 * This is the question the anchor rule turns on — a published page is served by
 * Python-Markdown and everything else by GitHub — so it is also the question that decides
 * whether a link is judged by the renderer that will actually serve it.
 */
export function isPublished(rel) {
  if (!PREDICATE) PREDICATE = publishedPredicate(config());
  return PREDICATE(rel);
}

/**
 * Every markdown file this repo SHIPS, from git rather than a readdir: the root also holds
 * a contributor's private notes (`ROADMAP.md` and friends are gitignored), and a gate that
 * fails on files the repo does not ship is a gate people learn to skip.
 */
export function trackedMarkdown() {
  let out;
  try {
    out = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: ROOT, encoding: "utf8" });
  } catch (err) {
    // Not a fallback — a readdir here would gate on a contributor's private notes, and an
    // empty list would let a pass report a green zero over nothing at all. Say why it
    // stopped, because `spawnSync git ENOENT` reads like a broken checkout.
    refuse(
      `The markdown this repo ships is listed by asking git, and git did not answer here` +
        ` (${err.message}). Run this from a git checkout with git available.`,
    );
  }
  const tracked = out.split("\u0000").filter(Boolean).sort();
  // `git ls-files` names a file that has been deleted but not yet staged, and every caller
  // here goes on to read it. Without this a gate dies on a bare ENOENT part-way through a
  // corpus, which reads like the checker is broken rather than like a half-finished delete.
  const missing = tracked.filter((rel) => !existsSync(join(ROOT, rel)));
  if (missing.length) {
    refuse(
      `git tracks ${missing.length} markdown file${missing.length === 1 ? "" : "s"} not in the` +
        ` working tree, and every check here reads them:\n` +
        missing.map((m) => `  ${m}`).join("\n") +
        `\nStage the deletion (\`git rm\`) or restore the file.`,
    );
  }
  return tracked;
}

/** The tracked markdown the site publishes — the pages a reader meets on the site. */
export function publishedPages() {
  return trackedMarkdown().filter(isPublished);
}

/**
 * The markdown a USER of Asterism meets, as opposed to a contributor: the site, the repo's
 * front page, and the README of every package this repo publishes to npm. Three clauses,
 * each derived — mkdocs decides the first, git the second, and each manifest's own
 * `private` flag the third.
 *
 * The third clause is the one that was missing. A package README is the page npm shows for
 * the thing people install (npm ships it whichever way `files` is written), and it was
 * outside every checker here: `packages/cli/README.md` advertised nine commands that
 * nothing typed, and its quickstart's `secrets add` line exits 1 as printed.
 *
 * Contributor markdown — CLAUDE.md, CONTRIBUTING.md, the CHANGELOG, `decisions/` — is
 * deliberately not in this set. Their fenced blocks are specifications and history rather
 * than instructions a reader follows, and typing a spec at the binary tests the spec's
 * prose, not the product. Their LINKS are checked; see `trackedMarkdown` callers.
 */
export function userFacingMarkdown() {
  const tracked = trackedMarkdown();
  const npmReadmes = publishedPackages()
    .map((dir) => `${dir}/README.md`)
    .filter((rel) => tracked.includes(rel));
  return [...new Set([...publishedPages(), "README.md", ...npmReadmes])].sort();
}

/**
 * Every directory holding a manifest this repo PUBLISHES — the workspace's own is private,
 * so it is not one. Derived from git and each manifest's `private` flag rather than from a
 * glob on `packages/*`, because the release workflow's list of eight is derived the same
 * way and a checker that disagreed with it would be checking a different product.
 */
export function publishedPackages() {
  const dirs = [];
  let listed;
  try {
    listed = execFileSync("git", ["ls-files", "-z", "--", "*package.json"], { cwd: ROOT, encoding: "utf8" });
  } catch (err) {
    refuse(`The packages this repo publishes are listed by asking git, and git did not answer (${err.message}).`);
  }
  for (const rel of listed.split("\u0000").filter(Boolean).sort()) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
    } catch (err) {
      refuse(`${rel} could not be parsed (${err.message}), so this cannot say whether npm publishes it.`);
    }
    if (manifest.private === true) continue;
    dirs.push(rel === "package.json" ? "" : rel.slice(0, -"/package.json".length));
  }
  return dirs.filter(Boolean);
}

/**
 * A package npm publishes whose README is not in the repo. npm renders a package page from
 * its README and shows only the one-line description without one, so this is a blank page
 * for something people install — and it is precisely the case the rule above cannot see,
 * since a set built from the files that EXIST can never notice a file that does not.
 *
 * Found by writing that rule: seven of the eight published packages had a README and
 * `@qmilab/asterism-adapter-lodestar` did not.
 */
export function publishedPackagesWithoutReadme() {
  const tracked = trackedMarkdown();
  return publishedPackages().filter((dir) => !tracked.includes(`${dir}/README.md`));
}
