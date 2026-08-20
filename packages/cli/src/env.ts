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
 * Whether an environment variable supplies anything. Derived from {@link envValue}
 * rather than testing `undefined` separately, so a surface that REPORTS a variable as
 * set and the code that USES it can never disagree about what "set" means — which is
 * the whole of #174.
 */
export function envIsSet(env: Env, name: string): boolean {
  return envValue(env, name) !== undefined;
}
