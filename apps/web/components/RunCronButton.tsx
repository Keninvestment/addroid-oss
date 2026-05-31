"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cronRunMonitorConfigForPreset } from "./cronRunMonitorConfig";
import { useCronRunMonitor } from "./useCronRunMonitor";
import { BusyLabel } from "./ui/AsyncFeedback";
import { useToast } from "./ui/Toast";

interface RunCronButtonProps {
  presetName: string;
  label: string;
  className?: string;
}

interface RunCronResponse {
  ok?: boolean;
  jobId?: string;
  error?: string;
}

export function RunCronButton({
  presetName,
  label,
  className = "btn btn--primary btn--sm",
}: RunCronButtonProps) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const monitorConfig = cronRunMonitorConfigForPreset(presetName);
  const monitor = useCronRunMonitor({
    presetName,
    ...monitorConfig,
    onTerminal: (state) => {
      router.refresh();
      if (state.phase === "failed") {
        toast.push({
          variant: "error",
          title: `${label} が失敗しました`,
          description: state.errorMessage ?? "実行履歴を確認してください。",
        });
      } else if (state.phase === "timeout") {
        toast.push({
          variant: "info",
          title: `${label} はバックグラウンドで継続中です`,
          description:
            state.errorMessage ??
            "実行履歴で完了状況を確認してください。",
        });
      }
    },
  });

  async function runNow() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/cron/${encodeURIComponent(presetName)}/run`, {
        method: "POST",
        headers: { "X-AdDroid-Web-Action": "1" },
      });
      const body = (await res.json().catch(() => ({}))) as RunCronResponse;
      if (!res.ok || body.ok === false) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toast.push({
        variant: "success",
        title: `${label} を開始しました`,
        description: body.jobId ? `job=${body.jobId}` : "実行要求を受け付けました。",
      });
      monitor.start(body.jobId ?? null);
      if (!body.jobId) router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: `${label} に失敗しました`,
        description: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || monitor.isActive;

  return (
    <button
      type="button"
      className={className}
      onClick={runNow}
      disabled={disabled}
      aria-busy={busy || monitor.isActive}
    >
      {busy ? (
        <BusyLabel>開始中</BusyLabel>
      ) : monitor.isActive ? (
        <BusyLabel>{monitor.label}</BusyLabel>
      ) : monitor.state.phase === "success" ? (
        "完了"
      ) : monitor.state.phase === "failed" ? (
        "失敗"
      ) : monitor.state.phase === "timeout" ? (
        "確認中断"
      ) : (
        label
      )}
    </button>
  );
}
