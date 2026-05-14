// AdDroid OSS — ai_runs persistence helper (the current implementation).
//
// 8 agent (strategy/copy/image_prompt/creative_qa/analyst/media_buyer/gitops/
// audit) と 4 workflow (daily_report/budget_guard/improvement_pr/adhoc) の
// 全 AI 実行が、ai_runs テーブルに以下の 12 種を伴って永続化されることを保証する:
//
//   1.  agent          — 8 種類のいずれか
//   2.  workflow       — 4 種類のいずれか
//   3.  provider       — codex / openai / anthropic / mock
//   4.  model          — 例: "gpt-4.1"
//   5.  prompt         — sanitize 済み messages payload
//   6.  inputs         — sanitize 済み workflow 入力
//   7.  outputs        — sanitize 済み workflow / LLM 出力
//   8.  decision       — 任意の決定ラベル
//   9.  confidence     — 0.00–1.00
//   10. tokens         — inputTokens / outputTokens
//   11. cost           — costUsd (pricing.ts 由来)
//   12. linkedRef      — 紐付け先 (snapshot / PR / cron_run / audit_log)
//
// 設計原則:
//   - prompt / inputs / outputs は **書き込み時に必ず sanitize する** (defense-in-depth)。
//     Provider 側で sanitize 済みでも、本 helper が再度 walk して token-shaped
//     文字列を [REDACTED] に置換する。
//   - agent / workflow / provider / status / linkedRefType は許容値リストで
//     fail-closed に検証する。未知値は AiRunValidationError を throw。
//   - costUsd は呼び出し側が値を渡せば優先し、無ければ pricing.ts で見積もる。
//   - 本ヘルパは Prisma 互換の plain object を返すだけで、実際の `prisma.aiRun.
//     create({ data })` は呼び出し側 (apps/web / apps/worker) が行う。これにより
//     llm-provider package が prisma client への直接依存を持たないで済む。

import { estimateCostUsd } from "./pricing.js";
import type {
  LLMCompletionResult,
  LLMMessage,
  LLMProviderName,
  LLMUsage,
} from "./types.js";

export const AI_AGENTS = [
  "strategy",
  "copy",
  "image_prompt",
  "creative_qa",
  "analyst",
  "media_buyer",
  "gitops",
  "audit",
] as const;
export type AiAgent = (typeof AI_AGENTS)[number];

export const AI_WORKFLOWS = [
  "daily_report",
  "budget_guard",
  "improvement_pr",
  "adhoc",
] as const;
export type AiWorkflow = (typeof AI_WORKFLOWS)[number];

export const AI_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

export const AI_RUN_LINKED_REF_TYPES = [
  "performance_snapshot",
  "github_pull_request",
  "cron_run",
  "audit_log",
  "improvement_pr",
  "apply_job",
] as const;
export type AiRunLinkedRefType = (typeof AI_RUN_LINKED_REF_TYPES)[number];

export const AI_RUN_PROVIDERS: readonly LLMProviderName[] = [
  "codex",
  "openai",
  "anthropic",
  "mock",
];

export class AiRunValidationError extends Error {
  readonly field: string;
  readonly value: unknown;
  constructor(field: string, value: unknown, hint: string) {
    super(
      `ai_run input invalid for '${field}': ${hint} (got: ${safeStringifyForError(value)})`
    );
    this.name = "AiRunValidationError";
    this.field = field;
    this.value = value;
  }
}

// ---- Sanitization --------------------------------------------------------

/** Maximum bytes of a single sanitized string before it is truncated. */
const MAX_SANITIZED_STRING_BYTES = 32 * 1024;

/** Keys whose values should be wholesale replaced regardless of content. */
const SECRET_KEY_NAMES = new Set([
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "authorization",
  "api_key",
  "apikey",
  "client_secret",
  "clientsecret",
  "password",
  "secret",
  "dataBase64",
  "database64",
  "data_base64",
  "bytes",
]);

/**
 * Recursively sanitize a JSON-serializable value before writing it to ai_runs.
 *
 * - Drops the value of any object key that is a known secret container.
 * - Replaces token-shaped substrings (sk-..., Bearer ..., EAA...) inside strings.
 * - Truncates very long strings to keep ai_runs row sizes bounded.
 * - Leaves numbers / booleans / null untouched.
 */
export function sanitizeAiRunPayload(value: unknown): unknown {
  return sanitizeAiRunPayloadInner(value, 0);
}

function sanitizeAiRunPayloadInner(value: unknown, depth: number): unknown {
  if (depth > 32) return "[TRUNCATED:depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeAiRunPayloadInner(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      if (SECRET_KEY_NAMES.has(lk)) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = sanitizeAiRunPayloadInner(v, depth + 1);
    }
    return out;
  }
  // Functions / symbols / etc. — drop.
  return null;
}

