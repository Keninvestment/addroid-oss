// AdDroid OSS — Budget Guard page (the current implementation browser regression fix).
//
// Browser test scenario `budget-guard` は `/budget` に直接アクセスし、
//   (1) budget_guard rules と auto_pause_policy 状態が見えること
//   (2) policy 欠落 (= ops repo に workflows/budget-guard.yaml 無し)
//       が「fail-closed」として表現されていること
//   (3) dangerous changes が「approval-required」ラベルで識別できること
// を期待する。
//
// データソース:
//   - `cron_schedules`           → budget_guard プリセットの enable / cron 状態
//   - `cron_runs` (budget_guard) → 直近 run の summary (alerts / candidates /
//                                  classification / decision / dangerous cats)
//   - `ai_runs`   (budget_guard) → 直近 audit agent 実行の provider/model/decision
//
// 設計原則:
//   - ガードレール「No Placeholder Data」: ダミーデータを描かない。
//     データが無い場合は明示的な空状態 / fail-closed バナーを出す。
//   - ガードレール「No Dead UI」: 本ページは read-only で書き込み操作を持たない。
//     policy 編集は ops repo (workflows/budget-guard.yaml) を介する設計境界
//     のため、UI 側に編集ボタンを置かない。
//   - sanitize-on-render: ai_runs の prompt/inputs/outputs は本ページでは
//     描画しない (一覧へのリンクは /ai を通じて辿らせる)。

import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { PageHeader } from "../../components/ui/PageHeader";
import {
  DataTable,
  type DataTableColumn,
} from "../../components/ui/DataTable";
import { EmptyState } from "../../components/ui/EmptyState";
import {
  KeyValueList,
  type KeyValueEntry,
} from "../../components/ui/KeyValueList";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { StatusDot, type StatusState } from "../../components/ui/StatusDot";
import { InlineCode } from "../../components/ui/CodeBlock";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { ensureWebWorkspace } from "../../lib/github-runtime";

export const dynamic = "force-dynamic";

type BudgetGuardRunStatus =
  | "succeeded"
  | "no_account"
  | "policy_missing"
  | "ai_failed";
type BudgetGuardClassification = "safe" | "requires_approval" | "dangerous";
type BudgetGuardDecision =
  | "auto_approved"
  | "approval_required"
  | "auto_blocked";
type BudgetGuardAlertRule =
  | "daily_budget_80"
  | "monthly_pace"
  | "day_over_day"
  | "no_conversions"
  | "auto_pause_policy";
type BudgetGuardAlertSeverity = "info" | "warn" | "trigger";

interface BudgetGuardAlert {
  rule: BudgetGuardAlertRule;
  severity: BudgetGuardAlertSeverity;
  message: string;
  observedValue: number;
  threshold: number;
}

interface BudgetGuardSummary {
  status: BudgetGuardRunStatus;
  workspaceId: string;
  accountKey: string;
  accountId: string | null;
  mode: string;
  aiRunId: string | null;
  classification: BudgetGuardClassification | null;
  decision: BudgetGuardDecision | null;
  dangerousCategories: string[];
  policyReasons: string[];
  candidateCount: number;
  alerts: BudgetGuardAlert[];
  errorMessage?: string;
}

interface CronRunRow {
  id: string;
  name: string;
  state: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
  output: unknown;
}

interface AiRunRow {
  id: string;
  agent: string;
  provider: string;
  model: string;
  status: string;
  decision: string | null;
  confidence: number | null;
  inputTokens: number;
  outputTokens: number;
  errorMessage: string | null;
  createdAt: Date;
}

interface ScheduleRow {
  name: string;
  cron: string;
  enabled: boolean;
  lastRunState: string | null;
  nextRunAt: Date | null;
}

