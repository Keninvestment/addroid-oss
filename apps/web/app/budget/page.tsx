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
  costUsd: number;
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

function formatTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\..+$/, "Z");
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
  let dbReady = true;
  try {
    [runs, aiRuns, schedules] = await Promise.all([
      prisma.cronRun.findMany({
        where: { name: "budget_guard" },
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
        where: { workflow: "budget_guard" },
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
          costUsd: true,
          errorMessage: true,
          createdAt: true,
        },
      }),
      prisma.cronSchedule.findMany({
        where: { name: "budget_guard" },
        select: {
          name: true,
          cron: true,
          enabled: true,
          lastRunState: true,
          nextRunAt: true,
        },
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

  const runColumns: DataTableColumn<CronRunRow>[] = [
    {
      header: "Started",
      cell: (row) => formatTimestamp(row.startedAt),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "State",
      cell: (row) => (
        <StatusBadge state={cronStateToStatus(row.state)}>
          {row.state}
        </StatusBadge>
      ),
    },
    {
      header: "Account",
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
      header: "Status",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        if (!summary) return <span>—</span>;
        return (
          <StatusBadge state={summaryStatusToState(summary.status)}>
            {summary.status}
          </StatusBadge>
        );
      },
    },
    {
      header: "Classification",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        if (!summary || !summary.classification) return <span>—</span>;
        return (
          <StatusBadge state={classificationToState(summary.classification)}>
            {summary.classification}
          </StatusBadge>
        );
      },
    },
    {
      header: "Decision",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        if (!summary || !summary.decision) return <span>—</span>;
        return (
          <StatusBadge state={decisionToState(summary.decision)}>
            {summary.decision === "approval_required"
              ? "approval-required"
              : summary.decision}
          </StatusBadge>
        );
      },
    },
    {
      header: "Alerts",
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
      header: "Candidates",
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
      header: "Duration",
      cell: (row) => (row.durationMs == null ? "—" : `${row.durationMs} ms`),
      className: "tabular",
      headerClassName: "tabular",
    },
  ];

  const alertColumns: DataTableColumn<BudgetGuardAlert>[] = [
    {
      header: "Rule",
      cell: (row) => <InlineCode>{formatRule(row.rule)}</InlineCode>,
    },
    {
      header: "Severity",
      cell: (row) => (
        <StatusBadge state={alertSeverityToState(row.severity)}>
          {row.severity}
        </StatusBadge>
      ),
    },
    {
      header: "Observed",
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
      header: "Threshold",
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
      header: "Message",
      cell: (row) => row.message,
    },
  ];

  const aiRunColumns: DataTableColumn<AiRunRow>[] = [
    {
      header: "Created",
      cell: (row) => formatTimestamp(row.createdAt),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "Agent",
      cell: (row) => <InlineCode>{row.agent}</InlineCode>,
    },
    {
      header: "Provider / model",
      cell: (row) => (
        <InlineCode>
          {row.provider}/{row.model}
        </InlineCode>
      ),
    },
    {
      header: "Status",
      cell: (row) => (
        <StatusBadge state={aiRunStatusState(row.status)}>
          {row.status}
        </StatusBadge>
      ),
    },
    {
      header: "Decision",
      cell: (row) =>
        row.decision ? (
          <StatusBadge
            state={decisionToState(
              VALID_DECISION.has(row.decision as BudgetGuardDecision)
                ? (row.decision as BudgetGuardDecision)
                : null
            )}
          >
            {row.decision === "approval_required"
              ? "approval-required"
              : row.decision}
          </StatusBadge>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "Confidence",
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
      header: "Tokens (in/out)",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Cost (USD)",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          ${row.costUsd.toFixed(6)}
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
    ? "warn"
    : !latestSummary
      ? "no runs yet"
      : policyMissing
        ? "fail-closed"
        : "configured";

  const latestSummaryItems: KeyValueEntry[] = latestSummary
    ? [
        {
          label: "Account",
          value: <InlineCode>{latestSummary.summary.accountKey}</InlineCode>,
        },
        {
          label: "Status",
          value: (
            <StatusBadge state={summaryStatusToState(latestSummary.summary.status)}>
              {latestSummary.summary.status}
            </StatusBadge>
          ),
        },
        {
          label: "Mode",
          value: (
            <StatusBadge state={modeToState(latestSummary.summary.mode)}>
              {latestSummary.summary.mode}
            </StatusBadge>
          ),
        },
        {
          label: "Classification",
          value: latestSummary.summary.classification ? (
            <StatusBadge
              state={classificationToState(latestSummary.summary.classification)}
            >
              {latestSummary.summary.classification}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "Decision",
          value: latestSummary.summary.decision ? (
            <StatusBadge state={decisionToState(latestSummary.summary.decision)}>
              {latestSummary.summary.decision === "approval_required"
                ? "approval-required"
                : latestSummary.summary.decision}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "Candidates",
          value: (
            <span className="tabular-nums">
              {latestSummary.summary.candidateCount}
            </span>
          ),
        },
        {
          label: "Dangerous categories",
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
          label: "AI run",
          value: latestSummary.summary.aiRunId ? (
            <InlineCode>{latestSummary.summary.aiRunId}</InlineCode>
          ) : (
            <span>—</span>
          ),
        },
      ]
    : [];

  const scheduleItems: KeyValueEntry[] = scheduleRow
    ? [
        {
          label: "Schedule",
          value: <InlineCode>{scheduleRow.cron || "(unscheduled)"}</InlineCode>,
        },
        {
          label: "Enabled",
          value: (
            <StatusBadge state={scheduleRow.enabled ? "ok" : "idle"}>
              {scheduleRow.enabled ? "on" : "off"}
            </StatusBadge>
          ),
        },
        {
          label: "Last run state",
          value: scheduleRow.lastRunState ? (
            <StatusBadge
              state={
                scheduleRow.lastRunState === "ok"
                  ? "ok"
                  : scheduleRow.lastRunState === "warn"
                    ? "warn"
                    : scheduleRow.lastRunState === "error"
                      ? "error"
                      : "idle"
              }
            >
              {scheduleRow.lastRunState}
            </StatusBadge>
          ) : (
            <span>未実行</span>
          ),
        },
        {
          label: "Next run",
          value: scheduleRow.nextRunAt ? (
            <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {formatTimestamp(scheduleRow.nextRunAt)}
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
        title="Budget Guard"
        subtitle={
          <>
            <InlineCode>budget_guard</InlineCode> rules
            (daily_budget / monthly_pace / day_over_day / no_conversions /
            auto_pause_policy) のポリシー評価結果と auto_pause 候補。
            policy が未設定 (= ops repo に
            <InlineCode>workflows/budget-guard.yaml</InlineCode> 無し) のときは
            fail-closed で Meta を変更しない。dangerous な変更は AI 単独で
            自動承認されず、必ず PR 承認 (approval-required) を経る。
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
              Fail-closed: configure budget guard
            </div>
            <div style={{ fontSize: "0.8125rem" }}>
              budget_guard policy が見つかりません。ops repo に{" "}
              <InlineCode>workflows/budget-guard.yaml</InlineCode> を配置するか、
              既存ファイルが正しく解釈できる形になっているか確認してください。
              policy が未設定のあいだ、budget_guard は AI 推論を行わず、Meta も
              一切変更しません。
            </div>
          </div>
        ) : null}

        <Panel
          title="Policy state"
          subtitle="budget_guard alerts (daily_budget / monthly_pace / day_over_day / no_conversions) と auto_pause_policy が直近 run で読み込めた状態"
          status={
            <StatusDot state={policyStateState}>{policyStateLabel}</StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="budget_guard 出力を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : !latestSummary ? (
            <EmptyState
              title="budget_guard はまだ実行されていません"
              description="/cron から budget_guard スケジュールを有効化するか、CLI から ad-hoc 実行すると、ここに alerts / auto_pause_policy / classification / decision が表示されます。"
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
                    Policy reasons
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
          title="Schedule"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : scheduleRow
                ? `cron_schedules (name="budget_guard")`
                : "budget_guard スケジュール未登録"
          }
          status={
            <StatusDot
              state={
                !dbReady
                  ? "warn"
                  : !scheduleRow
                    ? "idle"
                    : scheduleRow.enabled
                      ? "ok"
                      : "idle"
              }
            >
              {!dbReady
                ? "warn"
                : !scheduleRow
                  ? "未登録"
                  : scheduleRow.enabled
                    ? "on"
                    : "off"}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="cron_schedules を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : !scheduleRow ? (
            <EmptyState
              title="budget_guard スケジュールはまだ登録されていません"
              description="addroid start を実行すると、budget_guard を含む schedule preset が登録されます。"
            />
          ) : (
            <KeyValueList items={scheduleItems} />
          )}
        </Panel>

        <Panel
          title="Alerts (latest run)"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : latestSummary
                ? `直近 budget_guard run のしきい値違反 · ${latestSummary.summary.alerts.length} 件`
                : "直近 run なし"
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
                    ? "no alerts"
                    : `${latestSummary.summary.alerts.length} alerts`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="alerts を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : !latestSummary ? (
            <EmptyState
              title="アラートはまだありません"
              description="budget_guard が一度でも実行されると、ここに daily_budget / monthly_pace / day_over_day / no_conversions / auto_pause_policy のしきい値判定結果が表示されます。"
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
          title="Recent budget_guard runs"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : `cron_runs (name="budget_guard") · ${runsCount} 件 (直近 25)`
          }
          status={
            <StatusDot state={!dbReady ? "warn" : runsCount === 0 ? "idle" : "ok"}>
              {!dbReady ? "warn" : runsCount === 0 ? "idle" : `${runsCount} runs`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="budget_guard 実行履歴を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : (
            <DataTable
              rows={runs}
              rowKey={(row) => row.id}
              columns={runColumns}
              empty={
                <EmptyState
                  title="budget_guard はまだ実行されていません"
                  description="/cron からスケジュールを有効化するか、CLI から ad-hoc 実行すると、ここに各実行の status / classification / decision / alerts / candidates が記録されます。"
                />
              }
            />
          )}
        </Panel>

        <Panel
          title="Audit AI runs"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : `ai_runs (workflow="budget_guard") · ${aiRunsCount} 件 (直近 25)`
          }
          status={
            <StatusDot
              state={!dbReady ? "warn" : aiRunsCount === 0 ? "idle" : "ok"}
            >
              {!dbReady
                ? "warn"
                : aiRunsCount === 0
                  ? "idle"
                  : `${aiRunsCount} runs`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="audit ai_runs を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : (
            <DataTable
              rows={aiRuns}
              rowKey={(row) => row.id}
              columns={aiRunColumns}
              empty={
                <EmptyState
                  title="audit ai_run はまだ実行されていません"
                  description="budget_guard が実行されると、audit agent の provider / model / decision / confidence / tokens / cost がここに保存されます (policy_missing 状態では AI を呼ばないため、ai_run も書かれません)。"
                />
              }
            />
          )}
        </Panel>
      </div>
    </>
  );
}
