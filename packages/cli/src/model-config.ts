// Pure model-configuration resolution for `run` and `reflect`. Kept free of any
// runtime Pi import (the `PiModelConfig` import is type-only and erased), so it is
// unit testable without loading the substrate; `model.ts` adds the adapter on top.
//
// Resolution layers a config file, the environment, and a per-agent override.
// Precedence, most specific first:
//   1. the agent's own model override (config file `agents.<name>.model`)
//   2. ASTERISM_MODEL_* environment variables
//   3. the install-wide default (config file `model`)
//   4. built-in provider defaults (endpoint + wire protocol)
// Each field resolves independently, so an override may set just `id` and inherit
// the endpoint/protocol from a lower layer. Each supported provider carries its
// own protocol (`api`) and default endpoint, so naming a provider is enough — a
// user does not have to also know the wire format.

import type { PiModelConfig } from "@qmilab/asterism-adapter-pi";

import type { AsterismConfig, ModelSettings } from "./config.js";
import { envText } from "./env.js";

type Env = Record<string, string | undefined>;

/**
 * The sources resolution draws on beyond the environment: the loaded config file
 * and which agent (by name) the model is being resolved for. Both optional — with
 * neither, resolution is environment-only, exactly as it was before the config
 * file existed. Shared as the wiring context passed to `buildAdapter` /
 * `buildReflectionProvider`.
 */
export interface ModelResolutionContext {
  config?: AsterismConfig;
  agentName?: string;
}

/**
 * The wire protocols a built-in provider is allowed to name: the ones BOTH call
 * sites speak. `run` goes through Pi, which registers many more; `reflect`
 * builds its own HTTP client (`@qmilab/asterism-reflect`) that knows exactly
 * `anthropic-messages` and OpenAI chat-completions, and falls through to the
 * OpenAI shape for anything it does not recognize — so a third protocol in the
 * table below would run fine and reflect wrongly, sending an OpenAI-shaped body
 * to an endpoint that speaks something else.
 *
 * Naming the permitted set as a TYPE makes that a build error on the entry
 * itself, rather than a rule stated in a comment for someone to read. A provider
 * whose protocol is not here stays reachable with an explicit ASTERISM_MODEL_API
 * — that is a user telling us what they want, not us shipping a wrong default.
 */
type ReflectableApi = "openai-completions" | "anthropic-messages";

interface ProviderDefaults {
  /** Default base URL for the provider's API. */
  baseUrl: string;
  /**
   * Default Pi API/protocol. Omitted for OpenAI-compatible providers, whose
   * protocol is the adapter's own default (`openai-completions`); set explicitly
   * where it differs. Constrained to {@link ReflectableApi}.
   */
  api?: ReflectableApi;
  /**
   * This provider's endpoint takes no API key — a model served from the user's
   * own machine (Ollama, LM Studio). Declared per provider rather than inferred
   * from the endpoint, so the set of keyless providers is a short list someone
   * can read, and an unknown or mistyped provider falls through to the normal
   * "you need a key" path instead of quietly becoming keyless.
   *
   * A declaration alone is NOT sufficient to skip the key: see
   * {@link needsNoApiKey}. The declaration names a provider; the endpoint it is
   * pointed at can change under it.
   */
  needsNoKey?: true;
}

/**
 * Built-in defaults for the providers Asterism configures out of the box, so
 * naming a provider is enough to reach it. The Anthropic entry sets `api` so an
 * Anthropic provider/key is never silently sent over the OpenAI protocol; the
 * rest are OpenAI-compatible and take the adapter's default protocol.
 *
 * Every hosted endpoint here is taken from the substrate's own model registry
 * rather than typed from memory, and every provider name matches the one the
 * substrate uses — so the key variable this module derives
 * ({@link providerKeyEnvVar}) is the variable that provider's users already set.
 * Providers whose endpoint carries an account-specific path, or whose protocol
 * `reflect` cannot speak, are deliberately absent: they stay reachable with an
 * explicit ASTERISM_MODEL_BASE_URL / ASTERISM_MODEL_API.
 */
