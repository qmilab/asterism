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
// rule beside it that does not is the same setup. Codex found it in the vocabulary rule; the
// gate rule had it too, and neither had a live instance — which is exactly when it is cheap
// to fix.
//
// Everything here is LENGTH- and NEWLINE-preserving, because both callers report a line
// number computed from an offset into the masked text.

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
 * The character a hidden line is left holding, so that removing its words does not turn it
 * into a BLANK line.
 *
 * Blanking to spaces alone was not enough, and the failure it caused is the one this file
 * cares most about — a red over correct copy. The gate rule reads a paragraph as one block
 * and a blank line as the end of it, so an HTML comment sitting between a guarantee and its
 * `unless` clause inside one `<p>` closed the claim early and reported the qualified
 * sentence as unqualified. The browser shows one paragraph; the checker saw two.
 * [Codex review R2 P2.]
 *
 * Anything non-blank would do; this one cannot be typed by accident, opens no list, table
 * row or heading, and ends no sentence. Both rules strip it before they match or print, so
 * it is invisible in a report.
 *
 * ⚠ A line that was ALREADY empty stays empty, so a hidden region containing a blank line
 * still ends a block. That is a TRADE, taken deliberately and with a count. In HTML the
 * browser renders one paragraph, so this is a false red waiting to happen; in MARKDOWN a
 * blank line really does end the block, and filling it would join two separate paragraphs
 * into one — a false GREEN, on 23 of the 24 pages in the corpus, to remove a false red on the
 * 1 that is HTML. Neither shape occurs in this repo's copy today; a fixture pins the
 * behaviour so the trade can be re-argued against a real instance rather than re-derived.
 * [Codex review R3 P2 — taken as the measurement, not as the change.]
 *
 * ⚠ This is for markup a reader never MEETS. `gate-claims.mjs` also blanks `> **Evidence**`
 * citations, to spaces, and that difference is deliberate rather than an oversight: a
 * citation is a rendered blockquote, so it really is a boundary between two things a reader
 * takes in separately, and a sentence on the far side of one does not qualify a claim on
 * this side. Measured — a claim, a citation, then an `unless` still reports, and should.
 * Filling those lines instead would buy a false green.
 */
export const HIDDEN_FILLER = "\u0000";

/**
 * The spans of a markdown page that are CODE — fenced blocks and inline spans.
 *
 * A page showing an HTML example puts real, visible characters on the screen. `<!-- … -->`
 * inside a fence is not markup the browser hides; it is a picture of markup, and a reader
 * meets every character of it. The word rule already treats a fence as copy — `kernel` in a
 * code span fires — so the hidden-markup masking has to agree with it, or one rule reads a
 * fence and the other erases it. [Codex review R3 P2.]
 *
 * Fenced blocks first, so a backtick inside one cannot start an inline span.
 */
function codeRanges(text) {
  const ranges = [];
  for (const m of text.matchAll(/^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1[ \t]*$/gm)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(/`+[^`\n]*`+/g)) {
    if (!ranges.some(([a, b]) => m.index < b && m.index + m[0].length > a)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

/** Blank a span, leaving each line that HAD content non-blank. See {@link HIDDEN_FILLER}. */
function blankHidden(span) {
  return span
    .split("\n")
    .map((line) => (line.length === 0 ? line : HIDDEN_FILLER + " ".repeat(line.length - 1)))
    .join("\n");
}

/**
 * Blank the regions of a page a reader never meets: HTML comments, `<style>`, `<script>`.
 *
 * A rule about what the copy says must not fire on a CSS class called `.registry-grid`, on a
 * design-token comment, or on the note at the top of `landing/index.html` explaining which
 * path the site owns. The cheapest way to green such a report is to rename the class — a
 * prose gate reaching into a stylesheet is the "wrong instrument certifies the damage"
 * failure this repo has already paid for once, on four correct links.
 *
 * Comments first: a `<style>` block can be commented out, and blanking the comment takes the
 * whole thing with it either way. An unterminated `<!--` matches nothing and is left alone,
 * which errs toward reporting rather than toward hiding.
 */
export function maskHiddenMarkup(text) {
  // Every replacement below preserves LENGTH, so the ranges stay valid across all three.
  const code = codeRanges(text);
  const hide = (m, at) =>
    code.some(([a, b]) => at < b && at + m.length > a) ? m : blankHidden(m);
  return text
    .replace(/<!--[\s\S]*?-->/g, hide)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, hide)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, hide);
}

/**
 * A multi-word phrase that may WRAP, but only once.
 *
 * Prose here is hard-wrapped, so a phrase that sits on one line today is split across two
 * after the next rewrap — a matcher that could not read across the break would fire on the
 * orphaned half of a page that is correct. But `\s+` reads across far too much: it spans a
 * BLANK line, so `## Container` followed by a paragraph opening `Registry controls the tool
 * list` matched as one phrase and masked a real claim out of existence.
 * [Codex review R2 P2.]
 *
 * One hard wrap is the whole allowance: horizontal space, at most one newline, horizontal
 * space. Two newlines are a new block, and a new block is a new statement.
 */
export function wrappablePhrase(...words) {
  return new RegExp(`\\b${words.join("[^\\S\\n]*\\n?[^\\S\\n]*")}\\b`, "gi");
}

/**
 * The attribute values a reader really does meet, even though they sit inside a tag.
 *
 * `alt` is read aloud by a screen reader and shown when an image fails; `title` is a
 * tooltip; `aria-label` is the accessible name; a `<meta>` `content` is the description
 * Google and every social preview show. Golden rule 7 covers "any user-facing string", and
 * these are strings a person meets without ever viewing source — `landing/index.html`
 * carries sixteen of them, including its Open Graph description, which is marketing copy and
 * exactly the kind that drifts. Blanking the whole tag hid all of it. [Codex review R3 P2.]
 *
 * The rest of the tag goes: an element name, a class, an href are not sentences.
 */
const VISIBLE_ATTRIBUTE = /\b(?:alt|title|aria-label|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** Blank every tag, keeping the values in {@link VISIBLE_ATTRIBUTE}. Length-preserving. */
export function blankTags(text) {
  return text.replace(/<\/?[a-z][^>]*>/gi, (tag) => {
    let out = blank(tag);
    for (const m of tag.matchAll(VISIBLE_ATTRIBUTE)) {
      const value = m[1] ?? m[2] ?? "";
      // The value's offset inside the tag: the whole match, less the closing quote and the
      // value itself.
      const at = m.index + m[0].length - value.length - 1;
      out = out.slice(0, at) + value + out.slice(at + value.length);
    }
    return out;
  });
}
