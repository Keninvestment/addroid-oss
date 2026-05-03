// AdDroid OSS — Improvements page (the current implementation browser regression fix).
//
// Browser test scenario `improvement-pr-workflow` は `/improvements` に直接
// アクセスし、(1) improvement_pr workflow の状態が見える、(2) record が
// あれば AI rationale / risk / dry-run フィールドが見える、(3) AI が PR 承認を
// 迂回できる導線が UI 上に存在しない、を期待する。
//
// データソース:
//   - `cron_schedules`            → improvement_pr プリセットの enable / cron 状態
//   - `cron_runs` (improvement_pr) → 直近 cron tick の集計 (accountsProcessed /
//                                    succeeded / skipped_no_proposal /
//                                    auto_blocked / ai_failed / pr_failed)
//   - `audit_logs` (improvement_pr.opened|skipped|failed)
//                                  → per-account の最終ステータスと PR・
//                                    classification / dangerous categories /
//                                    budget impact / dry-run validation を含む
//                                    metadata (improvement-pr-runtime.ts で
//                                    sanitize 済みで書き込まれる)
//   - `ai_runs` (workflow="improvement_pr")
//                                  → 8 段パイプライン (analyst → ... → audit)
//                                    の provider / model / decision /
//                                    confidence / tokens / cost
//
// 設計原則:
//   - ガードレール「No Placeholder Data」: ダミーデータを描かない。
//     データが無ければ明示的な空状態 / fail-closed バナーを出す。
//   - ガードレール「No Dead UI」: 本ページは read-only。改善 PR は ops repo の
//     workflow / AI ワークフローを介して生成される設計境界のため、UI 側に
//     「Adhoc 起動」「PR 承認」「Meta 反映」ボタンを置かない。
//   - 承認境界: AI は Meta を直接変更しない。改善は必ず GitHub PR を経由し、
//     dangerous categories (budget_increase / new_campaign / targeting_change /
//     monthly_budget_change / automation_rule_change) は approval_required で
//     人間の merge を待つ。本ページはその境界を明示するコピーを page-header
//     subtitle と承認境界カードの 2 箇所で出す。

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

type ImprovementPrRunStatus =
  | "succeeded"
  | "skipped_no_proposal"
  | "auto_blocked"
  | "ai_failed"
  | "pr_failed"
  | "no_account";
type ImprovementPrClassification = "safe" | "requires_approval" | "dangerous";
type ImprovementPrAuditDecision =
  | "auto_approved"
  | "approval_required"
  | "auto_blocked";
type ImprovementPrAction =
  | "improvement_pr.opened"
  | "improvement_pr.skipped"
  | "improvement_pr.failed";

const VALID_ACTIONS = new Set<ImprovementPrAction>([
  "improvement_pr.opened",
  "improvement_pr.skipped",
  "improvement_pr.failed",
]);

const VALID_CLASSIFICATION = new Set<ImprovementPrClassification>([
  "safe",
  "requires_approval",
  "dangerous",
]);

const VALID_AUDIT_DECISION = new Set<ImprovementPrAuditDecision>([
  "auto_approved",
  "approval_required",
  "auto_blocked",
]);

interface CronRunRow {
  id: string;
  state: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
  output: unknown;
}

