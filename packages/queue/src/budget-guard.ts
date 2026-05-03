// AdDroid OSS — budget_guard cron handler (Implementation item).
//
// 1 ティック分の budget_guard ワークフローを実装する:
//
//   1. 対象 ad_account を解決する。未登録なら no_account で抜ける。
//   2. policy が未設定 (= null) のときは fail-closed で `policy_missing` を
//      返し、AI を呼ばず ai_runs も書かない。
//   3. policy + spend context から決定論的に 5 つのアラート規則
//      (daily_budget_80 / monthly_pace / day_over_day / no_conversions /
//      auto_pause_policy) を評価し、必要に応じて `auto_pause` 候補を組み立てる。
//   4. audit agent (`BudgetGuardAuditRunner`) に候補と safe categories を渡し、
//      `safe | requires_approval | dangerous` 分類と `auto_approved |
//      approval_required | auto_blocked` 決定を生成する。
//   5. 結果を ai_runs に永続化し、cron_runs.output 用 summary を返す。
//
// 設計原則:
//   - Prisma / pg-boss / LLM Provider を直接 import しない。すべて injected
//     interface 経由。テストは in-memory fake で完結する。
//   - しきい値判定は本ファイル内の純粋関数 `evaluateBudgetGuardPolicy` に閉じる。
//     呼び出し側 (apps/worker) は policy YAML と performance_snapshots から
//     spend context を組み立てて渡す。
//   - AI 失敗時でも ai_runs は status="failed" で書き、cron_run を ai_failed
//     に倒す (= GitOps state は腐らない)。
//   - policy 欠落 (= ops repo に workflows/budget-guard.yaml が無い、または
//     opsRepo 自体が未指定) は **fail-closed**: ai_runs を書かず、Meta も
//     操作しない。`policy_missing` 状態を summary + cron_runs.output に残し、
//     UI から「Configure budget guard」を促す。

import type { AiRunCreateInputData } from "@addroid/llm-provider";
import type { DailyReportAdAccountSnapshot } from "./daily-report.js";
import {
  combineApprovalClassifications,
  combineApprovalDecisions,
  evaluateApprovalPolicy,
  unionDangerousCategories,
  type ApprovalClassification,
  type ApprovalDecision,
  type ExecutionMode,
} from "./execution-mode.js";

export type BudgetGuardExecutionMode = ExecutionMode;

export type BudgetGuardClassification = ApprovalClassification;
export type BudgetGuardDecision = ApprovalDecision;

export type BudgetGuardRunStatus =
  | "succeeded"
  | "no_account"
  | "policy_missing"
  | "ai_failed";

export interface BudgetGuardCandidateAction {
  /** どの階層への自動 pause を検討しているか。 */
  hierarchy: "account" | "campaign" | "adset" | "ad";
  /** Meta の対象 ID または name。 */
  target: string;
  /** 候補カテゴリ。budget_guard は通常 "auto_pause" 等を渡す。 */
  category: string;
  /** 1 行の説明。 */
  description: string;
}

// ---------------------------------------------------------------------
// Policy + spend context (deterministic threshold evaluation)
// ---------------------------------------------------------------------

/**
 * Alert thresholds. すべて optional / 0 のとき「無効」として扱う
 * (= そのルールでアラートを出さない)。
 */
export interface BudgetGuardPolicyAlerts {
  /** 当日 spend / dailyBudget >= ratio で alert。例: 0.8 = 80%。 */
  dailyBudgetAlertRatio?: number;
  /** MTD spend / 月予算 prorated >= ratio で alert。例: 1.0 = ペース 100%。 */
  monthlyPaceRatio?: number;
  /** todaySpend / yesterdaySpend >= ratio で alert。例: 1.5 = 前日比 150%。 */
  dayOverDayRatio?: number;
  /** 当日 conversions == 0 かつ todaySpend >= 値 で alert (currency major)。 */
  noConversionsSpendMin?: number;
}

/**
 * auto_pause_policy. enabled=false のときは候補を生成しない (= alert のみ)。
 * 候補が生成された場合のみ audit agent に渡る `safeCategories` も同期される。
 */
