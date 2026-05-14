export interface ImprovementReportRun {
  state: string;
  startedAt: Date;
  durationMs: number | null;
  errorMessage: string | null;
  output: unknown;
}

export interface ImprovementReportLog {
  level: string;
  message: string;
  payload: unknown;
}

export interface ImprovementReportAudit {
  action: string;
  ref: string | null;
  metadata: unknown;
}

export function formatImprovementReportForUser(
  run: ImprovementReportRun,
  logs: ImprovementReportLog[],
  audits: ImprovementReportAudit[],
  webUrl: string
): string {
  const aggregate = parseAggregate(run.output);
  const accountSummaries = collectAccountSummaries(logs);
  const auditSummaries = audits
    .map((audit) => parseAuditSummary(audit))
    .filter((audit): audit is ParsedAuditSummary => audit !== null);

  const lines: string[] = [];
  if (run.state === "failed") {
    lines.push("改善提案の作成に失敗しました。");
    if (run.errorMessage) lines.push(`理由: ${run.errorMessage}`);
  } else {
    lines.push("改善提案の作成が完了しました。");
  }

  if (aggregate) {
    lines.push(
      `対象: ${aggregate.accountsProcessed}件 / PR作成 ${aggregate.succeeded} / 提案なし ${aggregate.skippedNoProposal} / 自動ブロック ${aggregate.autoBlocked} / 失敗 ${aggregate.failed}`
    );
  } else if (accountSummaries.length > 0) {
    const failed = accountSummaries.filter((s) => s.status.endsWith("_failed")).length;
    lines.push(`対象: ${accountSummaries.length}件 / 失敗 ${failed}`);
  }

  if (auditSummaries.length > 0) {
    lines.push("");
    lines.push("提案・判断:");
    for (const audit of auditSummaries.slice(0, 5)) {
      lines.push(`- ${audit.accountKey}: ${actionLabel(audit.action)}`);
      if (audit.summary) lines.push(`  要約: ${audit.summary}`);
      if (audit.classification || audit.auditDecision) {
        lines.push(
          `  リスク: ${audit.classification ?? "未分類"} / 判断: ${audit.auditDecision ?? "未判定"}`
        );
      }
      if (audit.budgetImpact) lines.push(`  予算影響: ${audit.budgetImpact}`);
      if (audit.prNumber) {
        lines.push(`  承認待ち: PR #${audit.prNumber}${audit.htmlUrl ? ` ${audit.htmlUrl}` : ""}`);
      }
      for (const proposal of audit.proposals.slice(0, 3)) {
        lines.push(
          `  - ${proposal.category ? `${proposal.category}: ` : ""}${proposal.target || "対象未指定"} ${proposal.proposedChange || ""}`.trim()
        );
        if (proposal.rationale) lines.push(`    理由: ${proposal.rationale}`);
      }
      if (audit.proposals.length > 3) {
        lines.push(`  - ほか ${audit.proposals.length - 3} 件`);
      }
    }
  } else if (accountSummaries.length > 0) {
    lines.push("");
    lines.push("実行状況:");
    for (const summary of accountSummaries.slice(0, 5)) {
      lines.push(
        `- ${summary.accountKey}: ${summary.status}${summary.decision ? ` / ${summary.decision}` : ""}${summary.proposalCount != null ? ` / 提案 ${summary.proposalCount}件` : ""}`
      );
      if (summary.errorMessage) lines.push(`  理由: ${summary.errorMessage}`);
    }
  }

  const refreshMessages = logs
    .filter((log) => /refreshed latest insights/.test(log.message))
    .map((log) => log.message)
    .slice(0, 3);
  if (refreshMessages.length > 0) {
    lines.push("");
    lines.push("取得データ:");
    for (const message of refreshMessages) lines.push(`- ${message}`);
  }

  lines.push("");
  lines.push(`詳細を見る: ${webUrl.replace(/\/+$/, "")}/improvements`);
  lines.push("");
  return lines.join("\n");
}

function parseAggregate(value: unknown): {
  accountsProcessed: number;
  succeeded: number;
  skippedNoProposal: number;
  autoBlocked: number;
  failed: number;
} | null {
  if (!isRecord(value)) return null;
  const accountsProcessed = readNumber(value.accountsProcessed);
  if (accountsProcessed === null) return null;
  const aiFailed = readNumber(value.ai_failed) ?? 0;
  const prFailed = readNumber(value.pr_failed) ?? 0;
  return {
    accountsProcessed,
    succeeded: readNumber(value.succeeded) ?? 0,
    skippedNoProposal: readNumber(value.skipped_no_proposal) ?? 0,
    autoBlocked: readNumber(value.auto_blocked) ?? 0,
    failed: aiFailed + prFailed,
  };
}

function collectAccountSummaries(logs: ImprovementReportLog[]): Array<{
  accountKey: string;
  status: string;
  decision: string | null;
  proposalCount: number | null;
  errorMessage: string | null;
}> {
  return logs
    .map((log) => {
      if (!isRecord(log.payload)) return null;
      const status = readString(log.payload.status);
      const accountKey = readString(log.payload.accountKey);
      if (!status || !accountKey) return null;
      return {
        accountKey,
        status,
        decision: readString(log.payload.decision),
        proposalCount: readNumber(log.payload.proposalCount),
        errorMessage: readString(log.payload.errorMessage),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

interface ParsedAuditSummary {
  action: string;
  accountKey: string;
  summary: string | null;
  classification: string | null;
  auditDecision: string | null;
  budgetImpact: string | null;
  prNumber: number | null;
  htmlUrl: string | null;
  proposals: Array<{
    category: string | null;
    target: string | null;
    proposedChange: string | null;
    rationale: string | null;
  }>;
}

function parseAuditSummary(audit: ImprovementReportAudit): ParsedAuditSummary | null {
  if (!isRecord(audit.metadata)) return null;
  const accountKey = readString(audit.metadata.accountKey);
  if (!accountKey) return null;
  return {
    action: audit.action,
    accountKey,
    summary: readString(audit.metadata.summary),
    classification: readString(audit.metadata.classification),
    auditDecision: readString(audit.metadata.auditDecision),
    budgetImpact: formatBudgetImpact(audit.metadata.budgetImpact),
    prNumber: readNumber(audit.metadata.prNumber),
    htmlUrl: readString(audit.metadata.htmlUrl),
    proposals: readProposals(audit.metadata.proposals),
  };
}

function readProposals(value: unknown): ParsedAuditSummary["proposals"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      return {
        category: readString(item.category),
        target: readString(item.target),
        proposedChange: readString(item.proposedChange),
        rationale: readString(item.rationale),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function formatBudgetImpact(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const delta = readNumber(value.deltaCurrency);
  const after = readNumber(value.afterCurrency);
  const notes = readString(value.notes);
  const parts: string[] = [];
  if (delta !== null) parts.push(`差分 ${delta}`);
  if (after !== null) parts.push(`変更後 ${after}`);
  if (notes) parts.push(notes);
  return parts.length > 0 ? parts.join(" / ") : null;
}

function actionLabel(action: string): string {
  if (action === "improvement_pr.opened") return "承認待ちPRを作成";
  if (action === "improvement_pr.skipped") return "提案なし、またはPR作成なし";
  if (action === "improvement_pr.failed") return "失敗";
  return action;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
