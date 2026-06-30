// InstallSettingsRepository — install-wide kernel defaults, a SINGLE row (no agentId).
// The load-bearing properties: exactly one row (the table CHECK pins singleton = 1), a
// positive-int write boundary, and clear-then-set preserving created_at.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { AsterismStore } from "./store.js";

let store: AsterismStore;

beforeEach(() => {
  store = AsterismStore.open(":memory:");
});

afterEach(() => {
  store.close();
});

test("an unset install has no recall-budget default (resolution falls to the constant)", () => {
  expect(store.installSettings.get()).toBeUndefined();
  expect(store.installSettings.getRecallBudget()).toBeUndefined();
});

test("setRecallBudget persists the install-wide default and reads back", () => {
  const settings = store.installSettings.setRecallBudget(12);
  expect(settings.recallBudget).toBe(12);
  expect(store.installSettings.getRecallBudget()).toBe(12);
});

test("setRecallBudget validates a positive whole number at the write boundary", () => {
  expect(() => store.installSettings.setRecallBudget(0)).toThrow();
  expect(() => store.installSettings.setRecallBudget(-3)).toThrow();
  expect(() => store.installSettings.setRecallBudget(2.5)).toThrow();
  expect(store.installSettings.getRecallBudget()).toBeUndefined(); // nothing persisted
});

test("there is exactly ONE install-settings row — a second set updates, never inserts", () => {
  store.installSettings.setRecallBudget(5);
  store.installSettings.setRecallBudget(9);
  expect(store.installSettings.getRecallBudget()).toBe(9);
  // The singleton CHECK + ON CONFLICT(singleton) means one row, updated in place.
  const rows = store.installSettings.get();
  expect(rows?.recallBudget).toBe(9);
});

test("clearRecallBudget returns to the constant but keeps the row (created_at preserved)", () => {
  const first = store.installSettings.setRecallBudget(8);
  store.installSettings.clearRecallBudget();
  expect(store.installSettings.getRecallBudget()).toBeUndefined();
  // The row is kept, so a later set preserves the original created_at.
  const again = store.installSettings.setRecallBudget(4);
  expect(again.createdAt).toBe(first.createdAt);
  expect(again.recallBudget).toBe(4);
});

test("clearRecallBudget on a fresh install is a no-op (nothing to clear)", () => {
  expect(store.installSettings.clearRecallBudget()).toBeUndefined();
  expect(store.installSettings.getRecallBudget()).toBeUndefined();
});

// World-fact cap — the sibling install-wide default, the same single-row shape as the
// recall budget (the middle tier of resolveWorldFactCap).

test("an unset install has no world-fact-cap default (resolution falls to the constant)", () => {
  expect(store.installSettings.getWorldFactCap()).toBeUndefined();
});

test("setWorldFactCap persists the install-wide default and reads back", () => {
  const settings = store.installSettings.setWorldFactCap(40);
  expect(settings.worldFactCap).toBe(40);
  expect(store.installSettings.getWorldFactCap()).toBe(40);
});

test("setWorldFactCap validates a positive whole number at the write boundary", () => {
  expect(() => store.installSettings.setWorldFactCap(0)).toThrow();
  expect(() => store.installSettings.setWorldFactCap(-3)).toThrow();
  expect(() => store.installSettings.setWorldFactCap(2.5)).toThrow();
  expect(store.installSettings.getWorldFactCap()).toBeUndefined(); // nothing persisted
});

test("clearWorldFactCap returns to the constant but keeps the row (created_at preserved)", () => {
  const first = store.installSettings.setWorldFactCap(50);
  store.installSettings.clearWorldFactCap();
  expect(store.installSettings.getWorldFactCap()).toBeUndefined();
  const again = store.installSettings.setWorldFactCap(30);
  expect(again.createdAt).toBe(first.createdAt);
  expect(again.worldFactCap).toBe(30);
});

test("clearWorldFactCap on a fresh install is a no-op (nothing to clear)", () => {
  expect(store.installSettings.clearWorldFactCap()).toBeUndefined();
  expect(store.installSettings.getWorldFactCap()).toBeUndefined();
});

test("the two install-wide defaults share one row without clobbering each other", () => {
  store.installSettings.setRecallBudget(7);
  store.installSettings.setWorldFactCap(45);
  // Each setter touches only its own column, so neither clears the other.
  expect(store.installSettings.getRecallBudget()).toBe(7);
  expect(store.installSettings.getWorldFactCap()).toBe(45);
  // Clearing one leaves the other intact.
  store.installSettings.clearWorldFactCap();
  expect(store.installSettings.getRecallBudget()).toBe(7);
  expect(store.installSettings.getWorldFactCap()).toBeUndefined();
});
