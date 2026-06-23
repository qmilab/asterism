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

/** A single named secret-value pattern. Mirrors `FirewallRule`, minus the category. */
export interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
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

/** Replacement markers — ASCII so they render cleanly in a terminal trace and never re-leak. */
const SECRET_MARK = "[redacted:secret]";
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
  // PEM private-key blocks (RSA/EC/OPENSSH/…). Multiline; non-greedy to the matching END.
  {
    name: "PEM private key block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  // JWTs — three base64url segments. Caught before the generic high-entropy rule so
  // the whole token (dots and all) goes as one unit.
  {
    name: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
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
  // `KEY = value` / `TOKEN: value` assignments — scrub the VALUE, keep the key name so
  // the trace still shows that a secret was set, not what it was. The key half is the
  // capture group; the replacer re-emits it followed by the marker.
  {
    name: "secret assignment value",
    pattern:
      /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY))\b(\s*[:=]\s*)("?)[^\s"']+\3/gi,
  },
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
 *      capping what lands on disk and the blast radius of any miss below.
 *   2. SECRET-VALUE SCRUB — replace every {@link SECRET_VALUE_RULES} match with a marker.
 *      This is the layer the firewall lacks: it targets the raw VALUES tool output
 *      carries, not just injection/exfiltration phrasings.
 *   3. FIREWALL SPAN SCRUB — run the {@link MEMORY_FIREWALL_RULES} over the scrubbed text
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

  // 2. Secret-value scrub.
  let secretsRedacted = 0;
  let content = bounded.text;
  for (const rule of SECRET_VALUE_RULES) {
    content = content.replace(globalize(rule.pattern), (...args) => {
      secretsRedacted++;
      // The "secret assignment value" rule keeps the key name + separator (groups 1, 2)
      // and redacts only the value; every other rule replaces its whole match.
      if (rule.name === "secret assignment value") {
        const [, key, sep] = args as [string, string, string];
        return `${key}${sep}${SECRET_MARK}`;
      }
      return SECRET_MARK;
    });
  }

  // 3. Firewall span scrub, per category.
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
      secretsRedacted,
      injectionRedacted,
      exfiltrationRedacted,
    },
  };
}
