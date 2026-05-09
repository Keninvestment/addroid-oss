"use client";

import { useState } from "react";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { useToast } from "../../components/ui/Toast";

type Mode = "report_only" | "proposal" | "auto_apply";

interface Props {
  initialMode: string;
}

const MODES: Array<{
  value: Mode;
  label: string;
  description: string;
}> = [
  {
    value: "report_only",
    label: "レポートのみ",
    description: "条件評価と履歴保存だけを行い、Metaは変更しません。",
  },
  {
    value: "proposal",
    label: "PR作成",
    description: "本番変更は承認待ちPRに寄せます。",
  },
  {
    value: "auto_apply",
    label: "自動承認ON",
    description: "事前承認済みYAMLと安全ゲートに一致した操作だけ実行します。",
  },
];

export function AutomationModeControl({ initialMode }: Props) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(normalizeMode(initialMode));
  const [busy, setBusy] = useState<Mode | null>(null);

  async function updateMode(next: Mode) {
    if (busy || next === mode) return;
    setBusy(next);
    try {
      const res = await fetch("/api/automation/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        mode?: Mode;
        error?: string;
      };
      if (!res.ok || !body.ok || !body.mode) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setMode(body.mode);
      toast.push({
        variant: "success",
        title: "自動承認モードを更新しました",
        description: modeLabel(body.mode),
      });
    } catch (err) {
      toast.push({
        variant: "error",
        title: "自動承認モードを更新できませんでした",
        description: (err as Error).message,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mode-control">
      <div className="mode-control__current">
        <span>現在</span>
        <StatusBadge state={mode === "auto_apply" ? "warn" : mode === "proposal" ? "ok" : "idle"}>
          {modeLabel(mode)}
        </StatusBadge>
      </div>
      <div className="mode-control__options" role="group" aria-label="自動承認モード">
        {MODES.map((item) => (
          <button
            key={item.value}
            type="button"
            className="mode-control__option"
            data-active={mode === item.value}
            disabled={busy !== null}
            onClick={() => void updateMode(item.value)}
          >
            <span className="mode-control__label">
              {busy === item.value ? "更新中..." : item.label}
            </span>
            <span className="mode-control__description">{item.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function normalizeMode(value: string): Mode {
  return value === "report_only" || value === "auto_apply" ? value : "proposal";
}

function modeLabel(value: Mode): string {
  if (value === "auto_apply") return "自動承認ON";
  if (value === "report_only") return "レポートのみ";
  return "PR作成";
}
