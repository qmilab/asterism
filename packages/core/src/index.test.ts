import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsterismStore } from "./store";
import type { Agent, MemoryType, RunStatus, TrustLevel } from "./types";

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

describe("persistence", () => {
  test("agents round-trip with their fields", () => {
    const got = store.agents.get(alice.id);
    expect(got).toEqual(alice);
    expect(got?.role).toBe("personal helper");
    expect(got?.soulRef).toBe("casual-helper");
    expect(got?.workspaceDir).toBe("/tmp/alice");
    expect(got?.trustLevel).toBe("autonomous");
  });

  test("registry lists both agents", () => {
    const ids = store.agents.list().map((a) => a.id);
    expect(ids).toContain(alice.id);
    expect(ids).toContain(bob.id);
  });

  test("trust level can be updated", () => {
    const updated = store.agents.setTrustLevel(alice.id, "notify");
    expect(updated.trustLevel).toBe("notify");
    expect(store.agents.get(alice.id)?.trustLevel).toBe("notify");
  });

  test("scoped entities round-trip", () => {
    const run = store.runs.create(alice.id, { input: "do a thing" });
    expect(store.runs.get(alice.id, run.id)?.input).toBe("do a thing");

    const mem = store.memories.create(alice.id, {
      memoryType: "semantic",
      content: "the sky is blue",
      confidence: 0.9,
      sourceRunId: run.id,
    });
    const gotMem = store.memories.get(alice.id, mem.id);
    expect(gotMem?.content).toBe("the sky is blue");
    expect(gotMem?.confidence).toBe(0.9);
    expect(gotMem?.sourceRunId).toBe(run.id);

    const skill = store.skills.create(alice.id, {
      name: "blog-writer",
      path: "/tmp/alice/blog-writer.md",
    });
    expect(store.skills.get(alice.id, skill.id)?.name).toBe("blog-writer");

    const cred = store.credentials.create(alice.id, {
      key: "GITHUB_TOKEN",
      valueRef: "secret://alice/GITHUB_TOKEN",
    });
    expect(store.credentials.get(alice.id, cred.id)?.valueRef).toBe(
      "secret://alice/GITHUB_TOKEN",
    );
    // The plaintext value is never stored — only a reference.
    expect(store.credentials.getByKey(alice.id, "GITHUB_TOKEN")?.id).toBe(cred.id);

    const evt = store.events.append(alice.id, {
      type: "run.started",
      payload: { runId: run.id },
      runId: run.id,
    });
    const gotEvt = store.events.get(alice.id, evt.id);
    expect(gotEvt?.type).toBe("run.started");
    expect(gotEvt?.payload).toEqual({ runId: run.id });
  });
});

