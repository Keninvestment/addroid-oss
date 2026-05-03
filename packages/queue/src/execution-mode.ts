// AdDroid OSS — execution mode + approval policy gate (Implementation item).
//
// AI workflows (`improvement_pr` / `budget_guard`) は audit agent (LLM) に
// `safe | requires_approval | dangerous` 分類と
// `auto_approved | approval_required | auto_blocked` 決定を返させるが、AI 単独
// では「report_only は Meta を絶対に変更しない」「auto_apply は事前承認済みの
// safe operation のみ」「dangerous categories は必ず PR 承認を要求」という
// 契約上の境界を保証できない。
//
// 本モジュールは以下を行う純粋関数群を提供する:
//
//   1. `evaluateApprovalPolicy({mode, candidates, safeCategories})` —
//      candidate の `category` のみを見て、決定論的に「このモードでこのカテゴリ
//      集合は auto_approved 可能か」を判定する。LLM を呼ばない。
//   2. `combineApprovalDecisions(ai, policy)` — AI と policy の結果を fail-closed
//      で合成する (= 厳しい方が勝つ)。
//
// 厳しさ順: `auto_blocked` > `approval_required` > `auto_approved`
//          `dangerous` > `requires_approval` > `safe`
//
// 設計原則:
//   - 入力は category 文字列のみで完結させる (proposal の hierarchy / target /
//     rationale は LLM が見るが、ポリシーゲートは見ない)。
//   - dangerous categories の判定は llm-provider の正本 `DANGEROUS_CHANGE_CATEGORIES`
//     を参照する (重複定義を避ける)。
//   - 結果は副作用フリーで、orchestrator が audit_logs.metadata に reasons を
//     書けるように `reasons: string[]` を付ける。
//   - AI の自由意志を尊重するため、AI が policy より厳しい判断 (例: AI が safe な
//     カテゴリでも独自に dangerous と分類する) を返した場合はそれを優先する。

import { DANGEROUS_CHANGE_CATEGORIES } from "@addroid/llm-provider";

export type ExecutionMode = "report_only" | "proposal" | "auto_apply";

export type ApprovalDecision =
  | "auto_approved"
  | "approval_required"
  | "auto_blocked";

export type ApprovalClassification =
  | "safe"
  | "requires_approval"
  | "dangerous";

/**
 * 評価対象の最小単位。proposal や budget_guard candidate を `category` 1 軸に
 * 投影した形。orchestrator は `proposals.map(p => ({category: p.category}))`
 * のように渡すだけでよい。
 */
export interface ApprovalCandidate {
  category: string;
}

export interface ApprovalPolicyInput {
  mode: ExecutionMode;
  candidates: ApprovalCandidate[];
  /** auto_apply モードで自動承認を許す category 集合 (policy YAML 由来)。 */
  safeCategories: string[];
}

export interface ApprovalPolicyResult {
  decision: ApprovalDecision;
  classification: ApprovalClassification;
  /** candidates に含まれていた dangerous categories の dedup リスト。 */
  dangerousCategories: string[];
  /** 1 行ずつのサニタイズ済み理由 (audit_logs.metadata + UI 表示用)。 */
  reasons: string[];
}

const DANGEROUS_SET: ReadonlySet<string> = new Set<string>(
  DANGEROUS_CHANGE_CATEGORIES
);

export function isDangerousCategory(category: string): boolean {
  return DANGEROUS_SET.has(category);
}

const KNOWN_MODES: ReadonlySet<ExecutionMode> = new Set<ExecutionMode>([
  "report_only",
  "proposal",
  "auto_apply",
]);

/**
 * regression fix: DB / config 文字列を `ExecutionMode` に正規化する。
 *
 * 既知の値は型付きで返し、未知 / null / undefined / 非文字列はすべて null を
 * 返して呼び出し側に fail-closed の判断を委ねる (= ここで黙って "proposal" 等に
 * 倒さない)。
 */
export function normalizeExecutionMode(value: unknown): ExecutionMode | null {
  if (typeof value !== "string") return null;
  return KNOWN_MODES.has(value as ExecutionMode)
    ? (value as ExecutionMode)
    : null;
}

/**
 * regression fix: workspace mode と ad_account.modeOverride から、当該
 * ad_account に対する実効 mode を 1 つ決める。
 *
 * 優先順位:
 *   1. accountOverride が既知の値 → それを使う (workspace 値より優先)
 *   2. workspaceMode が既知の値    → それを使う
 *   3. どちらも不正                 → fail-closed で "report_only" に倒し、
 *      Meta を変更しない側に寄せる。
 *
 * `daily_report` / `budget_guard` / `improvement_pr` の cron handler、
 * `runGithubPollOnce` (fail-closed for report_only)、`runExecuteApply` (Meta
 * mutation 直前の per-account revalidation) がすべてこの 1 つの解決規則を共有
 * する (apps/worker からの旧 helper を queue 層へ集約)。
 */
export function resolveExecutionMode(
  workspaceMode: unknown,
  accountOverride: unknown
): ExecutionMode {
  const override = normalizeExecutionMode(accountOverride);
  if (override) return override;
  const workspace = normalizeExecutionMode(workspaceMode);
  if (workspace) return workspace;
  return "report_only";
}