export interface BudgetGuardAutoPausePolicy {
  enabled: boolean;
  /** 当日 spend / dailyBudget >= ratio で auto_pause 候補化 (例: 1.5)。 */
  minDailyBudgetRatio?: number;
  /** todaySpend / yesterdaySpend >= ratio で auto_pause 候補化 (例: 2.0)。 */
  minDayOverDayRatio?: number;
  /**
   * audit agent が auto_approve できる safe operation カテゴリ。
   * 既定空 = 何も自動承認しない。
   */
  safeCategories?: string[];
}

export interface BudgetGuardPolicy {
  alerts: BudgetGuardPolicyAlerts;
  autoPause?: BudgetGuardAutoPausePolicy;
}

export interface BudgetGuardSpendContext {
  /** 当日 spend (currency major)。 */
  todaySpend: number;
  /** 前日 spend (currency major)。 */
  yesterdaySpend: number;
  /** 当日 conversions。 */
  todayConversions: number;
  /** MTD (= 月初〜当日含む) spend (currency major)。 */
  monthToDateSpend: number;
  /** 設定された日次予算 (currency major)。0 = 未設定。 */
  dailyBudget: number;
  /** 設定された月次予算 (currency major)。0 = 未設定。 */
  monthlyBudget: number;
  /** UTC day-of-month (1..31)。月予算 proration 用。 */
  dayOfMonth: number;
  /** UTC days-in-current-month (28..31)。 */
  daysInMonth: number;
  /** Optional: account 側の通貨 (UI / message 用)。 */
  currency?: string;
}

export type BudgetGuardAlertRule =
  | "daily_budget_80"
  | "monthly_pace"
  | "day_over_day"
  | "no_conversions"
  | "auto_pause_policy";

export type BudgetGuardAlertSeverity = "info" | "warn" | "trigger";

export interface BudgetGuardAlert {
  rule: BudgetGuardAlertRule;
  severity: BudgetGuardAlertSeverity;
  message: string;
  /** 計測値 (e.g., spend ratio, day-over-day ratio)。 */
  observedValue: number;
  /** 該当 rule のしきい値。 */
  threshold: number;
}

export interface BudgetGuardEvaluation {
  alerts: BudgetGuardAlert[];
  candidateActions: BudgetGuardCandidateAction[];
  /** auto_pause_policy.safeCategories を反映した結果 (audit agent に渡す)。 */
  safeCategories: string[];
}

/**
 * `evaluateBudgetGuardPolicy` — 純粋関数。
 *
 * 5 種類のアラート規則を評価し、auto_pause 候補と safeCategories を派生させる。
 *   1. daily_budget_80   — alerts.dailyBudgetAlertRatio (e.g., 0.8) を超えたら warn alert。
 *   2. monthly_pace      — alerts.monthlyPaceRatio を超えたら warn alert。
 *   3. day_over_day      — alerts.dayOverDayRatio を超えたら warn alert。
 *   4. no_conversions    — alerts.noConversionsSpendMin を超えて CV=0 なら warn alert。
 *   5. auto_pause_policy — autoPause.enabled=true かつ minDailyBudgetRatio /
 *      minDayOverDayRatio を超えたら trigger alert + `auto_pause` 候補を生成。
 *
 * 設計原則:
 *   - すべての rule で「観測値 >= threshold」を判定。判定不能 (e.g.,
 *     dailyBudget=0) なら静かに skip する。
 *   - alerts のみが発生する rule (1〜4) は候補を生成しない (= AI に「OK」を
 *     確認させる)。auto_pause_policy だけが Meta 側 mutation の候補を作る。
 *   - alerts と candidates は両方とも audit agent の input に含めて評価される
 *     (呼び出し側 = orchestrator が組み立てる)。
 *   - 候補 hierarchy は account 既定。campaign / adset / ad 単位の判定は
 *     spend context を node 別に渡す将来拡張で対応する。
 */
