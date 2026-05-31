"use client";

// AdDroid OSS — /campaigns 行内 Activate ボタン.
//
// 仕様 (UI plan §6.5):
//   - PAUSED ノード行のみに表示。表示判定は SSR で行われ、ここは PAUSED 前提。
//   - クリックで ConfirmDialog を開く。
//   - confirmVariant = "caution" (配信開始 PR は merge 後に実費発生する副作用)。
//   - description には対象オブジェクトの name / external_id / account / daily_budget を列挙。
//   - 確定後 POST /api/campaigns/[id]/activate → GitOps PR 作成 → Toast → router.refresh()。
//
// Web UI は Meta を直接変更しない。PR merge 後の apply 経路だけが本番反映を行う。

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
        headers: { "Content-Type": "application/json", "X-AdDroid-Web-Action": "1" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        externalId?: string;
        prNumber?: number;
        htmlUrl?: string;
      };
      if (!res.ok || !body.ok) {
        toast.push({
          variant: "error",
          title: `${nodeLabel}の配信開始PRを作成できませんでした`,
          description: body.error ?? `HTTP ${res.status}`,
        });
        setBusy(false);
        return;
      }
      toast.push({
        variant: "success",
        title: `${nodeLabel}の配信開始PRを作成しました`,
        description: body.prNumber
          ? `PR #${body.prNumber} を確認・merge すると反映されます。`
          : `${accountLabel} / ${displayName}`,
      });
      setBusy(false);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: `${nodeLabel}の配信開始PRを作成できませんでした`,
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
        配信開始PR
      </button>
      <ConfirmDialog
        open={open}
        title={`${nodeLabel}の配信開始PRを作成する`}
        description={
          <div className="confirm-body">
            <p className="confirm-body__lead">
              この操作は <strong>{nodeLabel}</strong> を配信開始するための GitOps PR を作成します。
              merge 後に反映されると実費が発生する可能性があります。
            </p>
            <dl className="kv">
              <dt>名前</dt>
              <dd>{displayName}</dd>
              <dt>広告アカウント</dt>
              <dd className="mono">{accountLabel}</dd>
              {externalId ? (
                <>
                  <dt>Meta ID</dt>
                  <dd className="mono">{externalId}</dd>
                </>
              ) : null}
              {budgetLabel ? (
                <>
                  <dt>予算</dt>
                  <dd className="tabular">{budgetLabel}</dd>
                </>
              ) : null}
              <dt>操作履歴</dt>
              <dd>
                確定すると PR 作成の操作として記録されます。Meta はこの時点では変更されません。
              </dd>
            </dl>
          </div>
        }
        confirmLabel="PRを作成"
        cancelLabel="キャンセル"
        confirmVariant="caution"
        busy={busy}
        onConfirm={confirmActivate}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
