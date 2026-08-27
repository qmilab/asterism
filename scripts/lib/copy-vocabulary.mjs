// Golden rule 7, as a predicate: public copy sells what the product DOES, not what its
// parts are called.
//
//   "README, CLI help text, and any user-facing string sell the behavioral outcome
//    (distinct agents, dialable autonomy, reviewable memory, separate lives). No internal
//    architecture vocabulary in user-facing text."                        — CLAUDE.md
//
// A guard for this already existed. `help.test.ts` joined `USAGE`, `AUTONOMY_HELP` and
// `COMMAND_HELP` and refused five words in the result — and read nothing else. It is named
// "public copy"; its corpus was the CLI's help text. So `kernel` sat in eight passages of
// published copy, the site's own front page among them, where the guard could not see it.
//
// That is the same shape as the destructive-action gate one file over (see
// `gate-claims.mjs`): a rule that is right about the wrong corpus reports zero forever. The
// fix is the same too — one predicate, applied to every page a user meets AND to the help
// the binary actually prints.
//
// WHAT MAKES THIS HARDER THAN WIDENING THE CORPUS. Three of the five words have a sense in
// which they are perfectly good user-facing English, and a list that fired on those would
// manufacture defects — which this repo has already paid for once, when a wrong slug rule
// got four correct links "fixed" until the checker agreed. So each word below names the
// sense it forbids AND the sense it allows, one page is exempt by name rather than by the
// corpus happening not to reach it, and one word came off the list entirely.
//
// WHAT THIS DOES NOT READ. Golden rule 7 says "any user-facing string", and this reads the
// pages and the help — not the messages the binary prints when something goes wrong. The
// residual was MEASURED rather than waved at, because a sentence explaining why a check is
// narrow is where this repo has hidden defects before. Scanning every non-comment string
// literal in every package for these words finds four:
//
//   · `store.ts`         "reserved for the kernel's own internal use" — REACHABLE, and it
//                        reached a terminal through `asterism api add --credential`. Fixed
//                        by giving that verb the plain-English refusal `secrets add` and
//                        `capabilities set` already print; the kernel keeps its own message
//                        as the backstop, where it is read by an embedder.
//   · `capabilities.ts`  "reserved for the kernel and is always available" — thrown for an
//                        embedder, and every CLI route to it (`capabilities set`,
//                        `capabilities remove`) refuses first, in the product's own words.
//                        Verified by typing both at the binary.
//   · `run.ts`           "Kernel-internal: …" — a tool description on a registry that is
//                        built, consumed and discarded inside one function. The confirmation
//                        prompt shows a capability and its arguments, never a description,
//                        and nothing else prints one.
//   · `db/schema.ts`     a SQL comment inside a DDL string.
//
// So a gate over thrown strings would open by reporting a message nobody meets — the
// "manufactures defects" failure this file exists to avoid — to catch one site that cost six
// words. The site was taken; the rule was not.

import { blank, HIDDEN_FILLER, readerText, wrappablePhrase } from "./copy-text.mjs";

/**
 * The words, each with the sense it is allowed in.
 *
 * A hand-written list is a claim, and nothing here can derive it — "kernel" is internal and
 * "surface" is not, and only a person can say which. What keeps this one honest is that
 * every entry carries the allowed sense next to the forbidden one, so the judgement is
 * written down where it fires instead of living in whoever last edited a page.
 *
 * `senses` are phrases masked out of the text BEFORE the word is looked for, built with
 * {@link wrappablePhrase} so that one hard wrap between the words is still the same phrase
 * and a BLANK LINE is not — a paragraph break starts a new statement, and `\s+` spanning one
 * masked a real claim out of existence.
 *
 * `firewall` used to be the fifth entry and is deliberately gone. **"The memory firewall"**
 * is what the product calls the thing, to the reader's face, in every surface that has one:
 * the binary prints it three times in `reflect --review` (`⚠ the memory firewall flagged
 * this…`, `⚠ your edit still trips the memory firewall…`, `⛔ blocked by the memory
 * firewall — not saved`), the dashboard prints `⚠ firewall flagged: …`, the local HTTP
 * endpoint answers a blocked write with `{"error": "Blocked by the memory firewall."}`, and
 * ten passages across four pages use it as the feature's name — including the sentence that
 * sells it, *"a memory firewall that flags anything unsafe to remember before you ever see
 * it"*. A word list that forbids what the product says out loud is wrong about the word: it
 * is a metaphor a reader already owns, and it describes an outcome rather than a component.
 * It stayed on the list only because the corpus never reached a page that used it. The
 * self-test keeps that decision falsifiable by running a real "memory firewall" sentence
 * through this and expecting nothing.
 */
