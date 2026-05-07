// AdDroid OSS — MockLLMProvider.
//
// `ADDROID_LLM_MOCK=1` のときに採用される、ネットワーク不要の実装。
// /ai (LLM Provider 接続 + AI runs 履歴の集約画面) の開発、AI ワークフロー
// (daily_report / budget_guard / improvement_pr) の単体テスト、UI スナップショット
// で再利用する。
//
// 重要 — ハードコードされた token や API key は使わない。決定的な
// completion 文字列を返し、tests から failureMode で切替えできる。

import { randomBytes } from "node:crypto";
import { estimateCostUsd } from "./pricing.js";
import type {
  LLMProviderTokenRecord,
  LLMProviderTokenStore,
} from "./token-store.js";
import {
  LLMNotImplementedError,
  LLMOAuthStateMismatchError,
  LLMProviderError,
  LLMProviderUnauthenticatedError,
  type LLMAuthKind,
  type LLMBeginOAuthResult,
  type LLMCompletionRequest,
  type LLMCompletionResult,
  type LLMConnectionMeta,
  type LLMEmbedRequest,
  type LLMEmbedResult,
  type LLMImageRequest,
  type LLMImageResult,
  type LLMProvider,
  type LLMProviderName,
  type LLMRefreshResult,
} from "./types.js";

const MOCK_AUTH_BASE = "https://addroid.invalid/mock-llm-auth/authorize";
const MOCK_DEFAULT_MODEL = "mock-small";

export interface MockLLMProviderOptions {
  tokenStore: LLMProviderTokenStore;
  /** 表示用 identifier。既定 "mock-codex-user". */
  accountIdentifier?: string;
  /** 既定 ["openai", "offline_access"]。 */
  scopes?: readonly string[];
  /** 既定 "mock-small"。 */
  defaultModel?: string;
  /** mock 暗号化シード (test seam)。 */
  fakeCiphertext?: string;
  /** completeOAuth 時の expiresAt 計算用 (秒)。既定 1 時間。 */
  expiresInSeconds?: number;
  /** completion で返す本文。既定: 入力に応じた決定的文字列。 */
  completionResponder?: (req: LLMCompletionRequest) => string;
  /** トークン使用量を上書き (test seam)。既定: input 12 / output 24。 */
  usageResponder?: (req: LLMCompletionRequest) => {
    inputTokens: number;
    outputTokens: number;
  };
  /**
   * テスト用フェイルモード。"auth_failed" は OAuth/refresh で失敗、"completion_failed"
   * は complete() で失敗を返す。
   */
  failureMode?: "auth_failed" | "completion_failed" | null;
}

const DEFAULT_SCOPES = ["openai", "offline_access"] as const;

export class MockLLMProvider implements LLMProvider {
  readonly name: LLMProviderName = "mock";
  readonly authKind: LLMAuthKind = "oauth";
  readonly defaultModel: string;

  private readonly tokenStore: LLMProviderTokenStore;
  private readonly accountIdentifier: string;
  private readonly scopes: string[];
  private readonly fakeCiphertext: string;
  private readonly expiresInSeconds: number;
  private readonly completionResponder: (req: LLMCompletionRequest) => string;
  private readonly usageResponder: (
    req: LLMCompletionRequest
  ) => { inputTokens: number; outputTokens: number };
  private failureMode: "auth_failed" | "completion_failed" | null;
  private pending: { state: string; codeVerifier: string } | null = null;

  constructor(opts: MockLLMProviderOptions) {
    this.tokenStore = opts.tokenStore;
    this.accountIdentifier = opts.accountIdentifier ?? "mock-codex-user";
    this.scopes = [...(opts.scopes ?? DEFAULT_SCOPES)];
    this.defaultModel = opts.defaultModel ?? MOCK_DEFAULT_MODEL;
    this.fakeCiphertext = opts.fakeCiphertext ?? "mock-codex-encrypted";
    this.expiresInSeconds = opts.expiresInSeconds ?? 60 * 60;
    this.completionResponder =
      opts.completionResponder ?? defaultCompletionResponder;
    this.usageResponder =
      opts.usageResponder ?? (() => ({ inputTokens: 12, outputTokens: 24 }));
    this.failureMode = opts.failureMode ?? null;
  }

