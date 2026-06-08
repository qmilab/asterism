import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsterismStore } from "./store";
import { secretValueRef } from "./secrets";
import type { Agent } from "./types";

let store: AsterismStore;
let alice: Agent;
let bob: Agent;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
  alice = store.agents.create({
    name: "alice",
    role: "personal helper",
    soulRef: "casual-helper",
    workspaceDir: "/tmp/alice",
    trustLevel: "autonomous",
  });
  bob = store.agents.create({
    name: "bob",
    role: "careful consultant",
    soulRef: "careful-consultant",
    workspaceDir: "/tmp/bob",
    trustLevel: "propose",
  });
});

afterEach(() => {
  store.close();
});

describe("secret store — issue / read round-trip", () => {
  test("issue returns a ref, never the value; read resolves it", () => {
    const ref = store.secrets.issue(alice.id, "GITHUB_TOKEN", "ghp_realsecret");
    expect(ref.valueRef).toBe(secretValueRef(alice.id, "GITHUB_TOKEN"));
    expect(ref.key).toBe("GITHUB_TOKEN");
    // The returned ref object carries no value field at all.
    expect("value" in (ref as Record<string, unknown>)).toBe(false);

    expect(store.secrets.read(alice.id, ref.valueRef)).toBe("ghp_realsecret");
    expect(store.secrets.readByKey(alice.id, "GITHUB_TOKEN")).toBe(
      "ghp_realsecret",
    );
  });

  test("re-issuing a key rotates the value in place (idempotent add)", () => {
    const first = store.secrets.issue(alice.id, "API", "v1");
    const second = store.secrets.issue(alice.id, "API", "v2");
    expect(second.valueRef).toBe(first.valueRef);
    expect(store.secrets.readByKey(alice.id, "API")).toBe("v2");
    expect(store.secrets.list(alice.id).filter((r) => r.key === "API")).toHaveLength(1);
  });

  test("has / list / delete operate without exposing values", () => {
    store.secrets.issue(alice.id, "A", "secret-a");
    store.secrets.issue(alice.id, "B", "secret-b");

    expect(store.secrets.has(alice.id, "A")).toBe(true);
    expect(store.secrets.has(alice.id, "Z")).toBe(false);

    const listed = store.secrets.list(alice.id);
    expect(listed.map((r) => r.key).sort()).toEqual(["A", "B"]);
    // No value ever appears in a listed ref.
    for (const ref of listed) {
      expect(JSON.stringify(ref)).not.toContain("secret-a");
      expect(JSON.stringify(ref)).not.toContain("secret-b");
    }

    expect(store.secrets.delete(alice.id, "A")).toBe(true);
    expect(store.secrets.has(alice.id, "A")).toBe(false);
    expect(store.secrets.delete(alice.id, "A")).toBe(false);
  });
});

describe("secret store — agent is the boundary", () => {
  test("an agentId is required for every secret operation", () => {
    expect(() => store.secrets.issue("", "K", "v")).toThrow();
    expect(() => store.secrets.read("", "secret://x/K")).toThrow();
    expect(() => store.secrets.readByKey("", "K")).toThrow();
    expect(() => store.secrets.has("", "K")).toThrow();
    expect(() => store.secrets.list("")).toThrow();
    expect(() => store.secrets.delete("", "K")).toThrow();
    // A key is also required at issue time.
    expect(() => store.secrets.issue(alice.id, "", "v")).toThrow();
  });

  test("bob cannot read alice's secret by ref or by key", () => {
    const ref = store.secrets.issue(alice.id, "GITHUB_TOKEN", "ghp_alice");

    // Cross-agent read of a valid ref minted for alice returns undefined.
    expect(store.secrets.read(bob.id, ref.valueRef)).toBeUndefined();
    expect(store.secrets.readByKey(bob.id, "GITHUB_TOKEN")).toBeUndefined();
    expect(store.secrets.has(bob.id, "GITHUB_TOKEN")).toBe(false);
    expect(store.secrets.list(bob.id)).toEqual([]);

    // Even guessing/forging alice's ref shape does not help bob.
    expect(
      store.secrets.read(bob.id, secretValueRef(alice.id, "GITHUB_TOKEN")),
    ).toBeUndefined();

    // Alice still reads her own.
    expect(store.secrets.read(alice.id, ref.valueRef)).toBe("ghp_alice");
  });

  test("same key in two agents stays distinct and isolated", () => {
    store.secrets.issue(alice.id, "GITHUB_TOKEN", "ghp_alice");
    store.secrets.issue(bob.id, "GITHUB_TOKEN", "ghp_bob");
    expect(store.secrets.readByKey(alice.id, "GITHUB_TOKEN")).toBe("ghp_alice");
    expect(store.secrets.readByKey(bob.id, "GITHUB_TOKEN")).toBe("ghp_bob");
  });
});

