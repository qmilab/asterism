// What a reader actually meets, for the rules that read what the copy SAYS.
//
// Two rules read the same corpus — the destructive-action gate (`gate-claims.mjs`) and
// golden rule 7's vocabulary (`copy-vocabulary.mjs`) — and both are about sentences a person
// reads. Both are pointed at `landing/index.html`, which is hand-written HTML: thirteen
// comments, one inlined stylesheet, and the paragraphs in between. Only the last of those is
// copy.
//
// The primitives live here rather than in either rule because this repo has now paid twice
// for one idea kept in two spellings: #139's `every-level` guard and #177's shared rule drew
// apart until the older one was blind to three shapes the newer one caught, and #176 restated
// half of a claim the other half's fix had corrected. A rule that knows about `<style>` and a
// rule beside it that does not is the same setup.
//
// Every function here answers one question — *would a reader meet these characters?* — and
// the answer depends on the RENDERER, which is why `maskHiddenMarkup` takes the page's kind.
// The same three characters are a block boundary in one and invisible in the other.
//
// Both callers report a line number computed from an offset into the masked text, so nothing
// here may change how many NEWLINES the text has.

/**
 * Blank a span to spaces, keeping its LENGTH and — the part that is easy to miss — its
 * NEWLINES.
 *
 * Length alone is not enough. Every span these rules blank can wrap: an HTML comment, a
 * stylesheet, a tag with attributes on three lines, and (for the vocabulary rule) a
 * two-word phrase split by the last rewrap. Blanking a newline to a space keeps every
 * offset and loses a LINE, so the next finding is reported one line early — and a fixture
 * whose finding is on line 1 can never see it.
 */
export function blank(text) {
  return text.replace(/[^\n]/g, " ");
}

/**
 * The character a hidden line is left holding on an HTML page, so that removing its words
 * does not turn it into a BLANK line.
 *
 * Blanking to spaces alone was not enough there, and the failure it caused is the one this
 * file cares most about — a red over correct copy. The gate rule reads a paragraph as one
 * block and a blank line as the end of it, so an HTML comment sitting between a guarantee and
 * its `unless` clause inside one `<p>` closed the claim early and reported the qualified
 * sentence as unqualified. The browser shows one paragraph; the checker saw two.
 *
 * Anything non-blank would do; this one cannot be typed by accident, opens no list, table
 * row or heading, and ends no sentence. Both rules strip it before they match or print, so
 * it is invisible in a report.
 */
export const HIDDEN_FILLER = "\u0000";

/**
 * Blank a span for an HTML page: every line it touches ends up non-blank, EMPTY lines
 * included.
 *
 * An empty line inside a comment is still inside the comment, so a browser still renders one
 * paragraph. Filling it makes the text one character longer, which is fine — the invariant
 * these rules need is the NEWLINE count, not the length, because a line number is a count of
 * newlines and the line a report quotes is looked up by index.
 */
function blankHiddenHtml(span) {
  return span
    .split("\n")
    .map((line) => HIDDEN_FILLER + " ".repeat(Math.max(0, line.length - 1)))
    .join("\n");
}

/**
 * The spans of a page that are CODE — a fenced block, or an inline span.
 *
 * A page showing an HTML example puts real, visible characters on the screen. `<!-- … -->`
 * inside a fence is not markup the browser hides; it is a picture of markup, and a reader
 * meets every character of it. The word rule already treats a fence as copy — `kernel` in a
 * code span fires — so the masking has to agree with it, or one rule reads a fence and the
 * other erases it.
 *
 * Fenced blocks first, so a backtick inside one cannot start an inline span.
 *
 * ⚠ Markdown's OTHER code block — four spaces of indent — is deliberately not here, and the
 * reason is a measurement rather than an oversight. This repo has **zero** of them and
 * **three** mkdocs admonitions (`!!! note`), whose bodies are indented by exactly four
 * spaces and are prose. Adding the rule would classify three passages a reader meets as
 * styled notes as "code", to protect none that exist. [Codex review R4 P2, taken as the
 * measurement and not as the change.]
 */