  async beginOAuth(): Promise<LLMBeginOAuthResult> {
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    this.pending = { state, codeVerifier };
    const params = new URLSearchParams({
      state,
      user: this.accountIdentifier,
      scope: this.scopes.join(" "),
    });
    return {
      authorizationUrl: `${MOCK_AUTH_BASE}?${params.toString()}`,
      state,
    };
  }

  async completeOAuth(params: {
    code: string;
    state: string;
  }): Promise<LLMConnectionMeta> {
    if (!this.pending || params.state !== this.pending.state) {
      this.pending = null;
      throw new LLMOAuthStateMismatchError();
    }
    this.pending = null;
    if (this.failureMode === "auth_failed") {
      throw new LLMProviderError("mock", "OAuth error: invalid_grant (mock failure)");
    }
    const connectedAt = new Date();
    const expiresAt = new Date(connectedAt.getTime() + this.expiresInSeconds * 1000);
    const record: LLMProviderTokenRecord = {
      provider: "mock",
      accountIdentifier: this.accountIdentifier,
      scopes: [...this.scopes],
      accessTokenCiphertext: `${this.fakeCiphertext}::access::${params.code}`,
      refreshTokenCiphertext: `${this.fakeCiphertext}::refresh::${params.code}`,
      expiresAt,
      connectedAt,
      defaultModel: this.defaultModel,
    };
    await this.tokenStore.saveOAuthToken(record);
    return {
      provider: "mock",
      accountIdentifier: this.accountIdentifier,
      scopes: [...this.scopes],
      connectedAt: connectedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      defaultModel: this.defaultModel,
    };
  }

