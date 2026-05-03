"use client";

// AdDroid OSS — /campaigns 行内 Activate ボタン.
//
// 仕様 (UI plan §6.5):
//   - PAUSED ノード行のみに表示。表示判定は SSR で行われ、ここは PAUSED 前提。
//   - クリックで ConfirmDialog を開く。
//   - confirmVariant = "caution" (Activate は実費発生する副作用)。
//   - description には対象オブジェクトの name / external_id / account / daily_budget を列挙。
//   - 確定後 POST /api/campaigns/[id]/activate → Toast (success/error) → router.refresh()。
//
// このコンポーネント自体は「結線担当」だが、本タスク (UI scaffold) では fetch 失敗時の
// エラー表示まで含めて UI を完結させる。実 Meta CLI 呼び出しはサーバー側で実装エージェントが結線する。

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { useToast } from "../../components/ui/Toast";

export interface ActivateButtonProps {
  nodeId: string;
  nodeType: "campaign" | "adset" | "ad";
  displayName: string;
  externalId: string | null;
  accountLabel: string;
  budgetLabel?: string | null;
}

const NODE_LABEL: Record<ActivateButtonProps["nodeType"], string> = {
  campaign: "キャンペーン",
  adset: "広告セット",
  ad: "広告",
};

export function ActivateButton({
  nodeId,
  nodeType,
  displayName,
  externalId,
  accountLabel,
  budgetLabel,
}: ActivateButtonProps) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const nodeLabel = NODE_LABEL[nodeType];

  async function confirmActivate() {
    if (busy) return;
    setBusy(true);
    try {
      // regression fix: source/actor は API 側で常に "web" / "user:web-ui" に
      // 固定される。クライアントが送る source 値はサーバー側で無視されるため、
      // ここでは送らない (誤読防止)。note は任意で送れる (将来の理由文 UI 用)。
      const res = await fetch(`/api/campaigns/${encodeURIComponent(nodeId)}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        externalId?: string;
      };
      if (!res.ok || !body.ok) {
        toast.push({
          variant: "error",
          title: `${nodeLabel}を ACTIVE にできませんでした`,
          description: body.error ?? `HTTP ${res.status}`,
        });
        setBusy(false);
        return;
      }
      toast.push({
        variant: "success",
        title: `${nodeLabel}を ACTIVE にしました`,
        description: `${accountLabel} / ${displayName}${
          body.externalId ? ` (${body.externalId})` : externalId ? ` (${externalId})` : ""
        }`,
      });
      setBusy(false);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: `${nodeLabel}を ACTIVE にできませんでした`,
        description: (err as Error).message,
      });
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--caution btn--sm"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        ACTIVE にする
      </button>
      <ConfirmDialog
        open={open}
        title={`${nodeLabel}を ACTIVE にする`}
        description={
          <div className="confirm-body">
            <p className="confirm-body__lead">
              この操作は <strong>{nodeLabel}</strong> を Meta 上で配信開始します。実費が発生する可能性があります。
            </p>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{displayName}</dd>
              <dt>Account</dt>
              <dd className="mono">{accountLabel}</dd>
              {externalId ? (
                <>
                  <dt>External ID</dt>
                  <dd className="mono">{externalId}</dd>
                </>
              ) : null}
              {budgetLabel ? (
                <>
                  <dt>Budget</dt>
                  <dd className="tabular">{budgetLabel}</dd>
                </>
              ) : null}
              <dt>Audit</dt>
              <dd>
                確定すると <span className="mono">activate.requested</span> →{" "}
                <span className="mono">activate.committed</span> が audit_logs に記録されます。
              </dd>
            </dl>
          </div>
        }
        confirmLabel="ACTIVE にする"
        cancelLabel="キャンセル"
        confirmVariant="caution"
        busy={busy}
        onConfirm={confirmActivate}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
