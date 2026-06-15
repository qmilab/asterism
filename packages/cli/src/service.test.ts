import { describe, expect, test } from "bun:test";

import {
  isServiceKind,
  launchdLabel,
  renderEnvFile,
  renderEnvTemplate,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWrapper,
  serviceCommand,
  SERVICE_KINDS,
  shQuote,
  systemdUnitName,
} from "./service.ts";

describe("service kinds", () => {
  test("the supported kinds are serve, telegram, discord", () => {
    expect([...SERVICE_KINDS]).toEqual(["serve", "telegram", "discord"]);
  });

  test("isServiceKind narrows only the known kinds", () => {
    expect(isServiceKind("serve")).toBe(true);
    expect(isServiceKind("telegram")).toBe(true);
    expect(isServiceKind("discord")).toBe(true);
    expect(isServiceKind("daemon")).toBe(false);
    expect(isServiceKind("")).toBe(false);
  });

  test("each kind maps to its long-lived asterism command", () => {
    expect(serviceCommand("serve", "writer")).toEqual(["serve", "writer"]);
    expect(serviceCommand("telegram", "writer")).toEqual(["channel", "telegram", "writer"]);
    expect(serviceCommand("discord", "writer")).toEqual(["channel", "discord", "writer"]);
  });
});

describe("service identifiers", () => {
  test("launchd label is reverse-DNS, per agent and kind", () => {
    expect(launchdLabel("writer", "serve")).toBe("com.qmilab.asterism.writer.serve");
    expect(launchdLabel("work", "telegram")).toBe("com.qmilab.asterism.work.telegram");
  });

  test("systemd unit name is per agent and kind", () => {
    expect(systemdUnitName("writer", "serve")).toBe("asterism-writer-serve.service");
    expect(systemdUnitName("work", "discord")).toBe("asterism-work-discord.service");
  });
});

describe("shQuote", () => {
  test("wraps a plain token in single quotes", () => {
    expect(shQuote("serve")).toBe("'serve'");
  });

  test("preserves spaces inside the quotes", () => {
    expect(shQuote("/Applications/My App/node")).toBe("'/Applications/My App/node'");
  });

  test("escapes an embedded single quote without breaking out", () => {
    // O'Brien -> 'O'\''Brien' — close, escaped quote, reopen.
    expect(shQuote("O'Brien")).toBe(`'O'\\''Brien'`);
  });
});

describe("renderWrapper", () => {
  const wrapper = renderWrapper({
    label: "writer (telegram)",
    argv: ["/abs/node", "/abs/bin.js", "channel", "telegram", "writer", "--allow", "123"],
    workingDir: "/home/me/project",
    envFile: "/home/me/.config/asterism/services/writer.telegram/service.env",
  });

  test("starts with a POSIX sh shebang", () => {
    expect(wrapper.startsWith("#!/bin/sh\n")).toBe(true);
  });

  test("sources the env file only when readable, then unsets auto-export", () => {
    expect(wrapper).toContain("set -a");
    expect(wrapper).toContain(
      `[ -r '/home/me/.config/asterism/services/writer.telegram/service.env' ] && . '/home/me/.config/asterism/services/writer.telegram/service.env'`,
    );
    expect(wrapper).toContain("set +a");
  });

  test("changes into the working directory before exec", () => {
    expect(wrapper).toContain("cd '/home/me/project' || exit 1");
  });

  test("execs the absolute, shell-quoted command", () => {
    expect(wrapper).toContain(
      "exec '/abs/node' '/abs/bin.js' 'channel' 'telegram' 'writer' '--allow' '123'",
    );
  });
});

describe("renderLaunchdPlist", () => {
  const plist = renderLaunchdPlist({
    label: "com.qmilab.asterism.writer.serve",
    wrapperPath: "/home/me/.config/asterism/services/writer.serve/run.sh",
    workingDir: "/home/me/project",
    logFile: "/home/me/.config/asterism/services/writer.serve/service.log",
  });

  test("declares the label and runs the wrapper through /bin/sh", () => {
    expect(plist).toContain("<string>com.qmilab.asterism.writer.serve</string>");
    expect(plist).toContain("<string>/bin/sh</string>");
    expect(plist).toContain(
      "<string>/home/me/.config/asterism/services/writer.serve/run.sh</string>",
    );
  });

  test("runs at load and restarts only on a non-clean exit", () => {
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
  });

  test("captures stdout and stderr to the log file", () => {
    expect(plist).toContain(
      "<string>/home/me/.config/asterism/services/writer.serve/service.log</string>",
    );
  });

  test("XML-escapes paths that contain markup characters", () => {
    const escaped = renderLaunchdPlist({
      label: "com.qmilab.asterism.a&b.serve",
      wrapperPath: "/tmp/a&b/run.sh",
      workingDir: "/tmp/a<b",
      logFile: "/tmp/a&b/service.log",
    });
    expect(escaped).toContain("com.qmilab.asterism.a&amp;b.serve");
    expect(escaped).toContain("/tmp/a&amp;b/run.sh");
    expect(escaped).toContain("/tmp/a&lt;b");
    expect(escaped).not.toContain("a&b/run.sh");
  });
});

