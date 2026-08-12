// Bound outbound endpoints — the product's FIRST credential-bearing capability class.
//
// Every tool before this one either touched the host's environment (`fs.*`, wired
// through the store-free `CliIO.capabilities` seam) or the agent's own kernel state
// (`notes.*`, `world-facts.ts`). This one carries a SECRET off the machine, which makes
// it a third category and the one golden rule 2 is written for:
//
//   The kernel builds, gates and discards the capability. The credential lives in the
//   `execute` CLOSURE, never in the `ScopedTool` descriptor. The adapter — Pi, or any
//   other — receives a name, a schema and a function, and there is no path from any of
//   the three back to the value.
//
// Four properties are load-bearing, and each is enforced somewhere different on purpose:
//
//   1. THE AGENT SUPPLIES NOTHING. The tool takes no arguments. The operator declared
//      the whole URL, query string included, so NO AGENT-AUTHORED BYTE LEAVES THE
//      MACHINE — the exfiltration surface is exactly "the credential the operator bound
//      goes to the URL the operator named". This product has no outbound content screen
//      (the memory firewall is inbound by construction), so a shape that let the agent
//      author outbound bytes would need one to exist first.
//   2. THE BINDING IS THE GRANT. A row in `agent_endpoints` unions `api.<name>` into the
//      agent's resolved capability set. `DEFAULT_CAPABILITY_KEYS` stays closed, so this
//      class can never be inherited by an agent that never asked for it.
//   3. DESTRUCTIVE AT EVERY TRUST LEVEL, ALWAYS. CLAUDE.md classifies outbound calls
//      carrying secrets as destructive, and this capability additionally can never be
//      auto-approved — see `isCredentialBearingKey` and the two locks it serves.
//   4. THE VALUE COMES BACK FROM NOWHERE. What the endpoint returns is scrubbed of the
//      exact value just disclosed, then run through the trace redaction boundary, then
//      bounded — in that order, for the reasons in `screenEndpointResponse`.
//
// `core` performs no I/O (no `node:fs`, and no `fetch` — `recall-local` is a separate
// package for exactly that reason), so the call itself is a HOST obligation behind
// {@link OutboundHost}, the same split `ArtifactFetchHost` makes: the kernel decides
// whether a credential may cross, the host moves the bytes.

import type { ToolResult } from "./adapter.js";
import type { Capability } from "./trust.js";
import type { AsterismStore } from "./store.js";
import type { BoundEndpoint } from "./types.js";
import { CREDENTIAL_CAPABILITY_PREFIX } from "./capabilities.js";
import { SECRET_MARK, redactForTrace } from "./redaction.js";

/**
 * How much of a response the kernel keeps and hands to the model. Its OWN constant
 * rather than a reuse of `DEFAULT_TRACE_CONTENT_MAX_BYTES`: the two are the same number
 * today and mean different things — what a trace records versus what a model is handed
 * — and one constant serving two purposes is how a later change to one silently moves
 * the other.
 */
export const DEFAULT_ENDPOINT_RESPONSE_MAX_BYTES = 4096;

/**
 * The most a host may buffer from one response. A memory guard, deliberately far above
 * the keep-cap: the kernel does the truncation itself, AFTER scrubbing, so there is
 * exactly one cut point and no chance of a credential straddling it and leaving a
 * readable fragment.
 */
export const OUTBOUND_READ_MAX_BYTES = 1_048_576;

/** How long a host may wait for a response before failing the call. */
export const OUTBOUND_TIMEOUT_MS = 30_000;

/** The most endpoints one agent may bind — a bound on the agent's tool list. */
export const MAX_BOUND_ENDPOINTS = 32;

/**
 * Below this length an echoed value is NOT exact-match scrubbed from a response. A
 * short string occurs by coincidence, and scrubbing every occurrence of a four-character
 * value would shred ordinary output while protecting something that is not a credential.
 * The shape rules in {@link redactForTrace} still run over it.
 */
const MIN_SCRUBBABLE_SECRET_LENGTH = 8;

/** Longest accepted endpoint name; it becomes a capability key and a tool name. */
const MAX_ENDPOINT_NAME_LENGTH = 32;

/** Longest accepted URL. */
const MAX_ENDPOINT_URL_LENGTH = 2048;