export function codeRanges(text) {
  const ranges = [];
  for (const m of text.matchAll(/^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1[ \t]*$/gm)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(/`+[^`\n]*`+/g)) {
    if (!inRanges(m.index, ranges)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** Is this offset inside one of the ranges? */
function inRanges(at, ranges) {
  return ranges.some(([a, b]) => at >= a && at < b);
}

/** Every region of a page a reader never meets: an HTML comment, a `<style>`, a `<script>`. */
const HIDDEN_REGION =
  /<!--[\s\S]*?-->|<style\b[^>]*>[\s\S]*?<\/style>|<script\b[^>]*>[\s\S]*?<\/script>/gi;

/**
 * Blank the regions a reader never meets.
 *
 * A rule about what the copy says must not fire on a CSS class called `.registry-grid`, on a
 * design-token comment, or on the note at the top of `landing/index.html` explaining which
 * path the site owns. The cheapest way to green such a report is to rename the class — a
 * prose gate reaching into a stylesheet is the "wrong instrument certifies the damage"
 * failure this repo has already paid for once, on four correct links.
 *
 * `html` decides whether a hidden region is also a BLOCK BOUNDARY, and the two renderers
 * genuinely disagree:
 *
 *   - **HTML.** A comment is invisible; the paragraph around it is one paragraph. Its lines
 *     must not go blank, or a claim is cut off from the clause that qualifies it.
 *   - **Markdown.** `<!--` at the start of a line opens an HTML *block*, which interrupts the
 *     paragraph — so there the blank line is CORRECT, and filling it would let a promise in
 *     one paragraph be excused by an `unless` in the next. A comment in the MIDDLE of a line
 *     is inline, and blanking it leaves the surrounding prose on the line, so that case comes
 *     out right with no special handling.
 *
 * Getting this from the caller rather than guessing is the same discipline the anchor rule
 * keeps: which renderer serves the page decides how the page is read. [Codex review R4 P2.]
 *
 * One pass over one regex, so every offset here is an offset into the text as given —
 * chaining three replacements only works while each preserves length, and the HTML branch
 * does not.
 */
export function maskHiddenMarkup(text, { kind = "markdown" } = {}) {
  // PLAIN text is not markup. A help screen and an npm description have no comments, no
  // stylesheet and no script — and pretending otherwise is how `Usage: asterism config
  // <adapter>` came to be erased as if it were a tag, in the very corpus this rule started
  // from. [Codex review R5 P2.]
  if (kind === "plain") return text;
  const code = codeRanges(text);
  return text.replace(HIDDEN_REGION, (region, at) => {
    // Only the OPENER's position counts. A `<script>` whose body contains a backtick — a
    // template literal, say — makes `codeRanges` see an inline span INSIDE the script, and an
    // overlap test would then preserve the whole script and report words no reader sees.
    // [Codex review R4 P2.]
    if (inRanges(at, code)) return region;
    return startsABlock(text, at, kind) ? blank(region) : blankHiddenHtml(region);
  });
}

/**
 * Does a hidden region beginning at `at` also begin a BLOCK — that is, does removing it split
 * what a reader sees into two?
 *
 * In HTML, never: a comment is invisible and the paragraph closes around it.
 *
 * In markdown it depends on where the region starts, and this is Python-Markdown's own rule
 * rather than a guess. Asked directly:
 *
 *   'claim <!--\nnote\n--> unless allowed'    → <p>claim <!--\nnote\n--> unless allowed</p>
 *   'claim\n<!--\nnote\n-->\nunless allowed'  → <p>claim</p> <!--…--> <p>unless allowed</p>
 *
 * A comment that OPENS a line is an HTML block and interrupts the paragraph; one that starts
 * after visible text is inline and does not. Blanking an inline one's continuation lines made
 * them blank lines, so a correctly qualified claim was cut off from its `unless` and reported
 * as an overclaim. [Codex review R5 P2.]
 */
function startsABlock(text, at, kind) {
  if (kind !== "markdown") return false;
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, at));
}

/**
 * Blank what a markdown link points AT, keeping the words it is written on.
 *
 * `[the threat model](./threat-model.md#what-the-kernel-enforces)` shows a reader four words
 * and none of them is the one in the URL. The destination is a path this repo chose for a
 * heading, not a sentence it wrote for a reader — and the safety case really does have
 * headings with these words in them, so a cross-reference to one would be reported as public
 * copy naming the machine. [Codex review R5 P2.]
 *
 * HTML needs no equivalent: an `href` lives inside a tag, and `blankTags` already drops
 * everything in a tag but the handful of attributes a reader meets.
 */
export function maskLinkDestinations(text, { kind = "markdown" } = {}) {
  if (kind !== "markdown") return text;
  const code = codeRanges(text);
  // The optional TITLE is not part of the destination — `[text](url "the kernel decides")`
  // renders that string as a tooltip, so a reader meets it. Only the URL goes.
  // [Codex review R6 P2.]
  const maskDestinationOnly = (payload) => {
    const [, lead, url, rest] = /^(\s*)(<[^>\n]*>|\S*)([\s\S]*)$/.exec(payload);
    return `${lead}${blank(url)}${rest}`;
  };
  return text
    .replace(/\]\(([^)\n]*)\)/g, (whole, payload, at) =>
      inRanges(at, code) ? whole : `](${maskDestinationOnly(payload)})`,
    )
    // …and a reference definition, whose line is a destination and may carry a title too.
    .replace(/^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*)(\S.*)$/gm, (whole, head, payload, at) =>
      inRanges(at, code) ? whole : head + maskDestinationOnly(payload),
    );
}

