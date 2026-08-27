// One pass of a checker — what it found, what it prints, and whether it stops the build —
// as a single registration rather than three statements written three places apart.
//
// `scripts/docs-commands-check.mjs` used to write those three separately: a heading over
// the findings, a green sentence in the `else`, and a term in a hand-written chain at the
// very end of the file —
//
//   if (groups.failures.length || links.broken.length || … || blockless.length) exit(1);
//
// Nothing proved a term was in that chain. The corpus is clean, so deleting one changed no
// verdict; it took planting a defect AND deleting its term to see anything, and then the
// finding printed in full above a passing build. Thirteen passes, one boolean, no fixture
// — measured on #186, reproduced for a second pass, so it was a property of the file and
// not of one check.
//
// Here, printing IS registering. `emit` is the only way a pass says what it found, and it
// records the count that `finish` reads. A pass left out of the list prints nothing at all,
// which is loud; the failure it replaces was a pass that printed and did not count, which
// is silent — and a silent false green over a real finding is the worst failure this
// checker has, the one it has already paid for twice (#165, #177).
//
// What this does NOT claim: that every check a file performs is registered. Nothing here
// can know about a check nobody wrote down. It claims that a REGISTERED pass with findings
// stops the build, and the caller's `--self-test` proves that over the real registration
// list rather than over an example.
//
// A registration is:
//
//   id          a stable name. The verdict names failing passes by it, so it is what a
//               reader sees when the build stops.
//   find()      the findings, as a list of lines. Empty means the pass is clean. Called
//               once, when the pass prints, so the work happens in report order.
//   heading(n)  the line printed above the findings. Receives how many there are.
//   green()     the sentence printed when there are none, or `null` for a pass that says
//               nothing when it is clean (a tripwire). `null` is explicit, not the
//               default: "I forgot" and "silence is this pass's green" must not look alike.
//   advisories() optional. Blocks printed either way that never fail the build — the
//               undecidable links, the off-site ones. `[[heading, lines], …]`.

