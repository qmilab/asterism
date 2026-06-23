// The redaction boundary — the kernel's policy for what tool CONTENT is safe to
// persist into an auditable trace.
//
// Why this exists, and why it is MORE than the memory firewall. The memory
// firewall (`firewall.ts`) is block/allow over a narrow set of injection /
// exfiltration *phrasings* in human-typed memory, and its own header is explicit
// that it is "best-effort defense-in-depth, NOT the primary boundary". Tool output
// is a different threat shape: a `read_file` over `.env`, a `cat` of a config, an
// HTTP response — these routinely carry raw secret VALUES (an `sk-…` key, a JWT, a
// PEM block), not the phrasings the firewall targets. The cognition trace's slice 1
// stored references only (a byte count + a keyed fingerprint) precisely to avoid
// persisting those values. Capturing content safely needs a layer aimed at VALUES:
// this module.
//
// `redactForTrace` is the chokepoint. It is PURE (no I/O, no secret reader — it
// works on the text alone, so it can run at the capture point without ever being
// handed a credential), CONSERVATIVE ("when in doubt, redact" — the trace's
// usefulness is secondary to never leaking a value into host storage), and BOUNDED
// (a length cap on what lands on disk). It returns the redacted content plus a
// COUNTS-ONLY summary — never the removed spans, which would re-leak what it just
// scrubbed.
//
// Like the firewall and the destructive-command taxonomy in `trust.ts`, the secret
// rules are a NAMED table so a test can assert every pattern individually — never a
// vibe. Extend the table when a common secret form is missed; do not mistake it for
// a guarantee that no secret can ever slip through (a novel format will). The trace
// is also host-owned and agent-unreachable (see adapter-lodestar); this layer is the
// content half of that defense in depth.

import { MEMORY_FIREWALL_RULES } from "./firewall.js";

/** Default cap on the bytes of tool content captured into the trace (per call). */
export const DEFAULT_TRACE_CONTENT_MAX_BYTES = 4096;

/**
 * A single named secret-value pattern. Mirrors `FirewallRule`, minus the category. An
 * optional `replace` keeps part of the match (e.g. a key name or a URL scheme) and redacts
 * only the secret portion; when absent the whole match becomes {@link SECRET_MARK}. The
 * replace args are `String.prototype.replace`'s — the match, then the capture groups.
 */
export interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace?: (match: string, ...groups: string[]) => string;
}

/**
 * What `redactForTrace` removed, as COUNTS only — never the removed text. A reviewer
 * (and a test) sees that N secrets / M injection spans were scrubbed and whether the
 * content was truncated, without the summary itself re-disclosing a single value.
 */
export interface RedactionSummary {
  /** True when the raw content exceeded the byte cap and was truncated. */
  readonly truncated: boolean;
  /** Byte length of the ORIGINAL (pre-truncation, pre-redaction) content. */
  readonly originalBytes: number;
  /**
   * How many control characters were stripped (ANSI/OSC escapes, CR, NUL, etc.). Stripped
   * FIRST, so they can neither drive an operator's terminal when the trace is read nor be
   * used to split a secret token and evade the patterns below.
   */
  readonly controlsStripped: number;
  /** How many secret-shaped values were scrubbed (across every {@link SECRET_VALUE_RULES} rule). */
  readonly secretsRedacted: number;
  /** How many injection-phrasing spans were scrubbed (firewall injection rules). */
  readonly injectionRedacted: number;
  /** How many exfiltration-phrasing spans were scrubbed (firewall exfiltration rules). */
  readonly exfiltrationRedacted: number;
}

/** The redacted content plus the counts-only account of what was removed. */
export interface RedactionResult {
  readonly content: string;
  readonly summary: RedactionSummary;
}

// Replacement markers — ASCII so they render cleanly in a terminal trace and never re-leak.
// Deliberately keyword-free: a marker must contain NONE of the firewall's secret nouns
// (`secret`, `token`, `key`, `password`, `credential`, …) so the firewall span scrub (which
// runs AFTER the secret scrub) cannot re-match an already-inserted marker — hence
// `[redacted:value]`, not `[redacted:secret]`. The assignment rule's `(?!\[redacted)`
// lookahead complements this, refusing to re-scrub any marker in a value position.
const SECRET_MARK = "[redacted:value]";
const INJECTION_MARK = "[redacted:injection]";
const EXFILTRATION_MARK = "[redacted:exfiltration]";

