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
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank);
}
