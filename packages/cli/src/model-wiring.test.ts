// The two places a model config becomes a live client: `run`'s adapter and
// `reflect`'s provider. They are tested together on purpose — the fault this
// covers was not either one being wrong, but the two DISAGREEING about whether a
// key was required, so a setup that ran happily could not be reflected on.

import { expect, test } from "bun:test";

import { buildAdapter } from "./model.ts";
import { buildReflectionProvider } from "./reflect-model.ts";

type Env = Record<string, string | undefined>;

/** Every case below is run through both call sites and must get the same verdict. */
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
