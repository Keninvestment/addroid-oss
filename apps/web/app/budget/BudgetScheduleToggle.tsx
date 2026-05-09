"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BusyLabel } from "../../components/ui/AsyncFeedback";
import { useToast } from "../../components/ui/Toast";

interface BudgetScheduleToggleProps {
  initialEnabled: boolean;
}

interface ToggleResponse {
  ok?: boolean;
  enabled?: boolean;
  cron?: string;
  error?: string;
}

export function BudgetScheduleToggle({
  initialEnabled,
}: BudgetScheduleToggleProps) {
  const router = useRouter();
  const toast = useToast();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    const nextEnabled = !enabled;
    setBusy(true);
    try {
      const res = await fetch("/api/cron/budget_guard/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const body = (await res.json().catch(() => ({}))) as ToggleResponse;
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const persisted = body.enabled ?? nextEnabled;
      setEnabled(persisted);
      toast.push({
        variant: "success",
        title: persisted ? "予算チェックをONにしました" : "予算チェックをOFFにしました",
        description: persisted
          ? `自動実行を再開しました (${body.cron ?? "保存済みのcron"}).`
          : "自動実行を停止しました。実行中の処理は中断されません。",
      });
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: "予算チェックの状態変更に失敗しました",
        description: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`btn btn--sm ${enabled ? "btn--caution" : "btn--primary"}`}
      onClick={toggle}
      disabled={busy}
      aria-busy={busy}
    >
      {busy ? (
        <BusyLabel>{enabled ? "OFFにしています" : "ONにしています"}</BusyLabel>
      ) : enabled ? (
        "OFF にする"
      ) : (
        "ON にする"
      )}
    </button>
  );
}