interface AdAccountTimeZoneRow {
  workspaceId: string;
  key: string;
  timezoneName: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

const VALID_STATUS = new Set<BudgetGuardRunStatus>([
  "succeeded",
  "no_account",
  "policy_missing",
  "ai_failed",
]);

const VALID_CLASSIFICATION = new Set<BudgetGuardClassification>([
  "safe",
  "requires_approval",
  "dangerous",
]);

const VALID_DECISION = new Set<BudgetGuardDecision>([
  "auto_approved",
  "approval_required",
  "auto_blocked",
]);

const VALID_ALERT_RULE = new Set<BudgetGuardAlertRule>([
  "daily_budget_80",
  "monthly_pace",
  "day_over_day",
  "no_conversions",
  "auto_pause_policy",
]);

const VALID_ALERT_SEVERITY = new Set<BudgetGuardAlertSeverity>([
  "info",
  "warn",
  "trigger",
]);

function readAlert(v: unknown): BudgetGuardAlert | null {
  if (!isRecord(v)) return null;
  if (typeof v.rule !== "string" || !VALID_ALERT_RULE.has(v.rule as BudgetGuardAlertRule)) {
    return null;
  }
  if (
    typeof v.severity !== "string" ||
    !VALID_ALERT_SEVERITY.has(v.severity as BudgetGuardAlertSeverity)
  ) {
    return null;
  }
  return {
    rule: v.rule as BudgetGuardAlertRule,
    severity: v.severity as BudgetGuardAlertSeverity,
    message: readString(v.message),
    observedValue: readNumber(v.observedValue),
    threshold: readNumber(v.threshold),
  };
}

function parseBudgetGuardSummary(output: unknown): BudgetGuardSummary | null {
  if (!isRecord(output)) return null;
  if (
    typeof output.status !== "string" ||
    !VALID_STATUS.has(output.status as BudgetGuardRunStatus) ||
    typeof output.workspaceId !== "string" ||
    typeof output.accountKey !== "string"
  ) {
    return null;
  }
  const classificationRaw = readString(output.classification);
  const classification =
    classificationRaw && VALID_CLASSIFICATION.has(classificationRaw as BudgetGuardClassification)
      ? (classificationRaw as BudgetGuardClassification)
      : null;
  const decisionRaw = readString(output.decision);
  const decision =
    decisionRaw && VALID_DECISION.has(decisionRaw as BudgetGuardDecision)
      ? (decisionRaw as BudgetGuardDecision)
      : null;
  const dangerousCategories = Array.isArray(output.dangerousCategories)
    ? output.dangerousCategories.filter((x): x is string => typeof x === "string")
    : [];
  const policyReasons = Array.isArray(output.policyReasons)
    ? output.policyReasons.filter((x): x is string => typeof x === "string")
    : [];
  const alerts = Array.isArray(output.alerts)
    ? output.alerts
        .map(readAlert)
        .filter((x): x is BudgetGuardAlert => x !== null)
    : [];
  return {
    status: output.status as BudgetGuardRunStatus,
    workspaceId: output.workspaceId,
    accountKey: output.accountKey,
    accountId: typeof output.accountId === "string" ? output.accountId : null,
    mode: readString(output.mode, "report_only"),
    aiRunId: typeof output.aiRunId === "string" ? output.aiRunId : null,
    classification,
    decision,
    dangerousCategories,
    policyReasons,
    candidateCount: readNumber(output.candidateCount),
    alerts,
    ...(typeof output.errorMessage === "string"
      ? { errorMessage: output.errorMessage }
      : {}),
  };
}

function cronStateToStatus(state: string): StatusState {
  switch (state) {
    case "success":
      return "ok";
    case "failed":
      return "error";
    case "running":
      return "info";
    default:
      return "idle";
  }
}

function cronStateLabel(state: string): string {
  const labels: Record<string, string> = {
    success: "成功",
    failed: "失敗",
    running: "実行中",
    queued: "待機中",
    ok: "成功",
    warn: "警告",
    error: "失敗",
  };
  return labels[state] ?? state;
}

function summaryStatusToState(status: BudgetGuardRunStatus): StatusState {
  switch (status) {
    case "succeeded":
      return "ok";
    case "no_account":
      return "warn";
    case "policy_missing":
      return "error";
    case "ai_failed":
      return "error";
    default:
      return "idle";
  }
}

function summaryStatusLabel(status: BudgetGuardRunStatus): string {
  const labels: Record<BudgetGuardRunStatus, string> = {
    succeeded: "チェック済み",
    no_account: "対象なし",
    policy_missing: "ルール未設定",
    ai_failed: "AI判断失敗",
  };
  return labels[status] ?? status;
}

function classificationToState(c: BudgetGuardClassification | null): StatusState {
  switch (c) {
    case "dangerous":
      return "error";
    case "requires_approval":
      return "warn";
    case "safe":
      return "idle";
    default:
      return "idle";
  }
}

function classificationLabel(c: BudgetGuardClassification | null): string {
  if (c === "dangerous") return "高リスク";
  if (c === "requires_approval") return "承認が必要";
  if (c === "safe") return "低リスク";
  return "—";
}

function decisionToState(d: BudgetGuardDecision | null): StatusState {
  switch (d) {
    case "auto_approved":
      return "idle";
    case "approval_required":
      return "warn";
    case "auto_blocked":
      return "error";
    default:
      return "idle";
  }
}

function decisionLabel(d: BudgetGuardDecision | null): string {
  if (d === "auto_approved") return "自動承認";
  if (d === "approval_required") return "承認が必要";
  if (d === "auto_blocked") return "自動ブロック";
  return "—";
}

function modeToState(mode: string): StatusState {
  switch (mode) {
    case "auto_apply":
      return "warn";
    case "proposal":
      return "info";
    case "report_only":
    default:
      return "idle";
  }
}

function severityLabel(severity: BudgetGuardAlertSeverity): string {
  if (severity === "trigger") return "対応が必要";
  if (severity === "warn") return "警告";
  return "情報";
}

function alertSeverityToState(severity: BudgetGuardAlertSeverity): StatusState {
  switch (severity) {
    case "trigger":
      return "error";
    case "warn":
      return "warn";
    case "info":
    default:
      return "info";
  }
}

function aiRunStatusState(status: string): StatusState {
  switch (status) {
    case "succeeded":
      return "ok";
    case "failed":
      return "error";
    case "running":
      return "info";
    case "queued":
    default:
      return "idle";
  }
}

function aiRunStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    succeeded: "成功",
    failed: "失敗",
    running: "実行中",
    queued: "待機中",
  };
  return labels[status] ?? status;
}

