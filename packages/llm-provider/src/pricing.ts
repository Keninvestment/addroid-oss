// AdDroid OSS — LLM cost estimation (the current implementation).
//
// ai_runs に書き込む `cost_usd` を算出するための小さな価格表。
// 値は 2026-04 時点の代表的な公開価格 (USD per 1K tokens) を参考にした近似値で、
// provider が cost を返す API を持たないため UI 側では本値を「概算」として扱う。
// 未登録 model は 0 を返す (UI は 0 を「未対応」として表示する)。

import type { LLMProviderName, LLMUsage } from "./types.js";

export interface ModelPricing {
  /** USD per 1,000 input tokens. */
  inputPer1k: number;
  /** USD per 1,000 output tokens. */
  outputPer1k: number;
}

/**
 * Provider/model ペアの代表的価格表。完全網羅は目的としない — 実運用で
 * 使われる model のみ追加する方針。値は公開資料に基づくが、UI 上はすべて
 * 「概算」として扱うため有効桁は最大 6 桁に丸める。
 */
const PRICE_TABLE: Record<string, ModelPricing> = {
  // OpenAI / Codex 経由で利用される代表 model
  "openai:gpt-4.1": { inputPer1k: 0.005, outputPer1k: 0.015 },
  "openai:gpt-4.1-mini": { inputPer1k: 0.0004, outputPer1k: 0.0016 },
  "openai:gpt-4o": { inputPer1k: 0.005, outputPer1k: 0.015 },
  "openai:gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "openai:gpt-4.1-nano": { inputPer1k: 0.0001, outputPer1k: 0.0004 },
  "codex:gpt-4.1": { inputPer1k: 0.005, outputPer1k: 0.015 },
  "codex:gpt-4.1-mini": { inputPer1k: 0.0004, outputPer1k: 0.0016 },
  "codex:gpt-4o": { inputPer1k: 0.005, outputPer1k: 0.015 },
  "codex:gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "anthropic:claude-3-5-sonnet-latest": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "anthropic:claude-3-5-haiku-latest": { inputPer1k: 0.0008, outputPer1k: 0.004 },
  "anthropic:claude-3-7-sonnet-latest": { inputPer1k: 0.003, outputPer1k: 0.015 },
  // Mock provider はコストゼロ
  "mock:mock-small": { inputPer1k: 0, outputPer1k: 0 },
  "mock:mock-large": { inputPer1k: 0, outputPer1k: 0 },
};

function priceKey(provider: LLMProviderName, model: string): string {
  return `${provider}:${model}`;
}

export function lookupModelPricing(
  provider: LLMProviderName,
  model: string
): ModelPricing | null {
  const key = priceKey(provider, model);
  return PRICE_TABLE[key] ?? null;
}

/**
 * トークン数 + provider/model から USD を見積もる。未登録 model は 0 を返す。
 * 結果は 1e-6 USD 未満を切り捨て (満たない金額は記録上 0 扱い)。
 */
export function estimateCostUsd(
  provider: LLMProviderName,
  model: string,
  usage: LLMUsage
): number {
  const pricing = lookupModelPricing(provider, model);
  if (!pricing) return 0;
  const inputCost = (usage.inputTokens / 1000) * pricing.inputPer1k;
  const outputCost = (usage.outputTokens / 1000) * pricing.outputPer1k;
  const total = inputCost + outputCost;
  // 6 桁 (1e-6 USD) で丸める。負値は防御的に 0 にクランプ。
  if (!Number.isFinite(total) || total < 0) return 0;
  return Math.round(total * 1_000_000) / 1_000_000;
}
