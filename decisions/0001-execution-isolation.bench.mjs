// EVIDENCE for decisions/0001-execution-isolation.md. NOT a gate, NOT shipped,
// NOT wired into CI — it is macOS-only and measures the host it runs on.
//
// It answers three questions the decision could not be written without:
//   1. Does macOS seatbelt (`sandbox-exec`) still deny, unsigned, on this host?
//   2. Can a JS runtime BOOT under a `(deny default)` profile — Node AND Bun?
//   3. What does a process boundary actually cost per tool call?
//
//   node decisions/0001-execution-isolation.bench.mjs
//   node decisions/0001-execution-isolation.bench.mjs --falsify
//
// `--falsify` GRANTS BACK what the profile denies and requires every security
// assertion, on every runtime, to flip to FAIL. Run it. A check that cannot fail
// is not one — and demanding it found three defects in this file that a passing
// run never would have.
//
// It writes and removes a temporary directory under $HOME — deliberately, because
// a real agent workspace lives there, and re-allowing a path inside the denied
// subtree is the part of the profile most likely to break.
//
// When the tier in ADR-0001 is built, this is the skeleton of its acceptance test.

import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:net";
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
// A second escape target OUTSIDE $HOME. Without this the harness only ever proves
// confinement for the flattering case, and a profile that denies $HOME alone would
// look like a jail while /tmp stayed wide open.
const outsideHome = `/private/tmp/asterism-spike-escape-${process.pid}.txt`;
writeFileSync(outsideHome, "SECRET OUTSIDE HOME\n");
// A THIRD target, in the real per-user $TMPDIR. It is a different root from /tmp
// (`/private/var/folders/...` on macOS) and is where os.tmpdir() actually points,
// so a probe that only checks /private/tmp passes while it stays readable.
const outsideTmpdir = join(realpathSync(tmpdir()), `asterism-spike-escape-${process.pid}.txt`);
writeFileSync(outsideTmpdir, "SECRET IN TMPDIR\n");

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
//    deny default; read the system + the runtime; deny every USER-DATA root;
//    write ONLY the workspace; no network, no exec. This is what the nine fs.*
//    capabilities need — and note reads of /usr and /etc remain permitted.
// ─────────────────────────────────────────────────────────────────────────────
// The profile that actually works. An enumerated read ALLOW-list does not boot a
// JS runtime (silent SIGABRT — no stderr, because it dies before it has one).
// What does work is layered, and SBPL is last-rule-wins: read the system broadly,
// then deny every user-data root, then re-allow the runtime's own tree, the tool
// host's code, and this agent's workspace. Writes, network and exec stay
// deny-default.
//
// That ordering IS the design, and it is also its limit: this confines user data,
// not all reads. /usr and /etc stay readable by construction.
// `--falsify` grants back what the denies removed. Every isolation assertion must
// FLIP to FAIL. A security check that cannot fail is not a check, and this repo has
// been burned by instruments that reported a clean zero.
const FALSIFY = process.argv.includes("--falsify");
const home = realpathSync(homedir());

// Denying only $HOME leaves /tmp, mounted volumes and other users' homes readable
// — so the tier would confine WRITES to the workspace while a read of
// /tmp/whatever still succeeded. Every location that can hold USER DATA is denied;
// system paths (/usr, /etc, /System, /Library) stay readable, which is deliberate:
// they are what the runtime needs to boot, and they are not the agent's secrets.
//
// `/private/var/folders` is the one most easily missed and among the most valuable:
// it is where macOS puts the PER-USER temp dir that `os.tmpdir()` returns, so
// leaving it out means every scratch file any program wrote stays readable while
// the profile looks confined. `/tmp` is NOT the same place and covering it is not
// enough. The realpath'd tmpdir is added too, for hosts where TMPDIR points
// somewhere else entirely.
const READ_DENY_ROOTS = [
  ...new Set([
    "/Users",
    home,
    "/tmp",
    "/private/tmp",
    "/Volumes",
    "/private/var/folders",
    realpathSync(tmpdir()),
  ]),
];

/** The tier's profile, parameterised by which runtime binary hosts the tools. */
function writeProfile(path, runtimePath) {
  const runtimeDir = dirname(dirname(runtimePath));
  writeFileSync(
    path,
    `(version 1)
(deny default)
(allow process-fork)
(allow process-exec (literal "${runtimePath}"))
(allow sysctl*)
(allow mach*)
(allow signal)
(allow file-read*)
${
      FALSIFY
        ? ";; READ DENIES REMOVED — falsification run"
        : READ_DENY_ROOTS.map((d) => `(deny file-read-data (subpath "${d}"))`).join("\n")
    }
${FALSIFY ? `(allow process-exec) ;; falsification run` : ""}
(allow file-read-data (subpath "${runtimeDir}"))
(allow file-read-data (subpath "${hostDir}"))
(allow file-read-data (subpath "${workspace}"))
${
      FALSIFY
        ? "(allow file-write*) ;; falsification run"
        : `(allow file-write* (subpath "${workspace}") (literal "/dev/null"))`
    }
${FALSIFY ? "(allow network*) ;; falsification run" : "(deny network*)"}
`,
  );
}