export function evaluateBudgetGuardPolicy(
  accountTarget: string,
  policy: BudgetGuardPolicy,
  ctx: BudgetGuardSpendContext
): BudgetGuardEvaluation {
  const alerts: BudgetGuardAlert[] = [];
  const candidateActions: BudgetGuardCandidateAction[] = [];

  // --- 1) daily_budget_80 ------------------------------------------------
  const dailyRatio = numericThreshold(policy.alerts.dailyBudgetAlertRatio);
  if (dailyRatio > 0 && ctx.dailyBudget > 0) {
    const observed = ctx.todaySpend / ctx.dailyBudget;
    if (observed >= dailyRatio) {
      alerts.push({
        rule: "daily_budget_80",
        severity: "warn",
        message: formatRatioMessage(
          "daily budget consumption",
          observed,
          dailyRatio,
          ctx.currency
        ),
        observedValue: round6(observed),
        threshold: round6(dailyRatio),
      });
    }
  }

  // --- 2) monthly_pace ---------------------------------------------------
  const monthlyRatio = numericThreshold(policy.alerts.monthlyPaceRatio);
  if (
    monthlyRatio > 0 &&
    ctx.monthlyBudget > 0 &&
    ctx.daysInMonth > 0 &&
    ctx.dayOfMonth >= 1 &&
    ctx.dayOfMonth <= ctx.daysInMonth
  ) {
    const prorated = (ctx.monthlyBudget * ctx.dayOfMonth) / ctx.daysInMonth;
    if (prorated > 0) {
      const observed = ctx.monthToDateSpend / prorated;
      if (observed >= monthlyRatio) {
        alerts.push({
          rule: "monthly_pace",
          severity: "warn",
          message: formatRatioMessage(
            "monthly budget pace",
            observed,
            monthlyRatio,
            ctx.currency
          ),
          observedValue: round6(observed),
          threshold: round6(monthlyRatio),
        });
      }
    }
  }

  // --- 3) day_over_day ---------------------------------------------------
  const dodRatio = numericThreshold(policy.alerts.dayOverDayRatio);
  if (dodRatio > 0 && ctx.yesterdaySpend > 0) {
    const observed = ctx.todaySpend / ctx.yesterdaySpend;
    if (observed >= dodRatio) {
      alerts.push({
        rule: "day_over_day",
        severity: "warn",
        message: formatRatioMessage(
          "day-over-day spend ratio",
          observed,
          dodRatio,
          ctx.currency
        ),
        observedValue: round6(observed),
        threshold: round6(dodRatio),
      });
    }
  }

  // --- 4) no_conversions -------------------------------------------------
  const noCvMin = numericThreshold(policy.alerts.noConversionsSpendMin);
  if (noCvMin > 0 && ctx.todayConversions === 0 && ctx.todaySpend >= noCvMin) {
    alerts.push({
      rule: "no_conversions",
      severity: "warn",
      message:
        `no-conversions spend reached ${formatCurrency(ctx.todaySpend, ctx.currency)}` +
        ` (>= threshold ${formatCurrency(noCvMin, ctx.currency)})`,
      observedValue: round6(ctx.todaySpend),
      threshold: round6(noCvMin),
    });
  }

  // --- 5) auto_pause_policy ---------------------------------------------
  let safeCategories: string[] = [];
  const autoPause = policy.autoPause;
  if (autoPause && autoPause.enabled) {
    safeCategories = dedupe(autoPause.safeCategories ?? []);
    const triggers: string[] = [];
    const dailyTrigger = numericThreshold(autoPause.minDailyBudgetRatio);
    if (dailyTrigger > 0 && ctx.dailyBudget > 0) {
      const observed = ctx.todaySpend / ctx.dailyBudget;
      if (observed >= dailyTrigger) {
        triggers.push(
          `daily spend ratio ${formatRatio(observed)} >= ${formatRatio(dailyTrigger)}`
        );
      }
    }
    const dodTrigger = numericThreshold(autoPause.minDayOverDayRatio);
    if (dodTrigger > 0 && ctx.yesterdaySpend > 0) {
      const observed = ctx.todaySpend / ctx.yesterdaySpend;
      if (observed >= dodTrigger) {
        triggers.push(
          `day-over-day ratio ${formatRatio(observed)} >= ${formatRatio(dodTrigger)}`
        );
      }
    }
    if (triggers.length > 0) {
      const description = `auto_pause candidate: ${triggers.join(" and ")}`;
      candidateActions.push({
        hierarchy: "account",
        target: accountTarget,
        category: "auto_pause",
        description,
      });
      const observedDailyRatio =
        ctx.dailyBudget > 0 ? ctx.todaySpend / ctx.dailyBudget : 0;
      alerts.push({
        rule: "auto_pause_policy",
        severity: "trigger",
        message: description,
        observedValue: round6(observedDailyRatio),
        threshold: round6(dailyTrigger > 0 ? dailyTrigger : (dodTrigger ?? 0)),
      });
    }
  }

  return { alerts, candidateActions, safeCategories };
}

