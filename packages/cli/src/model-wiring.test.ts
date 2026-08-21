// The two places a model config becomes a live client: `run`'s adapter and
// `reflect`'s provider. They are tested together on purpose — the fault this
// covers was not either one being wrong, but the two DISAGREEING about whether a
// key was required, so a setup that ran happily could not be reflected on.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { buildAdapter } from "./model.ts";
import { buildReflectionProvider } from "./reflect-model.ts";

type Env = Record<string, string | undefined>;

// `buildAdapter` asks the substrate whether IT can authenticate, and the
// substrate reads the ambient process environment — so these tests have to own
// that environment. Without this, a developer with OPENAI_API_KEY exported would
// see different results from CI, which is the definition of a check that is not
// one.
const AMBIENT = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ASTERISM_API_KEY"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of AMBIENT) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of AMBIENT) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/**
 * Every case below is decided by THIS layer's own resolution, and must get the
 * same verdict from both call sites. Cases the substrate decides are not here on
 * purpose: `reflect` speaks two header shapes and genuinely cannot use an OAuth
 * token, so parity there would mean breaking `run` rather than fixing `reflect`.
 * That asymmetry is pinned by its own test below.
 */
const CASES: { name: string; env: Env; builds: boolean }[] = [
  {
    name: "a local model with no key anywhere",
    env: { ASTERISM_MODEL_ID: "qwen3", ASTERISM_MODEL_PROVIDER: "ollama" },
    builds: true,
  },
  {
    name: "LM Studio with no key anywhere",
    env: { ASTERISM_MODEL_ID: "qwen3", ASTERISM_MODEL_PROVIDER: "lmstudio" },
    builds: true,
  },
  {
    name: "a hosted provider with its own key",
    env: { ASTERISM_MODEL_ID: "gpt-4o-mini", OPENAI_API_KEY: "sk-test" },
    builds: true,
  },
  {
    name: "a hosted provider with the shared key",
    env: {
      ASTERISM_MODEL_ID: "x",
      ASTERISM_MODEL_PROVIDER: "openrouter",
      ASTERISM_API_KEY: "sk-shared",
    },
    builds: true,
  },
  {
    name: "a hosted provider with no key",
    env: { ASTERISM_MODEL_ID: "gpt-4o-mini" },
    builds: false,
  },
  {
    name: "a local provider pointed at a remote endpoint",
    env: {
      ASTERISM_MODEL_ID: "qwen3",
      ASTERISM_MODEL_PROVIDER: "ollama",
      ASTERISM_MODEL_BASE_URL: "https://ollama.example.com/v1",
    },
    builds: false,
  },
  {
    name: "no model configured at all",
    env: {},
    builds: false,
  },
];

test("a credential only the substrate knows still lets `run` proceed", () => {
  // Pi reads ANTHROPIC_OAUTH_TOKEN (and aliases like GEMINI_API_KEY / HF_TOKEN)
  // that this layer's <PROVIDER>_API_KEY convention does not cover. Those runs
  // worked before the pre-flight existed; refusing them would be a regression
  // introduced by a check meant only to improve a message.
  process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oat01-not-a-real-token";
  const { adapter, reason } = buildAdapter({
    ASTERISM_MODEL_ID: "claude-sonnet-4-6",
    ASTERISM_MODEL_PROVIDER: "anthropic",
  });
  expect(reason).toBeUndefined();
  expect(adapter).toBeDefined();
});

test("no substrate credential can un-refuse a local provider aimed elsewhere", () => {
  // The refusal is a policy decision, not a failed lookup: an unauthenticated-by
  // -design provider pointed at someone else's server stays refused however many
  // credentials happen to be lying around.
  //
  // The substrate is stubbed to claim it CAN authenticate anything. Nothing in
  // its real table would say so for `ollama` today — which is exactly why the
  // guard needs a stub to be provable rather than merely asserted, and why it
  // exists: what it defends against is that table changing.
  const { adapter, reason } = buildAdapter(
    {
      ASTERISM_MODEL_ID: "qwen3",
      ASTERISM_MODEL_PROVIDER: "ollama",
      ASTERISM_MODEL_BASE_URL: "https://ollama.example.com/v1",
    },
    {},
    () => true,
  );
  expect(adapter).toBeUndefined();
  expect(reason).toContain("ollama.example.com");
});

test("a substrate credential does not resurrect a plain missing key either way round", () => {
  // The complement: with the substrate claiming nothing, a hosted provider with
  // no key still refuses — so the consult widens the check, it does not replace it.
  const { adapter, reason } = buildAdapter({ ASTERISM_MODEL_ID: "gpt-4o-mini" }, {}, () => false);
  expect(adapter).toBeUndefined();
  expect(reason).toContain("OPENAI_API_KEY");
});

