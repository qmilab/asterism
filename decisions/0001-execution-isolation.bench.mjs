// EVIDENCE for decisions/0001-execution-isolation.md. NOT a gate, NOT shipped,
// NOT wired into CI — it is macOS-only and measures the host it runs on.
//
// It answers three questions the decision could not be written without:
//   1. Does macOS seatbelt (`sandbox-exec`) still deny, unsigned, on this host?
//   2. Can a JS runtime BOOT under a `(deny default)` profile?
//   3. What does a process boundary actually cost per tool call?
//
//   node decisions/0001-execution-isolation.bench.mjs
//   node decisions/0001-execution-isolation.bench.mjs --falsify
//
// `--falsify` removes the single deny line the security assertions rest on and
// requires the escape check to FAIL. Run it. A check that cannot fail is not one.
//
// It writes and removes a temporary directory under $HOME — deliberately, because
// a real agent workspace lives there, and re-allowing a path inside the denied
// subtree is the part of the profile most likely to break.
//
// When the tier in ADR-0001 is built, this is the skeleton of its acceptance test.

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { execPath as rawExecPath } from "node:process";

// CRITICAL: seatbelt matches on the REAL path. `tmpdir()` on macOS is
// /var/folders/... which is a symlink to /private/var/folders/... — a profile
// written against the symlinked form silently matches NOTHING and the sandbox
// appears to be a no-op. Realpath everything that reaches a profile.
// The root lives under $HOME on purpose: a real agent workspace does
// (~/.asterism/<agent>/), and the profile below denies $HOME wholesale and then
// re-allows the workspace. Re-allowing a path INSIDE a denied subtree is the part
// that could fail, so the bench must be arranged the way the product is.
const execPath = realpathSync(rawExecPath);
const root = realpathSync(mkdtempSync(join(realpathSync(homedir()), ".asterism-spike-bench-")));
const workspace = join(root, "workspace");
const outside = join(root, "outside");
// Stands in for Asterism's own install dir: the tool host's CODE must be readable
// inside the jail, or the child cannot even load itself. Granted like the runtime,
// separately from the agent's workspace — code and data are different grants.
const hostDir = join(root, "host");
mkdirSync(workspace);
mkdirSync(outside);
mkdirSync(hostDir);
writeFileSync(join(workspace, "note.md"), "# in the workspace\n");
// Stands in for a neighbouring agent's workspace / ~/.ssh — same subtree, not granted.
writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY MATERIAL\n");

const ms = (ns) => Number(ns) / 1e6;
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { median: pct(s, 0.5), p99: pct(s, 0.99), min: s[0], max: s[s.length - 1] };
};
const fmt = (s) => `median ${s.median.toFixed(3)}ms  p99 ${s.p99.toFixed(3)}ms  min ${s.min.toFixed(3)}ms`;