export const PROVIDER_DEFAULTS: Readonly<Record<string, ProviderDefaults>> = {
  openai: { baseUrl: "https://api.openai.com/v1" },
  anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  deepseek: { baseUrl: "https://api.deepseek.com" },
  xai: { baseUrl: "https://api.x.ai/v1" },
  together: { baseUrl: "https://api.together.ai/v1" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1" },
  // Served from the user's own machine: no account, no key, no network egress.
  ollama: { baseUrl: "http://localhost:11434/v1", needsNoKey: true },
  lmstudio: { baseUrl: "http://localhost:1234/v1", needsNoKey: true },
};

/**
 * The provider assumed when none is named — both for filling defaults and for
 * deciding which provider an endpoint set without a provider belongs to.
 */
const DEFAULT_PROVIDER = "openai";

export interface ModelConfigResult {
  model?: PiModelConfig;
  /** When `model` is absent, a user-facing explanation of what to configure. */
  reason?: string;
}

/**
 * The environment variable that holds a given provider's API key: an explicit
 * name where the ecosystem's convention differs from the derived one, else a
 * derived `<PROVIDER>_API_KEY`. So an OpenAI-compatible provider like
 * `openrouter` reads `OPENROUTER_API_KEY`, and the "no key" message can name the
 * variable that actually works instead of always pointing at `OPENAI_API_KEY`.
 */
export function providerKeyEnvVar(provider: string): string {
  const known: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  };
  return known[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/**
 * Stand-in sent as the API key where the provider needs none. Not a secret and
 * not a credential — the substrate requires a non-empty string before it will
 * make a request at all, so "no key" has to be spelled as *some* value. It is
 * deliberately self-describing: if it ever shows up in a server log, it reads as
 * what it is rather than as a key someone should try.
 */
export const NO_API_KEY_PLACEHOLDER = "asterism-local-no-key";

/** The "one key across providers" variable, read when a provider's own is unset. */
export const SHARED_KEY_ENV = "ASTERISM_API_KEY";

/**
 * Whether a resolved endpoint is served from this machine. Parsed as a URL, not
 * matched as a string: `http://localhost:11434@example.com/v1` has the loopback
 * text in it and a hostname of `example.com`, and only parsing tells them apart.
 * Anything unparseable, or on a scheme other than HTTP(S), is not loopback —
 * an endpoint we cannot understand is never treated as local.
 */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // WHATWG keeps IPv6 hosts bracketed and lowercases/compresses them.
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  // The whole 127.0.0.0/8 loopback block, plus 0.0.0.0 — which connects to this
  // host, so it can only ever reach a local server, never a remote one.
  return /^127(\.\d{1,3}){3}$/.test(host) || host === "0.0.0.0";
}

/**
 * Whether this model's endpoint takes no API key. BOTH halves are required: the
 * provider must be declared keyless in {@link PROVIDER_DEFAULTS}, *and* the
 * endpoint that actually resolved must be on this machine.
 *
 * The declaration on its own would be a grant to a NAME, and a name outlives the
 * endpoint attached to it — `--provider ollama --base-url https://ollama.example.com`
 * would then send an unauthenticated request to someone else's server, silently,
 * because of a default typed months earlier. The loopback check on its own would
 * make an auth decision out of free user input, and would flip as a side effect
 * of the provider-change rule in {@link mergeSettings}. Requiring both means the
 * only way to reach an unauthenticated remote call is to satisfy neither.
 */
export function needsNoApiKey(model: Pick<PiModelConfig, "provider" | "baseUrl">): boolean {
  return (
    PROVIDER_DEFAULTS[model.provider]?.needsNoKey === true && isLoopbackUrl(model.baseUrl)
  );
}

/** What a run or a reflection should authenticate with, or why it cannot. */
export interface ProviderAuth {
  /** The value to send. Absent only when `reason` explains what to set. */
  apiKey?: string;
  /** When `apiKey` is absent, a user-facing explanation of what to configure. */
  reason?: string;
  /**
   * Set when the refusal is a POLICY decision rather than "nothing was set": a
   * keyless provider pointed at an endpoint that is not this machine.
   *
   * The distinction matters to a caller with a credential source of its own. The
   * substrate keeps its own environment lookup, with aliases this module does not
   * know (`ANTHROPIC_OAUTH_TOKEN`, `GEMINI_API_KEY`, `HF_TOKEN`), and a caller may
   * consult it when we simply found nothing. It must never consult it to overturn
   * *this* — the whole point of the refusal is that no credential makes an
   * unauthenticated-by-design provider safe to send to someone else's server.
   */
  refused?: true;
}

/**
 * Resolve what to authenticate the provider call with — infrastructure, never an
 * agent-scoped credential. The single door for both `run` (the adapter) and
 * `reflect` (the reflection model): they used to answer the "is a key required?"
 * question separately and disagree about it, so it is answered once, here.
 *
 * Order, and why:
 *  1. The provider's own variable ({@link providerKeyEnvVar}) always wins — a
 *     local server put behind an auth proxy is a real setup, and an explicitly
 *     set OLLAMA_API_KEY is an unambiguous instruction.
 *  2. A keyless provider ({@link needsNoApiKey}) gets the placeholder.
 *  3. `ASTERISM_API_KEY` — the "one key across providers" fallback — but NOT for
 *     a provider declared keyless. That variable is by construction a key for a
 *     hosted provider the user pays for; forwarding it to a local server (or to
 *     whatever a keyless provider has been re-pointed at) sends a real secret
 *     somewhere it was never meant to go. A provider whose ecosystem has no keys
 *     has no use for it, so it is not offered one.
 */
export function resolveProviderAuth(
  env: Env,
  model: Pick<PiModelConfig, "provider" | "baseUrl">,
): ProviderAuth {
  const keyVar = providerKeyEnvVar(model.provider);
  // Read through the one empty-is-unset rule, like every other variable in this module:
  // an exported-but-empty key — or one holding only whitespace — is a cleared key, not a
  // credential to send. `service install --capture-env` decides the same way, so it
  // cannot report the key need satisfied by a value it then declines to capture.
  const explicit = envText(env, keyVar);
  if (explicit !== undefined) return { apiKey: explicit };

  const declaredKeyless = PROVIDER_DEFAULTS[model.provider]?.needsNoKey === true;
  if (declaredKeyless) {
    if (isLoopbackUrl(model.baseUrl)) return { apiKey: NO_API_KEY_PLACEHOLDER };
    return {
      refused: true,
      reason:
        `"${model.provider}" needs no API key when it is served from this machine, but ` +
        `${model.baseUrl} is not. Point --base-url at localhost, or set ${keyVar} for that endpoint.`,
    };
  }

  const shared = envText(env, SHARED_KEY_ENV);
  if (shared !== undefined) return { apiKey: shared };
  return {
    reason:
      `No API key configured for ${model.provider}. Set ${keyVar} (or ${SHARED_KEY_ENV}) — ` +
      "or run a model on your own machine, which needs no key at all " +
      "(`asterism config set <model-id> --provider ollama`).",
  };
}

/**
 * What a surface needs to know to ASK for a key rather than to use one: which
 * variables can authenticate this model, whether one is needed at all, and
 * whether a given environment already supplies it.
 *
 * It exists because a second surface — the service env plan, which writes the
 * file an installed service reads — had re-derived that rule itself, and drifted
 * from it in both directions. It dropped the provider's own variable for a local
 * provider behind an auth proxy, which {@link resolveProviderAuth} honours; and
 * it accepted the shared key for a keyless provider pointed at a remote
 * endpoint, which {@link resolveProviderAuth} refuses. Both answers are now read
 * off the same function the foreground path calls, so the two cannot disagree
 * about what a working setup looks like.
 *
 * With no model configured, the answer is the default provider's — which is what
 * a not-yet-configured install has always been shown.
 */
export function providerAuthPlan(
  env: Env,
  model?: Pick<PiModelConfig, "provider" | "baseUrl">,
): {
  /** Variables that can authenticate, the provider's own first. */
  vars: string[];
  /** Whether anything must be set: false for a model served from this machine. */
  required: boolean;
  /** Whether `env` already authenticates this model. */
  satisfied: boolean;
} {
  const target = model ?? {
    provider: DEFAULT_PROVIDER,
    baseUrl: PROVIDER_DEFAULTS[DEFAULT_PROVIDER]?.baseUrl ?? "",
  };
  const keyVar = providerKeyEnvVar(target.provider);
  // A provider with no key ecosystem is never offered the shared key, matching
  // the resolver, which will not read it for one at any endpoint. Its own
  // variable stays listed: a local server behind an auth proxy still needs it,
  // and dropping it is how an install that worked in the shell failed as a
  // service.
  const declaredKeyless = PROVIDER_DEFAULTS[target.provider]?.needsNoKey === true;
  return {
    vars: declaredKeyless ? [keyVar] : [keyVar, SHARED_KEY_ENV],
    // Derived, not declared: nothing is required exactly when resolution already
    // succeeds against an empty environment.
    required: resolveProviderAuth({}, target).apiKey === undefined,
    satisfied: resolveProviderAuth(env, target).apiKey !== undefined,
  };
}

/**
 * The model coordinates carried by the ASTERISM_MODEL_* environment variables.
 *
 * Read through {@link envText}, so a variable that exists and holds nothing — or holds
 * only whitespace, which is what a copy-paste leaves — supplies nothing. The service env
 * plan asks the same question when deciding whether capturing this variable would put a
 * value in the file, and the two have to agree or it reports a need satisfied by a value
 * it will not write. Read as merely-defined, `ASTERISM_MODEL_ID=` silently disabled a working
 * configured model that `config show` went on displaying (#174). {@link mergeSettings}
 * drops an empty field from every layer, so this is belt as well as braces — but the
 * question `config show` asks about the environment is answered by the same rule, and
 * having it stated where the variables are read is what keeps the two agreeing.
 */
function settingsFromEnv(env: Env): ModelSettings {
  const s: ModelSettings = {};
  const id = envText(env, "ASTERISM_MODEL_ID");
  if (id !== undefined) s.id = id;
  const provider = envText(env, "ASTERISM_MODEL_PROVIDER");
  if (provider !== undefined) s.provider = provider;
  const baseUrl = envText(env, "ASTERISM_MODEL_BASE_URL");
  if (baseUrl !== undefined) s.baseUrl = baseUrl;
  const api = envText(env, "ASTERISM_MODEL_API");
  if (api !== undefined) s.api = api;
  return s;
}

/**
 * One layer with its EMPTY fields dropped, so an empty coordinate is not a coordinate
 * wherever it came from.
 *
 * The input boundaries refuse to create one — `config set` and `new` refuse an option
 * given `""` (#174), and an emptied environment variable supplies nothing. But a config
 * file written by an earlier version still holds what those used to accept, and nothing
 * on read normalized it: `{"model":{"provider":""}}` went on producing
 * `(provider: )` from `config show` and an untypeable `--provider  --base-url <url>`
 * from `run`, and a per-agent `{"model":{"id":""}}` went on shadowing a perfectly good
 * install default with nothing. Refusing to LOAD such a file would strand the operator —
 * `config unset` reads it too — so it is normalized here instead, and `config show` then
 * displays the layer that will actually be used.
 *
 * Exported because a surface that DESCRIBES a stored layer has to describe the same
 * thing resolution reads from it. `config show`'s install-default line printed the file
 * verbatim — `llama3.2 (provider: , base url: )` — one line above the per-agent lines
 * reporting what those coordinates resolve to. One command, two answers.
 */
export function withoutEmptyFields(layer: ModelSettings): ModelSettings {
  // Whitespace-only counts as empty here too — a stored coordinate made of spaces is
  // never what was meant, and the environment layer reads the same way (`envText`).
  const carried = (v: string | undefined): string | undefined =>
    v !== undefined && v.trim().length > 0 ? v : undefined;
  const out: ModelSettings = {};
  const id = carried(layer.id);
  if (id !== undefined) out.id = id;
  const provider = carried(layer.provider);
  if (provider !== undefined) out.provider = provider;
  const baseUrl = carried(layer.baseUrl);
  if (baseUrl !== undefined) out.baseUrl = baseUrl;
  const api = carried(layer.api);
  if (api !== undefined) out.api = api;
  return out;
}

/**
 * Merge layers low → high precedence: each set field overrides the ones before it.
 *
 * `baseUrl` and `api` are coupled to the provider they were configured for, so a
 * plain field-wise merge is wrong: when a higher layer names a DIFFERENT provider
 * than the one a lower layer's endpoint belongs to, that endpoint/protocol must be
 * dropped — otherwise an agent override of `--provider anthropic` over an install
 * default that set an OpenRouter (or local OpenAI-compatible) base URL would call
 * Anthropic at the wrong endpoint. Dropping them lets resolution fall back to the
 * new provider's defaults.
 *
 * The owning provider of an endpoint is the provider in effect at the layer that
 * set it: an explicit provider, or — when none was named — the DEFAULT_PROVIDER.
 * So the drop fires on any genuine provider CHANGE, including switching away from
 * the implicit default. A layer that re-states the same (or implied) provider
 * keeps a lower layer's custom endpoint.
 */
function mergeSettings(layers: readonly ModelSettings[]): ModelSettings {
  const out: ModelSettings = {};
  for (const raw of layers) {
    // An empty field is dropped BEFORE the provider-change rule below reads it, so a
    // stored `"provider": ""` cannot count as naming a different provider and discard a
    // lower layer's endpoint on its way past.
    const layer = withoutEmptyFields(raw);
    if (layer.id !== undefined) out.id = layer.id;
    if (layer.provider !== undefined) {
      // The provider the accumulated endpoint belongs to: the last explicit one,
      // else the default (a bare base-url is an endpoint for the default provider).
      const owningProvider = out.provider ?? DEFAULT_PROVIDER;
      if (layer.provider !== owningProvider) {
        delete out.baseUrl;
        delete out.api;
      }
      out.provider = layer.provider;
    }
    if (layer.baseUrl !== undefined) out.baseUrl = layer.baseUrl;
    if (layer.api !== undefined) out.api = layer.api;
  }
  return out;
}

/** Where a resolved coordinate came from, named as `config show` reports it. */
export type ModelSource = "install default" | "environment" | "agent override";

/**
 * The layers resolution draws on, LOW → HIGH precedence, each named.
 *
 * Shared by {@link resolveModelConfig} and {@link modelIdSource} so the value a surface
 * shows and the source it credits are read off ONE list. Restating the layering was how
 * `config show` came to label an agent `[agent override]` whose override supplied
 * nothing: the label tested `override.id !== undefined`, which an empty stored id
 * satisfies, while resolution had already dropped it (#174).
 */
function modelLayers(
  env: Env,
  context: ModelResolutionContext,
): { source: ModelSource; settings: ModelSettings }[] {
  const { config, agentName } = context;
  return [
    { source: "install default", settings: config?.model ?? {} },
    { source: "environment", settings: settingsFromEnv(env) },
    {
      source: "agent override",
      settings: (agentName ? config?.agents?.[agentName]?.model : undefined) ?? {},
    },
  ];
}

/**
 * Which layer supplies the model id that {@link resolveModelConfig} will use, or
 * undefined when none does. The headline coordinate, so it is the one `config show`
 * names — asked of the layers rather than re-derived beside them.
 */
export function modelIdSource(
  env: Env,
  context: ModelResolutionContext = {},
): ModelSource | undefined {
  let found: ModelSource | undefined;
  // Low → high, so the last layer that supplies an id is the one that wins — the same
  // order `mergeSettings` overwrites in.
  for (const layer of modelLayers(env, context)) {
    if (withoutEmptyFields(layer.settings).id !== undefined) found = layer.source;
  }
  return found;
}

/**
 * Resolve the model config from the config file, environment, and a per-agent
 * override, then apply provider defaults. See the module header for the
 * precedence order. A resolved model needs at minimum an `id`; an endpoint comes
 * from a built-in provider default or must be supplied. Pass only `env` for
 * environment-only resolution.
 */
export function resolveModelConfig(env: Env, context: ModelResolutionContext = {}): ModelConfigResult {
  const merged = mergeSettings(modelLayers(env, context).map((l) => l.settings));

  const id = merged.id;
  if (!id) {
    return {
      reason:
        "No model configured. Set one with `asterism config set <model-id>` or the " +
        "ASTERISM_MODEL_ID environment variable, plus an API key (e.g. OPENAI_API_KEY), " +
        "before running an agent.",
    };
  }
  const provider = merged.provider ?? DEFAULT_PROVIDER;
  const defaults = PROVIDER_DEFAULTS[provider];
  const baseUrl = merged.baseUrl ?? defaults?.baseUrl;
  if (!baseUrl) {
    return {
      reason:
        `No endpoint for provider "${provider}". Set a base URL ` +
        `(asterism config set ${id} --provider ${provider} --base-url <url>, or ` +
        "ASTERISM_MODEL_BASE_URL).",
    };
  }
  const api = merged.api ?? defaults?.api;
  const model: PiModelConfig = {
    provider,
    id,
    baseUrl,
    ...(api !== undefined ? { api } : {}),
  };
  return { model };
}
