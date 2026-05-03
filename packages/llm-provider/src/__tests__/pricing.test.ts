import test from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, lookupModelPricing } from "../index.js";

test("estimateCostUsd: known model produces a non-zero estimate", () => {
  const cost = estimateCostUsd("codex", "gpt-4.1", {
    inputTokens: 1000,
    outputTokens: 500,
  });
  // 1000 input @ $0.005/1k = $0.005; 500 output @ $0.015/1k = $0.0075 → $0.0125
  assert.equal(cost, 0.0125);
});

test("estimateCostUsd: unknown model returns 0", () => {
  const cost = estimateCostUsd("codex", "totally-unknown-model", {
    inputTokens: 100_000,
    outputTokens: 100_000,
  });
  assert.equal(cost, 0);
});

test("estimateCostUsd: mock provider is always zero", () => {
  const cost = estimateCostUsd("mock", "mock-small", {
    inputTokens: 10_000,
    outputTokens: 10_000,
  });
  assert.equal(cost, 0);
});

test("estimateCostUsd: 1e-6 USD rounding floor", () => {
  // gpt-4o-mini: $0.00015/1k input → 1 token = 1.5e-7 USD → rounds to 0
  const cost = estimateCostUsd("openai", "gpt-4o-mini", {
    inputTokens: 1,
    outputTokens: 0,
  });
  assert.equal(cost, 0);
  // 100 input tokens → 1.5e-5 USD = 0.000015 (within 1e-6 precision)
  const cost2 = estimateCostUsd("openai", "gpt-4o-mini", {
    inputTokens: 100,
    outputTokens: 0,
  });
  assert.equal(cost2, 0.000015);
});

test("lookupModelPricing returns null for unknown models", () => {
  assert.equal(lookupModelPricing("openai", "no-such-model"), null);
  const known = lookupModelPricing("openai", "gpt-4o-mini");
  assert.ok(known);
  assert.ok(known!.inputPer1k > 0);
});

test("estimateCostUsd: defensive against negative or NaN usage", () => {
  const cost = estimateCostUsd("openai", "gpt-4.1", {
    inputTokens: -10,
    outputTokens: -10,
  });
  assert.equal(cost, 0);
});