describe("addCredential — plaintext never reaches the credential row or log", () => {
  test("the credential carries only a valueRef; the value is read-only via the store", () => {
    const cred = store.addCredential(alice.id, "GITHUB_TOKEN", "ghp_plaintext");

    // The returned credential is reference-only — no plaintext anywhere on it.
    expect(cred.key).toBe("GITHUB_TOKEN");
    expect(cred.valueRef).toBe(secretValueRef(alice.id, "GITHUB_TOKEN"));
    expect(JSON.stringify(cred)).not.toContain("ghp_plaintext");

    // The persisted credential row is likewise value-free.
    const persisted = store.credentials.getByKey(alice.id, "GITHUB_TOKEN");
    expect(JSON.stringify(persisted)).not.toContain("ghp_plaintext");

    // The plaintext is recoverable only through the scoped secret store.
    expect(store.secrets.read(alice.id, cred.valueRef)).toBe("ghp_plaintext");

    // And an event recording this action would reference, never carry, the value.
    const evt = store.events.append(alice.id, {
      type: "secret.added",
      payload: { key: cred.key, valueRef: cred.valueRef },
    });
    expect(JSON.stringify(store.events.get(alice.id, evt.id))).not.toContain(
      "ghp_plaintext",
    );
  });

  test("bob cannot resolve the value behind alice's credential ref", () => {
    const cred = store.addCredential(alice.id, "GITHUB_TOKEN", "ghp_alice");
    expect(store.secrets.read(bob.id, cred.valueRef)).toBeUndefined();
    expect(store.credentials.getByKey(bob.id, "GITHUB_TOKEN")).toBeUndefined();
  });
});

