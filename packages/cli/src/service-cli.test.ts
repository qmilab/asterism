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
      env: { HOME: home, XDG_CONFIG_HOME: xdg, ASTERISM_TELEGRAM_TOKEN: "tok-123", OPENAI_API_KEY: "sk-xyz" },
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
      env: { HOME: home, XDG_CONFIG_HOME: xdg, ASTERISM_TELEGRAM_TOKEN: "tok", ASTERISM_API_KEY: "sk-shared" },
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