// ---------------------------------------------------------------------------
// 1. The host seam.
// ---------------------------------------------------------------------------

/** One outbound call, fully assembled by the kernel. */
export interface OutboundRequest {
  /** The complete URL, exactly as the operator declared it. */
  url: string;
  /**
   * The headers to send, credential included. A host must treat this as secret
   * material: it may transmit it and must not log, cache, or persist it.
   */
  headers: Readonly<Record<string, string>>;
  /** Fail the call after this many milliseconds. */
  timeoutMs: number;
  /** Stop reading the body after this many bytes. */
  maxBytes: number;
}

/** What a host reports back. Never the request, and never a header. */
export type OutboundResponse =
  | { ok: true; status: number; body: string }
  | { ok: false; reason: string };

/**
 * What a host must do for an outbound call that the kernel cannot: speak HTTP. The same
 * split {@link ArtifactFetchHost} makes for the filesystem, and it carries obligations
 * that are contract rather than advice, because each one is a way the kernel's guarantee
 * fails silently without it:
 *
 *   - **Do not follow redirects.** A declared endpoint that answers `302` to another
 *     origin would otherwise forward the `Authorization` header to a host the operator
 *     never named — the one way an operator-declared URL becomes an attacker-chosen one.
 *     A redirect is a response, reported as one; it is never chased.
 *   - **Time out.** A hung socket parks a run with no gate decision to resume from.
 *   - **Bound the body read** at `maxBytes`. The kernel caps what it keeps, but a host
 *     that buffers a gigabyte first has already lost.
 *   - **Never log the request.** It carries the credential.
 *
 * Absent from a surface ⇒ that surface's bound endpoints report themselves unavailable
 * rather than calling. Safe, and deliberately LOUD at the tool result, because an
 * unavailability that reads as a refusal is indistinguishable from a working gate.
 */
export interface OutboundHost {
  call(request: OutboundRequest): Promise<OutboundResponse>;
}

// ---------------------------------------------------------------------------
// 2. Naming and validation — the write boundary.
// ---------------------------------------------------------------------------

/** The capability key a bound endpoint grants. */
export function endpointCapabilityKey(name: string): string {
  return `${CREDENTIAL_CAPABILITY_PREFIX}${name}`;
}

/**
 * The tool name the model sees. Injective over the accepted alphabet — `-` maps to `_`
 * and `_` is not an accepted name character, so two distinct bindings can never resolve
 * to one tool name.
 */
export function endpointToolName(name: string): string {
  return `call_${name.replace(/-/g, "_")}`;
}

/**
 * Assert an endpoint name is usable, and return it.
 *
 * Strict, because this string becomes BOTH a capability key and a tool name a
 * model-facing provider must accept: a lowercase identifier, no leading dash, bounded.
 * The write-boundary chokepoint, beside `validateCapabilityKeys` — a bad name from a
 * surface can never reach a stored binding the kernel later builds a tool from.
 */
export function validateEndpointName(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("invalid endpoint name: expected a non-empty name");
  }
  if (name.length > MAX_ENDPOINT_NAME_LENGTH) {
    throw new Error(
      `invalid endpoint name: at most ${MAX_ENDPOINT_NAME_LENGTH} characters`,
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `invalid endpoint name: ${JSON.stringify(name)} (lowercase letters, digits and dashes only, starting with a letter or digit)`,
    );
  }
  return name;
}

/**
 * Assert an endpoint URL is usable, and return it verbatim.
 *
 * Two refusals, and both are about keeping the URL a piece of CONFIG rather than a
 * value the event log must not hold:
 *
 *   - **`https` only.** A credential sent over cleartext `http` is a credential on the
 *     wire. The natural exception is loopback, which never leaves the box — but that is
 *     a hostname-classification rule (`localhost`, `127.0.0.0/8`, `::1`, and the
 *     question of names that merely RESOLVE to loopback), and a rule that has to be
 *     exactly right is worth more than it buys in a first class. Deferred with a trigger.
 *   - **No userinfo.** `https://user:pass@host` would smuggle a credential past the
 *     credentials table into a column that is displayed and logged.
 */