interface CronRunAggregate {
  accountsProcessed: number;
  succeeded: number;
  skipped_no_proposal: number;
  auto_blocked: number;
  ai_failed: number;
  pr_failed: number;
  no_account: number;
  llmProvider: string | null;
  note: string | null;
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

interface AuditRow {
  id: string;
  action: string;
  target: string | null;
  ref: string | null;
  metadata: unknown;
  createdAt: Date;
}

interface ScheduleRow {
  name: string;
  cron: string;
  enabled: boolean;
  lastRunState: string | null;
  nextRunAt: Date | null;
}

interface ParsedAuditMetadata {
  accountKey: string | null;
  accountId: string | null;
  classification: ImprovementPrClassification | null;
  auditDecision: ImprovementPrAuditDecision | null;
  dangerousCategories: string[];
  proposalCount: number | null;
  fileCount: number | null;
  budgetImpact: BudgetImpact | null;
  planValidation: PlanValidation | null;
  snapshotIds: string[];
  mode: string | null;
  prNumber: number | null;
  htmlUrl: string | null;
  headSha: string | null;
  summary: string | null;
}

interface BudgetImpact {
  deltaCurrency: number;
  afterCurrency: number;
  notes: string;
}

interface PlanValidation {
  available: boolean;
  ok: boolean;
  risk: string;
  summary: string;
  counts: {
    creates: number;
    updates: number;
    deletes: number;
    errors: number;
    warnings: number;
  } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function readNullableNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readString(v: unknown, fallback: string | null = null): string | null {
  return typeof v === "string" ? v : fallback;
}

function parseCronRunAggregate(output: unknown): CronRunAggregate | null {
  if (!isRecord(output)) return null;
  // accountsProcessed は必須。これが無ければ improvement_pr aggregate ではない。
  if (typeof output.accountsProcessed !== "number") return null;
  return {
    accountsProcessed: readNumber(output.accountsProcessed),
    succeeded: readNumber(output.succeeded),
    skipped_no_proposal: readNumber(output.skipped_no_proposal),
    auto_blocked: readNumber(output.auto_blocked),
    ai_failed: readNumber(output.ai_failed),
    pr_failed: readNumber(output.pr_failed),
    no_account: readNumber(output.no_account),
    llmProvider: readString(output.llmProvider),
    note: readString(output.note),
  };
}

function parseAuditMetadata(metadata: unknown): ParsedAuditMetadata {
  const m = isRecord(metadata) ? metadata : {};
  const classificationRaw = readString(m.classification) ?? "";
  const classification = VALID_CLASSIFICATION.has(
    classificationRaw as ImprovementPrClassification
  )
    ? (classificationRaw as ImprovementPrClassification)
    : null;
  const auditDecisionRaw = readString(m.auditDecision) ?? "";
  const auditDecision = VALID_AUDIT_DECISION.has(
    auditDecisionRaw as ImprovementPrAuditDecision
  )
    ? (auditDecisionRaw as ImprovementPrAuditDecision)
    : null;
  const dangerousCategories = Array.isArray(m.dangerousCategories)
    ? m.dangerousCategories.filter((x): x is string => typeof x === "string")
    : [];
  const snapshotIds = Array.isArray(m.snapshotIds)
    ? m.snapshotIds.filter((x): x is string => typeof x === "string")
    : [];

  let budgetImpact: BudgetImpact | null = null;
  if (isRecord(m.budgetImpact)) {
    budgetImpact = {
      deltaCurrency: readNumber(m.budgetImpact.deltaCurrency),
      afterCurrency: readNumber(m.budgetImpact.afterCurrency),
      notes: readString(m.budgetImpact.notes) ?? "",
    };
  }

  let planValidation: PlanValidation | null = null;
  if (isRecord(m.planValidation)) {
    const pv = m.planValidation;
    const counts = isRecord(pv.counts)
      ? {
          creates: readNumber(pv.counts.creates),
          updates: readNumber(pv.counts.updates),
          deletes: readNumber(pv.counts.deletes),
          errors: readNumber(pv.counts.errors),
          warnings: readNumber(pv.counts.warnings),
        }
      : null;
    planValidation = {
      available: Boolean(pv.available),
      ok: Boolean(pv.ok),
      risk: readString(pv.risk) ?? "ok",
      summary: readString(pv.summary) ?? "",
      counts,
    };
  }

  return {
    accountKey: readString(m.accountKey),
    accountId: readString(m.accountId),
    classification,
    auditDecision,
    dangerousCategories,
    proposalCount: readNullableNumber(m.proposalCount),
    fileCount: readNullableNumber(m.fileCount),
    budgetImpact,
    planValidation,
    snapshotIds,
    mode: readString(m.mode),
    prNumber: readNullableNumber(m.prNumber),
    htmlUrl: readString(m.htmlUrl),
    headSha: readString(m.headSha),
    summary: readString(m.summary),
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

function actionToState(action: ImprovementPrAction): StatusState {
  switch (action) {
    case "improvement_pr.opened":
      return "ok";
    case "improvement_pr.skipped":
      return "idle";
    case "improvement_pr.failed":
      return "error";
  }
}

function classificationToState(
  c: ImprovementPrClassification | null
): StatusState {
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

function auditDecisionToState(
  d: ImprovementPrAuditDecision | null
): StatusState {
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

function modeToState(mode: string | null): StatusState {
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

function planRiskToState(risk: string): StatusState {
  switch (risk) {
    case "ok":
      return "ok";
    case "warn":
      return "warn";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function formatTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\..+$/, "Z");
}

function formatBudgetDelta(impact: BudgetImpact): string {
  const sign = impact.deltaCurrency > 0 ? "+" : impact.deltaCurrency < 0 ? "" : "±";
  return `${sign}${impact.deltaCurrency.toFixed(2)} → ${impact.afterCurrency.toFixed(2)}`;
}

export default async function ImprovementsPage() {
  let runs: CronRunRow[] = [];
  let aiRuns: AiRunRow[] = [];
  let audits: AuditRow[] = [];
  let schedules: ScheduleRow[] = [];
  let dbReady = true;
  try {
    [runs, aiRuns, audits, schedules] = await Promise.all([
      prisma.cronRun.findMany({
        where: { name: "improvement_pr" },
        orderBy: { startedAt: "desc" },
        take: 25,
        select: {
          id: true,
          state: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          errorMessage: true,
          output: true,
        },
      }),
      prisma.aiRun.findMany({
        where: { workflow: "improvement_pr" },
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
      prisma.auditLog.findMany({
        where: { action: { startsWith: "improvement_pr." } },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true,
          action: true,
          target: true,
          ref: true,
          metadata: true,
          createdAt: true,
        },
      }),
      prisma.cronSchedule.findMany({
        where: { name: "improvement_pr" },
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

  const auditRows = audits
    .filter((a): a is AuditRow & { action: ImprovementPrAction } =>
      VALID_ACTIONS.has(a.action as ImprovementPrAction)
    )
    .map((a) => ({ row: a, parsed: parseAuditMetadata(a.metadata) }));

  const latestAudit = auditRows[0] ?? null;
  const scheduleRow = schedules[0] ?? null;
  const runsCount = runs.length;
  const aiRunsCount = aiRuns.length;
  const auditCount = auditRows.length;

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
      header: "Accounts",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.accountsProcessed}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Succeeded",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.succeeded}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Skipped (no proposal)",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.skipped_no_proposal}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Auto-blocked",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.auto_blocked}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "AI failed",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.ai_failed}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "PR failed",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.pr_failed}</span>
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

  const auditColumns: DataTableColumn<{
    row: AuditRow & { action: ImprovementPrAction };
    parsed: ParsedAuditMetadata;
  }>[] = [
    {
      header: "Created",
      cell: ({ row }) => formatTimestamp(row.createdAt),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "Action",
      cell: ({ row }) => (
        <StatusBadge state={actionToState(row.action)}>{row.action}</StatusBadge>
      ),
    },
    {
      header: "Account",
      cell: ({ parsed }) =>
        parsed.accountKey ? (
          <InlineCode>{parsed.accountKey}</InlineCode>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "Mode",
      cell: ({ parsed }) =>
        parsed.mode ? (
          <StatusBadge state={modeToState(parsed.mode)}>{parsed.mode}</StatusBadge>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "Risk",
      cell: ({ parsed }) =>
        parsed.classification ? (
          <StatusBadge state={classificationToState(parsed.classification)}>
            {parsed.classification}
          </StatusBadge>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "Decision",
      cell: ({ parsed }) =>
        parsed.auditDecision ? (
          <StatusBadge state={auditDecisionToState(parsed.auditDecision)}>
            {parsed.auditDecision === "approval_required"
              ? "approval-required"
              : parsed.auditDecision}
          </StatusBadge>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "Proposals",
      cell: ({ parsed }) =>
        parsed.proposalCount === null ? (
          <span>—</span>
        ) : (
          <span className="tabular-nums">{parsed.proposalCount}</span>
        ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Budget impact",
      cell: ({ parsed }) =>
        parsed.budgetImpact ? (
          <span
            className="tabular-nums"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {formatBudgetDelta(parsed.budgetImpact)}
          </span>
        ) : (
          <span>—</span>
        ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Dry-run",
      cell: ({ parsed }) => {
        const pv = parsed.planValidation;
        if (!pv) return <span>—</span>;
        if (!pv.available) {
          return <StatusBadge state="idle">skipped</StatusBadge>;
        }
        return (
          <StatusBadge state={planRiskToState(pv.risk)}>{pv.risk}</StatusBadge>
        );
      },
    },
    {
      header: "PR",
      cell: ({ parsed }) =>
        parsed.prNumber !== null ? (
          parsed.htmlUrl ? (
            <a
              href={parsed.htmlUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: "var(--color-accent)" }}
            >
              <InlineCode>#{parsed.prNumber}</InlineCode>
            </a>
          ) : (
            <InlineCode>#{parsed.prNumber}</InlineCode>
          )
        ) : (
          <span>—</span>
        ),
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
        row.decision ? <InlineCode>{row.decision}</InlineCode> : <span>—</span>,
    },
    {
      header: "Confidence",
      cell: (row) =>
        row.confidence === null ? (
          <span>—</span>
        ) : (
          <span
            className="tabular-nums"
            style={{ fontFamily: "var(--font-mono)" }}
          >
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
            <span
              className="tabular-nums"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {formatTimestamp(scheduleRow.nextRunAt)}
            </span>
          ) : (
            <span>—</span>
          ),
        },
      ]
    : [];

  const latestAuditItems: KeyValueEntry[] = latestAudit
    ? [
        {
          label: "Action",
          value: (
            <StatusBadge state={actionToState(latestAudit.row.action)}>
              {latestAudit.row.action}
            </StatusBadge>
          ),
        },
        {
          label: "Account",
          value: latestAudit.parsed.accountKey ? (
            <InlineCode>{latestAudit.parsed.accountKey}</InlineCode>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "Mode",
          value: latestAudit.parsed.mode ? (
            <StatusBadge state={modeToState(latestAudit.parsed.mode)}>
              {latestAudit.parsed.mode}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "Risk classification",
          value: latestAudit.parsed.classification ? (
            <StatusBadge
              state={classificationToState(latestAudit.parsed.classification)}
            >
              {latestAudit.parsed.classification}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "Audit decision",
          value: latestAudit.parsed.auditDecision ? (
            <StatusBadge
              state={auditDecisionToState(latestAudit.parsed.auditDecision)}
            >
              {latestAudit.parsed.auditDecision === "approval_required"
                ? "approval-required"
                : latestAudit.parsed.auditDecision}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "Dangerous categories",
          value:
            latestAudit.parsed.dangerousCategories.length === 0 ? (
              <span>—</span>
            ) : (
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {latestAudit.parsed.dangerousCategories.join(", ")}
              </span>
            ),
        },
        {
          label: "Proposals",
          value:
            latestAudit.parsed.proposalCount === null ? (
              <span>—</span>
            ) : (
              <span className="tabular-nums">
                {latestAudit.parsed.proposalCount}
              </span>
            ),
        },
        {
          label: "Files",
          value:
            latestAudit.parsed.fileCount === null ? (
              <span>—</span>
            ) : (
              <span className="tabular-nums">
                {latestAudit.parsed.fileCount}
              </span>
            ),
        },
        {
          label: "Budget impact",
          value: latestAudit.parsed.budgetImpact ? (
            <span style={{ display: "grid", gap: "0.125rem" }}>
              <span
                className="tabular-nums"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {formatBudgetDelta(latestAudit.parsed.budgetImpact)}
              </span>
              {latestAudit.parsed.budgetImpact.notes ? (
                <span
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  {latestAudit.parsed.budgetImpact.notes}
                </span>
              ) : null}
            </span>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "Dry-run validation",
          value: latestAudit.parsed.planValidation ? (
            <span style={{ display: "grid", gap: "0.125rem" }}>
              {latestAudit.parsed.planValidation.available ? (
                <span style={{ display: "flex", gap: "0.5rem" }}>
                  <StatusBadge
                    state={planRiskToState(latestAudit.parsed.planValidation.risk)}
                  >
                    {latestAudit.parsed.planValidation.risk}
                  </StatusBadge>
                  <StatusBadge
                    state={latestAudit.parsed.planValidation.ok ? "ok" : "error"}
                  >
                    {latestAudit.parsed.planValidation.ok ? "ok" : "errors"}
                  </StatusBadge>
                </span>
              ) : (
                <StatusBadge state="idle">skipped (no ops repo)</StatusBadge>
              )}
              {latestAudit.parsed.planValidation.summary ? (
                <span
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  {latestAudit.parsed.planValidation.summary}
                </span>
              ) : null}
              {latestAudit.parsed.planValidation.counts ? (
                <span
                  className="tabular-nums"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.8125rem",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  creates={latestAudit.parsed.planValidation.counts.creates}{" "}
                  updates={latestAudit.parsed.planValidation.counts.updates}{" "}
                  deletes={latestAudit.parsed.planValidation.counts.deletes}{" "}
                  errors={latestAudit.parsed.planValidation.counts.errors}{" "}
                  warnings={latestAudit.parsed.planValidation.counts.warnings}
                </span>
              ) : null}
            </span>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "Snapshot IDs",
          value:
            latestAudit.parsed.snapshotIds.length === 0 ? (
              <span>—</span>
            ) : (
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {latestAudit.parsed.snapshotIds.length} 件 (
                {latestAudit.parsed.snapshotIds.slice(0, 4).join(", ")}
                {latestAudit.parsed.snapshotIds.length > 4 ? ", …" : ""})
              </span>
            ),
        },
        {
          label: "Pull request",
          value:
            latestAudit.parsed.prNumber !== null ? (
              latestAudit.parsed.htmlUrl ? (
                <a
                  href={latestAudit.parsed.htmlUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ color: "var(--color-accent)" }}
                >
                  <InlineCode>#{latestAudit.parsed.prNumber}</InlineCode>
                </a>
              ) : (
                <InlineCode>#{latestAudit.parsed.prNumber}</InlineCode>
              )
            ) : (
              <span>—</span>
            ),
        },
      ]
    : [];

  const latestAuditState: StatusState = !dbReady
    ? "warn"
    : !latestAudit
      ? "idle"
      : actionToState(latestAudit.row.action);
  const latestAuditLabel = !dbReady
    ? "warn"
    : !latestAudit
      ? "no records yet"
      : latestAudit.row.action;

  return (
    <>
      <PageHeader
        title="Improvements"
        subtitle={
          <>
            <InlineCode>improvement_pr</InlineCode> ワークフローの実行状態と監査
            記録。AI は Meta を直接変更せず、改善は必ず GitHub PR として提示
            される。dangerous categories
            (<InlineCode>budget_increase</InlineCode> /{" "}
            <InlineCode>new_campaign</InlineCode> /{" "}
            <InlineCode>targeting_change</InlineCode> /{" "}
            <InlineCode>monthly_budget_change</InlineCode> /{" "}
            <InlineCode>automation_rule_change</InlineCode>) は AI 単独で
            自動承認されず、approval-required で人間の merge を待つ。
          </>
        }
      />

      <div className="page-body page-body--single">
        <div
          role="note"
          style={{
            border: "1px solid var(--color-border-subtle)",
            background: "var(--color-bg-subtle)",
            color: "var(--color-text-primary)",
            borderRadius: "var(--radius-md)",
            padding: "0.875rem 1rem",
            display: "grid",
            gap: "0.25rem",
          }}
          data-testid="improvement-pr-approval-boundary"
        >
          <div style={{ fontWeight: 600 }}>
            承認境界 — AI は GitHub PR を経由してのみ改善を提案する
          </div>
          <div style={{ fontSize: "0.8125rem" }}>
            <InlineCode>improvement_pr</InlineCode> ワークフローは ops repo に
            YAML diff を含む PR を立てるだけで、Meta API には書き込まない。
            <InlineCode>auto_apply</InlineCode> モードでも、PR が merge され、
            さらに Apply (PAUSED) → Activate の人間確認を経由したものだけが
            広告配信に反映される。dangerous category を含む変更は{" "}
            <InlineCode>approval_required</InlineCode> で必ず人間の merge を
            待つ (本ページからは PR 承認 / Meta 反映を行わない)。
          </div>
        </div>

        <Panel
          title="Schedule"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : scheduleRow
                ? `cron_schedules (name="improvement_pr")`
                : "improvement_pr スケジュール未登録"
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
              title="improvement_pr スケジュールはまだ登録されていません"
              description="addroid up を実行すると、improvement_pr を含む cron preset が登録されます。"
            />
          ) : (
            <KeyValueList items={scheduleItems} />
          )}
        </Panel>

        <Panel
          title="Latest improvement_pr audit"
          subtitle="直近 audit_logs エントリから取得した PR 提案の AI rationale / risk / dry-run / budget impact"
          status={
            <StatusDot state={latestAuditState}>{latestAuditLabel}</StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="audit_logs を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : !latestAudit ? (
            <EmptyState
              title="improvement_pr はまだ実行されていません"
              description="/cron から improvement_pr スケジュールを有効化するか、CLI から ad-hoc 実行すると、ここに最新ランの AI rationale / risk classification / dangerous categories / budget impact / dry-run validation / PR 番号が表示されます。"
            />
          ) : (
            <div style={{ display: "grid", gap: "1rem" }}>
              <KeyValueList items={latestAuditItems} />
              {latestAudit.parsed.summary ? (
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
                    Audit summary
                  </div>
                  <p style={{ margin: 0 }}>{latestAudit.parsed.summary}</p>
                </div>
              ) : null}
            </div>
          )}
        </Panel>

        <Panel
          title="Recent improvement_pr audit trail"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : `audit_logs (action LIKE "improvement_pr.%") · ${auditCount} 件 (直近 25)`
          }
          status={
            <StatusDot
              state={!dbReady ? "warn" : auditCount === 0 ? "idle" : "ok"}
            >
              {!dbReady
                ? "warn"
                : auditCount === 0
                  ? "idle"
                  : `${auditCount} records`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="audit_logs を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : (
            <DataTable
              rows={auditRows}
              rowKey={({ row }) => row.id}
              columns={auditColumns}
              empty={
                <EmptyState
                  title="improvement_pr audit はまだありません"
                  description="improvement_pr が実行されると、各 ad_account について improvement_pr.opened / improvement_pr.skipped / improvement_pr.failed の audit_log が 1 行ずつ書かれ、ここに risk classification / decision / proposals / budget impact / dry-run / PR 番号が表示されます。"
                />
              }
            />
          )}
        </Panel>

        <Panel
          title="Recent improvement_pr cron runs"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : `cron_runs (name="improvement_pr") · ${runsCount} 件 (直近 25)`
          }
          status={
            <StatusDot
              state={!dbReady ? "warn" : runsCount === 0 ? "idle" : "ok"}
            >
              {!dbReady
                ? "warn"
                : runsCount === 0
                  ? "idle"
                  : `${runsCount} runs`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="improvement_pr 実行履歴を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : (
            <DataTable
              rows={runs}
              rowKey={(row) => row.id}
              columns={runColumns}
              empty={
                <EmptyState
                  title="improvement_pr はまだ実行されていません"
                  description="/cron からスケジュールを有効化するか、CLI から ad-hoc 実行すると、ここに各 cron tick の集計 (accountsProcessed / succeeded / skipped_no_proposal / auto_blocked / ai_failed / pr_failed) が記録されます。"
                />
              }
            />
          )}
        </Panel>

        <Panel
          title="Pipeline AI runs"
          subtitle={
            !dbReady
              ? "Prisma スキーマ未反映"
              : `ai_runs (workflow="improvement_pr") · ${aiRunsCount} 件 (直近 25)`
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
              title="improvement_pr ai_runs を読み出せません"
              description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
            />
          ) : (
            <DataTable
              rows={aiRuns}
              rowKey={(row) => row.id}
              columns={aiRunColumns}
              empty={
                <EmptyState
                  title="improvement_pr ai_run はまだ実行されていません"
                  description="improvement_pr が実行されると、analyst → media_buyer → creative_qa → strategy → copy → image_prompt → gitops → audit の 8 段の provider / model / decision / confidence / tokens / cost がここに保存されます。"
                />
              }
            />
          )}
        </Panel>
      </div>
    </>
  );
}