function formatRatio(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function formatRule(rule: BudgetGuardAlertRule): string {
  switch (rule) {
    case "daily_budget_80":
      return "daily_budget";
    case "monthly_pace":
      return "monthly_pace";
    case "day_over_day":
      return "day_over_day";
    case "no_conversions":
      return "no_conversions";
    case "auto_pause_policy":
      return "auto_pause_policy";
  }
}

export default async function BudgetGuardPage() {
  let runs: CronRunRow[] = [];
  let aiRuns: AiRunRow[] = [];
  let schedules: ScheduleRow[] = [];
  let adAccountTimeZones: AdAccountTimeZoneRow[] = [];
  let dbReady = true;
  try {
    const workspace = await ensureWebWorkspace();
    [runs, aiRuns, schedules, adAccountTimeZones] = await Promise.all([
      prisma.cronRun.findMany({
        where: {
          name: "budget_guard",
          schedule: { is: { workspaceId: workspace.id } },
        },
        orderBy: { startedAt: "desc" },
        take: 25,
        select: {
          id: true,
          name: true,
          state: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          errorMessage: true,
          output: true,
        },
      }),
      prisma.aiRun.findMany({
        where: { workspaceId: workspace.id, workflow: "budget_guard" },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true,
          agent: true,
          provider: true,
          model: true,
          status: true,
          decision: true,
          confidence: true,
          inputTokens: true,
          outputTokens: true,
          errorMessage: true,
          createdAt: true,
        },
      }),
      prisma.cronSchedule.findMany({
        where: { workspaceId: workspace.id, name: "budget_guard" },
        select: {
          name: true,
          cron: true,
          enabled: true,
          lastRunState: true,
          nextRunAt: true,
        },
      }),
      prisma.adAccount.findMany({
        where: { workspaceId: workspace.id, active: true },
        select: { workspaceId: true, key: true, timezoneName: true },
      }),
    ]);
  } catch {
    dbReady = false;
  }

  const parsedSummaries = runs
    .map((r) => ({ run: r, summary: parseBudgetGuardSummary(r.output) }))
    .filter(
      (x): x is { run: CronRunRow; summary: BudgetGuardSummary } =>
        x.summary !== null
    );

  const latestSummary = parsedSummaries[0] ?? null;
  const policyMissing = latestSummary?.summary.status === "policy_missing";

  // policy_missing は最新 run だけでなく履歴の中でも fail-closed として扱う
  // (ops repo に YAML 未配置のままになっている可能性を識別するため)。
  const anyPolicyMissing = parsedSummaries.some(
    ({ summary }) => summary.status === "policy_missing"
  );

  const runsCount = runs.length;
  const aiRunsCount = aiRuns.length;
  const scheduleRow = schedules[0] ?? null;
  const scheduleView: ScheduleRow | null = scheduleRow;
  const timeZoneByAccount = new Map(
    adAccountTimeZones.map((row) => [`${row.workspaceId}:${row.key}`, row.timezoneName])
  );
  const accountTimeZone = (summary: BudgetGuardSummary | null): string | null =>
    summary ? timeZoneByAccount.get(`${summary.workspaceId}:${summary.accountKey}`) ?? null : null;
  const pageDisplayTimeZone = resolveDisplayTimeZone(accountTimeZone(latestSummary?.summary ?? null));
  const runTimeZone = (row: CronRunRow): string => {
    const summary = parseBudgetGuardSummary(row.output);
    return resolveDisplayTimeZone(accountTimeZone(summary), pageDisplayTimeZone);
  };

  const runColumns: DataTableColumn<CronRunRow>[] = [
    {
      header: "開始日時",
      cell: (row) => formatDateTime(row.startedAt, { timeZone: runTimeZone(row) }),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "実行状態",
      cell: (row) => (
        <StatusBadge state={cronStateToStatus(row.state)}>
          {cronStateLabel(row.state)}
        </StatusBadge>
      ),
    },
    {
      header: "広告アカウント",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        return summary ? (
          <InlineCode>{summary.accountKey}</InlineCode>
        ) : (
          <span>—</span>
        );
      },
    },
    {
      header: "チェック結果",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        if (!summary) return <span>—</span>;
        return (
          <StatusBadge state={summaryStatusToState(summary.status)}>
            {summaryStatusLabel(summary.status)}
          </StatusBadge>
        );
      },
    },
    {
      header: "リスク",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        if (!summary || !summary.classification) return <span>—</span>;
        return (
          <StatusBadge state={classificationToState(summary.classification)}>
            {classificationLabel(summary.classification)}
          </StatusBadge>
        );
      },
    },
    {
      header: "判断",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        if (!summary || !summary.decision) return <span>—</span>;
        return (
          <StatusBadge state={decisionToState(summary.decision)}>
            {decisionLabel(summary.decision)}
          </StatusBadge>
        );
      },
    },
    {
      header: "アラート",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        return summary ? (
          <span className="tabular-nums">{summary.alerts.length}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "停止候補",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        return summary ? (
          <span className="tabular-nums">{summary.candidateCount}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "所要時間",
      cell: (row) => (row.durationMs == null ? "—" : `${row.durationMs} ms`),
      className: "tabular",
      headerClassName: "tabular",
    },
  ];

  const alertColumns: DataTableColumn<BudgetGuardAlert>[] = [
    {
      header: "ルール",
      cell: (row) => <InlineCode>{formatRule(row.rule)}</InlineCode>,
    },
    {
      header: "重要度",
      cell: (row) => (
        <StatusBadge state={alertSeverityToState(row.severity)}>
          {severityLabel(row.severity)}
        </StatusBadge>
      ),
    },
    {
      header: "観測値",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {row.rule === "no_conversions"
            ? row.observedValue.toFixed(2)
            : formatRatio(row.observedValue)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "しきい値",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {row.rule === "no_conversions"
            ? row.threshold.toFixed(2)
            : formatRatio(row.threshold)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "内容",
      cell: (row) => row.message,
    },
  ];

  const aiRunColumns: DataTableColumn<AiRunRow>[] = [
    {
      header: "作成日時",
      cell: (row) => formatDateTime(row.createdAt, { timeZone: pageDisplayTimeZone }),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "担当",
      cell: (row) => <InlineCode>{row.agent}</InlineCode>,
    },
    {
      header: "AIモデル",
      cell: (row) => (
        <InlineCode>
          {row.provider}/{row.model}
        </InlineCode>
      ),
    },
    {
      header: "状態",
      cell: (row) => (
        <StatusBadge state={aiRunStatusState(row.status)}>
          {aiRunStatusLabel(row.status)}
        </StatusBadge>
      ),
    },
    {
      header: "判断",
      cell: (row) =>
        row.decision ? (
          <StatusBadge
            state={decisionToState(
              VALID_DECISION.has(row.decision as BudgetGuardDecision)
                ? (row.decision as BudgetGuardDecision)
                : null
            )}
          >
            {row.decision && VALID_DECISION.has(row.decision as BudgetGuardDecision)
              ? decisionLabel(row.decision as BudgetGuardDecision)
              : row.decision}
          </StatusBadge>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "信頼度",
      cell: (row) =>
        row.confidence === null ? (
          <span>—</span>
        ) : (
          <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
            {row.confidence.toFixed(2)}
          </span>
        ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "利用量",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
  ];

  const policyStateState: StatusState = !dbReady
    ? "warn"
    : !latestSummary
      ? "idle"
      : policyMissing
        ? "error"
        : "ok";
  const policyStateLabel = !dbReady
    ? "要確認"
    : !latestSummary
      ? "未実行"
      : policyMissing
        ? "ルール未設定"
        : "設定済み";

  const latestSummaryItems: KeyValueEntry[] = latestSummary
    ? [
        {
          label: "広告アカウント",
          value: <InlineCode>{latestSummary.summary.accountKey}</InlineCode>,
        },
        {
          label: "チェック結果",
          value: (
            <StatusBadge state={summaryStatusToState(latestSummary.summary.status)}>
              {summaryStatusLabel(latestSummary.summary.status)}
            </StatusBadge>
          ),
        },
        {
          label: "実行モード",
          value: (
            <StatusBadge state={modeToState(latestSummary.summary.mode)}>
              {latestSummary.summary.mode}
            </StatusBadge>
          ),
        },
        {
          label: "リスク",
          value: latestSummary.summary.classification ? (
            <StatusBadge
              state={classificationToState(latestSummary.summary.classification)}
            >
              {classificationLabel(latestSummary.summary.classification)}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "判断",
          value: latestSummary.summary.decision ? (
            <StatusBadge state={decisionToState(latestSummary.summary.decision)}>
              {decisionLabel(latestSummary.summary.decision)}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "停止候補",
          value: (
            <span className="tabular-nums">
              {latestSummary.summary.candidateCount}
            </span>
          ),
        },
        {
          label: "注意が必要な変更",
          value:
            latestSummary.summary.dangerousCategories.length === 0 ? (
              <span>—</span>
            ) : (
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {latestSummary.summary.dangerousCategories.join(", ")}
              </span>
            ),
        },
        {
          label: "AI実行ID",
          value: latestSummary.summary.aiRunId ? (
            <InlineCode>{latestSummary.summary.aiRunId}</InlineCode>
          ) : (
            <span>—</span>
          ),
        },
      ]
    : [];

  const scheduleItems: KeyValueEntry[] = scheduleView
    ? [
        {
          label: "実行タイミング",
          value: <InlineCode>{scheduleView.cron || "(unscheduled)"}</InlineCode>,
        },
        {
          label: "状態",
          value: (
            <StatusBadge state={scheduleView.enabled ? "ok" : "idle"}>
              {scheduleView.enabled ? "有効" : "停止中"}
            </StatusBadge>
          ),
        },
        {
          label: "前回",
          value: scheduleView.lastRunState ? (
            <StatusBadge
              state={
                scheduleView.lastRunState === "ok"
                  ? "ok"
                  : scheduleView.lastRunState === "warn"
                    ? "warn"
                    : scheduleView.lastRunState === "error"
                      ? "error"
                      : "idle"
              }
            >
              {cronStateLabel(scheduleView.lastRunState)}
            </StatusBadge>
          ) : (
            <span>未実行</span>
          ),
        },
        {
          label: "次回",
          value: scheduleView.nextRunAt ? (
            <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {formatDateTime(scheduleView.nextRunAt, { timeZone: pageDisplayTimeZone })}
            </span>
          ) : (
            <span>—</span>
          ),
        },
      ]
    : [];

  return (
    <>
      <PageHeader
        title="予算チェック"
        subtitle={
          <>
            予算超過、月間ペース、急な変化、成果なしを確認します。
            ルールが未設定のときや危険な変更は、Meta を直接変更せず人の承認を待ちます。
          </>
        }
      />

      <div className="page-body page-body--single">
        {policyMissing || anyPolicyMissing ? (
          <div
            role="alert"
            style={{
              border: "1px solid var(--color-status-error)",
              background: "var(--color-status-error-subtle)",
              color: "var(--color-text-primary)",
              borderRadius: "var(--radius-md)",
              padding: "0.875rem 1rem",
              marginBottom: "1rem",
              display: "grid",
              gap: "0.25rem",
            }}
            data-testid="budget-guard-fail-closed"
          >
            <div style={{ fontWeight: 600 }}>
              予算チェックのルールが未設定です
            </div>
            <div style={{ fontSize: "0.8125rem" }}>
              ルールが見つからない間は、AI判断もMetaへの変更も行いません。
              設定が必要な場合は接続と健康状態、またはGitHub連携を確認してください。
            </div>
          </div>
        ) : null}

        <Panel
          title="ルールの状態"
          subtitle="予算・月間ペース・急な変化・成果なし・自動停止候補を確認します"
          status={
            <StatusDot state={policyStateState}>{policyStateLabel}</StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="予算チェックを読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : !latestSummary ? (
            <EmptyState
              title="予算チェックはまだ実行されていません"
              description="予算条件を含むカスタム自動実行を作成すると、ここにアラートと判断結果が表示されます。"
            />
          ) : (
            <div style={{ display: "grid", gap: "1rem" }}>
              <KeyValueList items={latestSummaryItems} />
              {latestSummary.summary.policyReasons.length > 0 ? (
                <div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--color-text-secondary)",
                      marginBottom: "0.25rem",
                    }}
                  >
                    判断理由
                  </div>
                  <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                    {latestSummary.summary.policyReasons.map((r, idx) => (
                      <li key={idx}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {latestSummary.summary.errorMessage ? (
                <div
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--color-status-error)",
                  }}
                >
                  {latestSummary.summary.errorMessage}
                </div>
              ) : null}
            </div>
          )}
        </Panel>

        <Panel
          title="自動実行の状態"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : scheduleView
                ? "予算チェックの定期実行"
                : "予算チェックの自動実行は未登録"
          }
          status={
            <StatusDot
              state={
                !dbReady
                  ? "warn"
                  : !scheduleView
                    ? "idle"
                    : scheduleView.enabled
                      ? "ok"
                      : "idle"
              }
            >
              {!dbReady
                ? "warn"
                : !scheduleView
                  ? "未登録"
                  : scheduleView.enabled
                    ? "on"
                    : "off"}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="自動実行の状態を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : !scheduleView ? (
            <EmptyState
              title="予算チェックの自動実行はまだ登録されていません"
              description="AdDroid を開始すると標準の自動実行が登録されます。"
            />
          ) : (
            <KeyValueList items={scheduleItems} />
          )}
        </Panel>

        <Panel
          title="最新アラート"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : latestSummary
                ? `しきい値を超えた項目 · ${latestSummary.summary.alerts.length} 件`
                : "直近の実行なし"
          }
          status={
            <StatusDot
              state={
                !dbReady
                  ? "warn"
                  : !latestSummary
                    ? "idle"
                    : latestSummary.summary.alerts.length === 0
                      ? "ok"
                      : "warn"
              }
            >
              {!dbReady
                ? "warn"
                : !latestSummary
                  ? "idle"
                  : latestSummary.summary.alerts.length === 0
                    ? "アラートなし"
                    : `${latestSummary.summary.alerts.length} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="アラートを読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : !latestSummary ? (
            <EmptyState
              title="アラートはまだありません"
              description="予算チェックが実行されると、しきい値判定結果が表示されます。"
            />
          ) : (
            <DataTable
              rows={latestSummary.summary.alerts}
              rowKey={(_row, index) => `${latestSummary.run.id}:${index}`}
              columns={alertColumns}
              empty={
                <EmptyState
                  title="このランではアラートは発生していません"
                  description="ポリシーで設定したしきい値を超える観測は検出されませんでした。"
                />
              }
            />
          )}
        </Panel>

        <Panel
          title="実行履歴"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : `${runsCount} 件 (直近 25)`
          }
          status={
            <StatusDot state={!dbReady ? "warn" : runsCount === 0 ? "idle" : "ok"}>
              {!dbReady ? "要確認" : runsCount === 0 ? "未実行" : `${runsCount} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="予算チェックの実行履歴を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <DataTable
              rows={runs}
              rowKey={(row) => row.id}
              columns={runColumns}
              empty={
                <EmptyState
                  title="予算チェックはまだ実行されていません"
                  description="自動実行を有効化すると、各回の状態・判断・アラートがここに記録されます。"
                />
              }
            />
          )}
        </Panel>

        <Panel
          title="AI判断履歴"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : `${aiRunsCount} 件 (直近 25)`
          }
          status={
            <StatusDot
              state={!dbReady ? "warn" : aiRunsCount === 0 ? "idle" : "ok"}
            >
              {!dbReady
                ? "要確認"
                : aiRunsCount === 0
                  ? "未実行"
                  : `${aiRunsCount} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="AI判断履歴を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <DataTable
              rows={aiRuns}
              rowKey={(row) => row.id}
              columns={aiRunColumns}
              empty={
                <EmptyState
                  title="AI判断履歴はまだありません"
                  description="予算チェックが実行されると、判断結果とコストの概要がここに保存されます。"
                />
              }
            />
          )}
        </Panel>
      </div>
    </>
  );
}
