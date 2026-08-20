// The one rule about environment values (#174): a variable that exists and holds
// nothing has supplied nothing. What we pin: the three shapes a read can take agree
// with each other, whitespace is a value (it was typed), and "set" means the same thing
// to a surface that REPORTS a variable as to the code that USES it.

import { expect, test } from "bun:test";

import {
  ambientValue,
  EMBED_ENDPOINT_VARS,
  embeddingEndpoint,
  envIsSet,
  envValue,
  missingEmbeddingVars,
  suppliesText,
} from "./env.ts";

test("an ambient value that is empty has supplied nothing", () => {
  expect(ambientValue("ghp_token")).toBe("ghp_token");
  expect(ambientValue("")).toBeUndefined();
  expect(ambientValue(undefined)).toBeUndefined();
});

test("whitespace is a value — it is something the operator put there", () => {
  // Only EMPTY means "nothing supplied". A padded token is a real credential shape, and
  // trimming an ambient value here would change what a pipe stores byte for byte.
  expect(ambientValue(" ")).toBe(" ");
  expect(envValue({ K: "\n" }, "K")).toBe("\n");
});

test("an exported-but-empty variable reads as unset, an absent one the same way", () => {
  const env = { EMPTY: "", REAL: "llama3.2" };
  expect(envValue(env, "EMPTY")).toBeUndefined();
  expect(envValue(env, "REAL")).toBe("llama3.2");
  expect(envValue(env, "NEVER_SET")).toBeUndefined();
});

test("reporting a variable as set and reading its value cannot disagree", () => {
  // The whole of #174 was two answers to one question: `config show` said the override
  // was set while the resolver read nothing from it. `envIsSet` is derived from
  // `envValue` rather than testing `undefined` on its own, so there is one answer.
  for (const raw of [undefined, "", " ", "x"]) {
    const env = raw === undefined ? {} : { K: raw };
    expect(envIsSet(env, "K")).toBe(envValue(env, "K") !== undefined);
  }
  expect(envIsSet({ K: "" }, "K")).toBe(false);
  expect(envIsSet({ K: "x" }, "K")).toBe(true);
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

test("whitespace supplies no TEXT, even though it is a value", () => {
  // Two questions, deliberately different. `envIsSet` asks whether the operator put
  // something there — a padded credential is a credential. `suppliesText` asks whether
  // there is anything to hand on, which is what a service env file needs to know,
  // because every reader on the other side of it trims before testing.
  expect(envIsSet({ K: "  " }, "K")).toBe(true);
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