const results = [];
const record = (name, verdict, detail) => {
  results.push({ name, verdict, detail });
  console.log(`${verdict === "PASS" ? "✓" : verdict === "FAIL" ? "✗" : "·"} ${name}\n    ${detail}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Is sandbox-exec present and does it actually deny?
// ─────────────────────────────────────────────────────────────────────────────
const denyProfile = join(root, "deny.sb");
writeFileSync(
  denyProfile,
  `(version 1)\n(allow default)\n(deny file-read* (subpath "${outside}"))\n`,
);

const sbAvailable = spawnSync("which", ["sandbox-exec"]).status === 0;
if (!sbAvailable) {
  record("seatbelt present", "FAIL", "`sandbox-exec` not on PATH — macOS tier unavailable");
} else {
  const blocked = spawnSync("sandbox-exec", ["-f", denyProfile, "/bin/cat", join(outside, "id_rsa")]);
  const allowed = spawnSync("sandbox-exec", ["-f", denyProfile, "/bin/cat", join(workspace, "note.md")]);
  record(
    "seatbelt denies a read outside the permitted subpath",
    blocked.status !== 0 ? "PASS" : "FAIL",
    `exit=${blocked.status} stderr=${(blocked.stderr ?? "").toString().trim().split("\n")[0] || "(none)"}`,
  );
  record(
    "seatbelt still allows the permitted read",
    allowed.status === 0 ? "PASS" : "FAIL",
    `exit=${allowed.status} stdout=${JSON.stringify((allowed.stdout ?? "").toString().trim())}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Can node boot under a REALISTIC allow-list profile — the one (c) would use?
//    deny default; read the system + the runtime; read/write ONLY the workspace;
//    no network at all. This is the profile the nine fs.* capabilities need.
// ─────────────────────────────────────────────────────────────────────────────
// The profile that actually works. An enumerated read ALLOW-list does not boot a
// JS runtime (silent SIGABRT — no stderr, because it dies before it has one).
// What does work is layered, and SBPL is last-rule-wins: read the system broadly,
// then deny the user's HOME wholesale, then re-allow the runtime's own tree and
// this agent's workspace. Writes and network stay deny-default.
//
// That ordering is the design: the secrets are in $HOME (~/.ssh, other agents'
// workspaces, the user's documents), not in /usr.
// `--falsify` removes the one line the security claims rest on. Every isolation
// assertion below must FLIP to FAIL. A security check that cannot fail is not a
// check, and this repo has been burned by instruments that reported a clean zero.
const FALSIFY = process.argv.includes("--falsify");
const home = realpathSync(homedir());
const runtimeDir = dirname(dirname(execPath));
const allowProfile = join(root, "toolhost.sb");
writeFileSync(
  allowProfile,
  `(version 1)
(deny default)
(allow process-fork)
(allow process-exec (literal "${execPath}"))
(allow sysctl*)
(allow mach*)
(allow signal)
(allow file-read*)
${FALSIFY ? ";; READ DENY REMOVED — falsification run" : `(deny file-read-data (subpath "${home}"))`}
${FALSIFY ? `(allow process-exec) ;; falsification run` : ""}
(allow file-read-data (subpath "${runtimeDir}"))
(allow file-read-data (subpath "${hostDir}"))
(allow file-read-data (subpath "${workspace}"))
(allow file-write* (subpath "${workspace}") (literal "/dev/null"))
${FALSIFY ? "(allow network*) ;; falsification run" : "(deny network*)"}
`,
);

const probe = `
const fs = require("node:fs");
const net = require("node:net");
const out = { boot: true };
try { fs.writeFileSync(${JSON.stringify(join(workspace, "written.txt"))}, "ok"); out.writeWorkspace = "ok"; }
  catch (e) { out.writeWorkspace = e.code ?? String(e); }
try { fs.readFileSync(${JSON.stringify(join(workspace, "note.md"))}); out.readWorkspace = "ok"; }
  catch (e) { out.readWorkspace = e.code ?? String(e); }
try { fs.readFileSync(${JSON.stringify(join(outside, "id_rsa"))}); out.readOutside = "READ SUCCEEDED"; }
  catch (e) { out.readOutside = e.code ?? String(e); }
// Metadata is deliberately NOT denied (path resolution into the workspace needs it).
// Record what that leaks, rather than letting it pass unnoticed.
try { fs.statSync(${JSON.stringify(join(outside, "id_rsa"))}); out.statOutside = "STAT SUCCEEDED (structure visible)"; }
  catch (e) { out.statOutside = e.code ?? String(e); }
try { out.listHome = "LISTED " + fs.readdirSync(process.env.HOME).length + " entries"; }
  catch (e) { out.listHome = e.code ?? String(e); }
// A filesystem tool host has no business execing anything but its own runtime.
try { require("node:child_process").execSync("/bin/echo x"); out.exec = "EXEC SUCCEEDED"; }
  catch (e) { out.exec = e.code ?? String(e).slice(0, 30); }
const s = net.connect(1, "127.0.0.1");
s.on("error", (e) => { out.network = e.code ?? String(e); console.log(JSON.stringify(out)); process.exit(0); });
s.on("connect", () => { out.network = "CONNECTED"; console.log(JSON.stringify(out)); process.exit(0); });
setTimeout(() => { out.network = "timeout"; console.log(JSON.stringify(out)); process.exit(0); }, 2000);
`;

if (sbAvailable) {
  const booted = spawnSync("sandbox-exec", ["-f", allowProfile, execPath, "-e", probe], {
    encoding: "utf8",
  });
  const line = (booted.stdout ?? "").trim().split("\n").pop() ?? "";
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { /* boot failed */ }
  if (!parsed) {
    record(
      "node boots under a (deny default) allow-list profile",
      "FAIL",
      `exit=${booted.status} stderr=${(booted.stderr ?? "").trim().split("\n").slice(0, 3).join(" | ")}`,
    );
  } else {
    record("node boots under a (deny default) allow-list profile", "PASS", JSON.stringify(parsed));
    record(
      "workspace read+write still work inside the jail",
      parsed.readWorkspace === "ok" && parsed.writeWorkspace === "ok" ? "PASS" : "FAIL",
      `read=${parsed.readWorkspace} write=${parsed.writeWorkspace}`,
    );
    record(
      "the OS denies the escape the kernel check would have caught",
      parsed.readOutside !== "READ SUCCEEDED" ? "PASS" : "FAIL",
      `reading ${outside}/id_rsa → ${parsed.readOutside}`,
    );
    record(
      "network is denied to the tool host",
      parsed.network !== "CONNECTED" && parsed.network !== "ECONNREFUSED" ? "PASS" : "FAIL",
      `connect(127.0.0.1:1) → ${parsed.network}  (ECONNREFUSED means the socket was ALLOWED)`,
    );
    record(
      "the tool host cannot exec anything but its own runtime",
      parsed.exec !== "EXEC SUCCEEDED" ? "PASS" : "FAIL",
      `execSync("/bin/echo") → ${parsed.exec}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cost. Per-CALL spawn (the fatal design) vs a long-lived child (the design).
// ─────────────────────────────────────────────────────────────────────────────
const SPAWNS = 15;
const spawnPlain = [];
const spawnJailed = [];
let jailedSpawnFailures = 0;
for (let i = 0; i < SPAWNS; i++) {
  let t = process.hrtime.bigint();
  const plain = spawnSync(execPath, ["-e", "0"]);
  if (plain.status === 0) spawnPlain.push(ms(process.hrtime.bigint() - t));
  if (sbAvailable) {
    t = process.hrtime.bigint();
    // A FAILED sandbox-exec exits in ~9ms and would otherwise be recorded as a
    // suspiciously fast "spawn" — the first version of this bench did exactly that.
    const jailed = spawnSync("sandbox-exec", ["-f", allowProfile, execPath, "-e", "0"]);
    if (jailed.status === 0) spawnJailed.push(ms(process.hrtime.bigint() - t));
    else jailedSpawnFailures++;
  }
}
record("cold spawn — plain node", "INFO", fmt(stats(spawnPlain)));
if (sbAvailable) {
  if (spawnJailed.length === 0) {
    record("cold spawn — node under seatbelt", "FAIL", `all ${SPAWNS} spawns exited non-zero`);
  } else {
    record(
      "cold spawn — node under seatbelt",
      "INFO",
      `${fmt(stats(spawnJailed))}  (${jailedSpawnFailures}/${SPAWNS} failed)`,
    );
  }
}

// Baseline: what one real fs.read costs in-process today.
const inproc = [];
for (let i = 0; i < 2000; i++) {
  const t = process.hrtime.bigint();
  readFileSync(join(workspace, "note.md"));
  inproc.push(ms(process.hrtime.bigint() - t));
}
record("in-process fs.read (today's cost)", "INFO", fmt(stats(inproc)));

// The design: one long-lived jailed child, newline-delimited JSON per tool call.
const childSrc = join(hostDir, "toolhost.mjs");
writeFileSync(
  childSrc,
  `import { readFileSync } from "node:fs";
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    let res;
    try { res = { id: req.id, output: readFileSync(req.path, "utf8"), isError: false }; }
    catch (e) { res = { id: req.id, output: String(e.code ?? e), isError: true }; }
    process.stdout.write(JSON.stringify(res) + "\\n");
  }
});
`,
);

const rpc = await new Promise((resolve) => {
  const args = sbAvailable
    ? ["-f", allowProfile, execPath, childSrc]
    : [childSrc];
  const cmd = sbAvailable ? "sandbox-exec" : execPath;
  const t0 = process.hrtime.bigint();
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  const samples = [];
  const CALLS = 2000;
  let n = 0;
  let started = 0n;
  let out = "";
  let readyAt = null;
  const send = () => {
    started = process.hrtime.bigint();
    child.stdin.write(JSON.stringify({ id: n, path: join(workspace, "note.md") }) + "\n");
  };
  child.stdout.on("data", (d) => {
    out += d;
    let i;
    while ((i = out.indexOf("\n")) >= 0) {
      out = out.slice(i + 1);
      if (readyAt === null) readyAt = ms(process.hrtime.bigint() - t0);
      samples.push(ms(process.hrtime.bigint() - started));
      n++;
      if (n >= CALLS) {
        child.kill();
        return resolve({ samples, firstCallLatency: readyAt });
      }
      send();
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", (e) => resolve({ samples: [], firstCallLatency: null, why: String(e) }));
  // A child that EXITS before answering must settle the promise, or the bench
  // hangs on an unsettled await and reports nothing at all.
  child.on("exit", (code, sig) => {
    if (samples.length < CALLS) {
      resolve({ samples, firstCallLatency: readyAt, why: `exit=${code} sig=${sig} stderr=${stderr.trim().split("\n").slice(0, 2).join(" | ")}` });
    }
  });
  send();
});

if (rpc.samples.length === 0) {
  record("long-lived jailed child — RPC per tool call", "FAIL", rpc.why ?? "child failed to start");
} else {
  record(
    "long-lived jailed child — RPC per tool call",
    "INFO",
    `${fmt(stats(rpc.samples))}   (spawn+first call ${rpc.firstCallLatency.toFixed(1)}ms, paid ONCE per run)`,
  );
  const overhead = stats(rpc.samples).median - stats(inproc).median;
  record(
    "added latency per tool call vs today",
    "INFO",
    `${overhead.toFixed(3)}ms — against a model round-trip of 300–3000ms`,
  );
  // Compare TOTAL per-call cost against TOTAL per-call cost. Dividing a spawn by the
  // marginal overhead flatters the argument by ~50% and is not the honest ratio.
  const perCallSpawn = stats(spawnJailed.length ? spawnJailed : spawnPlain).median;
  const perCallRpc = stats(rpc.samples).median;
  record(
    "per-CALL spawn, had we designed it that way",
    "INFO",
    `${perCallSpawn.toFixed(1)}ms vs ${perCallRpc.toFixed(3)}ms per call — ${(
      perCallSpawn / perCallRpc
    ).toFixed(0)}× worse`,
  );
}

console.log(`\n─── summary${FALSIFY ? " (FALSIFICATION RUN — the deny line is removed)" : ""} ───`);
for (const r of results.filter((r) => r.verdict !== "INFO")) {
  console.log(`${r.verdict.padEnd(4)} ${r.name}`);
}
if (FALSIFY) {
  // Every claim that rests on a removed deny line must flip. Checking only ONE of
  // them would leave the others free to be inert — which the network check was,
  // until this run caught it (ECONNREFUSED reads as "denied" unless you look).
  // NOTE what falsifying these required: dropping `(deny network*)` was NOT enough,
  // because `(deny default)` already denies it — that line is belt-and-braces, not
  // the mechanism. A real falsification must GRANT the thing, not un-deny it.
  const mustFail = ["the OS denies the escape", "network is denied", "the tool host cannot exec"];
  const flipped = mustFail.map((prefix) => ({
    prefix,
    verdict: results.find((r) => r.name.startsWith(prefix))?.verdict,
  }));
  // `undefined` means the PREFIX MATCHED NOTHING — a broken matcher, not a passing
  // check. It happened. Report it as its own failure rather than as an inert check.
  const unmatched = flipped.filter((f) => f.verdict === undefined);
  if (unmatched.length > 0) {
    console.log(
      `\n✗ BROKEN MATCHER: no result named like ${unmatched.map((f) => `"${f.prefix}"`).join(", ")} — fix the prefix before trusting this run.`,
    );
  }
  const inert = flipped.filter((f) => f.verdict === "PASS");
  console.log(
    inert.length === 0
      ? `\n✓ FALSIFIED CORRECTLY — all ${flipped.length} claims fail once their deny line is removed. The checks are real.`
      : `\n✗ INERT CHECK(S): ${inert.map((f) => `"${f.prefix}" (${f.verdict})`).join(", ")} — passed with the deny removed, so it was never testing anything.`,
  );
}
rmSync(root, { recursive: true, force: true });