// Asterism is Bun-first and Node is the compatibility floor, so a feasibility
// claim about "a JS runtime" has to be executable for BOTH — not measured for one
// and asserted for the other.
const bunPath = (() => {
  const found = spawnSync("which", ["bun"], { encoding: "utf8" });
  if (found.status !== 0) return null;
  try { return realpathSync(found.stdout.trim()); } catch { return null; }
})();
// The ADR's feasibility claim covers BOTH, so both are prerequisites of the
// evidence — not "whatever this machine has". A missing one is reported as a
// failure, rather than quietly narrowing what the harness claims to have shown.
const REQUIRED_RUNTIMES = ["node", "bun"];
const RUNTIMES = [
  { name: "node", path: execPath },
  ...(bunPath ? [{ name: "bun", path: bunPath }] : []),
];
for (const required of REQUIRED_RUNTIMES) {
  if (!RUNTIMES.some((r) => r.name === required)) {
    record(
      `prerequisite: ${required} is installed`,
      "FAIL",
      `not on PATH — the ADR's Node+Bun claim cannot be reproduced on this host`,
    );
  }
}

const allowProfile = join(root, "toolhost.sb");
writeProfile(allowProfile, execPath);

// A real listener, outside the sandbox, so the network assertion tests reachability
// rather than an error code. Bound to loopback only.
// Under --falsify the child DOES connect, then exits — so the server side sees a
// reset. Swallow it: an unhandled 'error' here kills the whole falsification run.
const listener = createServer((c) => {
  c.on("error", () => {});
  c.end("hi");
});
listener.on("error", () => {});
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const LISTEN_PORT = listener.address().port;
record("control: the probe's target listener is up", "INFO", `127.0.0.1:${LISTEN_PORT}`);

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
// The escape that is NOT under $HOME — the case a $HOME-only deny would miss.
try { fs.readFileSync(${JSON.stringify(outsideHome)}); out.readOutsideHome = "READ SUCCEEDED"; }
  catch (e) { out.readOutsideHome = e.code ?? String(e); }
// ...and the per-user $TMPDIR, which is a DIFFERENT root from /tmp.
try { fs.readFileSync(${JSON.stringify(outsideTmpdir)}); out.readTmpdir = "READ SUCCEEDED"; }
  catch (e) { out.readTmpdir = e.code ?? String(e); }
// A system path SHOULD stay readable; the tier confines user data, not /etc.
try { fs.readFileSync("/etc/hosts"); out.readSystem = "ok"; }
  catch (e) { out.readSystem = e.code ?? String(e); }
// Metadata is deliberately NOT denied (path resolution into the workspace needs it).
// Record what that leaks, rather than letting it pass unnoticed.
try { fs.statSync(${JSON.stringify(join(outside, "id_rsa"))}); out.statOutside = "STAT SUCCEEDED (structure visible)"; }
  catch (e) { out.statOutside = e.code ?? String(e); }
try { out.listHome = "LISTED " + fs.readdirSync(process.env.HOME).length + " entries"; }
  catch (e) { out.listHome = e.code ?? String(e); }
// The ADR claims writes are confined to the workspace. Writing only INSIDE it
// proves the allow, never the deny — a profile that leaked file-write* would have
// passed every assertion here. Both escape targets, inside $HOME and outside it.
try { fs.writeFileSync(${JSON.stringify(join(outside, "escape.txt"))}, "x"); out.writeOutside = "WRITE SUCCEEDED"; }
  catch (e) { out.writeOutside = e.code ?? String(e); }
try { fs.writeFileSync(${JSON.stringify(outsideHome + ".escape")}, "x"); out.writeOutsideHome = "WRITE SUCCEEDED"; }
  catch (e) { out.writeOutsideHome = e.code ?? String(e); }
// A filesystem tool host has no business execing anything but its own runtime.
// execFileSync, NOT execSync: execSync runs /bin/sh -c "...", so a denial there
// only proves the SHELL could not start. This tests the stated property — a direct
// exec of a non-runtime binary — with no shell in between.
try { require("node:child_process").execFileSync("/bin/echo", ["x"]); out.exec = "EXEC SUCCEEDED"; }
  catch (e) { out.exec = e.code ?? String(e).slice(0, 30); }
