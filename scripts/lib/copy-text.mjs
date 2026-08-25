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
 * A line that was ALREADY empty keeps its length of zero — there is nowhere to put a filler
 * without moving every offset after it, and an empty line was a block boundary before any
 * masking happened, so nothing here created it.
 *
 * ⚠ This is for markup a reader never MEETS. `gate-claims.mjs` also blanks `> **Evidence**`
 * citations, to spaces, and that difference is deliberate rather than an oversight: a
 * citation is a rendered blockquote, so it really is a boundary between two things a reader
 * takes in separately, and a sentence on the far side of one does not qualify a claim on
 * this side. Measured — a claim, a citation, then an `unless` still reports, and should.
 * Filling those lines instead would buy a false green.
 */
export const HIDDEN_FILLER = "\u0000";

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
  return text
    .replace(/<!--[\s\S]*?-->/g, blankHidden)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blankHidden)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blankHidden);
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
