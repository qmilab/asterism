// The real terminal the dashboard draws to, over Node/Bun's stdin/stdout. This is
// the single place that touches process I/O for the TUI — `runDashboard` and
// `render` stay pure over the injected {@link TerminalIO}, so the whole UI is
// testable with a fake terminal and this thin adapter is the only untested seam.
//
// Keys arrive as raw bytes in raw mode; `decodeKeys` turns a chunk into normalized
// {@link Key}s (arrows, enter, backspace, escape, Ctrl+<x>, and printable chars).
// `columns`/`rows` are getters so a live resize is always reflected.

import type { Key, TerminalIO } from "./tui.js";

/**
 * Decode a stdin chunk into key presses. A chunk can hold several keys (fast typing)
 * or a multi-byte escape sequence (arrows). Letter names are lowercased so command
 * bindings match regardless of shift/caps; the raw character rides on `sequence` for
 * text input.
 */
export function decodeKeys(chunk: Buffer | string): Key[] {
  const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const keys: Key[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\x1b") {
      const next = s[i + 1];
      if (next === "[" || next === "O") {
        const code = s[i + 2];
        const arrow: Record<string, string> = { A: "up", B: "down", C: "right", D: "left" };
        if (code && arrow[code]) {
          keys.push({ name: arrow[code]!, ctrl: false, sequence: "" });
          i += 3;
          continue;
        }
        // Unknown CSI sequence — consume the introducer + final byte and move on.
        i += 3;
        continue;
      }
      keys.push({ name: "escape", ctrl: false, sequence: "\x1b" });
      i += 1;
      continue;
    }
    if (c === "\r" || c === "\n") {
      keys.push({ name: "enter", ctrl: false, sequence: c });
      i += 1;
      continue;
    }
    if (c === "\x7f" || c === "\b") {
      keys.push({ name: "backspace", ctrl: false, sequence: c });
      i += 1;
      continue;
    }
    if (c === "\t") {
      keys.push({ name: "tab", ctrl: false, sequence: c });
      i += 1;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x20) {
      // A control character: Ctrl+<letter> (e.g. 0x03 → Ctrl+C). 0x40 maps 1→'a'.
      keys.push({ name: String.fromCharCode(code + 0x60), ctrl: true, sequence: c });
      i += 1;
      continue;
    }
    keys.push({ name: c.toLowerCase(), ctrl: false, sequence: c });
    i += 1;
  }
  return keys;
}

/**
 * Build a {@link TerminalIO} over the process's stdin/stdout. Side-effect-free to
 * construct: no listener is attached and raw mode is not touched until `onKey` /
 * `setRawMode` are called (which `runDashboard` does), so creating one for every CLI
 * invocation costs nothing.
 */
export function createNodeTerminal(): TerminalIO {
  const stdin = process.stdin;
  const stdout = process.stdout;
  return {
    get columns(): number {
      return stdout.columns ?? 80;
    },
    get rows(): number {
      return stdout.rows ?? 24;
    },
    write(s: string): void {
      stdout.write(s);
    },
    setRawMode(on: boolean): void {
      if (stdin.isTTY) stdin.setRawMode(on);
      if (on) stdin.resume();
      else stdin.pause();
    },
    onKey(handler: (key: Key) => void | Promise<void>): () => void {
      const onData = (chunk: Buffer): void => {
        for (const key of decodeKeys(chunk)) void handler(key);
      };
      stdin.on("data", onData);
      return () => {
        stdin.off("data", onData);
      };
    },
    onResize(handler: () => void): () => void {
      stdout.on("resize", handler);
      return () => {
        stdout.off("resize", handler);
      };
    },
  };
}
