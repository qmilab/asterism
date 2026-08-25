// The destructive-action gate, as the copy is allowed to state it.
//
// The gate is one line of the kernel (`packages/core/src/trust.ts`, `decideGate`):
//
//   if (effect === "destructive" && !profile.autoApprove.has(action.capability)) {
//     return profile.level === "propose" ? "withhold" : "confirm";
//   }
//
// Read it and there are TWO ways a sentence can promise more than it delivers, and this
// repo has now shipped both — the second one installed by the fix for the first:
//
//   every-level   "a destructive action pauses at every trust level". False at `propose`,
//                 which WITHHOLDS the action and hands over a plan. Nothing is asked, so a
//                 reader waiting to be asked waits forever. Found in eight places at once
//                 (#139), five of them in the binary.
//   no-exception  "even an `autonomous` agent pauses" / "never happens without you", with
//                 no mention of the allow-list. False for any capability in `autoApprove`
//                 — which earned standing really does fill (`run.ts`), so an operator who
//                 accepted a `trust <agent> --review` grant on `fs.delete` gets deletions
//                 with no prompt. That is the feature working; the copy just did not say so.
//
// The second was written INTO this repo by the correction for the first: #176 rewrote the
// `propose` overclaim and, in doing so, stated the `autonomous` half as an unconditional
// guarantee. #177 is that mirror. Which is why both rules live in one function over one
// corpus rather than in two guards that can drift apart — fixing one must not be able to
// break the other silently, and a sentence can be wrong in both ways at once.
//
// WHAT THIS DOES NOT ASK FOR. It does not demand the allow-list clause on every mention of
// the gate. Most mentions are passing references whose point is something else entirely
// ("a container does not loosen this"), and burying the clause in each would make the gate
// read as weaker than it is. It fires only on a sentence that makes the pause UNIVERSAL —
// a guarantee. A passing reference silences it not by adding a clause but by becoming
// RELATIVE ("this surface changes nothing about the gate"), which is true whether or not
// the capability is allow-listed and has no mirror to install later.
//
// That restriction is MEASURED, not assumed, because a sentence explaining why a check is
// narrow is exactly where this repo has hidden defects before. Dropping the quantifier
// requirement — firing on any pause promise about a destructive action — reports **43**
// sentences across the pages and the shipped help. Reading them: two were real overclaims
// and were fixed; the rest are conditional ("WHEN a destructive action pauses a run,
// confirm it with…"), or descriptions of a verb that presupposes a pause already happened,
// or statements about how BOUNDED an approval is — all true whether or not the capability
// is allow-listed. Demanding the clause on all 43 is the outcome the issue that raised
// this explicitly ruled out.

import { blankTags, HIDDEN_FILLER, maskHiddenMarkup } from "./copy-text.mjs";

/**
 * Strip the typography and read the CLAIM.
 *
 * `*every*`, `**pauses**` and `` `autonomous` `` are the same words a reader sees, and a
 * matcher that does not know it is blind in a way no eyeball review catches: the first
 * version of this sweep missed `The gate pauses *every* destructive action` because two
 * asterisks sat between `every` and `destructive`. Same failure as looking for `Node 20`
 * in a page that percent-encodes it.
 *
 * HTML tags go too, because the landing page — the page a reader arrives at FIRST — is
 * hand-written HTML, and it carried this exact defect.
 */
