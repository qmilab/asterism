// `asterism api` — binding a credential to an outbound endpoint (#123, PR 2).
//
// The CLI half of the credential-bearing class. The kernel half (isolation, the gate,
// the two standing locks, the response pipeline) is `core/credential-capability.test.ts`;
// what is proved here is the SURFACE, which is where every finding of PR 1 landed:
//
//   · the verbs do what they say, and refuse what they cannot do;
//   · every view that states a count says what it does NOT count;
//   · every string that names a command names one that works;
//   · a mistyped option is refused rather than swallowing a URL.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliIO } from "./cli.js";
import { runCli } from "./cli.js";
import { workspaceCapabilities } from "./capabilities.js";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface Harness {
  io: CliIO;
  out: string[];
  err: string[];
  dir: string;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "asterism-api-"));
  tempDirs.push(dir);
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      cwd: dir,
      env: {},
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      capabilities: workspaceCapabilities,
    },
    out,
    err,
    dir,
  };
}

/** An initialized install with one agent and one stored credential. */
async function install(): Promise<Harness> {
  const h = harness();
  await runCli(["init"], h.io);
  await runCli(["new", "work", "--trust", "autonomous"], h.io);
  await runCli(["secrets", "add", "work", "GITHUB_TOKEN", "tok-abcdefgh"], h.io);
  h.out.length = 0;
  h.err.length = 0;
  return h;
}

const URL_A = "https://api.example.test/issues?state=open";

// --- add ----------------------------------------------------------------------

test("api add states the grant: the credential, the destination, and that it always asks", async () => {
  const h = await install();

  expect(
    await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io),
  ).toBe(0);

  const out = h.out.join("\n");
  expect(out).toContain("Bound api.issues for work");
  expect(out).toContain("send credential GITHUB_TOKEN to api.example.test");
  expect(out).toContain(
    "No call happens without you: at notify and autonomous it pauses and asks; a propose agent only ever plans it.",
  );
  // The value is never echoed, on any path.
  expect(out).not.toContain("tok-abcdefgh");
});

test("api add warns — but does not refuse — when the credential is not stored yet", async () => {
  const h = await install();

  expect(
    await runCli(["api", "add", "work", "issues", URL_A, "--credential", "NOT_STORED"], h.io),
  ).toBe(0);

  expect(h.out.join("\n")).toContain("no credential 'NOT_STORED' is stored for work yet");
  // Binding before storing is a legitimate order, so the binding really did land.
  h.out.length = 0;
  await runCli(["api", "list", "work"], h.io);
  expect(h.out.join("\n")).toContain("api.issues");
});

test("api add refuses http, a URL carrying a password, and a bad name", async () => {
  const h = await install();

  expect(
    await runCli(
      ["api", "add", "work", "issues", "http://api.example.test/x", "--credential", "GITHUB_TOKEN"],
      h.io,
    ),
  ).toBe(1);
  expect(h.err.join("\n")).toContain("only https is supported");

  h.err.length = 0;
  expect(
    await runCli(
      ["api", "add", "work", "issues", "https://u:p@api.example.test/x", "--credential", "GITHUB_TOKEN"],
      h.io,
    ),
  ).toBe(1);
  expect(h.err.join("\n")).toContain("username or password");

  h.err.length = 0;
  expect(
    await runCli(["api", "add", "work", "Issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io),
  ).toBe(1);
  expect(h.err.join("\n")).toContain("lowercase letters, digits and dashes");
});

test("api add refuses a --credential with no value rather than binding the string 'true'", async () => {
  const h = await install();

  // `--credential` at the end parses to boolean true; binding that would name a
  // credential nobody stored and fail much later, for a reason nobody would connect.
  expect(await runCli(["api", "add", "work", "issues", URL_A, "--credential"], h.io)).toBe(1);
  expect(h.err.join("\n")).toContain("needs --credential <KEY>");
});

test("a mistyped option is refused, not allowed to swallow the URL", async () => {
  const h = await install();

  // `--credental <URL>` would consume the URL as the flag's value, leaving the operator
  // hunting a missing URL they had typed. PR 1 paid for this three times.
  expect(
    await runCli(["api", "add", "work", "issues", "--credental", URL_A], h.io),
  ).toBe(1);
  expect(h.err.join("\n")).toContain("does not take --credental");
});

test("api add re-binds a name in place rather than accumulating", async () => {
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);
  await runCli(
    ["api", "add", "work", "issues", "https://other.test/x", "--credential", "GITHUB_TOKEN"],
    h.io,
  );

  h.out.length = 0;
  await runCli(["api", "list", "work"], h.io);
  const out = h.out.join("\n");
  expect(out).toContain("1 bound endpoint");
  expect(out).toContain("https://other.test/x");
  expect(out).not.toContain(URL_A);
});

// --- list ---------------------------------------------------------------------

test("api list shows what each call sends, and flags a credential that is not stored", async () => {
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);
  await runCli(["api", "add", "work", "orders", "https://o.test/o", "--credential", "GONE"], h.io);

  h.out.length = 0;
  expect(await runCli(["api", "list", "work"], h.io)).toBe(0);
  const out = h.out.join("\n");
  expect(out).toContain("2 bound endpoints");
  expect(out).toContain(`calls    ${URL_A}`);
  expect(out).toContain("sends    GITHUB_TOKEN");
  expect(out).toContain("NOT STORED");
  expect(out).not.toContain("tok-abcdefgh");
});