// Connect to a REAL listener the parent is running, and judge only on whether the
// connection was ESTABLISHED. Inferring from errno is runtime-specific and wrong:
// Node reports a denied socket as EPERM, Bun reports the same denial as
// ECONNREFUSED — so "ECONNREFUSED means it was allowed" is a Node-ism that fails
// Bun for a jail that is in fact holding.
const s = net.connect(${LISTEN_PORT}, "127.0.0.1");
const done = (v) => { out.network = v; console.log(JSON.stringify(out)); process.exit(0); };
s.on("error", (e) => done("blocked:" + (e.code ?? String(e))));
s.on("connect", () => done("CONNECTED"));
setTimeout(() => done("blocked:timeout"), 2000);
`;

for (const runtime of sbAvailable ? RUNTIMES : []) {
  const rp = join(root, `toolhost-${runtime.name}.sb`);
  writeProfile(rp, runtime.path);
  const booted = spawnSync("sandbox-exec", ["-f", rp, runtime.path, "-e", probe], {
    encoding: "utf8",
    cwd: workspace,
  });
  const line = (booted.stdout ?? "").trim().split("\n").pop() ?? "";
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { /* boot failed */ }
  const t = (name) => `[${runtime.name}] ${name}`;

  // Boot is asked SEPARATELY from the capability probe, with a trivial script.
  // Collapsing the two reports "cannot boot" for a runtime that boots fine but
  // whose probe misbehaved — which is exactly what Bun did here, and it sent me
  // hunting a profile bug that did not exist.
  const bootCheck = spawnSync("sandbox-exec", ["-f", rp, runtime.path, "-e", 'console.log("BOOTED")'], {
    encoding: "utf8",
    cwd: workspace,
  });
  const boots = (bootCheck.stdout ?? "").includes("BOOTED");
  record(
    t("boots under a (deny default) allow-list profile"),
    boots ? "PASS" : "FAIL",
    boots ? "trivial script ran inside the jail" : `exit=${bootCheck.status} stderr=${(bootCheck.stderr ?? "").trim().split("\n")[0]}`,
  );

  if (!parsed) {
    record(
      t("capability probe returned a readable result"),
      "FAIL",
      `exit=${booted.status} stderr=${(booted.stderr ?? "").trim().split("\n").slice(0, 3).join(" | ")}` +
        (boots ? "  — NOTE: this runtime BOOTS; the probe itself is what failed" : ""),
    );
  } else {
    record(t("capability probe returned a readable result"), "PASS", JSON.stringify(parsed));
    record(
      t("workspace read+write still work inside the jail"),
      parsed.readWorkspace === "ok" && parsed.writeWorkspace === "ok" ? "PASS" : "FAIL",
      `read=${parsed.readWorkspace} write=${parsed.writeWorkspace}`,
    );
    record(
      t("the OS denies the escape the kernel check would have caught"),
      parsed.readOutside !== "READ SUCCEEDED" ? "PASS" : "FAIL",
      `reading ${outside}/id_rsa → ${parsed.readOutside}`,
    );
    record(
      t("the OS denies an escape OUTSIDE $HOME too"),
      parsed.readOutsideHome !== "READ SUCCEEDED" && parsed.readTmpdir !== "READ SUCCEEDED"
        ? "PASS"
        : "FAIL",
      `/private/tmp → ${parsed.readOutsideHome}; $TMPDIR → ${parsed.readTmpdir}`,
    );
    record(
      t("writes outside the workspace are denied"),
      parsed.writeOutside !== "WRITE SUCCEEDED" && parsed.writeOutsideHome !== "WRITE SUCCEEDED"
        ? "PASS"
        : "FAIL",
      `inside $HOME → ${parsed.writeOutside}; outside $HOME → ${parsed.writeOutsideHome}`,
    );
    record(
      t("system paths stay readable (the tier confines user data, not /etc)"),
      parsed.readSystem === "ok" ? "PASS" : "FAIL",
      `/etc/hosts → ${parsed.readSystem}`,
    );
    record(
      t("network is denied to the tool host"),
      parsed.network !== "CONNECTED" ? "PASS" : "FAIL",
      `connect to a live listener on 127.0.0.1:${LISTEN_PORT} → ${parsed.network}`,
    );
    record(
      t("the tool host cannot exec anything but its own runtime"),
      parsed.exec !== "EXEC SUCCEEDED" ? "PASS" : "FAIL",
      `execSync("/bin/echo") → ${parsed.exec}`,
    );
    // The ADR leans on BOTH halves of the metadata story. Recorded as assertions,
    // not as fields inside a JSON blob nobody diffs: a host or profile change that
    // moved either one would otherwise pass every named check in this file.
    record(
      t("directory enumeration outside the workspace is denied"),
      parsed.listHome === "EPERM" ? "PASS" : "FAIL",
      `readdir($HOME) → ${parsed.listHome}`,
    );
    // NOT a security property — a KNOWN LIMITATION the record publishes. Asserted so
    // that if it ever stops being true (either way) the ADR is known to be stale.
    record(
      t("known limitation still holds: stat of a known outside path succeeds"),
      parsed.statOutside === "STAT SUCCEEDED (structure visible)" ? "PASS" : "FAIL",
      `stat(outside/id_rsa) → ${parsed.statOutside}`,
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
    const jailed = spawnSync("sandbox-exec", ["-f", allowProfile, execPath, "-e", "0"], { cwd: workspace });
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
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: workspace });
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
  //
  // Every SECURITY claim goes here, for EVERY runtime — matching one runtime's copy
  // would leave the other's free to be inert. `stat of a known outside path` is
  // deliberately absent: it is a published limitation, not a security property, and
  // it correctly still holds when the denies are removed.
  const mustFail = [
    "the OS denies the escape the kernel check",
    "the OS denies an escape OUTSIDE $HOME",
    "writes outside the workspace are denied",
    "network is denied",
    "the tool host cannot exec",
    "directory enumeration outside the workspace is denied",
  ];
  // Check the full CROSS PRODUCT of runtime × claim, by name, rather than counting
  // matches. Counting is not enough: if one runtime's probe dies before emitting any
  // per-claim result, the other runtime's failures alone satisfy a length test and
  // the run prints "FALSIFIED CORRECTLY" for assertions that never executed. An
  // absent pair is a FAILED falsification, not a missing row.
  // The matrix is built from what the ADR CLAIMS, never from what this host happens
  // to provide. Deriving it from `RUNTIMES` lets a machine without Bun — or without
  // seatbelt at all — shrink the requirement to nothing and still reach the success
  // branch: "all 0 pairs falsified". An absent prerequisite is a FAILED
  // falsification, because the claim went untested.
  const expected = [];
  for (const runtime of REQUIRED_RUNTIMES) {
    for (const claim of mustFail) expected.push({ runtime, claim });
  }
  if (!sbAvailable) {
    console.log(
      "\n✗ NOT FALSIFIED — `sandbox-exec` is unavailable, so no sandbox assertion ran at all.",
    );
  }
  const flipped = expected.map(({ runtime, claim }) => {
    const hit = results.find((r) => r.name.includes(`[${runtime}]`) && r.name.includes(claim));
    return {
      prefix: `[${runtime}] ${claim}`,
      verdict: hit ? hit.verdict : "MISSING (probe never produced this assertion)",
    };
  });
  const missing = flipped.filter((f) => f.verdict.startsWith("MISSING"));
  const inert = flipped.filter((f) => f.verdict === "PASS");
  if (missing.length > 0) {
    console.log(
      `\n✗ NOT FALSIFIED — ${missing.length} runtime/claim pair(s) produced no assertion at all: ` +
        `${missing.map((f) => `"${f.prefix}"`).join(", ")}. An absent assertion is an UNTESTED claim, not a passing one.`,
    );
  }
  if (inert.length > 0) {
    console.log(
      `\n✗ INERT CHECK(S): ${inert.map((f) => `"${f.prefix}"`).join(", ")} — still passed with the capability granted back, so it was never testing anything.`,
    );
  }
  if (missing.length === 0 && inert.length === 0) {
    console.log(
      `\n✓ FALSIFIED CORRECTLY — all ${flipped.length} runtime/claim pairs fail once the capability is granted back. The checks are real.`,
    );
  } else {
    // A security harness that prints a failure and exits 0 cannot be used by
    // anything — `node bench.mjs --falsify && ...` would treat a broken check as
    // success. This is the skeleton of an acceptance test; it has to be scriptable.
    process.exitCode = 1;
  }
} else if (results.some((r) => r.verdict === "FAIL")) {
  // Same rule for the normal run. In --falsify a FAIL is the DESIRED outcome, which
  // is why the two modes decide the exit status differently.
  process.exitCode = 1;
}
listener.close();
try { rmSync(outsideHome, { force: true }); } catch {}
try { rmSync(outsideTmpdir, { force: true }); } catch {}
// Under --falsify the child SUCCEEDS at these writes, so the harness must clean up
// what its own escape probes created — otherwise a falsification run litters /tmp.
for (const stray of [outsideHome + ".escape", outsideTmpdir + ".escape"]) {
  try { rmSync(stray, { force: true }); } catch {}
}
rmSync(root, { recursive: true, force: true });