export function plainClaim(text) {
  // Tags out — but NOT the attribute values a reader meets without viewing source. The
  // landing page's Open Graph description is the sentence a social preview shows, and a gate
  // promise made there is made to a reader. See `blankTags`. [Codex review R3 P2.]
  return blankTags(text)
    // The filler a masked-out comment or stylesheet leaves on each of its lines, so that a
    // hidden region cannot split a visible paragraph. Out before anything is matched or
    // printed. See `copy-text.mjs`.
    .replace(new RegExp(HIDDEN_FILLER, "g"), " ")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[*_`>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The blocks a reader takes in as separate statements: a paragraph, a table row, a list
 * item, a heading.
 *
 * This is a CLAIM boundary as much as a scope for qualifiers. `README.md`'s feature table
 * puts a whole feature on one line, and a sentence splitter alone ran the gate row together
 * with the row above it — so the claim's offset landed in the previous row and the block
 * scoping below judged it against the wrong text. A row is not a continuation of the row
 * before it.
 */
function blocks(text) {
  const lines = text.split("\n");
  const starts = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  // A row, a bullet, a numbered item or a heading BEGINS a block. Its wrapped continuation
  // lines do not, so a table cell or list item that spans lines stays whole.
  const opens = (line) => /^\s*(?:\||[-*+]\s|\d+[.)]\s|#{1,6}\s)/.test(line);
  const out = [];
  let first = null;
  const close = (i) => {
    if (first !== null) out.push([starts[first], starts[i] + lines[i].length]);
    first = null;
  };
  lines.forEach((line, i) => {
    if (/^\s*$/.test(line)) {
      if (i > 0) close(i - 1);
      first = null;
      return;
    }
    if (opens(line)) {
      if (i > 0) close(i - 1);
      first = i;
      return;
    }
    if (first === null) first = i;
  });
  if (first !== null) close(lines.length - 1);
  return out;
}

/**
 * Split into claims, block by block.
 *
 * A colon is NOT a sentence boundary. `And the gate holds at every level: notify and
 * autonomous stop and ask` is one claim wearing a colon, and splitting on it put the
 * quantifier in one fragment and the promise in the other, so neither matched and a live
 * defect in `docs/getting-started.md` read as clean. Em dashes and semicolons are internal
 * for the same reason. Only `.`, `!`, `?` — and the end of a block — end a claim.
 */
function claims(text) {
  const out = [];
  for (const [from, to] of blocks(text)) {
    const slice = text.slice(from, to);
    let at = 0;
    for (const piece of slice.split(/(?<=[.!?])\s+/)) {
      const idx = slice.indexOf(piece, at);
      if (idx >= 0) at = idx + piece.length;
      out.push({ text: piece, offset: from + (idx < 0 ? at : idx), block: [from, to] });
    }
  }
  return out;
}

/**
 * Blank out the `> **Evidence**` blocks, preserving length so offsets and line numbers
 * still land.
 *
 * Those blocks quote TEST TITLES verbatim, and `check:safety-case` requires each quoted
 * title to match a test that ran and passed — exactly, on purpose, so that the cheapest
 * way to green a broken citation is to open the real test. If this gate could fire inside
 * one, the cheapest way to green THIS would be to rename a kernel test until the prose gate
 * agreed. That is how a wrong instrument certifies damage (it has happened here once
 * already, to four correct links). The two gates cover each other instead: safety-case
 * guarantees a block holds nothing but citations, so exempting the block exempts exactly
 * the quoted titles and nothing else.
 *
 * `"a delegated call always pauses — at notify AND at autonomous, and standing cannot buy
 * it out"` is the one that makes this concrete: it is unconditionally true (a delegated
 * call is the one destructive action earned standing can NOT buy out), it names a real
 * test, and a gate that demanded an allow-list clause on it would be demanding a lie.
 */
export function maskEvidenceBlocks(text) {
  const lines = text.split("\n");
  let inBlock = false;
  return lines
    .map((line) => {
      if (/^>?\s*\*\*Evidence\b/.test(line)) inBlock = true;
      else if (!line.trimStart().startsWith(">")) inBlock = false;
      return inBlock ? " ".repeat(line.length) : line;
    })
    .join("\n");
}

/**
 * The quantifiers that turn a description into a guarantee. Each one asserts the pause
 * holds across trust levels, or for `autonomous` specifically — the shape a reader takes
 * as a promise rather than as an example.
 */
/**
 * Every way this repo quantifies over the three LEVELS. Named once and used twice — as a
 * quantifier below, and as half the test for the `every-level` rule — because two
 * spellings of one pattern is how a fix lands on one of them and not the other.
 *
 * The first version listed only `at every … level(s)`, and the other four spellings were
 * quantifiers but not level-wide tests. So `pauses … regardless of the agent's autonomy
 * level` — the threat model's own headline sentence — was never checked for the `propose`
 * half at all, while the identical claim spelled `at every trust level` was. Equivalent
 * sentences have to be judged equivalently or the rule is a rule about phrasing.
 *
 * `(\s+\w+)?` is what lets `at every TRUST level` and `for all AUTONOMY levels` match; a
 * version allowing only the word `trust` missed the other, and it was false the same way.
 */
const LEVEL_WIDE_PHRASE =
  /\b(at|for) (every|any|all)(\s+\w+)? levels?\b|\bgate holds\b|whatever (the agent'?s?|its) (trust|autonomy) level|regardless of (the agent'?s? |its )?(trust|autonomy)|independent of (the )?(trust|autonomy)/i;

/**
 * The three levels, named here and checked against the kernel's own `TRUST_LEVELS` by
 * `check:docs --self-test`. Hard-coded rather than imported because this module is pure —
 * `help.test.ts` uses it with no build — so the self-test is what stops the list drifting.
 */
export const TRUST_LEVEL_NAMES = ["propose", "notify", "autonomous"];

/**
 * A claim is level-wide if it says so, OR if it simply LISTS all three levels and then
 * promises a pause.
 *
 * `README.md`'s feature table did the second: "`propose` / `notify` / `autonomous` — with a
 * hard stop for your confirmation before anything irreversible". Naming the levels puts all
 * three in the frame just as firmly as the words "at every level" — and at `propose` there
 * is no stop for your confirmation, there is a plan. A rule that reads only the phrasings
 * is a rule about phrasing, which is the correction this file already made once.
 *
 * A sentence that enumerates the levels in order to DISTINGUISH them still passes, because
 * saying what `propose` does instead is exactly what {@link PROPOSE_QUALIFIED} looks for —
 * as the binary's own `AUTONOMY_HELP` does, naming all three in one paragraph.
 */
function levelWide(claim) {
  if (LEVEL_WIDE_PHRASE.test(claim)) return true;
  return TRUST_LEVEL_NAMES.every((name) => new RegExp(`\\b${name}\\b`, "i").test(claim));
}

const UNIVERSAL = [
  /\beven (an?|the) (autonomous|notify)\b/i,
  /\bautonomous included\b/i,
  /never happens without you/i,
  /\balways (pauses|stops|asks)\b/i,
  /\bevery destructive action\b/i,
  /\bstill (pauses?|stops?)\b/i,
  /\bno matter (how|what|which)\b/i,
];

/**
 * The run STOPS and puts the decision to a human — the promise that is false at `propose`,
 * where the action is withheld and nothing is ever asked.
 *
 * Kept apart from {@link PAUSE} because the difference decides the `every-level` rule. "A
 * destructive action never happens without you, whatever the agent's trust level" is TRUE
 * at `propose` — it does not happen. "A destructive action pauses for confirmation,
 * whatever the agent's trust level" is FALSE there. Same quantifier, opposite verdicts, and
 * only the verb tells them apart.
 */
const PAUSE_VERB =
  /\bpauses?\b|\bpaused\b|stops? (dead )?(and asks?|to ask)|stop and ask|asks? (you )?first|your confirmation|explicit confirmation|needs? confirmation/i;

/**
 * …or the weaker promise that it does not happen behind your back, which IS true at every
 * level. Derived from {@link PAUSE_VERB} rather than repeated, so widening one widens both.
 */
const PAUSE = new RegExp(`${PAUSE_VERB.source}|never happens without you|stops? before`, "i");

/**
 * The claim is about the destructive gate, not about some other pause.
 *
 * Matched against the NEIGHBOURHOOD, not the sentence. "Even an `autonomous` agent pauses
 * for your confirmation." names no destructive thing and is still exactly the promise this
 * rule exists to catch — the topic was set by the sentence before it. Requiring the word
 * inside the claim let that shape through, which is how the fixture for it was written and
 * then failed.
 */
const DESTRUCTIVE = /destructive|irreversible|\bdelet\w*|force-push/i;

/**
 * The exception, in the spellings this repo actually uses.
 *
 * Two calibrations, both made by running it over copy that was already right:
 *
 *   - `by default` counts only where it qualifies the pause itself (`pauses every
 *     destructive action by default`). Unanchored, it matched "By default the trace records
 *     references only" three pages away and excused four bare guarantees.
 *   - So does saying the exception CANNOT apply. "this one can never earn a standing
 *     grant" is the most complete way to address it there is, and a pattern that only knew
 *     `earn the standing` reported the one capability the kernel refuses to auto-approve —
 *     the delegated call — as though it had forgotten the exception it exists to deny.
 *   - `you have NOT allowed` counts. The landing page states the exception by its
 *     contrapositive — "neither acts unasked on a capability you have not allowed it" —
 *     and a pattern demanding the positive spelling called the site's front page broken.
 *     A red over a correct sentence is the worse failure of the two: a green merely misses
 *     something, while a red gets a correct sentence "fixed" until the checker agrees.
 */
const EXCEPTION =
  /unless[^.]{0,140}(allow|grant|earn)|allow-listed|specifically allowed|you have (not )?allowed|(pauses?|stops?|asks?)[^.]{0,70}\bby default\b|\bearn(s|ed)? (a|the) (standing|right)|\bearn its way out/i;

/**
 * What `propose` does INSTEAD, named alongside the claim — which is what makes a level-wide
 * phrasing honest.
 *
 * Both spellings count, because the copy uses both: the negative ("a `propose` agent does
 * not take one at all") and the positive ("`propose` hands you a plan"). A version wanting
 * only a negation reported `README.md`'s own quickstart note, which says exactly what
 * `propose` does and says it the other way round.
 */
const PROPOSE_ALTERNATIVE = /\b(never|not|no|plans?|diffs?|withholds?|withheld)\b/;
const PROPOSE_QUALIFIED = new RegExp(
  `\\bpropose\\b[^.]{0,120}${PROPOSE_ALTERNATIVE.source}|${PROPOSE_ALTERNATIVE.source}[^.]{0,120}\\bpropose\\b`,
  "i",
);

/**
 * How far from the claim the exception may sit.
 *
 * The issue that found this measured 150 characters and so does this. It is deliberately
 * tighter than a paragraph: a qualification a reader meets three sentences later does not
 * un-promise the sentence they already believed. It is deliberately looser than the
 * sentence: the binary's own `AUTONOMY_HELP` — the site this repo holds up as the model —
 * puts the guarantee and its `unless` in two consecutive sentences, and a gate that failed
 * the model site would be measuring its own preference, not the truth.
 *
 * Distance is only half of it. A qualifier qualifies a claim when a reader takes the two as
 * ONE statement, and no character count expresses that: `README.md`'s feature table put "a
 * hard stop for your confirmation … `autonomous` included" in one row and "an agent can
 * earn the right to take one capability without pausing" in the NEXT, forty characters
 * away — so a bare guarantee was excused by a different row about a different feature. The
 * walkthrough's numbered claims did the same across items 3 and 4. Both read as green. So
 * the window is also clipped to the claim's own {@link blocks} block.
 */
export const NEARBY = 150;

/**
 * Every overclaim in one page of copy.
 *
 * `text` is raw — markdown, HTML, or the binary's own `--help` output; `html` says which,
 * because a hidden region is a block boundary in one and invisible in the other. Returns
 * `{ line, rule, sentence }`, `rule` being `every-level` or `no-exception`.
 */
export function gateOverclaims(text, { html = false } = {}) {
  // What a reader never meets goes first: an HTML comment, a stylesheet, a script. The
  // landing page is hand-written HTML with thirteen comments and an inlined stylesheet, and
  // a note in one of them saying "a destructive action always pauses for your confirmation"
  // is a fact about the file, not a promise to anybody — this rule reported it as an
  // unqualified guarantee. No live instance; found by auditing the identical defect Codex
  // caught in the vocabulary rule next door, which reads the SAME corpus. Fixing one and
  // leaving the other is precisely the mirror this file exists because of.
  //
  // Length- and newline-preserving, because the line numbers below are offsets into this.
  // Evidence blocks FIRST. A multi-line HTML comment inside one would otherwise have its
  // `>` prefixes blanked away, so the citation reader saw a line that no longer began with
  // `>`, ended the block there, and read the quoted TEST TITLES below it as public claims.
  // [Codex review R4 P2.]
  const masked = maskHiddenMarkup(maskEvidenceBlocks(text), { html });
  const found = [];
  for (const { text: piece, offset, block: [blockFrom, blockTo] } of claims(masked)) {
    const claim = plainClaim(piece);
    if (!claim) continue;
    if (!UNIVERSAL.some((re) => re.test(claim)) && !levelWide(claim)) continue;
    if (!PAUSE.test(claim)) continue;

    const window = plainClaim(
      masked.slice(
        Math.max(blockFrom, offset - NEARBY),
        Math.min(blockTo, offset + piece.length + NEARBY),
      ),
    );
    if (!DESTRUCTIVE.test(window)) continue;
    const line = masked.slice(0, offset).split("\n").length;
    const sentence = claim.length > 240 ? `${claim.slice(0, 237)}...` : claim;

    // A pause asserted across the LEVELS has to say what `propose` does instead, because
    // at `propose` there is no pause to wait for. It is the pause VERB that makes the
    // claim false there — the same quantifier over "never happens without you" is true.
    if (levelWide(claim) && PAUSE_VERB.test(claim) && !PROPOSE_QUALIFIED.test(window)) {
      found.push({ line, rule: "every-level", sentence });
    }
    if (!EXCEPTION.test(window)) {
      found.push({ line, rule: "no-exception", sentence });
    }
  }
  return found;
}

/** What to print when one fires — the fix, not just the complaint. */
export const GATE_RULE_ADVICE = {
  "every-level": "at `propose` nothing pauses — the action is withheld and you get a plan; say so, or drop the quantifier",
  "no-exception":
    "an allow-listed capability does NOT pause — carry `unless you have allowed that capability for it` in the same sentence, or make the claim relative (`this changes nothing about the gate`)",
};