test("api list on an agent with none names the command that binds one", async () => {
  const h = await install();

  expect(await runCli(["api", "list", "work"], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("work has no bound endpoints.");
  expect(h.out.join("\n")).toContain("asterism api add work <name> <https-url> --credential <KEY>");
});

// --- remove -------------------------------------------------------------------

test("api remove withdraws the binding and leaves the credential alone", async () => {
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);

  h.out.length = 0;
  expect(await runCli(["api", "remove", "work", "issues"], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("Removed api.issues from work");
  expect(h.out.join("\n")).toContain("credential itself is untouched");

  // The credential is genuinely still there: re-binding needs no re-add.
  h.out.length = 0;
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);
  expect(h.out.join("\n")).not.toContain("no credential");
});

test("api remove accepts the capability key `capabilities show` prints", async () => {
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);

  expect(await runCli(["api", "remove", "work", "api.issues"], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("Removed api.issues from work");
});

test("api remove names the listing command when there is no such binding", async () => {
  const h = await install();

  expect(await runCli(["api", "remove", "work", "nope"], h.io)).toBe(1);
  expect(h.err.join("\n")).toContain("has no bound endpoint 'nope'");
  expect(h.err.join("\n")).toContain("asterism api list work");
});

// --- the views that state a count ---------------------------------------------

test("capabilities show lists a bound endpoint in its own block, not as an unbuildable key", async () => {
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);

  h.out.length = 0;
  expect(await runCli(["capabilities", "show", "work"], h.io)).toBe(0);
  const out = h.out.join("\n");
  expect(out).toContain("Credential-bearing (bound by you, never auto-approved)");
  expect(out).toContain(`✓ api.issues  →  ${URL_A}  (sends GITHUB_TOKEN)`);
  // NOT reported as something this install cannot build: the kernel builds it.
  expect(out).not.toContain("api.issues  (this install builds no such tool)");
  expect(out).not.toContain("(+1 this install does not build)");
  // The host-catalog count is unchanged by a binding.
  expect(out).toContain("holds all 9 in the catalog  [not narrowed]");
  expect(out).toContain("asterism api remove work <name>");
});

test("capabilities show flags a binding whose credential is not stored, exactly as api list does", async () => {
  // Two views of one fact must not disagree inside one install — the specific defect this
  // surface produced five times in PR 1. A ✓ with no credential behind it reads as
  // "this works", and it does not.
  const h = await install();
  await runCli(["api", "add", "work", "orders", "https://o.test/o", "--credential", "GONE"], h.io);

  h.out.length = 0;
  await runCli(["capabilities", "show", "work"], h.io);
  expect(h.out.join("\n")).toContain("✓ api.orders  →  https://o.test/o  (sends GONE)  — credential not stored");

  // …and the same binding with its credential present carries no flag.
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);
  h.out.length = 0;
  await runCli(["capabilities", "show", "work"], h.io);
  expect(h.out.join("\n")).toContain("✓ api.issues  →  " + URL_A + "  (sends GITHUB_TOKEN)");
  expect(h.out.join("\n")).not.toContain("(sends GITHUB_TOKEN)  — credential not stored");
});

test("every capabilities verb that reports a count says what it does not count", async () => {
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);
  const note = "Not counted above: 1 bound endpoint (api.issues)";

  for (const argv of [
    ["capabilities", "set", "work", "fs.read"],
    ["capabilities", "remove", "work", "fs.read"],
    ["capabilities", "unset", "work"],
    // …including `unset`'s early-return branch, which carried its own hardcoded copy in
    // PR 1 and was the one place the shared helper had not reached.
    ["capabilities", "unset", "work"],
  ]) {
    h.out.length = 0;
    expect(await runCli(argv, h.io)).toBe(0);
    expect(h.out.join("\n")).toContain(note);
  }
});