/**
 * 決定論的な承認ゲート。LLM を呼ばず、入力のみで判定する。
 *
 * ルール (上から順に評価し、最初にマッチしたものが勝つ):
 *
 *   A. `candidates` が空 → `auto_approved` / `safe` (no-op)。
 *   B. dangerous category を 1 件以上含む:
 *       - mode=report_only → `auto_blocked` / `dangerous`
 *       - それ以外         → `approval_required` / `dangerous`
 *      (契約: "dangerous changes ... require PR approval")
 *   C. mode=report_only で B に該当しない → `auto_blocked` / `requires_approval`
 *      (契約: "report_only never mutates Meta")
 *   D. mode=proposal で B に該当しない → `approval_required` / `requires_approval`
 *      (契約: "proposal never mutates Meta before PR merge")
 *   E. mode=auto_apply:
 *       - すべての candidate.category が safeCategories に含まれる →
 *         `auto_approved` / `safe`
 *       - そうでない → `approval_required` / `requires_approval`
 *      (契約: "auto_apply only executes pre-approved safe operations")
 */
export function evaluateApprovalPolicy(
  input: ApprovalPolicyInput
): ApprovalPolicyResult {
  // A. empty candidates → vacuously safe (no operations to gate).
  if (input.candidates.length === 0) {
    return {
      decision: "auto_approved",
      classification: "safe",
      dangerousCategories: [],
      reasons: ["no candidates to evaluate"],
    };
  }

  // B. dangerous categories present → always at least approval_required.
  const dangerousCategories = collectDangerous(input.candidates);
  if (dangerousCategories.length > 0) {
    if (input.mode === "report_only") {
      return {
        decision: "auto_blocked",
        classification: "dangerous",
        dangerousCategories,
        reasons: [
          `dangerous categories present: ${dangerousCategories.join(", ")}`,
          "mode=report_only blocks all Meta-mutating proposals",
        ],
      };
    }
    return {
      decision: "approval_required",
      classification: "dangerous",
      dangerousCategories,
      reasons: [
        `dangerous categories present: ${dangerousCategories.join(", ")}`,
        "dangerous changes always require human PR approval",
      ],
    };
  }

  // C. report_only → always block (even non-dangerous proposals).
  if (input.mode === "report_only") {
    return {
      decision: "auto_blocked",
      classification: "requires_approval",
      dangerousCategories: [],
      reasons: ["mode=report_only blocks all Meta-mutating proposals"],
    };
  }

  // D. proposal → human approval required at PR merge.
  if (input.mode === "proposal") {
    return {
      decision: "approval_required",
      classification: "requires_approval",
      dangerousCategories: [],
      reasons: ["mode=proposal: human approval required at PR merge"],
    };
  }

  // E. auto_apply → only safeCategories may be auto_approved.
  const safeSet = new Set<string>(input.safeCategories);
  const unsafe: string[] = [];
  for (const c of input.candidates) {
    if (!safeSet.has(c.category) && !unsafe.includes(c.category)) {
      unsafe.push(c.category);
    }
  }
  if (unsafe.length > 0) {
    return {
      decision: "approval_required",
      classification: "requires_approval",
      dangerousCategories: [],
      reasons: [
        `mode=auto_apply: categories not in safeCategories: ${unsafe.join(", ")}`,
      ],
    };
  }
  return {
    decision: "auto_approved",
    classification: "safe",
    dangerousCategories: [],
    reasons: [
      "mode=auto_apply: all candidates are in safeCategories — auto-approve permitted",
    ],
  };
}

function collectDangerous(candidates: ApprovalCandidate[]): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    if (isDangerousCategory(c.category) && !out.includes(c.category)) {
      out.push(c.category);
    }
  }
  return out;
}

const DECISION_STRICTNESS: Record<ApprovalDecision, number> = {
  auto_approved: 0,
  approval_required: 1,
  auto_blocked: 2,
};

const CLASSIFICATION_STRICTNESS: Record<ApprovalClassification, number> = {
  safe: 0,
  requires_approval: 1,
  dangerous: 2,
};

/**
 * Fail-closed combiner — AI と policy の決定を合成して厳しい方を返す。
 *
 *   auto_blocked > approval_required > auto_approved
 */
export function combineApprovalDecisions(
  ai: ApprovalDecision,
  policy: ApprovalDecision
): ApprovalDecision {
  return DECISION_STRICTNESS[ai] >= DECISION_STRICTNESS[policy] ? ai : policy;
}

/**
 * Fail-closed combiner — AI と policy の分類を合成して厳しい方を返す。
 *
 *   dangerous > requires_approval > safe
 */
export function combineApprovalClassifications(
  ai: ApprovalClassification,
  policy: ApprovalClassification
): ApprovalClassification {
  return CLASSIFICATION_STRICTNESS[ai] >= CLASSIFICATION_STRICTNESS[policy]
    ? ai
    : policy;
}

/**
 * dangerous categories の dedup union。orchestrator が AI と policy 双方の
 * 結果を audit_logs.metadata.dangerousCategories に書く際に使う。
 */
export function unionDangerousCategories(
  a: readonly string[],
  b: readonly string[]
): string[] {
  const out: string[] = [];
  for (const v of a) {
    if (typeof v === "string" && v.length > 0 && !out.includes(v)) out.push(v);
  }
  for (const v of b) {
    if (typeof v === "string" && v.length > 0 && !out.includes(v)) out.push(v);
  }
  return out;
}