export const INTERNAL_VOCABULARY = [
  {
    word: "kernel",
    pattern: /\bkernels?\b/gi,
    senses: [],
    instead:
      "name the product — `Asterism decides what it may do` — or the outcome the sentence is really about",
  },
  {
    word: "substrate",
    pattern: /\bsubstrates?\b/gi,
    senses: [],
    instead: "say what it does (`the model that drives the agent`), not what the band is called",
  },
  {
    word: "adapter",
    // A published package's NAME is not vocabulary; it is the string you type to install the
    // thing. `packages/adapter-pi/README.md` IS the npm page for
    // `@qmilab/asterism-adapter-pi` and its first line is that name. The names are not
    // listed here: the caller derives them from the manifests and passes them to
    // {@link vocabularyLeaks}, so renaming a package cannot leave a stale spelling exempt.
    pattern: /\badapters?\b/gi,
    senses: [],
    instead:
      "a published package's own name is fine; the component is not — say which runtime runs the agent",
  },
  {
    word: "registry",
    // A CONTAINER registry is a different thing spelled the same way: `container.md`
    // publishes the image to the GitHub Container Registry, and a reader pulling an image
    // meets that phrase everywhere. The forbidden one is the TOOL registry — the scoped list
    // of capabilities a run is handed.
    pattern: /\bregistr(?:y|ies)\b/gi,
    senses: [wrappablePhrase("container", "registr(?:y|ies)")],
    instead:
      "a container registry is fine; the tool registry is not — say which tools the agent has",
  },
];

/** Just the words, for a report that wants to say what it looked for. */
export const VOCABULARY_WORDS = INTERNAL_VOCABULARY.map((v) => v.word);

/**
 * The one page where naming the component is the point.
 *
 * `docs/threat-model.md` is the published safety case. It exists to say WHERE each guarantee
 * is enforced — "the kernel/substrate boundary is what keeps the model loop from being the
 * security perimeter" is the document's thesis, not a slip — and it carries 17 `kernel`, 11
 * `substrate`, 6 `registry` and 3 `adapter` for that reason. A gate firing there would be
 * asking a security document to stop naming the thing it is about.
 *
 * Exempt BY NAME, here, beside the rule. It was exempt before this existed too — by the
 * corpus stopping at the binary — and an exception that holds only because nothing looks is
 * indistinguishable from a rule nobody has tested. `check:docs --self-test` asserts both
 * halves: that the page really does carry the vocabulary (an exemption for a page that no
 * longer needs one is dead and should be deleted), and that the same sentence on any other
 * page still fires.
 *
 * It is the whole page rather than a list of words, because all four are load-bearing there.
 * What that costs is stated rather than hidden: marketing prose written into the safety case
 * would go unchecked. That is the smaller risk, and it is the one page with a second gate of
 * its own — `check:safety-case` requires every claim on it to cite a test that passed.
 */
export const VOCABULARY_EXEMPT_PAGES = ["docs/threat-model.md"];

/** Whether this repo-relative path is exempt. See {@link VOCABULARY_EXEMPT_PAGES}. */
export function isVocabularyExempt(rel) {
  return VOCABULARY_EXEMPT_PAGES.includes(rel);
}

/** Blank out every match. See {@link blank} for what "blank" has to preserve. */
function mask(text, pattern) {
  return text.replace(pattern, blank);
}

/**
 * Strip the typography, keeping every LINE where it was.
 *
 * The same discipline `gate-claims.mjs` keeps, for the same reason: `**kernel**` and
 * `<strong>kernel</strong>` are the word a reader sees, and the site's front page — the page
 * a reader arrives at FIRST — is hand-written HTML where every phrase has tags in it.
 *
 * A single word survives emphasis on its own (`\b` holds against an asterisk), so it would
 * be easy to think this only affects how a finding is PRINTED. It does not. The allowed
 * senses are multi-word — `container registry` — and `container <em>registry</em>` is the
 * same phrase to a reader and two different ones to a matcher. So the scan runs on this,
 * not on the raw text.
 *
 * The invariant is the NEWLINE count, not the length. Every step blanks in place except
 * `decodeEntities`, which shortens — `ker&#110;el` has to come out as one word, not as a
 * letter followed by five spaces — and it runs last, after everything that compares offsets.
 * A line number is a count of newlines, and the line a report quotes is looked up by index.
 */
