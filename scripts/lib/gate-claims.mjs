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
  return text
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[*_`>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split into claims.
 *
 * A colon is NOT a boundary. `And the gate holds at every level: notify and autonomous
 * stop and ask` is one claim wearing a colon, and splitting on it put the quantifier in one
 * fragment and the promise in the other, so neither fragment matched and a live defect in
 * `docs/getting-started.md` read as clean. Em dashes and semicolons are internal for the
 * same reason. Only `.`, `!`, `?` and a blank line end a claim.
 */
function claims(text) {
  const out = [];
  let at = 0;
  for (const piece of text.split(/(?<=[.!?])\s+|\n\n+/)) {
    const idx = text.indexOf(piece, at);
    if (idx >= 0) at = idx + piece.length;
    out.push({ text: piece, offset: idx < 0 ? at : idx });
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
 * The quantifier that attaches to the LEVEL — the one shape that is false in BOTH
 * directions, so it is named once and used twice: as a quantifier below, and as the test
 * for the `every-level` rule. Two spellings of one pattern is how a fix lands on one of
 * them and not the other.
 *
 * Matches `at every level`, `at every trust level`, `for all autonomy levels` — the
 * optional word is what a version allowing only `trust` missed, and it was false in
 * exactly the same way.
 */
const EVERY_LEVEL = /\b(at|for) (every|any|all)(\s+\w+)? levels?\b|\bgate holds\b/i;

const UNIVERSAL = [
  /\beven (an?|the) (autonomous|notify)\b/i,
  /whatever (the agent'?s?|its) (trust|autonomy) level/i,
  /regardless of (the agent'?s? |its )?(trust|autonomy)/i,
  EVERY_LEVEL,
  /independent of (the )?(trust|autonomy)/i,
  /\bautonomous included\b/i,
  /never happens without you/i,
  /\balways (pauses|stops|asks)\b/i,
  /\bevery destructive action\b/i,
  /\bstill (pauses?|stops?)\b/i,
  /\bno matter (how|what|which)\b/i,
];

/** The promise itself — that the run stops and puts the decision to a human. */
const PAUSE =
  /\bpauses?\b|\bpaused\b|stops? (dead )?(and asks?|to ask|before)|asks? (you )?first|your confirmation|explicit confirmation|needs? confirmation|never happens without you|stop and ask/i;

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
 *   - `you have NOT allowed` counts. The landing page states the exception by its
 *     contrapositive — "neither acts unasked on a capability you have not allowed it" —
 *     and a pattern demanding the positive spelling called the site's front page broken.
 *     A red over a correct sentence is the worse failure of the two: a green merely misses
 *     something, while a red gets a correct sentence "fixed" until the checker agrees.
 */
const EXCEPTION =
  /unless[^.]{0,140}(allow|grant|earn)|allow-listed|specifically allowed|you have (not )?allowed|(pauses?|stops?|asks?)[^.]{0,70}\bby default\b|\bearn(s|ed)? the (standing|right)/i;

/** `propose` named alongside the claim, which is what makes an every-level phrasing honest. */
const PROPOSE_QUALIFIED = /\bpropose\b[^.]{0,120}(never|not|no)\b|(never|not|no)\b[^.]{0,120}\bpropose\b/i;

/**
 * How far from the claim the exception may sit.
 *
 * The issue that found this measured 150 characters and so does this. It is deliberately
 * tighter than a paragraph: a qualification a reader meets three sentences later does not
 * un-promise the sentence they already believed. It is deliberately looser than the
 * sentence: the binary's own `AUTONOMY_HELP` — the site this repo holds up as the model —
 * puts the guarantee and its `unless` in two consecutive sentences, and a gate that failed
 * the model site would be measuring its own preference, not the truth.
 */
export const NEARBY = 150;

/**
 * Every overclaim in one page of copy.
 *
 * `text` is raw — markdown, HTML, or the binary's own `--help` output. Returns
 * `{ line, rule, sentence }`, `rule` being `every-level` or `no-exception`.
 */
export function gateOverclaims(text) {
  const masked = maskEvidenceBlocks(text);
  const found = [];
  for (const { text: piece, offset } of claims(masked)) {
    const claim = plainClaim(piece);
    if (!claim) continue;
    if (!UNIVERSAL.some((re) => re.test(claim))) continue;
    if (!PAUSE.test(claim)) continue;

    const window = plainClaim(masked.slice(Math.max(0, offset - NEARBY), offset + piece.length + NEARBY));
    if (!DESTRUCTIVE.test(window)) continue;
    const line = masked.slice(0, offset).split("\n").length;
    const sentence = claim.length > 240 ? `${claim.slice(0, 237)}...` : claim;

    // A pause asserted at EVERY level has to say what `propose` does instead, because at
    // `propose` there is no pause to wait for.
    if (EVERY_LEVEL.test(claim) && !PROPOSE_QUALIFIED.test(window)) {
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
