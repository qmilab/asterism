import { expect, test } from "bun:test";

import type { AsterismConfig } from "./config.ts";
import {
  isLoopbackUrl,
  needsNoApiKey,
  NO_API_KEY_PLACEHOLDER,
  PROVIDER_DEFAULTS,
  providerAuthPlan,
  providerKeyEnvVar,
  resolveModelConfig,
  resolveProviderAuth,
  SHARED_KEY_ENV,
} from "./model-config.ts";

test("openai is the default provider with its OpenAI endpoint", () => {
  const { model } = resolveModelConfig({ ASTERISM_MODEL_ID: "gpt-4o-mini" });
  expect(model).toEqual({
    provider: "openai",
    id: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
  });
  // OpenAI uses the adapter's own default protocol, so `api` is left unset.
  expect(model?.api).toBeUndefined();
});

test("the anthropic provider defaults to the Anthropic protocol and endpoint", () => {
  const { model } = resolveModelConfig({
    ASTERISM_MODEL_ID: "claude-haiku-4-5",
    ASTERISM_MODEL_PROVIDER: "anthropic",
  });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-haiku-4-5",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("explicit overrides beat the provider defaults", () => {
  const { model } = resolveModelConfig({
    ASTERISM_MODEL_ID: "x",
    ASTERISM_MODEL_PROVIDER: "anthropic",
    ASTERISM_MODEL_API: "openai-completions",
    ASTERISM_MODEL_BASE_URL: "http://localhost:1234",
  });
  expect(model).toMatchObject({
    api: "openai-completions",
    baseUrl: "http://localhost:1234",
  });
});

test("a missing model id is explained, not silently accepted", () => {
  const { model, reason } = resolveModelConfig({});
  expect(model).toBeUndefined();
  // The message names both ways to set a model: the config command and the env var.
  expect(reason).toContain("asterism config set");
  expect(reason).toContain("ASTERISM_MODEL_ID");
});

// --- config file + per-agent layering --------------------------------------

test("the config file supplies the model when no env var is set", () => {
  const config: AsterismConfig = { model: { id: "gpt-4o", provider: "openai" } };
  const { model } = resolveModelConfig({}, { config });
  expect(model).toEqual({
    provider: "openai",
    id: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
  });
});

test("an env var overrides the config-file default", () => {
  const config: AsterismConfig = { model: { id: "gpt-4o" } };
  const { model } = resolveModelConfig({ ASTERISM_MODEL_ID: "gpt-4o-mini" }, { config });
  expect(model?.id).toBe("gpt-4o-mini");
});