test("`run` and `reflect` agree on whether a setup is usable", () => {
  for (const { name, env, builds } of CASES) {
    const adapter = buildAdapter(env);
    const reflection = buildReflectionProvider(env);
    expect(`${name}: run ${adapter.adapter !== undefined}`).toBe(`${name}: run ${builds}`);
    expect(`${name}: reflect ${reflection.provider !== undefined}`).toBe(
      `${name}: reflect ${builds}`,
    );
    // A refusal always explains itself; neither may fail silently.
    if (!builds) {
      expect(adapter.reason).toBeTruthy();
      expect(reflection.reason).toBeTruthy();
    }
  }
});

test("`run` and `reflect` refuse with the SAME explanation", () => {
  // They used to word this differently ("...before running an agent" vs
  // "...before reflecting"), which is how they came to disagree about the rule
  // underneath. One resolver, one message.
  for (const { env, builds } of CASES) {
    if (builds) continue;
    expect(buildAdapter(env).reason).toBe(buildReflectionProvider(env).reason);
  }
});

test("a missing key is reported by `run` up front, not by the substrate later", () => {
  // Without the pre-flight check this returned an adapter, and the failure
  // arrived at the first token as Pi's own "No API key for provider: openai"
  // down the adapter's unexpected-fault path.
  const { adapter, reason } = buildAdapter({ ASTERISM_MODEL_ID: "gpt-4o-mini" });
  expect(adapter).toBeUndefined();
  expect(reason).toContain("OPENAI_API_KEY");
  expect(reason).not.toContain("No API key for provider");
});

test("the no-key message points at running a model on your own machine", () => {
  // The whole point of the slice: there is a way forward that needs no account.
  const { reason } = buildAdapter({ ASTERISM_MODEL_ID: "gpt-4o-mini" });
  expect(reason).toContain("ollama");
});

test("a key of only whitespace stops `run` too, not just `reflect`", () => {
  // The invariant below is one-directional — reflect ⊆ run — so it cannot see `run`
  // doing something `reflect` refuses, which is what happened here. The host reads the
  // key through its own trimmed rule and found nothing; the SUBSTRATE was then asked
  // whether it could authenticate, read the same variable untrimmed, said yes, and an
  // adapter was built that sent a blank key. `reflect` refused. One install, two
  // answers, on the path that costs money.
  const saved = process.env.OPENAI_API_KEY;
  try {
    const env: Env = { ASTERISM_MODEL_ID: "gpt-4o-mini" };
    for (const blank of ["", " ", "  ", "\t", "\n"]) {
      process.env.OPENAI_API_KEY = blank;
      const run = buildAdapter(env);
      const reflect = buildReflectionProvider(env);
      expect(`${JSON.stringify(blank)}: ${run.adapter !== undefined}`).toBe(
        `${JSON.stringify(blank)}: false`,
      );
      expect(reflect.provider).toBeUndefined();
      // …and refusing for the same stated reason, which is the rule they share.
      expect(run.reason).toBe(reflect.reason);
    }
    // A key with padding around something real still runs — presence, not shape.
    process.env.OPENAI_API_KEY = " sk-ambient\n";
    expect(buildAdapter(env).adapter).toBeDefined();
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test("whatever `reflect` can do, `run` can do — never the other way round", () => {
  // The honest invariant now that the substrate has credentials of its own:
  // reflect's reach is a SUBSET of run's. A setup reflect accepts must always be
  // one run accepts, or the agent could learn from a model it cannot think with.
  const envs: Env[] = [
    ...CASES.map((c) => c.env),
    { ASTERISM_MODEL_ID: "claude-sonnet-4-6", ASTERISM_MODEL_PROVIDER: "anthropic" },
    { ASTERISM_MODEL_ID: "qwen3", ASTERISM_MODEL_PROVIDER: "lmstudio" },
  ];
  for (const env of envs) {
    for (const ambient of [undefined, "sk-ant-oat01-not-a-real-token"]) {
      if (ambient === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
      else process.env.ANTHROPIC_OAUTH_TOKEN = ambient;
      const runs = buildAdapter(env).adapter !== undefined;
      const reflects = buildReflectionProvider(env).provider !== undefined;
      expect(`${JSON.stringify(env)}/${ambient}: ${reflects && !runs}`).toBe(
        `${JSON.stringify(env)}/${ambient}: false`,
      );
    }
  }
});

test("a local model pointed remotely names the endpoint it refused", () => {
  const env = {
    ASTERISM_MODEL_ID: "qwen3",
    ASTERISM_MODEL_PROVIDER: "ollama",
    ASTERISM_MODEL_BASE_URL: "https://ollama.example.com/v1",
    ASTERISM_API_KEY: "sk-a-real-hosted-key",
  };
  const { adapter, reason } = buildAdapter(env);
  expect(adapter).toBeUndefined();
  expect(reason).toContain("ollama.example.com");
  expect(reason).toContain("OLLAMA_API_KEY");
});