function numericThreshold(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string" || v.length === 0) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function round6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

function formatRatio(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  return `${(n * 100).toFixed(1)}%`;
}

function formatCurrency(amount: number, currency?: string): string {
  if (!Number.isFinite(amount)) return `0 ${currency ?? ""}`.trim();
  const fixed = amount.toFixed(2);
  return currency ? `${fixed} ${currency}` : fixed;
}

function formatRatioMessage(
  label: string,
  observed: number,
  threshold: number,
  currency: string | undefined
): string {
  const _ = currency; // keep currency in signature for future localization
  return `${label} reached ${formatRatio(observed)} (>= threshold ${formatRatio(threshold)})`;
}

// ---------------------------------------------------------------------
// Store + audit runner (unchanged)
// ---------------------------------------------------------------------

export interface BudgetGuardStore {
  findAdAccount(input: {
    workspaceId: string;
    accountKey: string;
  }): Promise<DailyReportAdAccountSnapshot | null>;
  /**
   * audit agent の sanitized ai_runs 行を 1 行 insert する。
   * 呼び出し側 (apps/worker) は `prisma.aiRun.create({ data })` を実行する。
   */
  createAiRun(data: AiRunCreateInputData): Promise<{ id: string }>;
}

export interface BudgetGuardAuditInput {
  accountId: string;
  mode: BudgetGuardExecutionMode;
  /** budget_guard policy が許す safe operation カテゴリ (空 = fail-closed)。 */
  safeCategories: string[];
  /** 評価対象の auto_pause / alert 候補 (deterministic 段階で組み立てた結果)。 */
  candidateActions: BudgetGuardCandidateAction[];
}

export interface BudgetGuardAuditOutput {
  classification: BudgetGuardClassification;
  dangerousCategories: string[];
  rationale: string;
}

export interface BudgetGuardAuditResult {
  /** Prisma-ready ai_runs row (sanitize 済み)。 */
  aiRunInput: AiRunCreateInputData;
  /** 成功時のみ非 null。 */
  output: BudgetGuardAuditOutput | null;
  /** audit agent の決定。失敗時 null。 */
  decision: BudgetGuardDecision | null;
  /** sanitized error message (失敗時のみ)。 */
  error: string | null;
}

export interface BudgetGuardAuditRunner {
  run(input: BudgetGuardAuditInput): Promise<BudgetGuardAuditResult>;
}

export interface BudgetGuardSummary {
  status: BudgetGuardRunStatus;
  workspaceId: string;
  accountKey: string;
  /** 解決済み ad_account.id (no_account なら null)。 */
  accountId: string | null;
  mode: BudgetGuardExecutionMode;
  /** 永続化された ai_run.id。account 未解決 / policy 未設定なら null。 */
  aiRunId: string | null;
  /**
   * 最終的な分類 (AI と決定論的ポリシーゲートを fail-closed で合成)。
   * approval_records / UI はこの値を信頼する。
   */
  classification: BudgetGuardClassification | null;
  /**
   * 最終的な決定 (AI と決定論的ポリシーゲートを fail-closed で合成)。
   * `auto_approved` は mode=auto_apply で全 candidate.category が
   * `safeCategories` に含まれる場合のみ可能。
   */
  decision: BudgetGuardDecision | null;
  /** 該当した dangerous categories (AI + policy の dedup union)。 */
  dangerousCategories: string[];
  /** ポリシーゲートが付与した 1 行ずつの理由 (UI / audit_logs metadata 用)。 */
  policyReasons: string[];
  /** 評価した候補数 (UI / cron_runs.output 用)。 */
  candidateCount: number;
  /** 評価で発生した alert (rule + observed/threshold)。 */
  alerts: BudgetGuardAlert[];
  errorMessage?: string;
}

export interface RunBudgetGuardOptions {
  workspaceId: string;
  mode: BudgetGuardExecutionMode;
  accountKey: string;
  /**
   * 主経路: policy + spendContext を渡すと `evaluateBudgetGuardPolicy` を内部で
   * 実行して候補と safeCategories を派生させる。
   * `policy === null` を明示すると fail-closed (`policy_missing`) で抜ける
   * (= worker が ops repo に workflows/budget-guard.yaml を見つけられなかった
   * ケース)。
   * undefined のときは旧 API (`safeCategories` / `candidateActions` 直接渡し)
   * にフォールバックする (skeleton 相当のテストで使用)。
   */
  policy?: BudgetGuardPolicy | null;
  spendContext?: BudgetGuardSpendContext;
  /** 旧 API: 直接渡しの safe operation categories (policy 未指定時のみ適用)。 */
  safeCategories?: string[];
  /** 旧 API: 直接渡しの auto_pause 候補 (policy 未指定時のみ適用)。 */
  candidateActions?: BudgetGuardCandidateAction[];
  store: BudgetGuardStore;
  runner: BudgetGuardAuditRunner;
  /** test seam: 現在時刻。 */
  now?: () => Date;
}

/**
 * `runBudgetGuardOnce` — budget_guard cron handler の純粋なオーケストレータ。
 * pg-boss handler は本関数を 1 回呼び、戻り値を `cron_runs.output` に書く。
 */
export async function runBudgetGuardOnce(
  opts: RunBudgetGuardOptions
): Promise<BudgetGuardSummary> {
  const account = await opts.store.findAdAccount({
    workspaceId: opts.workspaceId,
    accountKey: opts.accountKey,
  });
  if (!account) {
    return {
      status: "no_account",
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: null,
      mode: opts.mode,
      aiRunId: null,
      classification: null,
      decision: null,
      dangerousCategories: [],
      policyReasons: [],
      candidateCount: 0,
      alerts: [],
      errorMessage: `ad_account '${opts.accountKey}' not found in workspace`,
    };
  }

  // --- fail-closed: policy が明示的に null (= ops repo に未配置) ---------
  if (opts.policy === null) {
    return {
      status: "policy_missing",
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      mode: opts.mode,
      aiRunId: null,
      classification: null,
      decision: null,
      dangerousCategories: [],
      policyReasons: [],
      candidateCount: 0,
      alerts: [],
      errorMessage:
        "budget_guard policy missing: configure workflows/budget-guard.yaml in the ops repo",
    };
  }

  // --- 候補 + safeCategories の決定 -------------------------------------
  let candidateActions: BudgetGuardCandidateAction[];
  let safeCategories: string[];
  let alerts: BudgetGuardAlert[];
  if (opts.policy && opts.spendContext) {
    const evaluation = evaluateBudgetGuardPolicy(
      account.metaAccountId ?? account.key,
      opts.policy,
      opts.spendContext
    );
    candidateActions = evaluation.candidateActions;
    safeCategories = evaluation.safeCategories;
    alerts = evaluation.alerts;
  } else {
    candidateActions = opts.candidateActions ?? [];
    safeCategories = opts.safeCategories ?? [];
    alerts = [];
  }

  const auditResult = await opts.runner.run({
    accountId: account.metaAccountId ?? account.key,
    mode: opts.mode,
    safeCategories,
    candidateActions,
  });
  const aiRunRow = await opts.store.createAiRun(auditResult.aiRunInput);

  if (!auditResult.output || !auditResult.decision) {
    return {
      status: "ai_failed",
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      mode: opts.mode,
      aiRunId: aiRunRow.id,
      classification: null,
      decision: null,
      dangerousCategories: [],
      policyReasons: [],
      candidateCount: candidateActions.length,
      alerts,
      errorMessage: auditResult.error ?? "audit agent failed",
    };
  }

  // --- 決定論的な承認ポリシーゲート (this implementation) ---------------
  // AI の audit 結果が `auto_approved` でも、契約境界
  // (report_only は Meta 不変更 / auto_apply は safe operations のみ /
  //  dangerous categories は必ず PR 承認) を fail-closed で再評価する。
  const policyResult = evaluateApprovalPolicy({
    mode: opts.mode,
    candidates: candidateActions.map((c) => ({ category: c.category })),
    safeCategories,
  });
  const finalDecision = combineApprovalDecisions(
    auditResult.decision,
    policyResult.decision
  );
  const finalClassification = combineApprovalClassifications(
    auditResult.output.classification,
    policyResult.classification
  );
  const finalDangerousCategories = unionDangerousCategories(
    auditResult.output.dangerousCategories,
    policyResult.dangerousCategories
  );

  return {
    status: "succeeded",
    workspaceId: opts.workspaceId,
    accountKey: opts.accountKey,
    accountId: account.id,
    mode: opts.mode,
    aiRunId: aiRunRow.id,
    classification: finalClassification,
    decision: finalDecision,
    dangerousCategories: finalDangerousCategories,
    policyReasons: policyResult.reasons,
    candidateCount: candidateActions.length,
    alerts,
  };
}
