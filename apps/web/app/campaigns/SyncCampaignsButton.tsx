"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BusyLabel } from "../../components/ui/AsyncFeedback";
import { useToast } from "../../components/ui/Toast";

interface SyncCampaignsButtonProps {
  accountId: string | null;
}

interface SyncResponse {
  ok?: boolean;
  campaigns?: number;
  adsets?: number;
  ads?: number;
  upserted?: number;
  error?: string;
}

export function SyncCampaignsButton({ accountId }: SyncCampaignsButtonProps) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function sync() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const body = (await res.json().catch(() => ({}))) as SyncResponse;
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toast.push({
        variant: "success",
        title: "広告一覧を更新しました",
        description: `campaign ${body.campaigns ?? 0} / adset ${body.adsets ?? 0} / ad ${body.ads ?? 0} 件`,
      });
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: "広告一覧の更新に失敗しました",
        description: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="btn btn--primary btn--sm"
      onClick={sync}
      disabled={busy || !accountId}
      aria-busy={busy}
    >
      {busy ? <BusyLabel>取得中</BusyLabel> : "Metaから更新"}
    </button>
  );
}