export function validateEndpointUrl(url: string): string {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("invalid endpoint URL: expected a non-empty URL");
  }
  if (url.length > MAX_ENDPOINT_URL_LENGTH) {
    throw new Error(`invalid endpoint URL: at most ${MAX_ENDPOINT_URL_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid endpoint URL: ${JSON.stringify(url)} is not a URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `invalid endpoint URL: only https is supported (a credential sent over ${parsed.protocol}// travels in cleartext)`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      "invalid endpoint URL: a URL may not carry a username or password — store the credential with `asterism secrets add` and bind it by key",
    );
  }
  if (parsed.hostname === "") {
    throw new Error(`invalid endpoint URL: ${JSON.stringify(url)} names no host`);
  }
  return url;
}

/**
 * What an event may record about a URL: its origin and path, never its query string.
 *
 * The event log stores references, never values — and a query string is the one part of
 * an operator-declared URL that can carry secret material in a shape nothing can detect
 * in general. The operator still sees the whole URL wherever they configured it and at
 * the confirmation prompt; only the durable log is narrowed.
 */
export function endpointLogTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Unreachable through the validated write path; a stored value that will not parse
    // is reported as such rather than echoed into the log.
    return "(unparseable URL)";
  }
}

// ---------------------------------------------------------------------------
// 3. The response pipeline.
// ---------------------------------------------------------------------------

/**
 * Screen an endpoint's response on its way to the model and the trace. Three steps, and
 * the ORDER is the design:
 *
 *   1. **Exact-match scrub of the value just disclosed.** `redactForTrace`'s
 *      `SECRET_VALUE_RULES` are SHAPE rules — they catch `sk-`, `ghp_`, JWTs, `AKIA`,
 *      assignments — and an arbitrary opaque bearer token has no shape. But the kernel
 *      knows precisely which value it just sent, so it can remove that one totally. An
 *      endpoint that echoes the credential back (a debug route, a misconfigured proxy,
 *      an error body quoting the request) cannot return it to the agent's context.
 *      Skipped below {@link MIN_SCRUBBABLE_SECRET_LENGTH}, where a "value" occurs by
 *      coincidence and scrubbing it would shred the output while protecting nothing.
 *   2. **`redactForTrace`.** The shape rules for values the kernel did NOT send, control
 *      stripping, and — for free, and it matters here more than anywhere else — the
 *      firewall span scrub, so injection-shaped text in an external response is screened
 *      on its way into the model's context.
 *   3. **The bound**, applied by `redactForTrace` itself. Last, so the single cut point
 *      is AFTER the scrub and a credential cannot straddle it and leave a readable
 *      fragment. This is why the host's read cap ({@link OUTBOUND_READ_MAX_BYTES}) is a
 *      memory guard set far above the keep-cap rather than the keep-cap itself.
 */
export function screenEndpointResponse(body: string, disclosed?: string): string {
  const scrubbed =
    disclosed !== undefined && disclosed.length >= MIN_SCRUBBABLE_SECRET_LENGTH
      ? body.split(disclosed).join(SECRET_MARK)
      : body;
  return redactForTrace(scrubbed, { maxBytes: DEFAULT_ENDPOINT_RESPONSE_MAX_BYTES }).content;
}

// ---------------------------------------------------------------------------
// 4. The capabilities.
// ---------------------------------------------------------------------------

/** A tool failure the model can see and react to (never throws across the seam). */
function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

/**
 * Build the credential-bearing capabilities for one agent's bindings, bound to that
 * agent's store scope.
 *
 * One capability per row, so exposure, the gate, the audit and (were it ever allowed)
 * standing are all per-ENDPOINT rather than per-class: revoking one binding says nothing
 * about another. Called from `run.ts` beside {@link worldFactCapabilities}, on the
 * kernel's side of the adapter boundary; the adapter receives only the resulting
 * `execute`.
 *
 * `host` absent ⇒ the capabilities are still BUILT and each reports itself unavailable
 * when called. Deliberately not "omit the tool": an absent tool is observationally
 * identical to a gated one, and that identity is how a demo passes while proving nothing
 * (the lesson `capability-ownership.md` §6.11 paid for). The same reasoning governs a
 * binding whose credential has been removed — see the `execute` below.
 */
export function endpointCapabilities(
  store: AsterismStore,
  agentId: string,
  host: OutboundHost | undefined,
  runId?: string,
): Capability[] {
  return store.endpoints.list(agentId).map((binding) => endpointCapability(store, binding, host, runId));
}