function sanitizeString(s: string): string {
  if (!s) return s;
  let out = s;
  // OpenAI-style sk- secrets
  out = out.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-[REDACTED]");
  // Meta long-lived access tokens
  out = out.replace(/EAA[A-Za-z0-9]{20,}/g, "EAA[REDACTED]");
  // Bearer headers
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  // JSON-shaped {"access_token":"..."} / {"refresh_token":"..."} / {"id_token":"..."}
  out = out.replace(
    /"(access_token|refresh_token|id_token|api_key|client_secret)"\s*:\s*"[^"]+"/gi,
    '"$1":"[REDACTED]"'
  );
  // env var assignments
  out = out.replace(
    /(META_[A-Z0-9_]*TOKEN|OPENAI_[A-Z0-9_]*KEY|CODEX_[A-Z0-9_]*TOKEN|ANTHROPIC_[A-Z0-9_]*KEY|GITHUB_[A-Z0-9_]*TOKEN)\s*=\s*\S+/g,
    "$1=[REDACTED]"
  );
  if (out.length > MAX_SANITIZED_STRING_BYTES) {
    out = out.slice(0, MAX_SANITIZED_STRING_BYTES) + "…[truncated]";
  }
  return out;
}

function safeStringifyForError(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (typeof s !== "string") return String(value);
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  } catch {
    return String(value);
  }
}

// ---- Build inputs --------------------------------------------------------