describe("removeCredential — both tables stay in sync", () => {
  test("removing a credential drops the metadata row and the plaintext together", () => {
    const cred = store.addCredential(alice.id, "GITHUB_TOKEN", "ghp_alice");
    // Precondition: both halves present.
    expect(store.credentials.getByKey(alice.id, "GITHUB_TOKEN")).toBeDefined();
    expect(store.secrets.read(alice.id, cred.valueRef)).toBe("ghp_alice");

    expect(store.removeCredential(alice.id, "GITHUB_TOKEN")).toBe(true);

    // Neither half survives — no credential pointing at an unresolvable valueRef,
    // no orphaned secret.
    expect(store.credentials.getByKey(alice.id, "GITHUB_TOKEN")).toBeUndefined();
    expect(store.credentials.list(alice.id)).toEqual([]);
    expect(store.secrets.read(alice.id, cred.valueRef)).toBeUndefined();
    expect(store.secrets.readByKey(alice.id, "GITHUB_TOKEN")).toBeUndefined();
    expect(store.secrets.has(alice.id, "GITHUB_TOKEN")).toBe(false);
  });

  test("removeCredential reports false when nothing existed", () => {
    expect(store.removeCredential(alice.id, "NOPE")).toBe(false);
  });

  test("a no-op removal leaves an unrelated standalone secret untouched", () => {
    // A secret issued directly, with no credential row backing it.
    store.secrets.issue(alice.id, "STANDALONE", "keep-me");

    // Removing a credential for that key is a no-op — there is no credential —
    // and must NOT destroy the standalone secret.
    expect(store.removeCredential(alice.id, "STANDALONE")).toBe(false);
    expect(store.secrets.readByKey(alice.id, "STANDALONE")).toBe("keep-me");
  });

  test("drops the secret the credential references, even with a non-default valueRef", () => {
    // A credential whose valueRef is NOT the key-derived default: the backing
    // secret lives under key "BACKING", but the credential is keyed "API".
    const backingRef = store.secrets.issue(alice.id, "BACKING", "real-value").valueRef;
    store.credentials.create(alice.id, { key: "API", valueRef: backingRef });

    expect(store.removeCredential(alice.id, "API")).toBe(true);

    // The actual referenced plaintext is gone — not orphaned.
    expect(store.secrets.read(alice.id, backingRef)).toBeUndefined();
    expect(store.credentials.getByKey(alice.id, "API")).toBeUndefined();
  });

  test("does not delete an unrelated standalone secret that shares the credential's key", () => {
    // Credential "TOKEN" references a CUSTOM ref; a separate standalone secret
    // happens to be stored under key "TOKEN". Removing the credential must touch
    // only what the credential references.
    const customRef = store.secrets.issue(alice.id, "CUSTOM", "cred-value").valueRef;
    store.credentials.create(alice.id, { key: "TOKEN", valueRef: customRef });
    store.secrets.issue(alice.id, "TOKEN", "standalone-value");

    expect(store.removeCredential(alice.id, "TOKEN")).toBe(true);

    // The credential's own secret is gone…
    expect(store.secrets.read(alice.id, customRef)).toBeUndefined();
    // …but the unrelated standalone secret keyed "TOKEN" survives.
    expect(store.secrets.readByKey(alice.id, "TOKEN")).toBe("standalone-value");
  });

  test("a secret shared by two credentials survives until the last one is removed", () => {
    // Two credentials (different keys) pointing at the same backing secret.
    const sharedRef = store.addCredential(alice.id, "PRIMARY", "shared-value").valueRef;
    store.credentials.create(alice.id, { key: "ALIAS", valueRef: sharedRef });

    // Removing the first leaves the secret alive — ALIAS still references it.
    expect(store.removeCredential(alice.id, "PRIMARY")).toBe(true);
    expect(store.secrets.read(alice.id, sharedRef)).toBe("shared-value");
    expect(store.credentials.getByKey(alice.id, "ALIAS")?.valueRef).toBe(sharedRef);

    // Removing the last reference finally revokes the secret.
    expect(store.removeCredential(alice.id, "ALIAS")).toBe(true);
    expect(store.secrets.read(alice.id, sharedRef)).toBeUndefined();
  });

  test("rotation revokes a stale non-default backing secret", () => {
    // A credential pointing at a non-default backing ref.
    const oldRef = store.secrets.issue(alice.id, "BACKING", "old-value").valueRef;
    store.credentials.create(alice.id, { key: "API", valueRef: oldRef });

    // Rotating the credential repoints it to the default ref and must not leave
    // the old plaintext readable behind its old ref.
    const rotated = store.addCredential(alice.id, "API", "new-value");
    expect(rotated.valueRef).toBe(secretValueRef(alice.id, "API"));
    expect(store.secrets.read(alice.id, rotated.valueRef)).toBe("new-value");
    expect(store.secrets.read(alice.id, oldRef)).toBeUndefined(); // stale plaintext gone
  });

  test("rotation does not revoke an old ref still shared by another credential", () => {
    const oldRef = store.secrets.issue(alice.id, "BACKING", "old-value").valueRef;
    store.credentials.create(alice.id, { key: "API", valueRef: oldRef });
    store.credentials.create(alice.id, { key: "ALIAS", valueRef: oldRef });

    // Rotating API away from oldRef must keep oldRef alive for ALIAS.
    store.addCredential(alice.id, "API", "new-value");
    expect(store.secrets.read(alice.id, oldRef)).toBe("old-value");
  });

  test("removing alice's credential leaves bob's identically-keyed one intact", () => {
    store.addCredential(alice.id, "GITHUB_TOKEN", "ghp_alice");
    const bobCred = store.addCredential(bob.id, "GITHUB_TOKEN", "ghp_bob");

    store.removeCredential(alice.id, "GITHUB_TOKEN");

    expect(store.credentials.getByKey(bob.id, "GITHUB_TOKEN")?.id).toBe(bobCred.id);
    expect(store.secrets.read(bob.id, bobCred.valueRef)).toBe("ghp_bob");
  });

  test("credentials.deleteByKey is scoped — bob cannot delete alice's row", () => {
    store.addCredential(alice.id, "GITHUB_TOKEN", "ghp_alice");
    expect(store.credentials.deleteByKey(bob.id, "GITHUB_TOKEN")).toBe(false);
    expect(store.credentials.getByKey(alice.id, "GITHUB_TOKEN")).toBeDefined();
  });
});