test("config show names an agent's bound endpoints alongside its capability count", async () => {
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);

  h.out.length = 0;
  expect(await runCli(["config"], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("work  →  all 9 in the catalog  + 1 bound endpoint  [not narrowed]");

  // And on the narrowed branch, which computes its line separately.
  await runCli(["capabilities", "set", "work", "fs.read"], h.io);
  h.out.length = 0;
  await runCli(["config"], h.io);
  expect(h.out.join("\n")).toContain("work  →  fs.read  + 1 bound endpoint  [narrowed to 1]");
});

// --- the one writer -------------------------------------------------------------

test("capabilities set and remove refuse a hand-typed api.* key, naming the verb that moves it", async () => {
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);

  for (const verb of ["set", "remove"]) {
    h.err.length = 0;
    expect(await runCli(["capabilities", verb, "work", "api.issues"], h.io)).toBe(1);
    const err = h.err.join("\n");
    expect(err).toContain("bound endpoints, which carry a credential");
    expect(err).toContain("Withdraw it with: asterism api remove work issues");
  }

  // And the binding is untouched — a refusal that half-applied would be worse than either
  // outcome. `remove` in particular WOULD have reported success and changed nothing.
  h.out.length = 0;
  await runCli(["api", "list", "work"], h.io);
  expect(h.out.join("\n")).toContain("api.issues");
});

test("a no-catalog host can still narrow an agent that has a bound endpoint", async () => {
  // `io.capabilities` is optional and its absence is a supported embedding. Without a
  // catalog, `capabilities remove` materializes the agent's FIRST declaration from what the
  // kernel resolves it to hold — which now includes bound endpoints, and those cannot be
  // declared. The operator asked to narrow and got a validation error naming a key they
  // never typed. [Codex R3.]
  const h = harness();
  delete h.io.capabilities;
  await runCli(["init"], h.io);
  await runCli(["new", "work", "--trust", "autonomous"], h.io);
  await runCli(["secrets", "add", "work", "TOK", "v"], h.io);
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "TOK"], h.io);
  h.out.length = 0;
  h.err.length = 0;

  expect(await runCli(["capabilities", "remove", "work", "fs.read"], h.io)).toBe(0);
  expect(h.err.join("\n")).not.toMatch(/invalid capability declaration/);
  expect(h.out.join("\n")).toContain("Removed fs.read from work");

  // The declaration that landed holds the other eight host keys and NOT the endpoint…
  h.out.length = 0;
  await runCli(["capabilities", "show", "work"], h.io);
  const shown = h.out.join("\n");
  expect(shown).toContain("[narrowed to 8]");
  // …and the binding still grants its capability, because a binding is not a declaration.
  expect(shown).toContain("✓ api.issues");
});

