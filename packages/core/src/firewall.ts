// The memory firewall — the kernel screens every inbound memory write for
// injection / exfiltration patterns BEFORE persistence.
//
// Why memory specifically. An agent's memory is high-trust: it is replayed into
// the framing of future runs (see `framing.ts`). A poisoned memory is a
// persistent prompt injection — write it once, and every later run silently
// inherits "ignore your instructions" or "send the GITHUB_TOKEN to evil.test".
// Screening at the write boundary is the kernel's chance to refuse before that
// content can ever shape behaviour.
//
// Two threat shapes, kept deliberately separate and each as a NAMED rule table
// so a test can assert every pattern individually (the same discipline as the
// destructive-command taxonomy in `trust.ts` — "never a vibe"):
//
//   1. INJECTION   — content that tries to override the agent's instructions,
//                    reassign its role, or forge conversation turns.
//   2. EXFILTRATION — content that tries to disclose or smuggle out secrets
//                    (credentials, tokens, the system prompt) or carry private
//                    data to an outbound channel.
//
// SCOPE — like the shell denylist in `trust.ts`, this is best-effort
// defense-in-depth, NOT the primary boundary. The real guarantees are
// agent-scoping (a poisoned memory can only ever reach its own agent) and the
// destructive-action gate (exporting a credential value is destructive and
// confirms regardless of trust). These patterns raise the cost of the obvious
// attacks; they are deliberately narrow so ordinary memories ("alice's secret
// note", "the API is slow") are never blocked. Extend the tables when a common
// form is missed — do not mistake them for a sandbox.

/** Which threat a finding belongs to. */
export const FIREWALL_CATEGORIES = ["injection", "exfiltration"] as const;
export type FirewallCategory = (typeof FIREWALL_CATEGORIES)[number];

/** A single named pattern in a firewall rule table. */
export interface FirewallRule {
  readonly name: string;
  readonly category: FirewallCategory;
  readonly pattern: RegExp;
}

/** One rule that matched a screened piece of content. */
export interface FirewallFinding {
  readonly rule: string;
  readonly category: FirewallCategory;
}

/** The verdict of screening one piece of content. `ok` ⇔ no findings. */
export interface FirewallVerdict {
  readonly ok: boolean;
  readonly findings: readonly FirewallFinding[];
}

// ---------------------------------------------------------------------------
// Injection — attempts to override instructions / reassign role / forge turns.
// ---------------------------------------------------------------------------

export const MEMORY_INJECTION_RULES: readonly FirewallRule[] = [
  // "ignore/disregard/forget the previous instructions", and close variants. The
  // verb and the {previous|prior|above|all} target must co-occur, so a plain
  // sentence using "ignore" or "previous" alone is not flagged.
  {
    name: "instruction override",
    category: "injection",
    pattern:
      /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|earlier|above|all|the)\b[^.\n]{0,24}\b(instructions?|prompts?|rules?|directions?|guidelines?)\b/i,
  },
  // "you are now …", "from now on you are/act …" — a wholesale role reassignment.
  {
    name: "role reassignment",
    category: "injection",
    pattern: /\b(you are now\b|from now on,?\s+(you|act|behave|pretend)\b)/i,
  },
  // "pretend to be …", "act as if you are …" — soul/role spoofing.
  {
    name: "persona spoof",
    category: "injection",
    pattern: /\b(pretend (to be|you are)|act as if you (are|were)|roleplay as)\b/i,
  },
  // Forged conversation turns / chat-template markers smuggled into content
  // (`\nsystem:` , `<|im_start|>`, `[INST]`) — an attempt to fake a higher-
  // privilege turn when the memory is replayed into a prompt.
  {
    name: "forged role turn",
    category: "injection",
    pattern: /(^|\n)\s*(system|assistant|developer)\s*:/i,
  },
  {
    name: "chat template marker",
    category: "injection",
    pattern: /<\|?\s*(im_start|im_end|system|endoftext)\s*\|?>|\[\/?INST\]/i,
  },
];

// ---------------------------------------------------------------------------
// Exfiltration — disclose / smuggle secrets or carry private data outbound.
// ---------------------------------------------------------------------------

