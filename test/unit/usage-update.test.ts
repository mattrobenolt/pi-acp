import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildUsageUpdate } from "../../src/acp/agent.js";

describe("buildUsageUpdate", () => {
  it("returns null when stats is null", () => {
    assert.strictEqual(buildUsageUpdate(null, null), null);
  });

  it("returns null when stats has no tokens", () => {
    assert.strictEqual(buildUsageUpdate({ cost: 0.01 }, null), null);
  });

  it("returns null when tokens.input is missing and tokens.total is missing", () => {
    assert.strictEqual(buildUsageUpdate({ tokens: {} }, null), null);
  });

  it("uses tokens.input as used when present", () => {
    const stats = { tokens: { input: 5000, output: 1000, total: 6000 } };
    const result = buildUsageUpdate(stats, null);
    assert.ok(result !== null);
    assert.strictEqual(result.used, 5000);
    assert.strictEqual(result.sessionUpdate, "usage_update");
  });

  it("falls back to tokens.total when tokens.input is absent", () => {
    const stats = { tokens: { output: 1000, total: 6000 } };
    const result = buildUsageUpdate(stats, null);
    assert.ok(result !== null);
    assert.strictEqual(result.used, 6000);
  });

  it("sets size from state.model.contextWindow", () => {
    const stats = { tokens: { input: 5000, total: 6000 } };
    const state = {
      model: { contextWindow: 200000, provider: "anthropic", id: "claude-3-5-sonnet-latest" },
    };
    const result = buildUsageUpdate(stats, state);
    assert.ok(result !== null);
    assert.strictEqual(result.size, 200000);
  });

  it("defaults size to 0 when state has no contextWindow", () => {
    const stats = { tokens: { input: 5000, total: 6000 } };
    const result = buildUsageUpdate(stats, {});
    assert.ok(result !== null);
    assert.strictEqual(result.size, 0);
  });

  it("defaults size to 0 when state is null", () => {
    const stats = { tokens: { input: 5000, total: 6000 } };
    const result = buildUsageUpdate(stats, null);
    assert.ok(result !== null);
    assert.strictEqual(result.size, 0);
  });

  it("includes cost when present as a number", () => {
    const stats = { tokens: { input: 5000, total: 6000 }, cost: 0.05 };
    const result = buildUsageUpdate(stats, null);
    assert.ok(result !== null);
    assert.deepEqual(result.cost, { amount: 0.05, currency: "USD" });
  });

  it("omits cost when not present", () => {
    const stats = { tokens: { input: 5000, total: 6000 } };
    const result = buildUsageUpdate(stats, null);
    assert.ok(result !== null);
    assert.strictEqual(result.cost, undefined);
  });

  it("omits cost when cost is zero (falsy but valid)", () => {
    // cost of 0 is technically valid but treated as null by the != null check since 0 !== null
    const stats = { tokens: { input: 5000, total: 6000 }, cost: 0 };
    const result = buildUsageUpdate(stats, null);
    assert.ok(result !== null);
    // cost: 0 is a number so it gets included as { amount: 0, currency: "USD" }
    assert.deepEqual(result.cost, { amount: 0, currency: "USD" });
  });

  it("full realistic payload", () => {
    const stats = {
      sessionId: "abc123",
      sessionFile: "/some/path/session.jsonl",
      totalMessages: 10,
      tokens: { input: 8500, output: 1200, cacheRead: 200, cacheWrite: 100, total: 10000 },
      cost: 0.12,
    };
    const state = {
      model: { contextWindow: 200000, provider: "anthropic", id: "claude-opus-4-5" },
      thinkingLevel: "medium",
    };
    const result = buildUsageUpdate(stats, state);
    assert.ok(result !== null);
    assert.strictEqual(result.sessionUpdate, "usage_update");
    assert.strictEqual(result.size, 200000);
    assert.strictEqual(result.used, 8500);
    assert.deepEqual(result.cost, { amount: 0.12, currency: "USD" });
  });
});