test("the offers list never names a key the next command refuses", async () => {
  // PR 1's first smoke finding, by a new route: bound endpoints are in the agent's resolved
  // set, so an unknown-key refusal listed `api.issues` among what the install "offers" —
  // while `capabilities set work api.issues` refuses it by name. [Codex R3.]
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);
  h.err.length = 0;

  expect(await runCli(["capabilities", "set", "work", "fs.reed"], h.io)).toBe(1);
  const offers = h.err.find((l) => l.startsWith("This install offers:"));
  expect(offers).toBeDefined();
  expect(offers).not.toContain("api.issues");
  expect(offers).toContain("fs.read");
});

test("every command the api.* refusal advertises actually runs", async () => {
  // `api remove` takes exactly ONE name, so a refusal naming several in one invocation
  // advertises a command that exits 1 — the fourth time in two PRs that a sentence naming a
  // command named one the product rejects. [Codex R3.]
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);
  await runCli(["api", "add", "work", "orders", "https://o.test/o", "--credential", "GITHUB_TOKEN"], h.io);
  h.err.length = 0;

  expect(await runCli(["capabilities", "remove", "work", "api.issues", "api.orders"], h.io)).toBe(1);
  const advised = h.err
    .filter((l) => l.startsWith("Withdraw it with: asterism "))
    .map((l) => l.replace("Withdraw it with: asterism ", "").split(" "));
  expect(advised).toHaveLength(2);
  for (const argv of advised) {
    h.err.length = 0;
    expect({ argv, code: await runCli(argv, h.io) }).toEqual({ argv, code: 0 });
  }
});

test("`capabilities set --none` leaves a bound endpoint, and says so", async () => {
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);

  h.out.length = 0;
  expect(await runCli(["capabilities", "set", "work", "--none"], h.io)).toBe(0);
  // The drastic-sounding verb must not imply a completeness it does not have.
  expect(h.out.join("\n")).toContain("Not counted above: 1 bound endpoint (api.issues)");

  h.out.length = 0;
  await runCli(["capabilities", "show", "work"], h.io);
  expect(h.out.join("\n")).toContain("✓ api.issues");
});

// --- the copy is a testable claim -------------------------------------------------

test("every command this surface's copy advertises exits 0", async () => {
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);

  // Extracted from the strings the verbs above print at an operator. A sentence that
  // names a command is a claim, and PR 1 shipped one that named a recovery the code
  // refused to perform.
  const advertised: string[][] = [
    ["api", "list", "work"],
    ["api", "add", "work", "other", "https://o.test/o", "--credential", "GITHUB_TOKEN"],
    ["secrets", "add", "work", "GONE", "x"],
    ["capabilities", "show", "work"],
    ["capabilities", "unset", "work"],
    ["trust", "work", "show"],
    ["api", "remove", "work", "issues"],
  ];
  for (const argv of advertised) {
    h.err.length = 0;
    expect({ argv, code: await runCli(argv, h.io) }).toEqual({ argv, code: 0 });
  }
});

test("the copy does not promise a confirmation prompt a `propose` agent never shows", async () => {
  // At `propose` the gate WITHHOLDS: nothing pauses and nobody is ever asked, so an
  // operator told "every call pauses for your confirmation" would wait for a prompt that
  // never arrives. The three places this surface describes when it asks must all say the
  // accurate thing — this is the "a string that names a behaviour is a testable claim"
  // rule applied to the one behaviour the whole class is sold on.
  const h = await install();
  await runCli(["api", "add", "work", "issues", URL_A, "--credential", "GITHUB_TOKEN"], h.io);
  h.out.length = 0;
  await runCli(["api", "list", "work"], h.io);
  await runCli(["api", "--help"], h.io);
  const copy = h.out.join("\n");

  expect(copy).not.toContain("at every trust level");
  expect(copy).toContain("a propose agent only ever plans it");
  expect(copy).toContain("a `propose` agent never calls at all");
});

test("api --help and an unknown subcommand both print the help", async () => {
  const h = await install();

  expect(await runCli(["api", "--help"], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("asterism api add");

  h.out.length = 0;
  expect(await runCli(["api", "nope"], h.io)).toBe(1);
  expect(h.out.join("\n")).toContain("asterism api add");
});