/**
 * The attribute values a reader really does meet, even though they sit inside a tag.
 *
 * `alt` is read aloud by a screen reader and shown when an image fails; `title` is a
 * tooltip; `aria-label` is the accessible name; a `<meta>` `content` is the description
 * Google and every social preview show. Golden rule 7 covers "any user-facing string", and
 * these are strings a person meets without ever viewing source — `landing/index.html`
 * carries sixteen of them, including its Open Graph description, which is marketing copy and
 * exactly the kind that drifts. Blanking the whole tag hid all of it.
 *
 * The name must BEGIN at an attribute boundary. `\b` alone matches the tail of
 * `data-title="…"`, which is implementation state a reader never meets, and restoring that
 * as copy is a red over a page that is correct. [Codex review R4 P2.]
 *
 * The rest of the tag goes: an element name, a class, an href are not sentences.
 */
const VISIBLE_ATTRIBUTE =
  /(?<![-\w])(alt|title|aria-label|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * A `<meta>` tag's `content` is TEXT only when the key beside it names text.
 *
 * `landing/index.html` carries sixteen meta tags and eleven of them hold something a reader
 * never reads as a sentence: `og:image` and `twitter:image` are URLs, `og:image:width` is
 * `1200`, `theme-color` is a hex colour, `og:type` is `website`. Scanning those means an
 * ordinary asset rename — `/adapter-card.png` — reds the build over a path.
 * [Codex review R6 P2.]
 *
 * Matched on what the key ENDS with, so the `og:` and `twitter:` prefixes need no list of
 * their own and `og:image:alt` — which really is alt text, for the social card — is kept.
 */
const TEXTUAL_META_KEY = /(?:^|:)(?:description|title|alt|site_name|author|keywords)$/i;

/** Whether this tag's `content` attribute holds a sentence rather than a URL or a number. */
function contentIsText(tag) {
  if (!/^<meta\b/i.test(tag)) return false;
  const key = /\b(?:name|property)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  return TEXTUAL_META_KEY.test((key?.[1] ?? key?.[2] ?? "").trim());
}

/**
 * A tag, read the way a parser reads one: a `>` inside a quoted attribute does not end it.
 *
 * `<a title="x > y" class="kernel-box">` stopped at the `>` in the title, leaving
 * ` class="kernel-box">` behind as prose — internal vocabulary reported on a page where no
 * reader meets it. [Codex review R4 P2.]
 *
 * The NAME has to look like a tag name, so an autolink — `<https://example.com/x>`, which
 * markdown renders as visible link text — is not mistaken for one.
 */
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/gi;

/**
 * Blank every tag, keeping the values in {@link VISIBLE_ATTRIBUTE}. Length-preserving.
 *
 * A tag inside a code example is left alone entirely: `<div class="kernel-box">` shown in a
 * fence is a picture of a tag, and every character of it is on the screen — including the
 * attribute a reader would never meet in a rendered page. [Codex review R4 P2.]
 */
export function blankTags(text, code = codeRanges(text), { kind = "markdown" } = {}) {
  // PLAIN text has no tags. `<agent>`, `<from>`, `<adapter>` are placeholders in a help
  // synopsis, and blanking them erased a word this rule exists to find. [Codex review R5 P2.]
  if (kind === "plain") return text;
  return text.replace(TAG, (tag, at) => {
    if (inRanges(at, code)) return tag;
    let out = blank(tag);
    const keepsContent = contentIsText(tag);
    for (const m of tag.matchAll(VISIBLE_ATTRIBUTE)) {
      if (m[1].toLowerCase() === "content" && !keepsContent) continue;
      const value = m[2] ?? m[3] ?? "";
      // The value's offset inside the tag: the whole match, less the closing quote and the
      // value itself. Using the attribute NAME's offset instead is five characters out, and
      // nothing notices until a tag wraps and the value lands on the next line.
      const valueAt = m.index + m[0].length - value.length - 1;
      out = out.slice(0, valueAt) + value + out.slice(valueAt + value.length);
    }
    return out;
  });
}

/**
 * A multi-word phrase that may WRAP, but only once.
 *
 * Prose here is hard-wrapped, so a phrase that sits on one line today is split across two
 * after the next rewrap — a matcher that could not read across the break would fire on the
 * orphaned half of a page that is correct. But `\s+` reads across far too much: it spans a
 * BLANK line, so `## Container` followed by a paragraph opening `Registry controls the tool
 * list` matched as one phrase and masked a real claim out of existence.
 *
 * One hard wrap is the whole allowance: horizontal space, at most one newline, horizontal
 * space. Two newlines are a new block, and a new block is a new statement.
 *
 * Each word is a regex FRAGMENT, so a sense can cover the same inflections the word list
 * does — `container registries` is the allowed meaning just as much as `container registry`,
 * and a sense that knew only the singular reported the plural. [Codex review R4 P2.]
 */
export function wrappablePhrase(...words) {
  return new RegExp(`\\b${words.join("[^\\S\\n]*\\n?[^\\S\\n]*")}\\b`, "gi");
}
