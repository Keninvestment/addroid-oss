"use client";

// AdDroid OSS — /plans の Ad-hoc Dry-run フォーム.
// アカウントを選択して `/api/plan` を呼び、結果 (PlanPreview) を inline 表示する。
// 履歴は SSR で取得しているため、成功時は window.location.reload で history を再取得する。

import { useState } from "react";
import { useToast } from "../../components/ui/Toast";
import { PlanPreview } from "../../components/ui/PlanPreview";
import type { PlanRunPayloadJson } from "../../../worker/src/lib/plan-runtime";

export interface AdhocAccountOption {
  id: string;
  key: string;
  displayName: string;
  metaAccountId: string | null;
}

interface ApiResponse {
  ok?: boolean;
  executionLogId?: string | null;
  result?: PlanRunPayloadJson | null;
  error?: string;
  persistError?: string;
}

interface State {
  accountId: string;
  running: boolean;
  error: string | null;
  preview: PlanRunPayloadJson | null;
}

export function AdhocPlanForm({
  accounts,
  defaultAdAccountId,
}: {
  accounts: AdhocAccountOption[];
  defaultAdAccountId: string | null;
}) {
  const { push } = useToast();
  const [state, setState] = useState<State>({
    accountId:
      defaultAdAccountId && accounts.some((a) => a.id === defaultAdAccountId)
        ? defaultAdAccountId
        : "",
    running: false,
    error: null,
    preview: null,
  });

  function patch(p: Partial<State>) {
    setState((s) => ({ ...s, ...p }));
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (state.running) return;
    patch({ running: true, error: null, preview: null });
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: state.accountId || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok) {
        const message = body.error ?? `HTTP ${res.status}`;
        patch({ running: false, error: message });
        push({
          variant: "error",
          title: "入稿前チェックに失敗しました",
          description: message,
        });
        return;
      }
      const result = (body.result ?? null) as PlanRunPayloadJson | null;
      if (!result) {
        patch({ running: false, error: "Empty plan result" });
        push({
          variant: "error",
          title: "入稿前チェックに失敗しました",
          description: "API から空の結果が返りました。",
        });
        return;
      }
      patch({ running: false, preview: result });
      if (body.persistError) {
        push({
          variant: "info",
          title: "チェックは完了しましたが履歴の保存に失敗しました",
          description: body.persistError,
        });
      } else if (result.ok) {
        push({
          variant: "success",
          title: "入稿前チェックが完了しました",
          description: planSummary(result),
        });
        // 履歴を再読み込み (SSR 由来のテーブルを最新化する)。
        setTimeout(() => window.location.reload(), 600);
      } else {
        push({
          variant: "error",
          title: "確認が必要な変更があります",
          description: planSummary(result),
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      patch({ running: false, error: message });
      push({
        variant: "error",
        title: "入稿前チェックに失敗しました",
        description: message,
      });
    }
  }

  return (
    <div className="adhoc-plan">
      <form className="adhoc-plan__form" onSubmit={submit}>
        <div className="toolbar__field">
          <label className="toolbar__label" htmlFor="adhoc-plan-account">
            広告アカウント
          </label>
          <select
            id="adhoc-plan-account"
            className="form-select"
            value={state.accountId}
            onChange={(e) => patch({ accountId: e.target.value })}
            disabled={state.running}
          >
            <option value="">(全アカウント)</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName} · {a.metaAccountId ?? a.key}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={state.running}
        >
          {state.running ? "確認中…" : "入稿前チェックを実行"}
        </button>
      </form>
      {state.error ? (
        <div className="banner" data-state="error">
          <span className="banner__title">入稿前チェックに失敗しました</span>
          <span>{state.error}</span>
        </div>
      ) : null}
      {state.preview ? (
        <div className="adhoc-plan__preview">
          <PlanPreview
            perAccount={state.preview.perAccount}
            validationErrors={state.preview.validationErrors}
            validationWarnings={state.preview.validationWarnings}
            totalCounts={state.preview.totalCounts}
            risk={state.preview.risk}
          />
        </div>
      ) : null}
    </div>
  );
}

function planSummary(p: PlanRunPayloadJson): string {
  const c = p.totalCounts;
  return `+${c.creates} ~${c.updates} -${c.deletes} (errors=${
    c.errors + p.validationErrors.length
  } warnings=${c.warnings + p.validationWarnings.length})`;
}