describe("isolation — the agent is the boundary", () => {
  test("reserved fields are never exposed on the public Agent", () => {
    const got = store.agents.get(alice.id) as Record<string, unknown>;
    expect("teamId" in got).toBe(false);
    expect("ownerPrincipalId" in got).toBe(false);
  });

  test("an agentId is required for every scoped query", () => {
    expect(() => store.runs.list("")).toThrow();
    expect(() => store.memories.list("")).toThrow();
    expect(() => store.skills.list("")).toThrow();
    expect(() => store.credentials.list("")).toThrow();
    expect(() => store.events.list("")).toThrow();
  });

  test("runs: bob cannot read or list alice's run", () => {
    const aliceRun = store.runs.create(alice.id, { input: "alice work" });
    store.runs.create(bob.id, { input: "bob work" });

    expect(store.runs.get(bob.id, aliceRun.id)).toBeUndefined();
    expect(store.runs.list(bob.id).map((r) => r.id)).not.toContain(aliceRun.id);
    expect(store.runs.list(alice.id).map((r) => r.id)).toEqual([aliceRun.id]);

    // A cross-agent status mutation must not touch alice's row.
    expect(store.runs.setStatus(bob.id, aliceRun.id, "done")).toBeUndefined();
    expect(store.runs.get(alice.id, aliceRun.id)?.status).toBe("pending");
  });

  test("memories: alice's memory never appears in bob's scope", () => {
    const aliceMem = store.memories.create(alice.id, {
      memoryType: "semantic",
      content: "alice secret note",
    });
    store.memories.create(bob.id, {
      memoryType: "semantic",
      content: "bob note",
    });

    expect(store.memories.get(bob.id, aliceMem.id)).toBeUndefined();
    const bobContents = store.memories.list(bob.id).map((m) => m.content);
    expect(bobContents).not.toContain("alice secret note");
    expect(bobContents).toEqual(["bob note"]);

    expect(
      store.memories.settleProposed(bob.id, aliceMem.id, "rejected"),
    ).toBeUndefined();
    expect(store.memories.get(alice.id, aliceMem.id)?.reviewState).toBe(
      "accepted",
    );
  });

  test("skills: bob cannot read or list alice's skill", () => {
    const aliceSkill = store.skills.create(alice.id, {
      name: "blog-writer",
      path: "/tmp/alice/blog-writer.md",
    });
    expect(store.skills.get(bob.id, aliceSkill.id)).toBeUndefined();
    expect(store.skills.list(bob.id)).toEqual([]);
  });

  test("credentials: bob cannot read alice's GITHUB_TOKEN", () => {
    const aliceCred = store.credentials.create(alice.id, {
      key: "GITHUB_TOKEN",
      valueRef: "secret://alice/GITHUB_TOKEN",
    });
    expect(store.credentials.get(bob.id, aliceCred.id)).toBeUndefined();
    expect(store.credentials.getByKey(bob.id, "GITHUB_TOKEN")).toBeUndefined();
    expect(store.credentials.list(bob.id)).toEqual([]);
  });

  test("events: alice's log is unreadable from bob's scope", () => {
    const aliceEvt = store.events.append(alice.id, {
      type: "secret.event",
      payload: { x: 1 },
    });
    store.events.append(bob.id, { type: "bob.event", payload: {} });

    expect(store.events.get(bob.id, aliceEvt.id)).toBeUndefined();
    const bobTypes = store.events.list(bob.id).map((e) => e.type);
    expect(bobTypes).not.toContain("secret.event");
    expect(bobTypes).toEqual(["bob.event"]);
  });

  test("same credential key in two agents stays distinct", () => {
    store.credentials.create(alice.id, {
      key: "GITHUB_TOKEN",
      valueRef: "secret://alice/GITHUB_TOKEN",
    });
    store.credentials.create(bob.id, {
      key: "GITHUB_TOKEN",
      valueRef: "secret://bob/GITHUB_TOKEN",
    });
    expect(store.credentials.getByKey(alice.id, "GITHUB_TOKEN")?.valueRef).toBe(
      "secret://alice/GITHUB_TOKEN",
    );
    expect(store.credentials.getByKey(bob.id, "GITHUB_TOKEN")?.valueRef).toBe(
      "secret://bob/GITHUB_TOKEN",
    );
  });
});

describe("write-path validation & state semantics", () => {
  test("invalid enum values are rejected at the write boundary", () => {
    expect(() =>
      store.agents.create({
        name: "x",
        role: "y",
        soulRef: "z",
        workspaceDir: "/tmp/x",
        trustLevel: "bogus" as unknown as TrustLevel,
      }),
    ).toThrow(/invalid trustLevel/);
    expect(() =>
      store.agents.setTrustLevel(alice.id, "nope" as unknown as TrustLevel),
    ).toThrow(/invalid trustLevel/);

    const run = store.runs.create(alice.id, { input: "t" });
    expect(() =>
      store.runs.setStatus(alice.id, run.id, "weird" as unknown as RunStatus),
    ).toThrow(/invalid run status/);
    expect(() =>
      store.memories.create(alice.id, {
        memoryType: "nope" as unknown as MemoryType,
        content: "c",
      }),
    ).toThrow(/invalid memoryType/);
  });

  test("setStatus stamps finished_at on terminal, keeps first finish, clears on non-terminal", () => {
    const run = store.runs.create(alice.id, { input: "t" });
    expect(run.finishedAt).toBeUndefined();

    const done = store.runs.setStatus(alice.id, run.id, "done");
    const firstFinish = done?.finishedAt;
    expect(firstFinish).toBeDefined();

    // A redundant terminal re-set must not mutate the recorded finish time.
    const doneAgain = store.runs.setStatus(alice.id, run.id, "done");
    expect(doneAgain?.finishedAt).toBe(firstFinish as string);

    // Returning to a non-terminal state clears the stale stamp.
    const running = store.runs.setStatus(alice.id, run.id, "running");
    expect(running?.status).toBe("running");
    expect(running?.finishedAt).toBeUndefined();
  });

  test("secrets add is idempotent — re-adding a key rotates its valueRef, no throw", () => {
    const first = store.credentials.create(alice.id, {
      key: "API",
      valueRef: "secret://alice/API#1",
    });
    const second = store.credentials.create(alice.id, {
      key: "API",
      valueRef: "secret://alice/API#2",
    });
    expect(second.id).toBe(first.id); // same credential identity, rotated value
    expect(store.credentials.getByKey(alice.id, "API")?.valueRef).toBe(
      "secret://alice/API#2",
    );
    expect(store.credentials.list(alice.id).filter((c) => c.key === "API")).toHaveLength(1);
  });

  test("list() preserves insertion order even for same-millisecond writes", () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(store.events.append(alice.id, { type: `e${i}`, payload: { i } }).id);
    }
    expect(store.events.list(alice.id).map((e) => e.id)).toEqual(ids);
  });
});
