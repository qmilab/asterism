// A tiny, dependency-free ANSI toolkit for the dashboard TUI.
//
// The project ships zero runtime dependencies (the chat channels speak their wire
// protocols by hand); the dashboard holds that line and draws the terminal itself.
// Nothing here is clever: escape sequences for the alternate screen, the cursor, and
// SGR colors, plus width-aware pad/truncate. Layout is always done in PLAIN text
// first (so widths are correct), then a finished cell is wrapped in a color — color
// codes add no visible width, so the two never fight.

const ESC = "\x1b[";

/** Switch into the alternate screen buffer (so the user's scrollback is preserved). */
export const ENTER_ALT_SCREEN = `${ESC}?1049h`;
/** Leave the alternate screen, restoring whatever was on screen before. */
export const EXIT_ALT_SCREEN = `${ESC}?1049l`;
export const HIDE_CURSOR = `${ESC}?25l`;
export const SHOW_CURSOR = `${ESC}?25h`;
export const CLEAR_SCREEN = `${ESC}2J`;
export const CURSOR_HOME = `${ESC}H`;

/** Move the cursor to a 1-based (row, col). */
export function cursorTo(row: number, col: number): string {
  return `${ESC}${row};${col}H`;
}

const RESET = `${ESC}0m`;

/** Wrap text in an SGR code, resetting after — a no-op on empty text. */
function sgr(code: number, text: string): string {
  return text.length === 0 ? text : `${ESC}${code}m${text}${RESET}`;
}

export const bold = (s: string): string => sgr(1, s);
export const dim = (s: string): string => sgr(2, s);
export const reverse = (s: string): string => sgr(7, s);
export const red = (s: string): string => sgr(31, s);
export const green = (s: string): string => sgr(32, s);
export const yellow = (s: string): string => sgr(33, s);
export const blue = (s: string): string => sgr(34, s);
export const magenta = (s: string): string => sgr(35, s);
export const cyan = (s: string): string => sgr(36, s);
export const gray = (s: string): string => sgr(90, s);

/**
 * Strip ANSI SGR sequences — used to measure the VISIBLE width of a string that may
 * already carry color, so layout math is never thrown off by escape codes.
 */
export function stripAnsi(s: string): string {
  // Matches SGR sequences (ESC [ … m) — the only escapes this toolkit emits.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The visible width of a string (ANSI-stripped; one column per code unit). */
export function width(s: string): number {
  return stripAnsi(s).length;
}

/**
 * Truncate `s` to at most `max` visible columns, marking a cut with `…`. Operates on
 * PLAIN text (call before coloring). A non-positive `max` yields an empty string.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max === 1) return "…";
  return `${s.slice(0, max - 1)}…`;
}

/** Pad (or truncate) PLAIN text to exactly `w` columns, left-aligned. */
export function padEnd(s: string, w: number): string {
  const t = truncate(s, w);
  return t + " ".repeat(Math.max(0, w - t.length));
}
