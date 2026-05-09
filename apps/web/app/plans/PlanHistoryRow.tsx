"use client";

// AdDroid OSS — /plans 履歴行のクライアントラッパ。
// 行をクリックすると PlanPreview を展開する toggle を提供する。

import { useState } from "react";
import { PlanPreview } from "../../components/ui/PlanPreview";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { InlineCode } from "../../components/ui/CodeBlock";
import type { PlanRunPayloadJson } from "../../../worker/src/lib/plan-runtime";

export interface PlanHistoryRowData {
  id: string;
  createdAt: string;
  message: string;
  payload: PlanRunPayloadJson;
}

export function PlanHistoryRow({ row }: { row: PlanHistoryRowData }) {
  const [open, setOpen] = useState(false);
  const { payload } = row;
  const accountLabel =
    payload.accountFilter ??
    (payload.perAccount.length === 1
      ? payload.perAccount[0]!.account
      : `(${payload.perAccount.length} accounts)`);
  const counts = payload.totalCounts;
  const summary = `+${counts.creates} ~${counts.updates} -${counts.deletes}`;
  const badge =
    payload.risk === "error" ? "error" : payload.risk === "warn" ? "warn" : "ok";
  return (
    <>
      <tr>
        <td className="tabular mono">{row.createdAt}</td>
        <td className="mono">{accountLabel}</td>
        <td className="mono">{payload.source}</td>
        <td className="mono tabular">{summary}</td>
        <td>
          <StatusBadge state={badge}>{payload.risk}</StatusBadge>
        </td>
        <td className="tabular mono">{payload.durationMs} ms</td>
        <td>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? "閉じる" : "詳細"}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="plan-history__detail-row">
          <td colSpan={7}>
            <div className="plan-history__detail">
              <div className="plan-history__detail-meta">
                <span>
                  triggered by <InlineCode>{payload.triggeredBy}</InlineCode>
                </span>
                <span>
                  rootDir <InlineCode>{payload.rootDir}</InlineCode>
                </span>
                {payload.baseDir ? (
                  <span>
                    baseDir <InlineCode>{payload.baseDir}</InlineCode>
                  </span>
                ) : null}
              </div>
              <PlanPreview
                perAccount={payload.perAccount}
                validationErrors={payload.validationErrors}
                validationWarnings={payload.validationWarnings}
                totalCounts={payload.totalCounts}
                risk={payload.risk}
              />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
