// `asterism service` end to end through the real command surface. The OS service
// manager (`launchctl`/`systemctl`) and the host platform are injected, so both the
// macOS and the Linux path are exercised on any host — no real service is ever
// registered. The filesystem is real (a temp HOME + XDG dir), the way the catalog
// and acceptance tests use real temp workspaces.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./cli.ts";
import type { CliIO } from "./cli.ts";

interface RunnerCall {
  command: string;
  args: string[];
}

/** A spy for `launchctl`/`systemctl`, with an optional scripted result. */
function makeRunner(
  impl?: (command: string, args: readonly string[]) => { code: number; stdout: string; stderr: string },
): { run: NonNullable<CliIO["runCommand"]>; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const run: NonNullable<CliIO["runCommand"]> = async (command, args) => {
    calls.push({ command, args: [...args] });
    return impl ? impl(command, args) : { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const SELF = ["/usr/bin/node", "/opt/asterism/bin.js"] as const;

describe("asterism service", () => {
  let project: string;
  let home: string;
  let xdg: string;

  /** Paths the handler derives, recomputed here independently. */
  function paths(agent: string, kind: string) {
    const base = join(xdg, "asterism", "services", `${agent}.${kind}`);
    return {
      base,
      wrapper: join(base, "run.sh"),
      env: join(base, "service.env"),
      log: join(base, "service.log"),
      launchdPlist: join(home, "Library", "LaunchAgents", `com.qmilab.asterism.${agent}.${kind}.plist`),
      systemdUnit: join(xdg, "systemd", "user", `asterism-${agent}-${kind}.service`),
    };
  }

  function baseIo(extra: Partial<CliIO>): CliIO {
    return {
      cwd: project,
      env: { HOME: home, XDG_CONFIG_HOME: xdg },
      out: () => {},
      err: () => {},
      selfInvocation: SELF,
      ...extra,
    };
  }

  /** Run a command, capturing stdout+stderr lines. */
  async function run(io: CliIO, argv: string[]): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    const capturing: CliIO = { ...io, out: (t) => lines.push(t), err: (t) => lines.push(t) };
    const code = await runCli(argv, capturing);
    return { code, text: lines.join("\n") };
  }

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), "asterism-svc-proj-"));
    home = mkdtempSync(join(tmpdir(), "asterism-svc-home-"));
    xdg = mkdtempSync(join(tmpdir(), "asterism-svc-xdg-"));
    const io = baseIo({ platform: "linux" });
    await run(io, ["init"]);
    await run(io, ["new", "writer", "--trust", "autonomous"]);
  });

  afterEach(() => {
    for (const d of [project, home, xdg]) if (d) rmSync(d, { recursive: true, force: true });
  });

  test("install (macOS, default kind serve) writes a launchd plist and loads it", async () => {
    const { run: runner, calls } = makeRunner();
    const io = baseIo({ platform: "darwin", runCommand: runner });
    const p = paths("writer", "serve");

    const { code, text } = await run(io, ["service", "install", "writer"]);
    expect(code).toBe(0);

    // The plist, wrapper, and env file are all written.
    expect(existsSync(p.launchdPlist)).toBe(true);
    expect(existsSync(p.wrapper)).toBe(true);
    expect(existsSync(p.env)).toBe(true);

    const plist = readFileSync(p.launchdPlist, "utf8");
    expect(plist).toContain("<string>com.qmilab.asterism.writer.serve</string>");
    expect(plist).toContain(`<string>${p.wrapper}</string>`);

    const wrapper = readFileSync(p.wrapper, "utf8");
    expect(wrapper).toContain("exec '/usr/bin/node' '/opt/asterism/bin.js' 'serve' 'writer'");
    expect(wrapper).toContain(`. '${p.env}'`);

    // The serve env template offers the HTTP access token as an OPTIONAL placeholder
    // (commented, no value) — set it to pin a stable secret for an exposed endpoint;
    // a loopback service works without it via the saved per-agent token.
    const env = readFileSync(p.env, "utf8");
    expect(env).toContain("# ASTERISM_HTTP_TOKEN=");
    expect(env).not.toMatch(/^ASTERISM_HTTP_TOKEN=/m);

    // The file modes are locked down.
    expect(statSync(p.wrapper).mode & 0o777).toBe(0o700);
    expect(statSync(p.env).mode & 0o777).toBe(0o600);

    // launchctl was asked to load it (after a best-effort unload).
    expect(calls.some((c) => c.command === "launchctl" && c.args[0] === "load")).toBe(true);
    expect(text).toContain('Installed service "writer (serve)"');
  });

  test("install (Linux, telegram) writes a systemd unit, enables it, and templates the token", async () => {
    const { run: runner, calls } = makeRunner();
    const io = baseIo({ platform: "linux", runCommand: runner });
    const p = paths("writer", "telegram");

    const { code, text } = await run(io, ["service", "install", "writer", "--kind", "telegram"]);
    expect(code).toBe(0);
    expect(existsSync(p.systemdUnit)).toBe(true);

    const unit = readFileSync(p.systemdUnit, "utf8");
    expect(unit).toContain(`ExecStart=/bin/sh "${p.wrapper}"`);
    expect(unit).toContain("Restart=on-failure");

    // The env template names the channel token and the API key as required, with no value.
    const env = readFileSync(p.env, "utf8");
    expect(env).toContain("# ASTERISM_TELEGRAM_TOKEN=");
    expect(env).toContain("# OPENAI_API_KEY=");
    expect(env).not.toMatch(/^ASTERISM_TELEGRAM_TOKEN=/m);

    expect(calls.some((c) => c.command === "systemctl" && c.args.includes("enable"))).toBe(true);
    // The required vars are surfaced to the operator.
    expect(text).toContain("ASTERISM_TELEGRAM_TOKEN");
    expect(text).toContain("loginctl enable-linger");
  });

  test("passthrough args after -- reach the supervised command verbatim", async () => {
    const io = baseIo({ platform: "darwin", runCommand: makeRunner().run });
    const p = paths("writer", "serve");
    await run(io, ["service", "install", "writer", "--", "--port", "8080"]);
    const wrapper = readFileSync(p.wrapper, "utf8");
    expect(wrapper).toContain("'serve' 'writer' '--port' '8080'");
  });

  test("re-install preserves an env file the operator has edited", async () => {
    const io = baseIo({ platform: "linux", runCommand: makeRunner().run });
    const p = paths("writer", "serve");
    await run(io, ["service", "install", "writer"]);
    writeFileSync(p.env, "OPENAI_API_KEY=sk-secret\n");
    await run(io, ["service", "install", "writer"]);
    // The wrapper is regenerated, but the filled-in env file is left untouched.
    expect(readFileSync(p.env, "utf8")).toBe("OPENAI_API_KEY=sk-secret\n");
  });

  test("--capture-env writes present values into the 0600 env file; absent stay commented", async () => {
    const io = baseIo({
      platform: "linux",
      runCommand: makeRunner().run,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        ASTERISM_TELEGRAM_TOKEN: "tok-123",
        OPENAI_API_KEY: "sk-xyz",
        ASTERISM_MODEL_ID: "gpt-4o-mini",
      },
    });
    const p = paths("writer", "telegram");
    const { code, text } = await run(io, ["service", "install", "writer", "--kind", "telegram", "--capture-env"]);
    expect(code).toBe(0);

    const env = readFileSync(p.env, "utf8");
    expect(env).toContain("ASTERISM_TELEGRAM_TOKEN='tok-123'");
    expect(env).toContain("OPENAI_API_KEY='sk-xyz'");
    // The unset optional var stays a commented placeholder.
    expect(env).toContain("# ASTERISM_TELEGRAM_ALLOW=");
    expect(statSync(p.env).mode & 0o777).toBe(0o600);

    // Captured required vars aren't nagged about.
    expect(text).toContain("Captured from your environment");
    expect(text).not.toContain("Before it can work");
  });

  test("--capture-env does not count an exported-but-empty variable as captured", async () => {
    // `export ASTERISM_TELEGRAM_TOKEN=` is how a shell clears one. Counted as present it
    // wrote a blank value into the service's env file AND reported the required need as
    // met — so the operator was told nothing was missing and the service failed to start
    // on the one thing that was (#174).
    const io = baseIo({
      platform: "linux",
      runCommand: makeRunner().run,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        ASTERISM_TELEGRAM_TOKEN: "",
        OPENAI_API_KEY: "sk-xyz",
      },
    });
    const p = paths("writer", "telegram");
    const { code, text } = await run(io, ["service", "install", "writer", "--kind", "telegram", "--capture-env"]);
    expect(code).toBe(0);

    const env = readFileSync(p.env, "utf8");
    // Left as the commented placeholder it would be if the variable were absent…
    expect(env).toContain("# ASTERISM_TELEGRAM_TOKEN=");
    expect(env).not.toContain("ASTERISM_TELEGRAM_TOKEN=''");
    // …the value that IS there is still captured…
    expect(env).toContain("OPENAI_API_KEY='sk-xyz'");
    // …it is not claimed as captured…
    expect(text).toContain("Captured from your environment: OPENAI_API_KEY");
    expect(text).not.toContain("Captured from your environment: ASTERISM_TELEGRAM_TOKEN");
    // …and the operator is told what the service still needs before it can work.
    expect(text).toContain("Before it can work");
    expect(text).toContain("ASTERISM_TELEGRAM_TOKEN");
  });

  test("--capture-env does not capture a token that is only whitespace", async () => {
    // The reader on the other side of this file trims before testing: `resolveHttpToken`
    // does, and so do the chat channels now. So capturing `ASTERISM_HTTP_TOKEN="  "`
    // reported a token captured, wrote a blank one, and left the service minting a
    // DIFFERENT token — which every client pinned to the "captured" one is then rejected
    // by. One install, two answers, narrowed to whitespace (#174).
    const io = baseIo({
      platform: "linux",
      runCommand: makeRunner().run,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        ASTERISM_TELEGRAM_TOKEN: "   ",
        OPENAI_API_KEY: " sk-padded ",
      },
    });
    const p = paths("writer", "telegram");
    const { code, text } = await run(io, ["service", "install", "writer", "--kind", "telegram", "--capture-env"]);
    expect(code).toBe(0);

    const env = readFileSync(p.env, "utf8");
    expect(env).toContain("# ASTERISM_TELEGRAM_TOKEN=");
    expect(env).not.toContain("ASTERISM_TELEGRAM_TOKEN='   '");
    expect(text).not.toContain("Captured from your environment: ASTERISM_TELEGRAM_TOKEN");
    // The TOKEN specifically among what is still missing, not merely that something is:
    // a telegram service also needs a model here, so "Before it can work" appears either
    // way and an assertion on it alone passes with the rule switched off — measured.
    const missing = text.slice(text.indexOf("Before it can work"));
    expect(missing).toContain("ASTERISM_TELEGRAM_TOKEN");

    // A value with padding AROUND something is still a value, and is written verbatim —
    // the rule decides whether anything is there, never what it is.
    expect(env).toContain("OPENAI_API_KEY=' sk-padded '");
    expect(text).toContain("OPENAI_API_KEY");
  });

  test("--capture-env overwrites a loose-permission env file and leaves it 0600", async () => {
    const p = paths("writer", "serve");
    await run(baseIo({ platform: "linux", runCommand: makeRunner().run }), ["service", "install", "writer"]);
    // Simulate an env file left world-readable before capture writes secrets into it.
    writeFileSync(p.env, "# hand edited\n");
    chmodSync(p.env, 0o644);
    const io = baseIo({
      platform: "linux",
      runCommand: makeRunner().run,
      env: { HOME: home, XDG_CONFIG_HOME: xdg, OPENAI_API_KEY: "sk-cap" },
    });
    await run(io, ["service", "install", "writer", "--capture-env"]);
    const env = readFileSync(p.env, "utf8");
    expect(env).toContain("OPENAI_API_KEY='sk-cap'");
    expect(env).not.toContain("hand edited");
    // The secret never lands in a world-readable file: the result is owner-only.
    expect(statSync(p.env).mode & 0o077).toBe(0);
  });

  test("re-install (no capture) hardens an existing env file to owner-only", async () => {
    const p = paths("writer", "serve");
    const io = baseIo({ platform: "linux", runCommand: makeRunner().run });
    await run(io, ["service", "install", "writer"]);
    // Operator filled in the template, but the file drifted to world-readable.
    writeFileSync(p.env, "OPENAI_API_KEY=sk-kept\n");
    chmodSync(p.env, 0o644);
    await run(io, ["service", "install", "writer"]);
    // The filled-in contents are preserved, and the permissions are tightened.
    expect(readFileSync(p.env, "utf8")).toBe("OPENAI_API_KEY=sk-kept\n");
    expect(statSync(p.env).mode & 0o077).toBe(0);
  });

  test("--capture-env captures the ASTERISM_API_KEY fallback when no provider key is set", async () => {
    const io = baseIo({
      platform: "linux",
      runCommand: makeRunner().run,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        ASTERISM_TELEGRAM_TOKEN: "tok",
        ASTERISM_API_KEY: "sk-shared",
        ASTERISM_MODEL_ID: "gpt-4o-mini",
      },
    });
    const p = paths("writer", "telegram");
    const { code, text } = await run(io, ["service", "install", "writer", "--kind", "telegram", "--capture-env"]);
    expect(code).toBe(0);

    const env = readFileSync(p.env, "utf8");
    expect(env).toContain("ASTERISM_API_KEY='sk-shared'");
    // The provider-specific key is unset, so it stays a commented placeholder.
    expect(env).toContain("# OPENAI_API_KEY=");
    // The API-key need is satisfied by the fallback — no "still missing" nag.
    expect(text).not.toContain("Before it can work");
  });

  test("a channel install with no model configured asks for one in the hint", async () => {
    // A fresh workspace has no model set, and a channel needs one to run a task —
    // so the hint must flag it, or the operator fills in token + key and still loops.
    const io = baseIo({ platform: "linux", runCommand: makeRunner().run });
    const { code, text } = await run(io, ["service", "install", "writer", "--kind", "telegram"]);
    expect(code).toBe(0);
    expect(text).toContain("Before it can work");
    expect(text).toContain("a configured model");
  });

  test("--capture-env carries ASTERISM_MODEL_* so an env-configured model survives", async () => {
    const io = baseIo({
      platform: "linux",
      runCommand: makeRunner().run,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        ASTERISM_MODEL_ID: "gpt-4o-mini",
        ASTERISM_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-xyz",
      },
    });
    const p = paths("writer", "serve");
    const { code } = await run(io, ["service", "install", "writer", "--capture-env"]);
    expect(code).toBe(0);

    const env = readFileSync(p.env, "utf8");
    expect(env).toContain("ASTERISM_MODEL_ID='gpt-4o-mini'");
    expect(env).toContain("ASTERISM_MODEL_PROVIDER='openai'");
    expect(env).toContain("OPENAI_API_KEY='sk-xyz'");
  });

  test("a channel on a local model requires no API key, and is not offered the shared one", async () => {
    // A model served from this machine needs no key, so the install hint must not
    // demand a variable the operator can never satisfy — and the env file must not
    // offer ASTERISM_API_KEY to a provider the foreground path refuses to send it to.
    const io = baseIo({
      platform: "linux",
      runCommand: makeRunner().run,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        ASTERISM_TELEGRAM_TOKEN: "tok",
        ASTERISM_MODEL_ID: "qwen3",
        ASTERISM_MODEL_PROVIDER: "ollama",
      },
    });
    const p = paths("writer", "telegram");
    const { code, text } = await run(io, ["service", "install", "writer", "--kind", "telegram", "--capture-env"]);
    expect(code).toBe(0);

    const env = readFileSync(p.env, "utf8");
    expect(env).not.toContain("ASTERISM_API_KEY");
    // Offered, but only as an unset placeholder — nothing is required.
    expect(env).toContain("# OLLAMA_API_KEY=");
    // The model still travels, so the service resolves the same model this shell did.
    expect(env).toContain("ASTERISM_MODEL_PROVIDER='ollama'");
    expect(text).not.toContain("Before it can work");
  });

  test("--capture-env keeps the key for a LOCAL model behind an auth proxy", async () => {
    // `resolveProviderAuth` honours an explicitly set OLLAMA_API_KEY even at a
    // local endpoint. Dropping it here — on the grounds that the provider is
    // "keyless" — is how a setup that works in the shell fails as a service: the
    // installed process would send the no-key placeholder to a proxy expecting a
    // token.
    const io = baseIo({
      platform: "linux",
      runCommand: makeRunner().run,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        ASTERISM_TELEGRAM_TOKEN: "tok",
        ASTERISM_MODEL_ID: "qwen3",
        ASTERISM_MODEL_PROVIDER: "ollama",
        OLLAMA_API_KEY: "proxy-token",
      },
    });
    const p = paths("writer", "telegram");
    const { code } = await run(io, ["service", "install", "writer", "--kind", "telegram", "--capture-env"]);
    expect(code).toBe(0);
    expect(readFileSync(p.env, "utf8")).toContain("OLLAMA_API_KEY='proxy-token'");
  });

  test("a local provider pointed remotely is not made ready by the shared key", async () => {
    // `resolveProviderAuth` refuses ASTERISM_API_KEY for a keyless provider at any
    // endpoint. Reporting the service ready on the strength of it would capture a
    // key the foreground path will never read, and the service would fail at once
    // with the remote-endpoint refusal.
    const io = baseIo({
      platform: "linux",
      runCommand: makeRunner().run,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        ASTERISM_TELEGRAM_TOKEN: "tok",
        ASTERISM_MODEL_ID: "qwen3",
        ASTERISM_MODEL_PROVIDER: "ollama",
        ASTERISM_MODEL_BASE_URL: "https://ollama.example.com/v1",
        ASTERISM_API_KEY: "sk-a-real-hosted-key",
      },
    });
    const p = paths("writer", "telegram");
    const { code, text } = await run(io, ["service", "install", "writer", "--kind", "telegram", "--capture-env"]);
    expect(code).toBe(0);
    // Still missing what it needs, and it says so rather than starting broken.
    expect(text).toContain("Before it can work");
    expect(text).toContain("OLLAMA_API_KEY");
    expect(readFileSync(p.env, "utf8")).not.toContain("ASTERISM_API_KEY='sk-a-real-hosted-key'");
  });

  test("the env template names the API key for the env-configured provider, plus the fallback", async () => {
    const io = baseIo({
      platform: "linux",
      runCommand: makeRunner().run,
      env: { HOME: home, XDG_CONFIG_HOME: xdg, ASTERISM_MODEL_ID: "claude-x", ASTERISM_MODEL_PROVIDER: "anthropic" },
    });
    const p = paths("writer", "serve");
    await run(io, ["service", "install", "writer"]);
    const env = readFileSync(p.env, "utf8");
    expect(env).toContain("# ANTHROPIC_API_KEY=");
    expect(env).toContain("# ASTERISM_API_KEY=");
    expect(env).toContain("# ASTERISM_MODEL_ID=");
  });

  test("status reports an installed service's state from the service manager", async () => {
    const installIo = baseIo({ platform: "linux", runCommand: makeRunner().run });
    await run(installIo, ["service", "install", "writer"]);

    const probe = makeRunner((command, args) => {
      if (args.includes("is-active")) return { code: 0, stdout: "active\n", stderr: "" };
      if (args.includes("is-enabled")) return { code: 0, stdout: "enabled\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const statusIo = baseIo({ platform: "linux", runCommand: probe.run });
    const { code, text } = await run(statusIo, ["service", "status", "writer"]);
    expect(code).toBe(0);
    expect(text).toContain("writer (serve) — active (enabled)");
  });

  test("status reports nothing installed when there is no service", async () => {
    const io = baseIo({ platform: "linux", runCommand: makeRunner().run });
    const { code, text } = await run(io, ["service", "status", "writer"]);
    expect(code).toBe(0);
    expect(text).toContain('No services installed for "writer"');
  });

  test("uninstall removes the unit and wrapper but leaves the env file", async () => {
    const io = baseIo({ platform: "linux", runCommand: makeRunner().run });
    const p = paths("writer", "serve");
    await run(io, ["service", "install", "writer"]);
    expect(existsSync(p.systemdUnit)).toBe(true);

    const { run: runner, calls } = makeRunner();
    const uninstallIo = baseIo({ platform: "linux", runCommand: runner });
    const { code, text } = await run(uninstallIo, ["service", "uninstall", "writer"]);
    expect(code).toBe(0);
    expect(existsSync(p.systemdUnit)).toBe(false);
    expect(existsSync(p.wrapper)).toBe(false);
    // The env file (possible secret store) survives, and the operator is told so.
    expect(existsSync(p.env)).toBe(true);
    expect(text).toContain("Left its env file in place");
    expect(calls.some((c) => c.command === "systemctl" && c.args.includes("disable"))).toBe(true);
  });

  test("--kind narrows status and uninstall to the one service named", async () => {
    // The NARROWING direction, which is why an ignored `--kind` here is worse than one
    // on install: absent, both verbs reach every kind the agent has. `service uninstall
    // writer --knid telegram` stopped and removed all three, reporting success for each.
    const io = baseIo({ platform: "linux", runCommand: makeRunner().run });
    for (const kind of ["serve", "telegram", "discord"]) {
      await run(io, ["service", "install", "writer", "--kind", kind]);
    }

    const status = await run(io, ["service", "status", "writer", "--kind", "telegram"]);
    expect(status.code).toBe(0);
    expect(status.text).toContain("writer (telegram)");
    expect(status.text).not.toContain("writer (serve)");
    expect(status.text).not.toContain("writer (discord)");

    const removed = await run(io, ["service", "uninstall", "writer", "--kind", "telegram"]);
    expect(removed.code).toBe(0);
    expect(existsSync(paths("writer", "telegram").systemdUnit)).toBe(false);
    expect(existsSync(paths("writer", "serve").systemdUnit)).toBe(true);
    expect(existsSync(paths("writer", "discord").systemdUnit)).toBe(true);
  });

  test("an unsupported platform declines and writes nothing", async () => {
    const { run: runner, calls } = makeRunner();
    const io = baseIo({ platform: "win32", runCommand: runner });
    const { code, text } = await run(io, ["service", "install", "writer"]);
    expect(code).toBe(1);
    expect(text).toContain("macOS (launchd) and Linux (systemd)");
    expect(calls).toHaveLength(0);
    expect(existsSync(paths("writer", "serve").wrapper)).toBe(false);
  });

  test("install for an unknown agent is refused", async () => {
    const io = baseIo({ platform: "linux", runCommand: makeRunner().run });
    const { code, text } = await run(io, ["service", "install", "ghost"]);
    expect(code).toBe(1);
    expect(text).toContain('No agent named "ghost"');
  });

  test("an unknown --kind is rejected", async () => {
    const io = baseIo({ platform: "linux", runCommand: makeRunner().run });
    const { code, text } = await run(io, ["service", "install", "writer", "--kind", "daemon"]);
    expect(code).toBe(1);
    expect(text).toContain('Unknown service kind "daemon"');
  });

  test("bare `service` prints help and is an error; `service --help` is not", async () => {
    const io = baseIo({ platform: "linux" });
    const bare = await run(io, ["service"]);
    expect(bare.code).toBe(1);
    expect(bare.text).toContain("asterism service install");

    const helped = await run(io, ["service", "--help"]);
    expect(helped.code).toBe(0);
    expect(helped.text).toContain("asterism service install");
  });

  test("an unknown subcommand is rejected with help", async () => {
    const io = baseIo({ platform: "linux" });
    const { code, text } = await run(io, ["service", "restart", "writer"]);
    expect(code).toBe(1);
    expect(text).toContain("Unknown subcommand: service restart");
  });
});
