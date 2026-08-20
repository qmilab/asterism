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

/** An environment variable's value, with a present-but-empty one read as unset. */
export function envValue(env: Env, name: string): string | undefined {
  return ambientValue(env[name]);
}

/**
 * An environment variable's value when it carries TEXT — the raw value, returned only if
 * it is not blank. The reading for a COORDINATE (a model id, an endpoint) or an
 * infrastructure CREDENTIAL (an API key), where whitespace on its own is never what was
 * meant and is usually what a copy-paste left behind.
 *
 * Distinct from {@link envValue}, which an agent-scoped secret uses: padding on a
 * credential the operator supplied may be load-bearing, and it is theirs to decide. The
 * difference is only about whether anything is THERE — what is returned, sent or written
 * is the value exactly as given, padding included.
 */
export function envText(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw !== undefined && raw.trim().length > 0 ? raw : undefined;
}

/**
 * Whether an environment variable supplies anything. Derived from {@link envValue}
 * rather than testing `undefined` separately, so a surface that REPORTS a variable as
 * set and the code that USES it can never disagree about what "set" means — which is
 * the whole of #174.
 */
export function envIsSet(env: Env, name: string): boolean {
  return envValue(env, name) !== undefined;
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
  const url = env.ASTERISM_RECALL_EMBED_URL?.trim();
  const model = env.ASTERISM_RECALL_EMBED_MODEL?.trim();
  return url && model ? { url, model } : undefined;
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

/**
 * Whether a variable supplies TEXT — present, and not only whitespace.
 *
 * Stricter than {@link envIsSet}, and only for deciding whether a value exists at all:
 * whatever is written or sent stays verbatim, padding included. It exists because the
 * readers on the other side of a service's env file trim before testing —
 * `resolveHttpToken` does — so capturing `ASTERISM_HTTP_TOKEN="  "` reported a token
 * captured, wrote a blank one into the file, and left the service minting a different
 * token that every client pinned to the "captured" one is then rejected by. One install,
 * two answers, narrowed to whitespace.
 *
 * NOT the rule for a credential VALUE an operator typed or piped (see
 * {@link ambientValue}): padding there may be load-bearing, and it is theirs to decide.
 */
export function suppliesText(env: Env, name: string): boolean {
  return envText(env, name) !== undefined;
}