  async refreshToken(): Promise<LLMRefreshResult> {
    const existing = await this.tokenStore.loadOAuthToken("mock");
    if (!existing) throw new LLMProviderUnauthenticatedError("mock", "refresh token");
    if (this.failureMode === "auth_failed") {
      throw new LLMProviderError("mock", "OAuth error: invalid_token (mock failure)");
    }
    const refreshedAt = new Date();
    const expiresAt = new Date(refreshedAt.getTime() + this.expiresInSeconds * 1000);
    await this.tokenStore.saveOAuthToken({
      ...existing,
      accessTokenCiphertext: `${this.fakeCiphertext}::refreshed::${refreshedAt.getTime()}`,
      expiresAt,
    });
    return {
      provider: "mock",
      accountIdentifier: existing.accountIdentifier,
      refreshedAt: refreshedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async disconnect(): Promise<boolean> {
    this.pending = null;
    return this.tokenStore.deleteOAuthToken("mock");
  }

  async getConnection(): Promise<LLMConnectionMeta | null> {
    const rec = await this.tokenStore.loadOAuthToken("mock");
    if (!rec) return null;
    return {
      provider: "mock",
      accountIdentifier: rec.accountIdentifier,
      scopes: rec.scopes,
      connectedAt: rec.connectedAt.toISOString(),
      expiresAt: rec.expiresAt ? rec.expiresAt.toISOString() : null,
      defaultModel: rec.defaultModel,
    };
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      throw new LLMProviderError("mock", "complete: messages must be a non-empty array");
    }
    const rec = await this.tokenStore.loadOAuthToken("mock");
    if (!rec) throw new LLMProviderUnauthenticatedError("mock", "complete a request");
    if (this.failureMode === "completion_failed") {
      throw new LLMProviderError("mock", "completion failed (mock failure_mode)", {
        status: 503,
        code: "mock_failure",
      });
    }
    const model = req.model ?? rec.defaultModel;
    const content = this.completionResponder(req);
    const usage = this.usageResponder(req);
    return {
      content,
      finishReason: "stop",
      usage,
      meta: {
        provider: "mock",
        model,
        requestId: `mock-req-${Date.now()}`,
        accountIdentifier: rec.accountIdentifier,
      },
      costUsd: estimateCostUsd("mock", model, usage),
    };
  }

  async generateImage(_req: LLMImageRequest): Promise<LLMImageResult> {
    throw new LLMNotImplementedError("mock", "generateImage");
  }

  async embed(_req: LLMEmbedRequest): Promise<LLMEmbedResult> {
    throw new LLMNotImplementedError("mock", "embed");
  }

  // ---- test helpers ----

  setFailureMode(mode: "auth_failed" | "completion_failed" | null): void {
    this.failureMode = mode;
  }
}

/**
 * 既定 completion responder。
 *
 * agent 経由で呼ばれた場合 (`purpose === "agent:<name>"`) は、各 agent の JSON
 * パーサ (packages/llm-provider/src/agents.ts の parse*AgentResponse) を確実に
 * 通る最小限の決定論的 JSON を返す。これにより `ADDROID_LLM_MOCK=1` でも
 * daily_report / budget_guard / improvement_pr の AI 段が `status="succeeded"`
 * の ai_run を残し、UI スナップショットとローカル開発で完全パイプラインを
 * 試せるようになる。
 *
 * agent 由来でない呼び出しは従来通り echo 形式の文字列を返す (テストハーネス
 * 等の利用者が任意の `completionResponder` を指定しない場合のフォールバック)。
 */
function defaultCompletionResponder(req: LLMCompletionRequest): string {
  const purpose = req.purpose ?? "general";
  const agentName = purpose.startsWith("agent:") ? purpose.slice(6) : null;
  const agentJson = agentName ? defaultAgentJson(agentName) : null;
  if (agentJson !== null) return agentJson;
  const last = req.messages[req.messages.length - 1];
  const summary = last?.content ? last.content.slice(0, 64) : "(empty)";
  return `[mock:${purpose}] echo: ${summary}`;
}

function defaultAgentJson(agent: string): string | null {
  switch (agent) {
    case "analyst":
      return JSON.stringify({
        commentary:
          "[mock] simulated daily_report: spend stable vs prior period; CTR within expected band.",
        deltas: { spend: "+0.0%", ctr: "+0.0%", cpa: "+0.0%" },
        topImprovements: [
          {
            hierarchy: "campaign",
            target: "cmp_mock",
            rationale: "Simulated mid-funnel candidate for review.",
            expectedImpact: "+5% CV (mock)",
          },
        ],
        decision: "report_only",
        confidence: 0.5,
      });
    case "strategy":
      return JSON.stringify({
        recommendedApproach:
          "[mock] hold current strategy; defer changes pending real insights.",
        audienceFocus: "[mock] existing audience",
        channelMix: ["meta_feed"],
        riskNotes: [],
        rationale: "Simulated provider returns a no-op proposal.",
        decision: "skip",
        confidence: 0.5,
      });
    case "copy":
      return JSON.stringify({
        primary: {
          headline: "[mock] headline",
          primaryText: "[mock] primary text",
          cta: "Learn more",
        },
        alternates: [],
        rationale: "Simulated provider returns no copy variants.",
        decision: "skip",
        confidence: 0.5,
      });
    case "image_prompt":
      return JSON.stringify({
        variants: [
          {
            prompt: "[mock] image prompt",
            negativePrompt: "[mock] negative prompt",
            styleNotes: "[mock] style notes",
          },
        ],
        rationale: "Simulated provider returns a single placeholder prompt.",
        decision: "skip",
        confidence: 0.5,
      });
    case "creative_qa":
      return JSON.stringify({
        issues: [],
        recommendation: "approve",
        rationale: "[mock] no policy issues detected by simulated QA.",
        confidence: 0.5,
      });
    case "media_buyer":
      return JSON.stringify({
        proposals: [],
        budgetImpact: { deltaCurrency: 0, afterCurrency: 0, notes: "n/a (mock)" },
        dryRunSummary: "[mock] no changes proposed.",
        rationale: "Simulated provider declines to propose budget changes.",
        decision: "skip_no_proposal",
        confidence: 0.5,
      });
    case "gitops":
      return JSON.stringify({
        prTitle: "[mock] no improvement PR",
        prBody:
          "## AI rationale\n[mock]\n\n## Risk\n[mock]\n\n## Budget impact\n[mock]\n\n## Dry-run\n[mock]\n\n## Snapshots\n[mock]",
        branchName: "addroid/mock-no-op",
        files: [],
        decision: "skip",
        confidence: 0.5,
      });
    case "audit":
      return JSON.stringify({
        classification: "safe",
        dangerousCategories: [],
        findings: [],
        rationale: "[mock] simulated audit found no dangerous categories.",
        decision: "approval_required",
        confidence: 0.5,
      });
    default:
      return null;
  }
}