test("a per-agent override beats both the env var and the config default", () => {
  const config: AsterismConfig = {
    model: { id: "gpt-4o" },
    agents: { work: { model: { id: "claude-opus-4-8", provider: "anthropic" } } },
  };
  const { model } = resolveModelConfig({ ASTERISM_MODEL_ID: "gpt-4o-mini" }, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("a per-agent override is field-level: it can change just the id", () => {
  // The agent sets only `id`; `provider` falls through to the install default.
  const config: AsterismConfig = {
    model: { id: "claude-sonnet-4-6", provider: "anthropic" },
    agents: { work: { model: { id: "claude-opus-4-8" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("switching provider in an override drops the lower layer's endpoint", () => {
  // Install default points at an OpenAI-compatible gateway (OpenRouter); the agent
  // switches to anthropic without restating an endpoint. It must resolve to
  // anthropic's OWN endpoint, never the gateway URL the default carried.
  const config: AsterismConfig = {
    model: {
      id: "anthropic/claude-sonnet-4-6",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    },
    agents: { work: { model: { id: "claude-opus-4-8", provider: "anthropic" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("an env provider switch drops a config-default endpoint for the old provider", () => {
  const config: AsterismConfig = {
    model: { id: "x", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  };
  const { model } = resolveModelConfig(
    { ASTERISM_MODEL_ID: "claude-sonnet-4-6", ASTERISM_MODEL_PROVIDER: "anthropic" },
    { config },
  );
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("a custom endpoint for the SAME provider survives a model-only override", () => {
  // No provider change in the override, so the lower layer's custom endpoint stays.
  const config: AsterismConfig = {
    model: { id: "claude-sonnet-4-6", provider: "anthropic", baseUrl: "https://anthropic.internal" },
    agents: { work: { model: { id: "claude-opus-4-8" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-8",
    baseUrl: "https://anthropic.internal",
    api: "anthropic-messages",
  });
});

test("a bare base-url survives an override that keeps the implied (default) provider", () => {
  // A base-url with no provider belongs to the default provider (openai). An agent
  // that pins openai explicitly matches that, so the custom endpoint is preserved.
  const config: AsterismConfig = {
    model: { baseUrl: "https://gateway.internal/v1" },
    agents: { work: { model: { id: "gpt-4o", provider: "openai" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "openai",
    id: "gpt-4o",
    baseUrl: "https://gateway.internal/v1",
  });
});

test("a bare base-url belongs to the default provider and is dropped on a switch", () => {
  // `config set gpt-4o --base-url <local>` is an OpenAI-compatible endpoint (no
  // provider ⇒ the default, openai). An agent that switches to anthropic must NOT
  // inherit that local OpenAI endpoint/protocol — it falls back to anthropic's.
  const config: AsterismConfig = {
    model: { id: "gpt-4o", baseUrl: "http://localhost:1234/v1" },
    agents: { work: { model: { id: "claude-opus-4-8", provider: "anthropic" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "work" });
  expect(model).toEqual({
    provider: "anthropic",
    id: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  });
});

test("an agent without its own override falls back to env, then config", () => {
  const config: AsterismConfig = {
    model: { id: "gpt-4o" },
    agents: { work: { model: { id: "claude-opus-4-8", provider: "anthropic" } } },
  };
  // `personal` has no override, so it resolves to the install default.
  const fromConfig = resolveModelConfig({}, { config, agentName: "personal" });
  expect(fromConfig.model?.id).toBe("gpt-4o");
  // ...and an env var still overrides that default for the un-pinned agent.
  const fromEnv = resolveModelConfig({ ASTERISM_MODEL_ID: "gpt-4o-mini" }, { config, agentName: "personal" });
  expect(fromEnv.model?.id).toBe("gpt-4o-mini");
});

test("an unknown provider needs an explicit base URL", () => {
  const { model, reason } = resolveModelConfig({
    ASTERISM_MODEL_ID: "x",
    ASTERISM_MODEL_PROVIDER: "cohere",
  });
  expect(model).toBeUndefined();
  expect(reason).toContain("ASTERISM_MODEL_BASE_URL");
});

test("an unknown provider builds once given a base URL", () => {
  const { model } = resolveModelConfig({
    ASTERISM_MODEL_ID: "x",
    ASTERISM_MODEL_PROVIDER: "cohere",
    ASTERISM_MODEL_BASE_URL: "https://api.cohere.example/v1",
  });
  expect(model).toMatchObject({
    provider: "cohere",
    baseUrl: "https://api.cohere.example/v1",
  });
  // No protocol default for an unknown provider — the adapter's default applies.
  expect(model?.api).toBeUndefined();
});

// --- built-in providers -----------------------------------------------------

test("every built-in provider resolves from its name alone", () => {
  // The point of the table: naming a provider is enough, no endpoint to look up.
  for (const [provider, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    const { model, reason } = resolveModelConfig({
      ASTERISM_MODEL_ID: "some-model",
      ASTERISM_MODEL_PROVIDER: provider,
    });
    expect(reason).toBeUndefined();
    expect(model?.baseUrl).toBe(defaults.baseUrl);
  }
});

test("no built-in provider names a protocol `reflect` cannot speak", () => {
  // `reflect` hand-rolls its HTTP client and knows exactly two wire formats,
  // falling through to the OpenAI shape for anything else — so a third protocol
  // here would run fine and reflect wrongly. The TYPE forbids it; this catches a
  // cast, and fails loudly rather than at someone's first `reflect`.
  for (const defaults of Object.values(PROVIDER_DEFAULTS)) {
    expect([undefined, "openai-completions", "anthropic-messages"]).toContain(defaults.api);
  }
});

test("no built-in endpoint carries an unfilled placeholder", () => {
  // Several providers the substrate knows have account-specific paths
  // ("…/{CLOUDFLARE_ACCOUNT_ID}/…"). Those are excluded on purpose: a default
  // nobody can use is worse than no default.
  for (const defaults of Object.values(PROVIDER_DEFAULTS)) {
    expect(defaults.baseUrl).not.toContain("{");
    expect(() => new URL(defaults.baseUrl)).not.toThrow();
  }
});

test("a keyless provider is served from this machine, a keyed one is not", () => {
  for (const [provider, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    // The two claims must agree: "needs no key" and "runs on your own machine"
    // are the same fact, and a hosted default marked keyless would be a leak.
    expect(isLoopbackUrl(defaults.baseUrl)).toBe(defaults.needsNoKey === true);
  }
});

// --- is this endpoint on this machine? --------------------------------------

test("loopback endpoints are recognized across their spellings", () => {
  for (const url of [
    "http://localhost:11434/v1",
    "https://localhost/v1",
    "http://127.0.0.1:1234/v1",
    "http://127.2.3.4/v1",
    "http://[::1]:11434/v1",
    "http://0.0.0.0:11434/v1",
    "http://LOCALHOST:11434/v1",
  ]) {
    expect(isLoopbackUrl(url)).toBe(true);
  }
});

test("an endpoint that merely READS as local is not local", () => {
  // The userinfo trick: everything before the `@` is credentials, not a host.
  // A string match on "localhost" would call this local and send an
  // unauthenticated request to example.com; parsing it as a URL does not.
  expect(isLoopbackUrl("http://localhost:11434@example.com/v1")).toBe(false);
  expect(isLoopbackUrl("https://localhost.example.com/v1")).toBe(false);
  expect(isLoopbackUrl("https://notlocalhost/v1")).toBe(false);
  expect(isLoopbackUrl("http://127.0.0.1.example.com/v1")).toBe(false);
});

test("an endpoint we cannot parse or do not speak is never treated as local", () => {
  expect(isLoopbackUrl("not a url")).toBe(false);
  expect(isLoopbackUrl("")).toBe(false);
  expect(isLoopbackUrl("ftp://localhost/v1")).toBe(false);
  expect(isLoopbackUrl("file:///etc/hosts")).toBe(false);
});

// --- keyless: declaration AND endpoint --------------------------------------

test("a keyless provider at its own default endpoint needs no key", () => {
  expect(needsNoApiKey({ provider: "ollama", baseUrl: "http://localhost:11434/v1" })).toBe(true);
  expect(needsNoApiKey({ provider: "lmstudio", baseUrl: "http://localhost:1234/v1" })).toBe(true);
});

test("a keyless provider pointed at a REMOTE endpoint is not keyless", () => {
  // The declaration names a provider; the endpoint under it can change. Without
  // this, a default typed months ago would send an unauthenticated request to
  // someone else's server.
  expect(needsNoApiKey({ provider: "ollama", baseUrl: "https://ollama.example.com/v1" })).toBe(false);
});

test("a local endpoint under a KEYED provider is not keyless", () => {
  // The other half: a local URL alone must not waive the key, or anyone running
  // an OpenAI-compatible proxy on localhost silently stops sending credentials.
  expect(needsNoApiKey({ provider: "openai", baseUrl: "http://localhost:11434/v1" })).toBe(false);
  expect(needsNoApiKey({ provider: "unknown", baseUrl: "http://localhost:11434/v1" })).toBe(false);
});

// --- what a call authenticates with -----------------------------------------

test("a local model runs with no key configured at all", () => {
  // The headline: trying Asterism needs no account anywhere.
  const { model } = resolveModelConfig({
    ASTERISM_MODEL_ID: "qwen3",
    ASTERISM_MODEL_PROVIDER: "ollama",
  });
  const auth = resolveProviderAuth({}, model!);
  expect(auth.reason).toBeUndefined();
  expect(auth.apiKey).toBe(NO_API_KEY_PLACEHOLDER);
});

test("an explicitly set key wins even for a keyless provider", () => {
  // A local server behind an auth proxy is a real setup, and setting
  // OLLAMA_API_KEY is an unambiguous instruction.
  const auth = resolveProviderAuth(
    { OLLAMA_API_KEY: "proxy-token" },
    { provider: "ollama", baseUrl: "http://localhost:11434/v1" },
  );
  expect(auth.apiKey).toBe("proxy-token");
});

test("the shared ASTERISM_API_KEY is never sent to a keyless provider", () => {
  // ASTERISM_API_KEY is by construction a key for a hosted provider the user
  // pays for. Forwarding it to a server on their own machine hands a real secret
  // to something that never asked for one.
  const auth = resolveProviderAuth(
    { ASTERISM_API_KEY: "sk-a-real-hosted-key" },
    { provider: "ollama", baseUrl: "http://localhost:11434/v1" },
  );
  expect(auth.apiKey).toBe(NO_API_KEY_PLACEHOLDER);
  expect(auth.apiKey).not.toBe("sk-a-real-hosted-key");
});

test("a keyless provider pointed remotely refuses rather than sending anything", () => {
  // Neither the placeholder (unauthenticated call to someone else's server) nor
  // the shared key (a hosted secret to an unrelated host). It stops and says so.
  const env = { ASTERISM_API_KEY: "sk-a-real-hosted-key" };
  const auth = resolveProviderAuth(env, {
    provider: "ollama",
    baseUrl: "https://ollama.example.com/v1",
  });
  expect(auth.apiKey).toBeUndefined();
  expect(auth.reason).toContain("OLLAMA_API_KEY");
  expect(auth.reason).toContain("ollama.example.com");
});

test("a keyed provider still takes its own variable, then the shared one", () => {
  const own = resolveProviderAuth(
    { OPENROUTER_API_KEY: "sk-or", ASTERISM_API_KEY: "sk-shared" },
    { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  );
  expect(own.apiKey).toBe("sk-or");
  const shared = resolveProviderAuth(
    { ASTERISM_API_KEY: "sk-shared" },
    { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  );
  expect(shared.apiKey).toBe("sk-shared");
});

test("a missing key names the variable that actually works for that provider", () => {
  for (const provider of ["openai", "anthropic", "openrouter", "groq"]) {
    const { model } = resolveModelConfig({
      ASTERISM_MODEL_ID: "x",
      ASTERISM_MODEL_PROVIDER: provider,
    });
    const auth = resolveProviderAuth({}, model!);
    expect(auth.apiKey).toBeUndefined();
    expect(auth.reason).toContain(providerKeyEnvVar(provider));
  }
});

test("an empty key variable counts as unset, not as a key", () => {
  // An exported-but-empty variable is a common shell accident; sending "" would
  // fail at the provider with an auth error instead of here with an answer.
  const auth = resolveProviderAuth(
    { OPENAI_API_KEY: "", ASTERISM_API_KEY: "" },
    { provider: "openai", baseUrl: "https://api.openai.com/v1" },
  );
  expect(auth.apiKey).toBeUndefined();
  expect(auth.reason).toContain("OPENAI_API_KEY");
});

// --- keyless meets the provider-change drop ---------------------------------

test("switching TO a local provider drops the hosted endpoint and needs no key", () => {
  const config: AsterismConfig = {
    model: { id: "gpt-4o", provider: "openrouter" },
    agents: { personal: { model: { id: "qwen3", provider: "ollama" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "personal" });
  expect(model?.baseUrl).toBe("http://localhost:11434/v1");
  expect(resolveProviderAuth({}, model!).apiKey).toBe(NO_API_KEY_PLACEHOLDER);
});

test("switching AWAY from a local provider drops the local endpoint and needs a key", () => {
  // The dangerous direction: without the drop, `work` would keep the localhost
  // endpoint AND — since the provider is no longer keyless — start requiring a
  // key for it. The endpoint must move to the new provider's own.
  const config: AsterismConfig = {
    model: { id: "qwen3", provider: "ollama" },
    agents: { work: { model: { id: "claude-opus-4-8", provider: "anthropic" } } },
  };
  const { model } = resolveModelConfig({}, { config, agentName: "work" });
  expect(model?.baseUrl).toBe("https://api.anthropic.com");
  expect(needsNoApiKey(model!)).toBe(false);
  expect(resolveProviderAuth({}, model!).reason).toContain("ANTHROPIC_API_KEY");
});

test("a bare local base-url belongs to the default provider, so it still needs a key", () => {
  // `--base-url http://localhost:11434/v1` with no provider is an endpoint for
  // DEFAULT_PROVIDER (openai), which is not declared keyless. Fails closed: the
  // user is told to name the provider rather than quietly getting no auth.
  const { model } = resolveModelConfig({
    ASTERISM_MODEL_ID: "qwen3",
    ASTERISM_MODEL_BASE_URL: "http://localhost:11434/v1",
  });
  expect(model?.provider).toBe("openai");
  expect(needsNoApiKey(model!)).toBe(false);
  expect(resolveProviderAuth({}, model!).reason).toContain("OPENAI_API_KEY");
});

test("naming the keyless provider is what makes a custom local endpoint keyless", () => {
  // Same URL as above, provider named: a second Ollama on another port works.
  const { model } = resolveModelConfig({
    ASTERISM_MODEL_ID: "qwen3",
    ASTERISM_MODEL_PROVIDER: "ollama",
    ASTERISM_MODEL_BASE_URL: "http://127.0.0.1:12345/v1",
  });
  expect(resolveProviderAuth({}, model!).apiKey).toBe(NO_API_KEY_PLACEHOLDER);
});

// --- what a surface should ASK for ------------------------------------------

test("every variable the plan lists actually authenticates on its own", () => {
  // The property that matters for anything that prints "set this": a variable we
  // name must be one the resolver will read. Listing a variable that does not
  // work is how an install that worked in a shell fails as a service.
  for (const provider of Object.keys(PROVIDER_DEFAULTS)) {
    const { model } = resolveModelConfig({
      ASTERISM_MODEL_ID: "x",
      ASTERISM_MODEL_PROVIDER: provider,
    });
    for (const name of providerAuthPlan({}, model).vars) {
      const auth = resolveProviderAuth({ [name]: "a-key" }, model!);
      expect(`${provider}/${name}: ${auth.apiKey}`).toBe(`${provider}/${name}: a-key`);
    }
  }
});

test("the plan does not offer the shared key to a provider that will not read it", () => {
  const local = resolveModelConfig({
    ASTERISM_MODEL_ID: "x",
    ASTERISM_MODEL_PROVIDER: "ollama",
  }).model;
  expect(providerAuthPlan({}, local).vars).toEqual(["OLLAMA_API_KEY"]);

  const hosted = resolveModelConfig({
    ASTERISM_MODEL_ID: "x",
    ASTERISM_MODEL_PROVIDER: "groq",
  }).model;
  expect(providerAuthPlan({}, hosted).vars).toEqual(["GROQ_API_KEY", SHARED_KEY_ENV]);
});

test("a local model requires nothing, but still accepts its own key", () => {
  // Both halves matter to a service: nothing to demand from an operator, and yet
  // an auth-proxy token must not be dropped on the grounds that it is optional.
  const { model } = resolveModelConfig({
    ASTERISM_MODEL_ID: "x",
    ASTERISM_MODEL_PROVIDER: "ollama",
  });
  expect(providerAuthPlan({}, model).required).toBe(false);
  expect(providerAuthPlan({}, model).satisfied).toBe(true);
  expect(providerAuthPlan({ OLLAMA_API_KEY: "proxy-token" }, model).vars).toContain(
    "OLLAMA_API_KEY",
  );
});

test("the shared key does not satisfy a local provider pointed remotely", () => {
  const { model } = resolveModelConfig({
    ASTERISM_MODEL_ID: "x",
    ASTERISM_MODEL_PROVIDER: "ollama",
    ASTERISM_MODEL_BASE_URL: "https://ollama.example.com/v1",
  });
  expect(providerAuthPlan({}, model).required).toBe(true);
  expect(providerAuthPlan({ [SHARED_KEY_ENV]: "sk-shared" }, model).satisfied).toBe(false);
  expect(providerAuthPlan({ OLLAMA_API_KEY: "token" }, model).satisfied).toBe(true);
});

test("with no model configured the plan is the default provider's", () => {
  const plan = providerAuthPlan({});
  expect(plan.vars).toEqual(["OPENAI_API_KEY", SHARED_KEY_ENV]);
  expect(plan.required).toBe(true);
  expect(providerAuthPlan({ OPENAI_API_KEY: "sk" }).satisfied).toBe(true);
});
