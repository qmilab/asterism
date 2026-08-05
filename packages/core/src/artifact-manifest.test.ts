// collectArtifactManifest — the pure reducer behind the `artifact-only` mode. Pure, so it
// is tested directly: selection (state-changing only), last-wins accumulation, the redaction
// boundary, and the defensive handling of malformed observations (an untrusted extra channel
// — a host/JS tool outside strict TS can return anything).

import { expect, test } from "bun:test";

import { collectArtifactManifest } from "./artifact-manifest.js";
import type { ObservedEffect } from "./world-fact-harvest.js";
import { DEFAULT_MAX_OBSERVATION_FACTS } from "./redaction.js";
import type { EffectClass } from "./trust.js";

function obs(
  effect: EffectClass,
  facts: readonly { subject: string; relation: string; object: unknown }[],
): ObservedEffect {
  return { effect, observation: { schema: "asterism.fs.test@1", facts } };
}

const wrote = (path: string, size: number): ObservedEffect =>
  obs("write", [
    { subject: `file:${path}`, relation: "exists", object: true },
    { subject: `file:${path}`, relation: "size_bytes", object: size },
  ]);

test("an empty run yields an empty manifest", () => {
  expect(collectArtifactManifest([])).toEqual([]);
});

test("pure reads are dropped — the manifest is what changed, not what was looked at", () => {
  const effects = [
    obs("read", [{ subject: "file:secret/notes.md", relation: "exists", object: true }]),
    obs("read", [{ subject: "dir:private", relation: "exists", object: true }]),
  ];
  expect(collectArtifactManifest(effects)).toEqual([]);
});

test("a write yields a file reference with its size", () => {
  expect(collectArtifactManifest([wrote("drafts/a.md", 4300)])).toEqual([
    { path: "drafts/a.md", kind: "file", exists: true, sizeBytes: 4300 },
  ]);
});

test("a directory observation yields a dir reference with no size", () => {
  const effects = [obs("write", [{ subject: "dir:drafts", relation: "exists", object: true }])];
  expect(collectArtifactManifest(effects)).toEqual([
    { path: "drafts", kind: "dir", exists: true },
  ]);
});

test("write-then-delete of one path resolves to absent (a deletion dominates a stale size)", () => {
  const effects = [
    wrote("drafts/a.md", 100),
    obs("destructive", [{ subject: "file:drafts/a.md", relation: "exists", object: false }]),
  ];
  expect(collectArtifactManifest(effects)).toEqual([
    { path: "drafts/a.md", kind: "file", exists: false },
  ]);
});

test("a re-write resolves to the LATEST size (last relation value wins)", () => {
  expect(collectArtifactManifest([wrote("drafts/a.md", 100), wrote("drafts/a.md", 250)])).toEqual([
    { path: "drafts/a.md", kind: "file", exists: true, sizeBytes: 250 },
  ]);
});

test("a subject kind this reducer does not model is dropped, never guessed", () => {
  const effects = [
    obs("write", [{ subject: "repo:origin", relation: "exists", object: true }]),
    wrote("drafts/a.md", 10),
  ];
  expect(collectArtifactManifest(effects)).toEqual([
    { path: "drafts/a.md", kind: "file", exists: true, sizeBytes: 10 },
  ]);
});

test("a subject with no renderable state is skipped", () => {
  const effects = [
    obs("write", [{ subject: "file:a.md", relation: "mode", object: "0644" }]),
    // A non-boolean `exists` and a non-numeric size both fall through rather than mis-report.
    obs("write", [
      { subject: "file:b.md", relation: "exists", object: "yes" },
      { subject: "file:b.md", relation: "size_bytes", object: "big" },
    ]),
  ];
  expect(collectArtifactManifest(effects)).toEqual([]);
});

test("the manifest is sorted by path (deterministic output)", () => {
  const manifest = collectArtifactManifest([
    wrote("z/last.md", 1),
    wrote("a/first.md", 2),
    wrote("m/middle.md", 3),
  ]);
  expect(manifest.map((a) => a.path)).toEqual(["a/first.md", "m/middle.md", "z/last.md"]);
});

test("a secret-shaped path is redacted at the boundary", () => {
  const SECRET = "sk-live-000011112222333344445555";
  const manifest = collectArtifactManifest([wrote(`keys/${SECRET}.env`, 64)]);
  expect(manifest).toHaveLength(1);
  expect(manifest[0]!.path).not.toContain(SECRET);
});

test("a malformed observation is skipped, never thrown on", () => {
  const effects = [
    // `facts` missing entirely / not an array — a JS-hosted tool can return this.
    { effect: "write", observation: {} } as unknown as ObservedEffect,
    { effect: "write", observation: { schema: "x", facts: "nope" } } as unknown as ObservedEffect,
    { effect: "write", observation: undefined } as unknown as ObservedEffect,
    // Individual malformed facts inside a well-formed observation.
    obs("write", [
      null as unknown as { subject: string; relation: string; object: unknown },
      { subject: 42 as unknown as string, relation: "exists", object: true },
      { subject: "file:ok.md", relation: 7 as unknown as string, object: true },
    ]),
    wrote("good.md", 5),
  ];
  expect(collectArtifactManifest(effects)).toEqual([
    { path: "good.md", kind: "file", exists: true, sizeBytes: 5 },
  ]);
});

test("a path that redacts to nothing is skipped rather than emitted as a blank reference", () => {
  const effects = [obs("write", [{ subject: "file:   ", relation: "exists", object: true }])];
  expect(collectArtifactManifest(effects)).toEqual([]);
});

test("facts processed per observation are bounded (a flood cannot blow up the exit path)", () => {
  const flood = Array.from({ length: DEFAULT_MAX_OBSERVATION_FACTS + 500 }, (_, i) => ({
    subject: `file:f${i}.md`,
    relation: "exists",
    object: true,
  }));
  const manifest = collectArtifactManifest([obs("write", flood)]);
  expect(manifest.length).toBeLessThanOrEqual(DEFAULT_MAX_OBSERVATION_FACTS);
});

test("a file and a directory at the same path are distinct entries", () => {
  const effects = [
    obs("write", [{ subject: "dir:build", relation: "exists", object: true }]),
    obs("write", [{ subject: "file:build", relation: "exists", object: true }]),
  ];
  expect(collectArtifactManifest(effects)).toEqual([
    { path: "build", kind: "dir", exists: true },
    { path: "build", kind: "file", exists: true },
  ]);
});