function endpointCapability(
  store: AsterismStore,
  binding: BoundEndpoint,
  host: OutboundHost | undefined,
  runId: string | undefined,
): Capability {
  const key = endpointCapabilityKey(binding.name);
  return {
    key,
    // Declared destructive, unconditionally and at every trust level. CLAUDE.md
    // classifies outbound calls carrying secrets as destructive, and there is no
    // argument-dependent variant of this to reason about: the call always carries the
    // credential, so it is always the thing the gate exists for.
    effect: "destructive",
    // What the human is asked to approve. References only — the credential's KEY, never
    // its value — because this reaches a prompt and an audit fingerprint. Without it the
    // confirmation for the product's most consequential action would name nothing at
    // all, since the agent supplies no arguments to describe.
    gateContext: {
      endpoint: binding.name,
      url: binding.url,
      credential: binding.credentialKey,
      method: "GET",
    },
    tool: {
      name: endpointToolName(binding.name),
      description:
        `Call the '${binding.name}' endpoint your operator set up for you and return what it ` +
        `sends back. It takes no arguments — the address is fixed, and the credentials are ` +
        `attached for you and never shown to you. A human has to approve every call.`,
      // NO arguments, ever. The operator declared the whole address, so there is nothing
      // for the agent to choose and nothing it authors leaves the machine.
      inputSchema: { type: "object", properties: {} },
      execute: async (): Promise<ToolResult> => {
        if (!host) {
          return failure(
            `The '${binding.name}' endpoint cannot be called from here — this surface has no outbound support.`,
          );
        }
        // THE BINDING IS RE-READ HERE, after the human's pause and before the credential
        // is read. A confirmation is human-length, and an operator may `api remove` (or
        // rebind to a different URL or credential) while the prompt is open. Trusting
        // the resolution from run start across that pause is what would let a call go
        // out under a binding that no longer exists — the same failure the artifact-fetch
        // review found for a revoked connection, and the reason its `execute` re-reads
        // the channel. Identity is compared, not mere existence: a rebind during the
        // pause is a DIFFERENT call than the one a human approved.
        const current = store.endpoints.getByName(binding.agentId, binding.name);
        if (
          !current ||
          current.id !== binding.id ||
          current.url !== binding.url ||
          current.credentialKey !== binding.credentialKey
        ) {
          return failure(
            `The '${binding.name}' endpoint changed or was removed before this call could run.`,
          );
        }
        // The one place a credential VALUE enters this module, audited as `secret.read`
        // (this class is that event type's first producer) and tagged with the
        // originating run so the per-run audit is complete. `agentId` comes from the
        // binding row, which is itself agent-scoped, so an agent can only ever reach its
        // own secrets.
        const value = store.readSecret(binding.agentId, binding.credentialKey, runId);
        if (value === undefined) {
          // Loud, not absent: the tool exists and says exactly what is missing. Reading
          // nothing discloses nothing, so no `secret.read` was recorded.
          return failure(
            `No credential '${binding.credentialKey}' is stored for this agent, so the ` +
              `'${binding.name}' endpoint cannot be called. Add it with: asterism secrets add ` +
              `<agent> ${binding.credentialKey}`,
          );
        }
        let response: OutboundResponse;
        try {
          response = await host.call({
            url: binding.url,
            headers: { Authorization: `Bearer ${value}` },
            timeoutMs: OUTBOUND_TIMEOUT_MS,
            maxBytes: OUTBOUND_READ_MAX_BYTES,
          });
        } catch (err) {
          // A host that throws must not throw across the adapter seam, and its message
          // must not be trusted to be value-free — it may quote the request.
          return failure(
            `The '${binding.name}' endpoint could not be reached: ${screenEndpointResponse(
              err instanceof Error ? err.message : String(err),
              value,
            )}`,
          );
        }
        if (!response.ok) {
          return failure(
            `The '${binding.name}' endpoint could not be reached: ${screenEndpointResponse(response.reason, value)}`,
          );
        }
        // The status is safe to report as-is. The body goes through the pipeline whatever
        // the status — an error body is exactly where a service quotes a request back.
        const screened = screenEndpointResponse(response.body, value);
        if (response.status < 200 || response.status >= 300) {
          return failure(`${binding.name} returned HTTP ${response.status}: ${screened}`);
        }
        return { output: screened };
      },
    },
  };
}