function flatten(text, kind) {
  // What the markup HIDES goes first and whole — a comment, a stylesheet, a script, a link
  // destination — and then what a reader sees THROUGH: a tag blanked down to the `alt`,
  // `title`, `aria-label` and `<meta content>` a person really meets, and every character
  // reference decoded. A rule about what the copy SAYS that fired on a CSS class would be
  // asking someone to rename it to satisfy a prose gate. [Codex review R1 P2.]
  //
  // The steps and their ORDER live in `copy-text.mjs`, where `check:mkdocs-parity` compares
  // the whole pipeline against the renderer that serves the page. What is left here is this
  // rule's own business:
  //
  // The filler a hidden line — and a block-level tag — is left holding STAYS: it is what
  // stops an allowed phrase reading across a boundary a reader sees. It is not whitespace
  // and not a word character, so it changes no word match; `readableLine` takes it out
  // before anything is printed. [Codex review R10 P2.]
  return readerText(text, { kind }).replace(/[*_`>]/g, " ");
}


/**
 * One line of the original, as a reader would see it — for the report, where collapsing
 * whitespace is what makes a finding legible rather than a problem.
 */
export function readableLine(text, kind = "markdown") {
  return (
    flatten(text, kind)
      .replace(new RegExp(HIDDEN_FILLER, "g"), " ")
      .replace(/\s+/g, " ")
      // Markup sits between a word and its punctuation more often than not —
      // `<strong>kernel</strong>,` blanks to `kernel ,` — and a report that quotes a sentence
      // nobody wrote is a report the reader cannot search the page for.
      .replace(/ ([,.;:!?])/g, "$1")
      .trim()
  );
}

/**
 * Every internal-vocabulary word in one piece of copy.
 *
 * `text` is raw, and `kind` says how to read it — `"markdown"`, `"html"`, or `"plain"` for a
 * help screen or an npm description, which are not markup at all and must not have their
 * `<placeholders>` read as tags. `packageNames` are
 * the names npm publishes this repo under; each is masked before the scan, because a
 * package's name is what a reader types to install it rather than something the copy chose
 * to say. A caller that is not looking at a page passes none.
 *
 * Returns `{ line, word, sentence, instead }`, one per occurrence.
 */
export function vocabularyLeaks(text, { packageNames = [], kind = "markdown" } = {}) {
  // Markup out first, and same-length, so a phrase split by emphasis or tags is still one
  // phrase and a line number is still a line number.
  let masked = flatten(text, kind);
  // LONGEST FIRST, and this is not a tidiness preference: `@qmilab/asterism` is itself a
  // published name and a prefix of all seven others, so masking it first leaves
  // `-adapter-pi` standing and reports the adapter's own npm page — a red over a correct
  // page, the failure this file is most concerned with.
  //
  // …and bounded, which is the same mistake pointing the other way: unbounded, a token that
  // merely BEGINS with a published name — `@qmilab/asterism-adapter-pipeline`, or a typo
  // like `…-adapter-pi2` — has the real name blanked out of the middle of it, `adapter`
  // included, and the leak is never reported. The exemption is for a package's actual
  // published name, not for anything that starts with one. [Codex review R1 P2.]
  //
  // `/` is deliberately NOT a boundary character, and the reason is a FUTURE site rather
  // than a present one — which is worth saying precisely, because a sentence explaining why
  // a check is narrow is where this repo keeps hiding defects. Measured: every mention
  // preceded by a slash in today's copy is `@qmilab/asterism` inside an npm URL, and that
  // name carries no forbidden word, so making `/` a boundary reds nothing right now. What it
  // would red is `npmjs.com/package/@qmilab/asterism-adapter-pi` — the obvious next line for
  // an adapter README to add, since every other package README already links to npm this
  // way, one word short of this. The self-test carries that URL as a fixture, so the choice
  // is falsifiable instead of merely explained.
  //
  // `.` is a boundary only when no name character follows it — see the lookahead below.
  const NAME_CHAR = "[A-Za-z0-9_-]";
  for (const name of [...packageNames].sort((a, b) => b.length - a.length)) {
    const literal = name.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    // A DOT continues the token when a name character follows it and ends a sentence when
    // one does not. `@qmilab/asterism-adapter-pi.next` is not a package this publishes, and
    // treating its dot as a boundary blanked the real name out of the middle of it —
    // `adapter` with it — so the leak went unreported. `Install …-adapter-pi.` at the end of
    // a sentence is still the name. [Codex review R2 P2.]
    const after = `(?!${NAME_CHAR}|\\.${NAME_CHAR})`;
    masked = mask(masked, new RegExp(`(?<!${NAME_CHAR})${literal}${after}`, "gi"));
  }
  for (const { senses } of INTERNAL_VOCABULARY) {
    for (const sense of senses) masked = mask(masked, sense);
  }

  const lines = text.split("\n");
  const found = [];
  for (const { word, pattern, instead } of INTERNAL_VOCABULARY) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(masked))) {
      const line = masked.slice(0, m.index).split("\n").length;
      // The line the word sits on, as a reader would see it: enough to recognise the
      // sentence without opening the file, and truncated so one bad page cannot fill the
      // terminal and scroll the rest of the report away.
      const sentence = readableLine(lines[line - 1] ?? "", kind);
      found.push({
        line,
        word,
        sentence: sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence,
        instead,
      });
    }
  }
  return found.sort((a, b) => a.line - b.line || a.word.localeCompare(b.word));
}