export interface BuildAiRunInputOptions {
  workspaceId: string;
  agent: AiAgent;
  workflow: AiWorkflow;
  provider: LLMProviderName;
  model: string;
  status?: AiRunStatus;
  /** sanitize 前の prompt (LLMMessage[] や任意の object でも可)。 */
  prompt?: LLMMessage[] | unknown;
  /** sanitize 前の workflow 入力 (account / period / 過去スナップショット ID 等)。 */
  inputs: unknown;
  /** sanitize 前の workflow / LLM 出力。 */
  outputs?: unknown;
  decision?: string | null;
  confidence?: number | null;
  usage?: LLMUsage;
  /** 明示指定があれば優先。無ければ pricing.ts で見積もる。 */
  costUsd?: number;
  requestId?: string | null;
  linkedRefType?: AiRunLinkedRefType | null;
  linkedRefId?: string | null;
  errorMessage?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

/** Plain object shape that matches `prisma.aiRun.create({ data })`. */
export interface AiRunCreateInputData {
  workspaceId: string;
  agent: AiAgent;
  workflow: AiWorkflow;
  provider: LLMProviderName;
  model: string;
  status: AiRunStatus;
  prompt: unknown;
  inputs: unknown;
  outputs: unknown;
  decision: string | null;
  confidence: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requestId: string | null;
  linkedRefType: AiRunLinkedRefType | null;
  linkedRefId: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/**
 * Validate + sanitize raw workflow output into a Prisma-ready ai_runs create
 * input. Throws AiRunValidationError on unknown enum values, missing required
 * fields, or out-of-range confidence. Cost is estimated when not provided.
 */
export function buildAiRunCreateInput(opts: BuildAiRunInputOptions): AiRunCreateInputData {
  if (typeof opts.workspaceId !== "string" || opts.workspaceId.length === 0) {
    throw new AiRunValidationError("workspaceId", opts.workspaceId, "must be a non-empty string");
  }
  if (!isAiAgent(opts.agent)) {
    throw new AiRunValidationError(
      "agent",
      opts.agent,
      `must be one of: ${AI_AGENTS.join(", ")}`
    );
  }
  if (!isAiWorkflow(opts.workflow)) {
    throw new AiRunValidationError(
      "workflow",
      opts.workflow,
      `must be one of: ${AI_WORKFLOWS.join(", ")}`
    );
  }
  if (!isAiProvider(opts.provider)) {
    throw new AiRunValidationError(
      "provider",
      opts.provider,
      `must be one of: ${AI_RUN_PROVIDERS.join(", ")}`
    );
  }
  if (typeof opts.model !== "string" || opts.model.length === 0) {
    throw new AiRunValidationError("model", opts.model, "must be a non-empty string");
  }

  const status: AiRunStatus = opts.status ?? "queued";
  if (!AI_RUN_STATUSES.includes(status)) {
    throw new AiRunValidationError(
      "status",
      status,
      `must be one of: ${AI_RUN_STATUSES.join(", ")}`
    );
  }

  let confidence: number | null = null;
  if (opts.confidence !== undefined && opts.confidence !== null) {
    if (
      typeof opts.confidence !== "number" ||
      !Number.isFinite(opts.confidence) ||
      opts.confidence < 0 ||
      opts.confidence > 1
    ) {
      throw new AiRunValidationError(
        "confidence",
        opts.confidence,
        "must be a finite number in [0, 1]"
      );
    }
    confidence = opts.confidence;
  }

  const usage: LLMUsage = opts.usage ?? { inputTokens: 0, outputTokens: 0 };
  const inputTokens = clampNonNegativeInt(usage.inputTokens);
  const outputTokens = clampNonNegativeInt(usage.outputTokens);

  let costUsd: number;
  if (typeof opts.costUsd === "number" && Number.isFinite(opts.costUsd) && opts.costUsd >= 0) {
    costUsd = opts.costUsd;
  } else {
    costUsd = estimateCostUsd(opts.provider, opts.model, { inputTokens, outputTokens });
  }

  const linkedRefType = opts.linkedRefType ?? null;
  const linkedRefId = opts.linkedRefId ?? null;
  if (linkedRefType !== null && !AI_RUN_LINKED_REF_TYPES.includes(linkedRefType)) {
    throw new AiRunValidationError(
      "linkedRefType",
      linkedRefType,
      `must be one of: ${AI_RUN_LINKED_REF_TYPES.join(", ")}`
    );
  }
  if (linkedRefType !== null && (typeof linkedRefId !== "string" || linkedRefId.length === 0)) {
    throw new AiRunValidationError(
      "linkedRefId",
      linkedRefId,
      "required (non-empty string) when linkedRefType is set"
    );
  }
  if (linkedRefType === null && linkedRefId !== null) {
    throw new AiRunValidationError(
      "linkedRefType",
      linkedRefType,
      "required when linkedRefId is set"
    );
  }

  return {
    workspaceId: opts.workspaceId,
    agent: opts.agent,
    workflow: opts.workflow,
    provider: opts.provider,
    model: opts.model,
    status,
    prompt: opts.prompt === undefined ? null : sanitizeAiRunPayload(opts.prompt),
    inputs: sanitizeAiRunPayload(opts.inputs ?? {}),
    outputs: opts.outputs === undefined ? null : sanitizeAiRunPayload(opts.outputs),
    decision: opts.decision == null ? null : String(opts.decision),
    confidence,
    inputTokens,
    outputTokens,
    costUsd,
    requestId: opts.requestId == null ? null : sanitizeRequestId(opts.requestId),
    linkedRefType,
    linkedRefId,
    errorMessage: opts.errorMessage == null ? null : sanitizeString(opts.errorMessage),
    startedAt: opts.startedAt ?? null,
    finishedAt: opts.finishedAt ?? null,
  };
}

export interface BuildAiRunInputFromCompletionOptions {
  workspaceId: string;
  agent: AiAgent;
  workflow: AiWorkflow;
  prompt: LLMMessage[];
  inputs: unknown;
  result: LLMCompletionResult;
  decision?: string | null;
  confidence?: number | null;
  linkedRefType?: AiRunLinkedRefType | null;
  linkedRefId?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

/**
 * Convenience helper: take an LLMCompletionResult and pre-fill provider /
 * model / usage / costUsd / requestId from its meta. Status is forced to
 * "succeeded"; callers handling failures should use buildAiRunCreateInput
 * with status: "failed" + errorMessage.
 */
export function buildAiRunCreateInputFromCompletion(
  opts: BuildAiRunInputFromCompletionOptions
): AiRunCreateInputData {
  return buildAiRunCreateInput({
    workspaceId: opts.workspaceId,
    agent: opts.agent,
    workflow: opts.workflow,
    provider: opts.result.meta.provider,
    model: opts.result.meta.model,
    status: "succeeded",
    prompt: opts.prompt,
    inputs: opts.inputs,
    outputs: { content: opts.result.content, finishReason: opts.result.finishReason },
    decision: opts.decision ?? null,
    confidence: opts.confidence ?? null,
    usage: opts.result.usage,
    costUsd: opts.result.costUsd,
    requestId: opts.result.meta.requestId,
    linkedRefType: opts.linkedRefType ?? null,
    linkedRefId: opts.linkedRefId ?? null,
    startedAt: opts.startedAt ?? null,
    finishedAt: opts.finishedAt ?? null,
  });
}

// ---- internals -----------------------------------------------------------

function clampNonNegativeInt(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function isAiAgent(value: unknown): value is AiAgent {
  return typeof value === "string" && (AI_AGENTS as readonly string[]).includes(value);
}

function isAiWorkflow(value: unknown): value is AiWorkflow {
  return typeof value === "string" && (AI_WORKFLOWS as readonly string[]).includes(value);
}

function isAiProvider(value: unknown): value is LLMProviderName {
  return typeof value === "string" && (AI_RUN_PROVIDERS as readonly string[]).includes(value);
}

function sanitizeRequestId(value: unknown): string {
  return sanitizeString(String(value)).slice(0, 256);
}
