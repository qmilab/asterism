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
 * Refuse, loudly, at exit 2 — the code this repo's checkers reserve for "this script is
 * broken", as distinct from exit 1's "the thing being checked is". A malformed
 * registration is not a finding about the docs; it is a report that does not know what it
 * checked, and continuing would print a verdict nobody should believe.
 */
function refuse(what) {
  console.error(`\nBUG IN THIS CHECKER: ${what}`);
  process.exit(2);
}

/**
 * Print one pass and record its verdict, in that order and in one call.
 *
 * The `find()` shape check is not ceremony. Every pass in the file this was extracted from
 * has a result to report, but two of them compute an OBJECT (`{ broken, offSite, checked }`)
 * and report one of its fields. Registering the object itself would read as a pass with no
 * findings, forever, on every run — `.length` on it is `undefined`, which the chain this
 * replaces treated exactly like zero.
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

  const findings = pass.find();
  if (!Array.isArray(findings) || !findings.every(isLine)) {
    refuse(
      `pass '${pass.id}' find() returned ${JSON.stringify(findings)?.slice(0, 80) ?? typeof findings},` +
        ` where a list of lines was expected. Anything else is read as "found nothing" on every run.`,
    );
  }

  verdicts.push({ id: pass.id, count: findings.length });

  if (findings.length) {
    const heading = pass.heading(findings.length);
    if (!isLine(heading)) refuse(`pass '${pass.id}' heading() printed nothing over ${findings.length} finding(s)`);
    console.log(`\n${heading}`);
    for (const line of findings) console.log(`  ${line}`);
  } else if (pass.green) {
    const sentence = pass.green();
    if (!isLine(sentence)) refuse(`pass '${pass.id}' green() printed nothing`);
    console.log(sentence);
  }

  for (const advisory of pass.advisories?.() ?? []) {
    const [heading, lines] = advisory ?? [];
    if (!Array.isArray(lines) || !lines.every(isLine)) refuse(`pass '${pass.id}' printed an advisory that is not a list of lines`);
    if (!lines.length) continue;
    if (!isLine(heading)) refuse(`pass '${pass.id}' printed ${lines.length} advisory line(s) under no heading`);
    console.log(`\n${heading}`);
    for (const line of lines) console.log(`  ${line}`);
  }
}

/** The passes that found something. This is the whole verdict; there is nothing else. */
export function failing(verdicts) {
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
