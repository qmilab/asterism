// One rule about values that come from the environment: a variable that EXISTS but
// holds nothing has supplied nothing (#173, #174).
//
// `export ASTERISM_MODEL_ID=` leaves the variable defined and empty. Read with
// `!== undefined` that counts as set, and the two surfaces that read it then disagreed
// about the same install: `config show` reported a configured model AND an active
// override, while `run` reported no model at all. An empty `ASTERISM_MODEL_PROVIDER`
// went further and printed advice that could not be typed — `--provider  --base-url
// <url>`, a flag whose value is the next flag.
//
// The convention this follows is the shell's own: clearing a variable is how you turn
// something off, and the credential-shaped reads in this package (`ASTERISM_HTTP_TOKEN`,
// the chat bot tokens, the embeddings endpoint) already treat it that way. This module
// is where the rule lives so the surfaces that report a value and the code that uses it
// cannot answer the question differently.
//
// It deliberately does NOT cover a value the operator TYPED. An empty inline argument is
// a statement, and reaching past it would substitute something they never named — see
// {@link ambientValue}.

/** An environment (or any name → value map) a value may be read from. */
type Env = Record<string, string | undefined>;

/**
 * A value from a source that merely EXISTS rather than one the operator typed — the
 * environment, a pipe. Empty means nothing was supplied, so the caller moves on to the
 * next source; an empty inline argument is not run through this, because typing one is
 * a statement and looking past it would substitute a value the operator never named.
 */
export function ambientValue(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * The text an environment variable carries, TRIMMED — or undefined when it carries none.
 *
 * The reading for a COORDINATE (a model id, an endpoint, a provider name) and for an
 * infrastructure CREDENTIAL (an API key, a chat bot token): whitespace on its own is never
 * what was meant, and whitespace on the END is what a copy-paste or a here-doc leaves
 * behind. Trimming it is the difference between a key that works and an opaque
 * invalid-header error at the first request.
 *
 * Deliberately NOT the reading for a value the operator supplied as an agent's own secret
 * (see {@link ambientValue}): padding there may be load-bearing, and it is theirs to
 * decide. Those are the only two rules in this module, and each is named for the question
 * it answers. There WAS a third — an untrimmed `envIsSet`, used by one reporting line
 * while every consumer moved to this one — and it did exactly what a second rule always
 * does: `config show` called a whitespace-only `ASTERISM_MODEL_ID` an active override
 * while the resolver ignored it. One install, two answers, in the fix for that (#174).
 */
export function envText(env: Env, name: string): string | undefined {
  const trimmed = env[name]?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Whether a variable carries any text. Derived from {@link envText} rather than asked
 * again, so a surface that REPORTS a variable as set and the code that USES it cannot
 * answer differently.
 */
export function suppliesText(env: Env, name: string): boolean {
  return envText(env, name) !== undefined;
}

/** The pair of variables that configure a local embeddings endpoint. Declared once. */
export const EMBED_ENDPOINT_VARS = [
  "ASTERISM_RECALL_EMBED_URL",
  "ASTERISM_RECALL_EMBED_MODEL",
] as const;

/**
 * The local embeddings endpoint {@link EMBED_ENDPOINT_VARS} configures, or undefined
 * when it does not — which takes BOTH variables carrying something.
 *
 * It lives here rather than beside the builder that consumes it because `config show`
 * needs the same answer, and `recall-provider.ts` is imported LAZILY on purpose: an
 * install that never opts in must not load the embeddings package. Two readings of one
 * question is what this used to be — `config show` filtered the two names on "is it
 * set", so either variable alone printed "local-embeddings endpoint configured" while a
 * run on an opted-in agent refused with "the endpoint is not configured". One install,
 * two answers, which is the whole of #174.
 *
 * Trimmed, unlike {@link ambientValue} — a whitespace-only URL is not an endpoint, where
 * a whitespace-padded credential may well be a credential.
 */
export function embeddingEndpoint(env: Env): { url: string; model: string } | undefined {
  const url = envText(env, "ASTERISM_RECALL_EMBED_URL");
  const model = envText(env, "ASTERISM_RECALL_EMBED_MODEL");
  return url !== undefined && model !== undefined ? { url, model } : undefined;
}

/**
 * The {@link EMBED_ENDPOINT_VARS} still needed when SOME of them are set — empty both
 * when none is set (nothing to report) and when the endpoint is complete.
 *
 * The half-configured state is the one worth naming. Reporting it as "configured" was
 * wrong (the run refuses), but reporting it as nothing at all is silence over a variable
 * the operator did export: they see `writer → local [set]`, no endpoint line, and then a
 * hard failure at run time with no hint that they were one variable away.
 */
export function missingEmbeddingVars(env: Env): string[] {
  const supplied = EMBED_ENDPOINT_VARS.filter((k) => suppliesText(env, k));
  if (supplied.length === 0 || supplied.length === EMBED_ENDPOINT_VARS.length) return [];
  return EMBED_ENDPOINT_VARS.filter((k) => !supplied.includes(k));
}

