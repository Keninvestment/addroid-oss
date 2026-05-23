// AdDroid OSS — PlanPreview (★B, release readiness).
//
// `runPlanForRoot` が返す per-account サマリ + plan-level findings を、
// creates / updates / deletes / findings の 4 ブロックで描画する。
// /plans の履歴展開 (PlanHistoryRow) と /plans の ad-hoc 結果表示の両方から
// 同じ component を使う。
//
// この component は表示専用 (No Dead UI 違反にならないよう、interactive 要素は持たない)。

import type { ReactNode } from "react";
import type {
  OperationPlanAction,
  PerAccountPlanSummary,
  PlanFinding,
  PlanCounts,
  PlanRiskLevel,
  ValidationFinding,
} from "../../../worker/src/lib/plan-runtime";
import { StatusBadge } from "./StatusBadge";
import { InlineCode } from "./CodeBlock";
import { EmptyState } from "./EmptyState";

export interface PlanPreviewProps {
  perAccount: PerAccountPlanSummary[];
  validationErrors?: ValidationFinding[];
  validationWarnings?: ValidationFinding[];
  totalCounts?: PlanCounts;
  risk?: PlanRiskLevel;
}

export function PlanPreview({
  perAccount,
  validationErrors = [],
  validationWarnings = [],
  totalCounts,
  risk,
}: PlanPreviewProps) {
  const hasContent =
    perAccount.length > 0 ||
    validationErrors.length > 0 ||
    validationWarnings.length > 0;
  if (!hasContent) {
    return (
      <EmptyState
        title="plan に該当する変更はありません。"
        description="operations/*.json に apply 対象の Graph API 操作がありません。"
      />
    );
  }
  return (
    <div className="plan-preview">
      <div className="plan-preview__head">
        {risk ? (
          <StatusBadge state={badgeStateForRisk(risk)}>
            risk: {risk}
          </StatusBadge>
        ) : null}
        {risk && risk !== "ok" ? (
          <StatusBadge state="warn">approval-required</StatusBadge>
        ) : null}
        {totalCounts ? (
          <span className="plan-preview__counts mono tabular">
            +{totalCounts.creates} ~{totalCounts.updates} -{totalCounts.deletes} (
            errors {totalCounts.errors + validationErrors.length} / warnings{" "}
            {totalCounts.warnings + validationWarnings.length})
          </span>
        ) : null}
      </div>

      {validationErrors.length > 0 ? (
        <FindingsBlock
          title="Validation Errors (repo-wide)"
          tone="error"
          findings={validationErrors}
        />
      ) : null}
      {validationWarnings.length > 0 ? (
        <FindingsBlock
          title="Validation Warnings (repo-wide)"
          tone="warn"
          findings={validationWarnings}
        />
      ) : null}

      {perAccount.map((acc) => (
        <AccountSection key={acc.account} summary={acc} />
      ))}
    </div>
  );
}

function AccountSection({ summary }: { summary: PerAccountPlanSummary }) {
  const creates = summary.actions.filter((a) =>
    a.verb === "create"
  );
  const updates = summary.actions.filter((a) =>
    a.verb === "update"
  );
  const deletes = summary.actions.filter((a) =>
    a.verb === "delete"
  );
  return (
    <div className="plan-preview__account">
      <div className="plan-preview__account-head">
        <span className="plan-preview__account-key mono">{summary.account}</span>
        <StatusBadge state={badgeStateForRisk(summary.risk)}>
          {summary.risk}
        </StatusBadge>
        <span className="plan-preview__counts mono tabular">
          +{summary.counts.creates} ~{summary.counts.updates} -
          {summary.counts.deletes}
        </span>
      </div>
      <ActionGroup
        title="Creates"
        tone="ok"
        sigil="+"
        actions={creates}
        emptyHint="新規作成はありません。"
      />
      <ActionGroup
        title="Updates"
        tone="info"
        sigil="~"
        actions={updates}
        emptyHint="変更はありません。"
      />
      <ActionGroup
        title="Deletes"
        tone="warn"
        sigil="-"
        actions={deletes}
        emptyHint="削除はありません。"
      />
      {summary.findings.length > 0 ? (
        <PlanFindingsBlock findings={summary.findings} />
      ) : null}
    </div>
  );
}

function ActionGroup({
  title,
  tone,
  sigil,
  actions,
  emptyHint,
}: {
  title: string;
  tone: "ok" | "info" | "warn";
  sigil: "+" | "~" | "-";
  actions: OperationPlanAction[];
  emptyHint: string;
}) {
  return (
    <div className="plan-preview__group">
      <div className="plan-preview__group-head">
        <StatusBadge state={tone}>{title}</StatusBadge>
        <span className="plan-preview__group-count mono tabular">
          {actions.length}
        </span>
      </div>
      {actions.length === 0 ? (
        <p className="plan-preview__group-empty">{emptyHint}</p>
      ) : (
        <ul className="plan-preview__list">
          {actions.map((a, i) => (
            <li key={`${a.resource}-${a.verb}-${actionIdentity(a)}-${i}`}>
              <span className="plan-preview__sigil mono">{sigil}</span>
              <span className="plan-preview__kind mono">{a.resource}:{a.verb}</span>
              <span className="plan-preview__detail">{describeAction(a)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FindingsBlock({
  title,
  tone,
  findings,
}: {
  title: string;
  tone: "error" | "warn";
  findings: ValidationFinding[];
}) {
  return (
    <div className="plan-preview__findings">
      <div className="plan-preview__group-head">
        <StatusBadge state={tone}>{title}</StatusBadge>
        <span className="plan-preview__group-count mono tabular">
          {findings.length}
        </span>
      </div>
      <ul className="plan-preview__list">
        {findings.map((f, i) => (
          <li key={`${f.file}-${i}`}>
            <span className="plan-preview__sigil mono">!</span>
            <span className="plan-preview__detail">
              <InlineCode>{f.file}</InlineCode>
              {f.pointer ? (
                <>
                  {" "}
                  <InlineCode>{f.pointer}</InlineCode>
                </>
              ) : null}
              <span className="plan-preview__finding-message">{f.message}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlanFindingsBlock({ findings }: { findings: PlanFinding[] }) {
  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warning");
  const info = findings.filter((f) => f.level === "info");
  return (
    <>
      {errors.length > 0 ? (
        <FindingsBlock
          title="Plan Errors"
          tone="error"
          findings={errors.map((f) => ({
            file: "",
            ...(f.pointer ? { pointer: f.pointer } : {}),
            message: f.message,
          }))}
        />
      ) : null}
      {warnings.length > 0 ? (
        <FindingsBlock
          title="Plan Warnings"
          tone="warn"
          findings={warnings.map((f) => ({
            file: "",
            ...(f.pointer ? { pointer: f.pointer } : {}),
            message: f.message,
          }))}
        />
      ) : null}
      {info.length > 0 ? (
        <FindingsBlock
          title="Plan Info"
          tone="warn"
          findings={info.map((f) => ({
            file: "",
            ...(f.pointer ? { pointer: f.pointer } : {}),
            message: f.message,
          }))}
        />
      ) : null}
    </>
  );
}

function actionIdentity(a: OperationPlanAction): string {
  return a.args.join(" ");
}

function describeAction(a: OperationPlanAction): ReactNode {
  return (
    <>
      account=<InlineCode>{a.account}</InlineCode> args=
      <InlineCode>{a.args.join(" ")}</InlineCode>
    </>
  );
}

function badgeStateForRisk(risk: PlanRiskLevel): "ok" | "warn" | "error" {
  if (risk === "ok") return "ok";
  if (risk === "warn") return "warn";
  return "error";
}
