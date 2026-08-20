// The one rule about environment values (#174): a variable that exists and holds
// nothing has supplied nothing. What we pin: the three shapes a read can take agree
// with each other, whitespace is a value (it was typed), and "set" means the same thing
// to a surface that REPORTS a variable as to the code that USES it.

import { expect, test } from "bun:test";

import {
  ambientValue,
  EMBED_ENDPOINT_VARS,
  embeddingEndpoint,
  envText,
  missingEmbeddingVars,
  suppliesText,
} from "./env.ts";

test("an ambient value that is empty has supplied nothing", () => {
  expect(ambientValue("ghp_token")).toBe("ghp_token");
  expect(ambientValue("")).toBeUndefined();
  expect(ambientValue(undefined)).toBeUndefined();
});

test("whitespace is a value the operator supplied — for a secret, which is theirs", () => {
  // Only EMPTY means "nothing supplied" to `ambientValue`. A padded token is a real
  // credential shape, and trimming here would change what a pipe stores byte for byte.
  expect(ambientValue(" ")).toBe(" ");
  expect(ambientValue("\n")).toBe("\n");
});

test("an exported-but-empty variable reads as unset, an absent one the same way", () => {
  const env = { EMPTY: "", REAL: "llama3.2" };
  expect(envText(env, "EMPTY")).toBeUndefined();
  expect(envText(env, "REAL")).toBe("llama3.2");
  expect(envText(env, "NEVER_SET")).toBeUndefined();
});

test("reporting a variable as set and reading its value cannot disagree", () => {
  // The whole of #174 was two answers to one question: `config show` said the override
  // was set while the resolver read nothing from it. It happened a second time, in the
  // fix, when one reporting line kept an untrimmed rule of its own after every consumer
  // moved to the trimming one — so there is now exactly one, and this is it.
  for (const raw of [undefined, "", " ", "\t", "x", " x "]) {
    const env = raw === undefined ? {} : { K: raw };
    expect(suppliesText(env, "K")).toBe(envText(env, "K") !== undefined);
  }
  expect(suppliesText({ K: "" }, "K")).toBe(false);
  expect(suppliesText({ K: "  " }, "K")).toBe(false);
  expect(suppliesText({ K: "x" }, "K")).toBe(true);
});

test("an embeddings endpoint needs both variables, trimmed", () => {
  // The one answer `config show` reports and `buildEmbeddingRecallProvider` builds from.
  // Either alone used to read as "configured" on the reporting side while the builder
  // refused the run — the same one-install-two-answers shape as the model override.
  expect(embeddingEndpoint({})).toBeUndefined();
  expect(embeddingEndpoint({ ASTERISM_RECALL_EMBED_URL: "http://x/v1/embeddings" })).toBeUndefined();
  expect(embeddingEndpoint({ ASTERISM_RECALL_EMBED_MODEL: "nomic" })).toBeUndefined();
  expect(
    embeddingEndpoint({ ASTERISM_RECALL_EMBED_URL: "http://x/v1/embeddings", ASTERISM_RECALL_EMBED_MODEL: "" }),
  ).toBeUndefined();
  // Trimmed here, unlike an ambient credential: whitespace is not a URL or a model name.
  expect(
    embeddingEndpoint({ ASTERISM_RECALL_EMBED_URL: "  ", ASTERISM_RECALL_EMBED_MODEL: "nomic" }),
  ).toBeUndefined();
  expect(
    embeddingEndpoint({
      ASTERISM_RECALL_EMBED_URL: " http://x/v1/embeddings ",
      ASTERISM_RECALL_EMBED_MODEL: " nomic ",
    }),
  ).toEqual({ url: "http://x/v1/embeddings", model: "nomic" });
  // The names the reporting surface prints come from the same module, not a second list.
  expect([...EMBED_ENDPOINT_VARS]).toEqual(["ASTERISM_RECALL_EMBED_URL", "ASTERISM_RECALL_EMBED_MODEL"]);
});

test("whitespace supplies no TEXT, even though it is something the operator typed", () => {
  // The two questions, side by side. `ambientValue` asks whether the operator supplied
  // something — a padded secret is a secret, and its padding is theirs. `suppliesText`
  // asks whether there is text to hand on, which is what a service env file, a model
  // coordinate and an infrastructure credential all need to know.
  expect(ambientValue("  ")).toBe("  ");
  expect(suppliesText({ K: "  " }, "K")).toBe(false);
  expect(suppliesText({ K: "" }, "K")).toBe(false);
  expect(suppliesText({}, "K")).toBe(false);
  expect(suppliesText({ K: " tok " }, "K")).toBe(true); // padded, but it carries something
});

test("a half-configured embeddings endpoint names what is still missing", () => {
  const url = "http://localhost:11434/v1/embeddings";
  // Nothing set: nothing to report, and no gap to name.
  expect(missingEmbeddingVars({})).toEqual([]);
  // Complete: also no gap.
  expect(
    missingEmbeddingVars({ ASTERISM_RECALL_EMBED_URL: url, ASTERISM_RECALL_EMBED_MODEL: "nomic" }),
  ).toEqual([]);
  // Half: the third state, and the actionable one. Reporting it as nothing at all left
  // an operator one variable away with no hint of it.
  expect(missingEmbeddingVars({ ASTERISM_RECALL_EMBED_URL: url })).toEqual([
    "ASTERISM_RECALL_EMBED_MODEL",
  ]);
  expect(missingEmbeddingVars({ ASTERISM_RECALL_EMBED_MODEL: "nomic" })).toEqual([
    "ASTERISM_RECALL_EMBED_URL",
  ]);
  // Whitespace is not a value here either, so it reads as half-configured, not complete.
  expect(
    missingEmbeddingVars({ ASTERISM_RECALL_EMBED_URL: url, ASTERISM_RECALL_EMBED_MODEL: " " }),
  ).toEqual(["ASTERISM_RECALL_EMBED_MODEL"]);
});

test("the two rules answer two different questions, and there is no third", () => {
  // `ambientValue`: did the operator supply something? Padding on an agent's own secret
  // may be load-bearing, and it is theirs. `envText`: is there text to USE? A model id or
  // an API key made of spaces is what a copy-paste left, never what was meant — and the
  // newline on the END of a pasted key is the same mistake, so it goes too.
  expect(ambientValue("  ")).toBe("  ");
  expect(envText({ K: "  " }, "K")).toBeUndefined();
  expect(envText({ K: "\n" }, "K")).toBeUndefined();
  expect(envText({ K: "" }, "K")).toBeUndefined();
  expect(envText({}, "K")).toBeUndefined();
  expect(envText({ K: " sk-padded\n" }, "K")).toBe("sk-padded");
  // `suppliesText` is derived from it, so the two cannot answer differently.
  for (const raw of [undefined, "", " ", "\t", "x", " x "]) {
    const env = raw === undefined ? {} : { K: raw };
    expect(suppliesText(env, "K")).toBe(envText(env, "K") !== undefined);
  }
});