describe("renderSystemdUnit", () => {
  const unit = renderSystemdUnit({
    description: "Asterism — writer (serve)",
    wrapperPath: "/home/me/.config/asterism/services/writer.serve/run.sh",
    workingDir: "/home/me/project",
  });

  test("describes the service and execs the wrapper via /bin/sh", () => {
    expect(unit).toContain("Description=Asterism — writer (serve)");
    expect(unit).toContain(
      `ExecStart=/bin/sh "/home/me/.config/asterism/services/writer.serve/run.sh"`,
    );
    expect(unit).toContain(`WorkingDirectory="/home/me/project"`);
  });

  test("restarts on failure and starts at login", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("quotes paths with spaces and escapes the systemd `%` and `$` in ExecStart", () => {
    const tricky = renderSystemdUnit({
      description: "Asterism — writer (serve)",
      wrapperPath: "/home/My User/.config/asterism/services/writer.serve/run%20$X.sh",
      workingDir: "/home/My User/pro$ject",
    });
    // ExecStart undergoes %- and $-expansion: both are doubled.
    expect(tricky).toContain(
      `ExecStart=/bin/sh "/home/My User/.config/asterism/services/writer.serve/run%%20$$X.sh"`,
    );
    // WorkingDirectory does %-expansion only, so its `$` stays literal.
    expect(tricky).toContain(`WorkingDirectory="/home/My User/pro$ject"`);
  });
});

describe("renderEnvTemplate", () => {
  const template = renderEnvTemplate("writer (telegram)", [
    { name: "ASTERISM_TELEGRAM_TOKEN", required: true, note: "your Telegram bot token." },
    { name: "OPENAI_API_KEY", required: true, note: "your model API key." },
    { name: "ASTERISM_TELEGRAM_ALLOW", required: false, note: "allowed chat ids." },
  ]);

  test("names the service and every variable, commented out with no value", () => {
    expect(template).toContain("# Environment for writer (telegram).");
    expect(template).toContain("# ASTERISM_TELEGRAM_TOKEN=");
    expect(template).toContain("# OPENAI_API_KEY=");
    expect(template).toContain("# ASTERISM_TELEGRAM_ALLOW=");
  });

  test("marks each variable required or optional", () => {
    expect(template).toContain("# Required — your Telegram bot token.");
    expect(template).toContain("# Optional — allowed chat ids.");
  });

  test("never writes an actual value (every KEY= line is commented)", () => {
    for (const line of template.split("\n")) {
      if (/^[A-Z]/.test(line)) {
        throw new Error(`uncommented line leaked into the env template: ${line}`);
      }
    }
  });
});

describe("renderEnvFile (--capture-env)", () => {
  const vars: { name: string; required: boolean; note: string }[] = [
    { name: "ASTERISM_TELEGRAM_TOKEN", required: true, note: "token." },
    { name: "OPENAI_API_KEY", required: true, note: "api key." },
    { name: "ASTERISM_TELEGRAM_ALLOW", required: false, note: "ids." },
  ];
  const values: Record<string, string | undefined> = {
    ASTERISM_TELEGRAM_TOKEN: "token with spaces",
    OPENAI_API_KEY: "sk-abc",
  };
  const out = renderEnvFile("writer (telegram)", vars, (n) => values[n]);

  test("writes present values as real, shell-quoted assignments", () => {
    expect(out).toContain("OPENAI_API_KEY='sk-abc'");
    expect(out).toContain("ASTERISM_TELEGRAM_TOKEN='token with spaces'");
  });

  test("leaves an absent variable as a commented placeholder", () => {
    expect(out).toContain("# ASTERISM_TELEGRAM_ALLOW=");
    expect(out).not.toMatch(/^ASTERISM_TELEGRAM_ALLOW=/m);
  });

  test("shell-quotes a value containing a single quote without breaking out", () => {
    const escaped = renderEnvFile("x", [{ name: "K", required: true, note: "n" }], () => "a'b");
    expect(escaped).toContain(`K='a'\\''b'`);
  });
});