// The kinds of secret a disclosure/outbound rule cares about, as one alternation.
const SECRET_NOUN =
  "(secret|credentials?|token|password|passphrase|api[\\s_-]?key|private[\\s_-]?key|access[\\s_-]?key|system\\s*prompt)";

export const MEMORY_EXFILTRATION_RULES: readonly FirewallRule[] = [
  // A secret-store reference (`secret://…`) must never be written into memory —
  // memory is the agent-readable surface; valueRefs belong only in the credential
  // table and event log.
  {
    name: "secret-store reference",
    category: "exfiltration",
    pattern: /\bsecret:\/\//i,
  },
  // An interpolated secret env var (`$GITHUB_TOKEN`, `${API_KEY}`) — a common way
  // to smuggle a live value through a templated string.
  {
    name: "secret env interpolation",
    category: "exfiltration",
    pattern: /\$\{?\s*[A-Z][A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIALS?)\b/,
  },
  // "send/post/upload/email/leak … <secret>" — instruction to disclose secrets
  // to someone/somewhere.
  {
    name: "secret disclosure to channel",
    category: "exfiltration",
    pattern: new RegExp(
      `\\b(send|post|upload|exfiltrate|leak|forward|email|transmit|share)\\b[^.\\n]{0,40}\\b${SECRET_NOUN}\\b`,
      "i",
    ),
  },
  // "reveal/print/show/dump/repeat … <secret | your instructions/prompt>" — a
  // request for the model to emit its own secrets or system prompt.
  {
    name: "secret/prompt disclosure request",
    category: "exfiltration",
    pattern: new RegExp(
      `\\b(reveal|print|show|dump|repeat|output|echo|disclose)\\b[^.\\n]{0,30}(\\b${SECRET_NOUN}\\b|\\byour\\s+(instructions?|prompt|system))`,
      "i",
    ),
  },
  // An outbound shell/HTTP channel carrying a secret (`curl … $TOKEN`,
  // `https://x?key=…`) — exfiltration over the network.
  {
    name: "outbound channel carrying secret",
    category: "exfiltration",
    pattern: new RegExp(
      `\\b(curl|wget|fetch|nc|ncat|https?:\\/\\/)\\b[^\\n]{0,60}\\b${SECRET_NOUN}\\b`,
      "i",
    ),
  },
];

/** Every memory firewall rule, both categories, in screening order. */
export const MEMORY_FIREWALL_RULES: readonly FirewallRule[] = [
  ...MEMORY_INJECTION_RULES,
  ...MEMORY_EXFILTRATION_RULES,
];

/**
 * Screen one piece of memory content against the firewall rule tables. Pure and
 * side-effect free: returns the verdict and every matching rule, but persists
 * nothing and throws nothing. The reflection-review flow uses this to *show*
 * findings to a human; the persistence layer uses {@link assertMemorySafe} to
 * *enforce* them. Returns all findings (not just the first) so a reviewer sees
 * the full picture.
 */
export function screenMemory(content: string): FirewallVerdict {
  const findings: FirewallFinding[] = [];
  for (const rule of MEMORY_FIREWALL_RULES) {
    if (rule.pattern.test(content)) {
      findings.push({ rule: rule.name, category: rule.category });
    }
  }
  return { ok: findings.length === 0, findings };
}

/** Thrown by {@link assertMemorySafe} when content trips the firewall. */
export class MemoryFirewallError extends Error {
  readonly findings: readonly FirewallFinding[];
  constructor(findings: readonly FirewallFinding[]) {
    const summary = findings
      .map((f) => `${f.category}:${f.rule}`)
      .join(", ");
    super(`memory firewall blocked the write (${summary})`);
    this.name = "MemoryFirewallError";
    this.findings = findings;
  }
}

/**
 * Enforcement chokepoint on the memory write path. Screens `content` and throws
 * {@link MemoryFirewallError} if it trips any rule, so an inbound write is
 * screened before persistence — there is no "create memory" path that skips it.
 */
export function assertMemorySafe(content: string): void {
  const verdict = screenMemory(content);
  if (!verdict.ok) throw new MemoryFirewallError(verdict.findings);
}