// ---------------------------------------------------------------------------
// Secret-VALUE rules — aimed at the raw tokens tool output commonly carries.
// Each pattern is global (it must replace EVERY occurrence, not just the first)
// and anchored on a recognizable shape, so ordinary prose is left intact while a
// credential value is scrubbed.
// ---------------------------------------------------------------------------

export const SECRET_VALUE_RULES: readonly RedactionRule[] = [
  // A secret-store reference must never be persisted outside the credential table /
  // event log — same rule the firewall enforces, applied here as a value scrub.
  { name: "secret-store reference", pattern: /\bsecret:\/\/\S+/gi },
  // PEM private-key blocks (RSA/EC/OPENSSH/…). Multiline; non-greedy to the matching END,
  // OR — when truncation removed the END marker — to end of content, so a key fragment is
  // never persisted just because its terminator fell past the byte cap.
  {
    name: "PEM private key block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  // JWTs — three base64url segments. Caught before the generic high-entropy rule so
  // the whole token (dots and all) goes as one unit.
  {
    name: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  },
  // `Bearer <token>` (an Authorization header value). Keep the scheme word, redact the
  // token. Runs before the assignment rule so the token (not just the word "Bearer") goes.
  {
    name: "bearer token",
    pattern: /\b([Bb]earer)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replace: (_m, scheme) => `${scheme} ${SECRET_MARK}`,
  },
  // Credentials embedded in a URL — `scheme://user:password@host`, `postgres://u:p@h/db`.
  // Keep the scheme + host shape; redact only the `user:password` userinfo.
  {
    name: "URL credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s:/@]+@/gi,
    replace: (_m, scheme) => `${scheme}${SECRET_MARK}@`,
  },
  // `KEY = value` / `"api_key": "value"` / `TOKEN='value'` assignments — scrub the VALUE,
  // keep the (optionally quoted) key name + separator + opening quote so the trace still
  // shows a secret was set, not what it was. Handles bare, double-quoted (JSON), and
  // single-quoted forms. The value lookahead `(?!\[redacted:)` refuses to match an
  // already-inserted marker, so a value redacted by an earlier rule is never counted twice.
  {
    name: "secret assignment value",
    pattern:
      /(["']?)([A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET))\1(\s*[:=]\s*)(["']?)(?!\[redacted)[^\s,;}"']+/gi,
    replace: (_m, kq, key, sep, vq) => `${kq}${key}${kq}${sep}${vq}${SECRET_MARK}`,
  },
  // OpenAI / Anthropic-style `sk-…` (and `sk-ant-…`) keys.
  { name: "sk- api key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  // GitHub tokens: ghp_ (PAT), gho_ (OAuth), ghs_ (server), ghu_ (user), ghr_ (refresh).
  { name: "GitHub token", pattern: /\bgh[posru]_[A-Za-z0-9]{20,}\b/g },
  // AWS access key id.
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{12,}\b/g },
  // Slack tokens (`xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, `xoxs-`).
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi },
  // GitLab personal access token.
  { name: "GitLab PAT", pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  // High-entropy catch-all: a 40+ char token mixing lower/upper/digit (the shape of a
  // random key, almost never an English word). Conservative — it may scrub a long
  // opaque id, which for an audit trace is the safe direction.
  {
    name: "high-entropy mixed token",
    pattern: /\b(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
  },
  // Long pure-hex runs (sha-1/256 digests, hex-encoded secrets).
  { name: "long hex run", pattern: /\b[0-9a-fA-F]{40,}\b/g },
];

/**
 * Control characters to strip from captured content: every C0 control EXCEPT tab (\t) and
 * newline (\n), plus DEL. This removes ANSI/OSC escape introducers (ESC, \x1b), carriage
 * returns, and NUL — so reading a trace cannot drive an operator's terminal, and a secret
 * cannot be split by a control char to slip past {@link SECRET_VALUE_RULES}.
 */
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Truncate `raw` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a multibyte
 * character: decode the byte slice and drop a trailing replacement char left by an
 * incomplete sequence at the boundary. Returns the (possibly truncated) text, the
 * flag, and the ORIGINAL byte length.
 */
function truncateUtf8(
  raw: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
  const originalBytes = Buffer.byteLength(raw, "utf8");
  if (originalBytes <= maxBytes) return { text: raw, truncated: false, originalBytes };
  const slice = Buffer.from(raw, "utf8").subarray(0, maxBytes);
  // A non-fatal decode turns an incomplete trailing sequence into one U+FFFD; strip it
  // so the truncated content does not end in a stray replacement char.
  const text = new TextDecoder("utf-8").decode(slice).replace(/�+$/, "");
  return { text, truncated: true, originalBytes };
}

/** A global clone of a firewall rule's pattern, so `replace` scrubs EVERY span, not just the first. */
function globalize(pattern: RegExp): RegExp {
  return pattern.flags.includes("g")
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`);
}

/**
 * Redact tool content for the trace. The boundary, applied in order:
 *
 *   1. BOUND — truncate to `maxBytes` (default {@link DEFAULT_TRACE_CONTENT_MAX_BYTES}),
 *      capping what lands on disk and the blast radius of any miss below. First, so the
 *      regexes below run on at most `maxBytes` — which bounds their cost (no catastrophic
 *      backtracking blow-up on a megabyte of adversarial input).
 *   2. STRIP CONTROL CHARS — remove ANSI/OSC escapes, CR, NUL, etc. ({@link CONTROL_CHARS}).
 *      So reading the trace cannot drive an operator's terminal, AND a secret cannot be
 *      split by a control char to evade the value rules below.
 *   3. SECRET-VALUE SCRUB — replace every {@link SECRET_VALUE_RULES} match (a rule may keep
 *      a key name / URL scheme and redact only the secret). This is the layer the firewall
 *      lacks: it targets the raw VALUES tool output carries, not just phrasings.
 *   4. FIREWALL SPAN SCRUB — run the {@link MEMORY_FIREWALL_RULES} over the scrubbed text
 *      and replace each match with a category marker. Injection content is neutralised
 *      before it could ever become belief → memory (slice 2b re-screens at accept too —
 *      defense in depth); any exfiltration phrasing the value-scrub missed is caught.
 *
 * Returns the redacted content and a COUNTS-ONLY {@link RedactionSummary}. Pure: no I/O,
 * no secret reader, deterministic. A blank input returns blank content and a zeroed summary.
 */
export function redactForTrace(
  raw: string,
  opts: { maxBytes?: number } = {},
): RedactionResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_TRACE_CONTENT_MAX_BYTES;
  const bounded = truncateUtf8(raw, maxBytes);

  // 2. Strip control characters (counting how many).
  let controlsStripped = 0;
  let content = bounded.text.replace(CONTROL_CHARS, () => {
    controlsStripped++;
    return "";
  });

  // 3. Secret-value scrub. Each rule may carry its own `replace` (keep a key/scheme, redact
  // the secret); the default replaces the whole match with the marker. The count is the
  // number of matches across all rules.
  let secretsRedacted = 0;
  for (const rule of SECRET_VALUE_RULES) {
    content = content.replace(globalize(rule.pattern), (match: string, ...groups: unknown[]): string => {
      secretsRedacted++;
      return rule.replace ? rule.replace(match, ...(groups as string[])) : SECRET_MARK;
    });
  }

  // 4. Firewall span scrub, per category.
  let injectionRedacted = 0;
  let exfiltrationRedacted = 0;
  for (const rule of MEMORY_FIREWALL_RULES) {
    content = content.replace(globalize(rule.pattern), () => {
      if (rule.category === "injection") {
        injectionRedacted++;
        return INJECTION_MARK;
      }
      exfiltrationRedacted++;
      return EXFILTRATION_MARK;
    });
  }

  return {
    content,
    summary: {
      truncated: bounded.truncated,
      originalBytes: bounded.originalBytes,
      controlsStripped,
      secretsRedacted,
      injectionRedacted,
      exfiltrationRedacted,
    },
  };
}