/** A printable line: present and non-empty. Neither `undefined` nor `""` is one. */
export function isLine(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * A list of printable lines.
 *
 * The spread is load-bearing. `Array.prototype.every` SKIPS holes, so `new Array(1)` and
 * `[, "real"]` both satisfy `arr.every(isLine)` while having a length that counts them —
 * a pass reporting a finding it prints as `undefined`. Spreading materialises each hole as
 * `undefined`, which `isLine` rejects. [Codex review P2.]
 */
export function isLines(value) {
  return Array.isArray(value) && [...value].every(isLine);
}

/**
 * Refuse, loudly, at exit 2 — the code this repo's checkers reserve for "this script is
 * broken", as distinct from exit 1's "the thing being checked is". A malformed
 * registration is not a finding about the docs; it is a report that does not know what it
 * checked, and continuing would print a verdict nobody should believe.
 */
/**
 * What a value actually was, short enough to sit in a refusal.
 *
 * This runs only on its way to `refuse`, so it must not be the thing that fails: a `BigInt`
 * or a circular reference makes `JSON.stringify` throw, and it threw here — before the exit
 * 2 it was building the message for, leaving exit 1 and a raw `TypeError`. A describer that
 * can fail turns every refusal it serves into the misclassification the refusal exists to
 * prevent. [Codex review P2.]
 */
function describe(value) {
  try {
    const shown = JSON.stringify(value);
    return (shown === undefined ? String(value) : shown).slice(0, 80);
  } catch {
    try {
      return String(value).slice(0, 80);
    } catch {
      return `a ${typeof value} that cannot be printed`;
    }
  }
}

/**
 * Run one of a registration's callbacks, and refuse if it throws.
 *
 * This is the general form of the describer above, and it is written as one statement
 * because the first two attempts at this file each fixed one instance of it. NOTHING a
 * registration supplies can make this file exit 1: not `find`, not `heading`, not `green`,
 * not `advisories`, and not whatever field is added next. A check that cannot run is this
 * script's problem, and exit 1 is reserved for the documentation being wrong.
 */
function call(id, what, fn) {
  try {
    return fn();
  } catch (err) {
    // The stack goes with it — a named refusal that loses where it happened is a worse
    // trade than the bare stack trace this replaces.
    console.error(err?.stack ?? String(err));
    refuse(`pass '${id}' ${what}() threw: ${err?.message ?? describe(err)}`);
  }
}

function refuse(what) {
  console.error(`\nBUG IN THIS CHECKER: ${what}`);
  process.exit(2);
}

/**
 * Print one pass and record its verdict, in that order and in one call.
 *
 * **Every value a registration hands this function is checked before it is used — the
 * function, and what the function returns.** That is the whole rule, and it is written as a
 * rule because the first version of this file applied it to `find()` alone, with a
 * paragraph explaining why it mattered there, and left the same hole open one field over.
 *
 * Why it matters at all, in the words of the case that motivated it: every pass in the file
 * this was extracted from has a result to report, but two of them compute an OBJECT
 * (`{ broken, offSite, checked }`) and report one of its fields. Registering the object
 * itself would read as a pass with no findings, forever, on every run — `.length` on it is
 * `undefined`, which the chain this replaces treated exactly like zero. Nothing about that
 * argument is special to `find()`.
 *
 * Refusals are exit 2 rather than a thrown error, and that distinction is the point: in
 * this repo exit 1 means the thing being checked is wrong, and a checker that cannot report
 * must not be able to look like a page that is.
 */
export function emit(verdicts, pass) {
  if (!Array.isArray(verdicts)) refuse("emit() was handed something other than a list of verdicts");
  if (!isLine(pass?.id)) refuse("a pass was registered with no id; the verdict names failing passes by id");
  if (verdicts.some((v) => v.id === pass.id)) {
    refuse(`two passes are registered as '${pass.id}'; the verdict would name one of them for both`);
  }
  if (typeof pass.find !== "function") refuse(`pass '${pass.id}' has no find()`);
  if (typeof pass.heading !== "function") refuse(`pass '${pass.id}' has no heading()`);
  if (pass.green !== null && typeof pass.green !== "function") {
    refuse(`pass '${pass.id}' must declare \`green: null\` or a function; it declared ${typeof pass.green}`);
  }
  if (pass.advisories != null && typeof pass.advisories !== "function") {
    refuse(`pass '${pass.id}' declares advisories that are not a function`);
  }

  const findings = call(pass.id, "find", () => pass.find());
  if (!isLines(findings)) {
    refuse(
      `pass '${pass.id}' find() returned ${describe(findings)}, where a list of lines was` +
        ` expected. Anything else is read as "found nothing" on every run.`,
    );
  }

  verdicts.push({ id: pass.id, count: findings.length });

  if (findings.length) {
    const heading = call(pass.id, "heading", () => pass.heading(findings.length));
    if (!isLine(heading)) refuse(`pass '${pass.id}' heading() printed nothing over ${findings.length} finding(s)`);
    console.log(`\n${heading}`);
    for (const line of findings) console.log(`  ${line}`);
  } else if (pass.green) {
    const sentence = call(pass.id, "green", () => pass.green());
    if (!isLine(sentence)) refuse(`pass '${pass.id}' green() printed nothing`);
    console.log(sentence);
  }

  // Declaring no advisories and declaring some that come back as nothing are different
  // things, and `pass.advisories?.() ?? []` could not tell them apart: a function that
  // forgot its `return` dropped every advisory line and still reported clean, and one that
  // returned a non-iterable threw where nobody caught it — exit 1, which in this repo means
  // "the docs are wrong" rather than "the checker is". [Codex review P2.]
  if (pass.advisories) {
    const advisories = call(pass.id, "advisories", () => pass.advisories());
    if (!Array.isArray(advisories)) {
      refuse(
        `pass '${pass.id}' advisories() returned ${describe(advisories)}, where a list of` +
          ` [heading, lines] pairs was expected. A pass that declares advisories and produces` +
          ` none is reporting less than it says it does.`,
      );
    }
    for (const advisory of advisories) {
      if (!Array.isArray(advisory) || advisory.length !== 2) {
        refuse(`pass '${pass.id}' produced an advisory that is not a [heading, lines] pair: ${describe(advisory)}`);
      }
      const [heading, lines] = advisory;
      if (!isLines(lines)) refuse(`pass '${pass.id}' produced an advisory whose lines are ${describe(lines)}`);
      if (!lines.length) continue;
      if (!isLine(heading)) refuse(`pass '${pass.id}' produced ${lines.length} advisory line(s) under no heading`);
      console.log(`\n${heading}`);
      for (const line of lines) console.log(`  ${line}`);
    }
  }
}

/**
 * The passes that found something. This is the whole verdict; there is nothing else.
 *
 * The entry check is here, and not in `finish`, because this is the only place `count` is
 * read: an entry without one is `undefined > 0`, which is false — a pass that found
 * something reading as clean, which is the failure this whole file exists to remove.
 */
export function failing(verdicts) {
  if (!Array.isArray(verdicts)) refuse(`a verdict list was expected, and this is ${describe(verdicts)}`);
  for (const v of verdicts) {
    if (!isLine(v?.id) || !Number.isInteger(v?.count) || v.count < 0) {
      refuse(`a verdict is ${describe(v)}, where { id, count } was expected`);
    }
  }
  return verdicts.filter((v) => v.count > 0);
}

/**
 * Say how it went and exit accordingly. The failing passes are NAMED: a report this long
 * makes "exit 1" a scroll hunt otherwise, and the name is the id the registration carries,
 * so the summary cannot drift from what printed.
 */
export function finish(verdicts, green) {
  if (!isLine(green)) refuse("finish() was given no sentence to print when everything is clean");
  const failed = failing(verdicts);
  if (failed.length) {
    console.log(
      `\n${failed.length} of ${verdicts.length} checks failed: ` +
        `${failed.map((v) => `${v.id} (${v.count})`).join(", ")}.`,
    );
    process.exit(1);
  }
  console.log(green);
  console.log(`All ${verdicts.length} checks in this report are clean.`);
}
