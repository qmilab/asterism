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
// ⚠ THIS IS A PORT, AND IT IS CHECKED AGAINST THE RENDERER, NOT AGAINST REASONING ABOUT ONE.
// `check:mkdocs-parity` renders every page the site serves, reads the visible text back with
// Python's own `html.parser`, and fails if a word a reader meets is one this file has hidden
// — the same treatment `anchors.mjs` gets, and for the same reason. It was written without
// that: ten rounds of review found 26 things wrong with it by inspection, the last five of
// them arguing about inputs the corpus does not contain, while both defects that turned out
// to be real were found by counting pages instead. **When a question about this file comes
// up, ask the renderer** — `.venv/bin/python -c "import markdown; print(markdown.markdown(src))"`
// settled five of them in seconds after reasoning had got them wrong.
//
// What the parity check cannot answer, so that a green there is not read as more than it is:
// text this file KEEPS and the renderer does not show (`alt`, `title`, a `<meta>`
// description — kept deliberately), the `plain` kind (nothing renders a help screen), and
// the pages GitHub and npm render rather than mkdocs. Those stay with the hand-written rows
// in `check:docs --self-test`. Between them the two cover all thirteen of this file's
// historical bugs when they are replayed as mutations; neither covers them alone.
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
export function codeRanges(text, { kind = "markdown" } = {}) {
  // Only markdown has them. A backtick in HTML is a backtick — `<p>`<!-- x -->`</p>` shows
  // the reader two backticks and hides the comment — and treating it as a code span
  // preserved the comment and reported words no reader meets. [Codex review R7 P2.]
  if (kind !== "markdown") return [];
  const ranges = [];
  // A closing run LONGER than the opening one closes the fence — and WHICH renderer that is
  // right for depends on the page. Both were asked, rather than reasoned about, while
  // building this file's parity check: `pymdownx.superfences`, which renders the site,
  // wants the two runs the same length and hands `~~~html … ~~~~` back as `<p>~~~html</p>`
  // followed by raw HTML, no fence anywhere; GitHub, which renders the READMEs, takes it.
  // The permissive reading is kept deliberately, because it can only ever over-keep: a code
  // range that runs too long preserves text the renderer hides, and every rule downstream
  // reports words it KEEPS. Neither reading is exercised today — 209 fenced blocks across
  // the 24 pages a user meets, 0 tilde-fenced and 0 closed by a longer run.
  // [Codex review R9 P2, whose "at least as long" is GitHub's rule and not the site's.]
  for (const m of text.matchAll(/^[ \t]*((`|~)\2{2,})[\s\S]*?^[ \t]*\1\2*[ \t]*$/gm)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  // An inline span MAY wrap: Python-Markdown renders `` `<!-- the\nkernel -->` `` as
  // `<code>&lt;!-- the\nkernel --&gt;</code>`, visible code across two lines. What it may not
  // contain is a blank line, which ends the paragraph. Asked the renderer.
  // [Codex review R7 P2.]
  // Scanned with the FENCES already blanked, not filtered afterwards. A stray backtick inside
  // a fence would otherwise start a match that runs on and swallows the opening backtick of a
  // real span below it — the match is then discarded for starting inside a fence, and the
  // span it ate is never recorded. [Codex review R8 P2.]
  let outsideFences = text;
  for (const [a, b] of ranges) {
    outsideFences = outsideFences.slice(0, a) + blank(text.slice(a, b)) + outsideFences.slice(b);
  }
  ranges.push(...inlineSpans(outsideFences));
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
  const code = codeRanges(text, { kind });
  // Where the TAGS are, so a hidden region inside one can be told from a real one.
  // `<meta content="What the <!-- kernel --> decides">` holds those characters as literal
  // attribute text and a search result shows every word of them. STRICTLY inside: a
  // `<style>` block opens exactly where its own tag does, and excluding that would stop
  // stylesheets being masked at all. [Codex review R9 P2.]
  const tags = tagRanges(text);
  return text.replace(HIDDEN_REGION, (region, at) => {
    if (tags.some(([a, b]) => at > a && at < b)) return region;
    // Only the OPENER's position counts. A `<script>` whose body contains a backtick — a
    // template literal, say — makes `codeRanges` see an inline span INSIDE the script, and an
    // overlap test would then preserve the whole script and report words no reader sees.
    // [Codex review R4 P2.]
    if (inRanges(at, code)) return region;
    const block = startsABlock(text, at, kind);
    // An INLINE hidden region may not span a blank line, and this is the renderer's answer
    // rather than a guess. Asked directly:
    //
    //   'claim <!--\nnote\n--> unless'        → <p>claim <!--\nnote\n--> unless</p>
    //   'claim <!--\nnote\n\nmore\n--> unless' → <p>claim &lt;!--\nnote</p><p>more\n--&gt; …</p>
    //
    // The second is not a comment at all: the blank line ends the paragraph and the markers
    // render as literal text, so `more` is on the screen. A BLOCK comment may hold a blank
    // line and stays a comment. Masking the inline one erased words a reader meets.
    if (kind === "markdown" && !block && /\n[ \t]*\n/.test(region)) return region;
    return block ? blank(region) : blankHiddenHtml(region);
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
  const code = codeRanges(text, { kind });
  // The optional TITLE is not part of the destination — `[text](url "the kernel decides")`
  // renders that string as a tooltip, so a reader meets it. Only the URL goes.
  // [Codex review R6 P2.]
  const maskDestinationOnly = (payload) => {
    const [, lead, url, rest] = /^(\s*)(<[^>\n]*>|\S*)([\s\S]*)$/.exec(payload);
    return `${lead}${blank(url)}${rest}`;
  };
  return (
    maskInlineDestinations(text, code, maskDestinationOnly)
      // A FULL reference link hides its identifier: `[details][adapter]` renders as
      // `<a href="…">details</a>` and the reader never meets `adapter`. Only the second pair
      // goes — in `[adapter][]` and in a bare `[adapter]`, the label IS the visible text.
      // [Codex review R10 P2.]
      .replace(/\]\[([^\]\n]+)\]/g, (whole, label, at) =>
        inRanges(at, code) ? whole : `][${blank(label)}]`,
      )
      // …and a reference DEFINITION renders nothing at all: its label is as hidden as its
      // URL, and only the title beside it is ever shown.
      .replace(/^([ \t]{0,3}\[)([^\]\n]+)(\]:[ \t]*)(\S.*)$/gm, (whole, open, label, mid, payload, at) =>
        inRanges(at, code) ? whole : open + blank(label) + mid + maskDestinationOnly(payload),
      )
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
  /(?<![-\w])(alt|title|aria-label|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

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
  // `(?<![-\w])`, not `\b` — the boundary `VISIBLE_ATTRIBUTE` already uses. With `\b`,
  // `data-name="description"` matched as `name` and an asset path in the `content` beside it
  // was read as a page description. The same bug as R4's, in the sibling written to fix it.
  // [Codex review R7 P2.]
  const key = /(?<![-\w])(?:name|property)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag);
  return TEXTUAL_META_KEY.test((key?.[1] ?? key?.[2] ?? key?.[3] ?? "").trim());
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
/**
 * The elements that put their contents on a line of their own.
 *
 * Blanking every tag to spaces left `<h2>Container</h2>` and the `<p>Registry …` beneath it
 * looking like one phrase, so the allowed sense `container registry` swallowed a heading and
 * a separate claim. A reader sees two blocks. So a block-level tag leaves a mark that a
 * phrase cannot read across — the same {@link HIDDEN_FILLER} a hidden line keeps, for the
 * same reason: it is not whitespace, and both rules strip it before printing.
 * [Codex review R10 P2.]
 */
const BLOCK_ELEMENT =
  /^<\/?(?:address|article|aside|blockquote|details|div|dl|dd|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul|br)\b/i;

export function blankTags(text, code = codeRanges(text), { kind = "markdown" } = {}) {
  // PLAIN text has no tags. `<agent>`, `<from>`, `<adapter>` are placeholders in a help
  // synopsis, and blanking them erased a word this rule exists to find. [Codex review R5 P2.]
  if (kind === "plain") return text;
  return text.replace(TAG, (tag, at) => {
    if (inRanges(at, code)) return tag;
    // In markdown a tag may not span a BLANK line: the paragraph ends there, and the renderer
    // escapes what is left. `Type \`<div\n\nclass="kernel-box">\`` comes back as
    // `<p>Type \`&lt;div</p><p>class="kernel-box"&gt;\` here.</p>` — the class is on the
    // screen. Blanking it as one tag erased a word a reader meets. The same rule the comment
    // reader and the code-span reader keep, in the third place it applies.
    if (kind === "markdown" && /\n[ \t]*\n/.test(tag)) return tag;
    let out = blank(tag);
    if (BLOCK_ELEMENT.test(tag)) out = HIDDEN_FILLER + out.slice(1);
    const keepsContent = contentIsText(tag);
    for (const m of tag.matchAll(VISIBLE_ATTRIBUTE)) {
      if (m[1].toLowerCase() === "content" && !keepsContent) continue;
      // …quoted or not: HTML allows `<img alt=kernel>`, and a screen reader reads it out.
      // [Codex review R7 P2.]
      const value = m[2] ?? m[3] ?? m[4] ?? "";
      // The value's offset inside the tag: the whole match, less the closing quote and the
      // value itself. Using the attribute NAME's offset instead is five characters out, and
      // nothing notices until a tag wraps and the value lands on the next line.
      const valueAt = m.index + m[0].length - value.length - (m[4] === undefined ? 1 : 0);
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

/**
 * `](…)` payloads, found by BALANCING the parentheses rather than stopping at the first `)`.
 *
 * Markdown allows them: `[detail](./foo(bar)-kernel.md)` renders as
 * `<a href="./foo(bar)-kernel.md">`, one URL. Stopping at the first `)` left `-kernel.md`
 * standing as prose and reported a page that is correct. A backslash escapes the next
 * character, and a payload that runs to the end of its line is not a link at all.
 * [Codex review R7 P2.]
 */
function maskInlineDestinations(text, code, maskPayload) {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== "]" || text[i + 1] !== "(") continue;
    // `\](…)` is not a link — the bracket is escaped, so the renderer shows the whole thing
    // and the words in it are copy. Nor is a `](` with no `[` opening it on the same line.
    // [Codex review R8 P2.]
    if (isEscaped(text, i) || !opensALink(text, i)) continue;
    let depth = 1;
    let j = i + 2;
    // An ANGLE destination is delimited, not balanced: `[x](<https://e.test/foo(kernel>)` is
    // one URL, and counting that `(` left the real closing paren unmatched — so a URL a
    // reader never sees was reported. [Codex review R8 P2.]
    if (text[i + 2] === "<") {
      const close = text.indexOf(">", i + 3);
      const nl = text.indexOf("\n", i + 2);
      if (close < 0 || (nl >= 0 && nl < close)) continue;
      // A TITLE may follow the destination, exactly as it may follow a bare one:
      // `[x](<https://e.test/kernel> "safe title")` is a link with a tooltip, and demanding
      // `)` immediately after the `>` rejected it and read the URL as prose.
      // [Codex review R10 P2.]
      const after = /^[ \t]*(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))?[ \t]*\)/.exec(text.slice(close + 1));
      if (!after) continue;
      j = close + 1 + after[0].length + 1;
      depth = 0;
    } else {
      for (; j < text.length && depth > 0; j++) {
        const ch = text[j];
        if (ch === "\\") j++;
        else if (ch === "\n") break;
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
    }
    if (depth !== 0) continue;
    const payload = text.slice(i + 2, j - 1);
    out += text.slice(from, i + 2);
    out += inRanges(i, code) ? payload : maskPayload(payload);
    from = j - 1;
    i = j - 2;
  }
  return out + text.slice(from);
}

/** Is the character at `at` preceded by an odd number of backslashes? */
function isEscaped(text, at) {
  let slashes = 0;
  while (at - 1 - slashes >= 0 && text[at - 1 - slashes] === "\\") slashes++;
  return slashes % 2 === 1;
}

/**
 * Is there an unmatched `[` that this `]` closes?
 *
 * BALANCED, not "is there a bracket somewhere": after `[first](url) prose ](the-kernel)` the
 * earlier pair has already closed, so the second fragment is literal text the renderer shows
 * — and masking it hid a visible word. [Codex review R9 P2.]
 *
 * And it may be on an EARLIER LINE: link text wraps, and this repo has one that does —
 * `docs/dashboard.md:44` begins a line with `model](./commands.md#config)`. Scanning only the
 * current line called that destination prose and read the URL as copy. Found by measuring the
 * corpus for this finding rather than by the finding. It stops at a blank line, which is
 * where the paragraph — and any link inside it — ends.
 */
function opensALink(text, at) {
  let closed = 0;
  for (let k = at - 1; k >= 0; k--) {
    const ch = text[k];
    if (ch === "\n" && /\n[ \t]*$/.test(text.slice(0, k))) return false;
    if (isEscaped(text, k)) continue;
    if (ch === "]") closed++;
    else if (ch === "[") {
      if (closed === 0) return true;
      closed--;
    }
  }
  return false;
}

/**
 * The entities this repo's hand-written HTML uses, kept as CHARACTERS and padded back out to
 * the length they had.
 *
 * A named one is a table lookup. A NUMERIC one is just a letter written the long way —
 * `ker&#110;el` is `kernel` on the screen, and `&#x6e;` is the same letter in hexadecimal —
 * so it is decoded, or a forbidden word could be spelled past this rule one character at a
 * time. [Codex review R8 P2.]
 *
 * One implementation, because there were two: a table here and three hard-coded replacements
 * in the gate rule's `plainClaim`, neither knowing about numbers. That is the shape this file
 * exists to stop.
 *
 * Exported so `check:mkdocs-parity` can compare the CHARACTERS this claims to preserve as
 * well as the words around them. An entity that decodes to a letter is already caught —
 * `caf&eacute;` masked to `caf ` loses a word — but one that decodes to punctuation is not,
 * and a lost `.` moves a sentence boundary, which is what the gate rule splits claims on.
 * Deriving the compared set from this table rather than listing it there means adding a row
 * here extends the check with it. [Codex review R2 P2.]
 */
export const NAMED_ENTITIES = {
  "&mdash;": "\u2014",
  "&ndash;": "\u2013",
  "&hellip;": "\u2026",
  "&amp;": "&",
  "&quot;": '"',
  "&nbsp;": " ",
};

export function decodeEntities(text) {
  return text.replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, (m) => {
    const numeric = /^&#(x)?([0-9a-f]+);$/i.exec(m);
    let ch;
    if (numeric) {
      const code = Number.parseInt(numeric[2], numeric[1] ? 16 : 10);
      ch = Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    } else {
      ch = NAMED_ENTITIES[m.toLowerCase()] ?? " ";
    }
    // A newline would change how many LINES the text has, which is the one thing every
    // caller here counts on; nothing else does. So this does NOT pad the decoded character
    // back out to the entity's length — padding is what kept `ker&#110;el` from reading as
    // one word, since the `n` arrived followed by five spaces. Length has never been the
    // invariant: a line number is a count of newlines, and the line a report quotes is
    // looked up by index. This runs last, after everything that compares offsets.
    return ch === "\n" || ch === "\r" ? " " : ch;
  });
}

/**
 * Inline code spans, paired by the LENGTH of their backtick runs.
 *
 * A span opened with two backticks closes on the next run of exactly two, and single
 * backticks inside it are literal — that is the whole point of the form: `` `<!-- x -->` ``
 * shows a reader a backtick. A matcher that closed at the first backtick it met left the
 * comment inside unprotected, and it was then masked as real markup. [Codex review R9 P2.]
 *
 * A span may wrap but not span a blank line, which is where the paragraph ends.
 */
function inlineSpans(text) {
  const runs = [...text.matchAll(/`+/g)].map((m) => [m.index, m[0].length]);
  const out = [];
  for (let i = 0; i < runs.length; i++) {
    const [start, len] = runs[i];
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j][1] !== len) continue;
      const end = runs[j][0] + len;
      if (/\n[ \t]*\n/.test(text.slice(start, end))) break;
      out.push([start, end]);
      i = j;
      break;
    }
  }
  return out;
}

/**
 * Where the tags are, so that a hidden region INSIDE one can be told from a real one.
 *
 * `<meta content="What the <!-- kernel --> decides">` holds those characters as literal
 * attribute text — the tokenizer never sees a comment, and the reader meets every word of
 * it in a search result. Masking it first hid copy the tag reader was about to restore.
 * [Codex review R9 P2.]
 */
function tagRanges(text) {
  return [...text.matchAll(TAG)].map((m) => [m.index, m.index + m[0].length]);
}

// --------------------------------------------------------------- the whole pipeline
//
// The functions above are steps; these are the composition, in one place, because it was
// previously written out at each call site and this file exists to stop one idea being kept
// in two spellings.
//
// The ORDER is the one both rules have always used, carried over unchanged. It is not
// defended here, because it turns out not to be defensible on today's evidence: swapping the
// two changes nothing across the 15 pages the parity check reads, its 19 construct fixtures,
// or `check:docs --self-test`. The one construct where a difference could be built — a
// markdown link inside an HTML comment — the renderer decides the OTHER way, resolving the
// link first, so the reasoning that would have justified this order was backwards. Left as
// it is because it is what shipped; changed only with a case that says which way is right.
//
// This composition is what `check:mkdocs-parity` compares against the renderer. One the
// parity check assembled for itself would be a fiction — it would verify an arrangement of
// these steps that nothing ships. Both rules call these, so the pipeline that is checked is
// the pipeline that runs.

/**
 * The spans a reader never meets, blanked: an HTML comment, a `<style>`, a `<script>`, and
 * what a markdown link points AT.
 *
 * Length- and newline-preserving, so an offset into the result is still an offset into the
 * file — which is what lets `gate-claims.mjs` slice this into claims and report a line.
 */
export function maskInvisible(text, { kind = "markdown" } = {}) {
  return maskLinkDestinations(maskHiddenMarkup(text, { kind }), { kind });
}

/**
 * The markup a reader sees THROUGH: every tag blanked down to the attribute values a person
 * really does meet, and every character reference decoded to the character it stands for.
 *
 * Separate from {@link maskInvisible} rather than folded into it because the gate rule needs
 * the text in between: it finds its claims by offset in the masked text and flattens each
 * claim on its own.
 */
export function flattenMarkup(text, { kind = "markdown" } = {}) {
  return decodeEntities(blankTags(text, codeRanges(text, { kind }), { kind }));
}

/**
 * What a reader meets, from raw file to readable text: {@link maskInvisible}, then
 * {@link flattenMarkup}.
 *
 * Still carries {@link HIDDEN_FILLER} where a hidden line or a block-level tag left one, and
 * still carries the emphasis characters — both are boundaries a caller may need, and both
 * are the caller's to strip before it prints.
 */
export function readerText(text, { kind = "markdown" } = {}) {
  return flattenMarkup(maskInvisible(text, { kind }), { kind });
}
